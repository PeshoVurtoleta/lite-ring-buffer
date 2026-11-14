// pushbatch-probe.mjs -- ONE (chunk, src type, layout) config x ONE compilation of the pushBatch A/B bench.
// Spawned by test/bench/pushbatch-ab.mjs (never run by `npm test` / `npm run verify`); prints one JSON line.
// Port of copyto-probe.mjs and of the R2 research probe (.handoff/research/r2/probe-pushbatch.mjs: layouts,
// values) to the REAL modules.
//
//   node --allow-natives-syntax --expose-gc test/bench/pushbatch-probe.mjs
//        --ref FILE --ref-sha8 HEX --cand FILE --cand-sha8 HEX
//        --chunk N --src f32|f64 --layout whole|slice|over [--K 21] [--control box|aa]
//
// FILE is a staged RingBuffer.mjs (two different paths -> two module instances, even for identical bytes).
// REF is the oracle reference only (its `push`); every timed call runs on the CAND class.
// Layouts (ring full before every call; the driver resets rb.head = H0 before each call, in every column):
//   whole  cap max(4096, 2N), src length N,     srcOffset 0, H0 0
//   slice  cap max(4096, 2N), src length N + 8, srcOffset 3, H0 0
//   over   cap N / 4,         src length N,     srcOffset 0, H0 1    (count > capacity every call; N >= 32)
// Timed columns (each its own col_* wrapper and drive_* driver, own rb + own src; unique source text so V8's
// eval cache never shares feedback between columns, LEDGER D11; every driver body is only
// `rb.head = H0; r = (r + col(rb, src, OFF, N)) | 0`):
//   PUSHN     the caller loop: for (i < count) rb.push(src[srcOffset + i]) on the CAND class (the baseline)
//   PUSHN_AA  PUSHN through its own text, rb and src (A/A twin)
//   CAND      rb.pushBatch(src, srcOffset, count)
//   CAND_AA   CAND through its own text, rb and src (A/A twin)
//   SLOW      must-fail control: pushBatch twice per call, head reset between
// The A/A twins are TIMING-POSITION twins: own text, own rb + src, but the same pushBatch / push
// SharedFunctionInfo (one class); the fresh processes the driver spawns are the compilation axis.
// Every call in this process uses ONE src class (the loopF32 / loopF64 sites stay monomorphic).
// B/op-only control: BOX = CAND plus `BOXES[0] = r + 0.5` into a PACKED_ELEMENTS array (one 16 B HeapNumber
// per call). --control box builds CAND's driver as a BOX driver (CAND B/op ~16, the judge must VOID);
// --control aa builds CAND_AA's column as SLOW (the A/A must leave its band). Picked at build time, never a
// branch inside a driver.
// B/op (LEDGER D6 v4): v8 total_allocated_bytes; per lane (min over windows 1..W-1 of the lane delta - min of
// its own time-matched empty-driver delta) / nb, nb >= 200,000 calls, gc() around every window, windows
// interleaved across lanes with the lane order rotated per window.
// Oracle before AND after timing: each timed column, one call on a fresh full ring at the timed layout, vs
// N x REF `push` on an identical REF ring (Object.is per data slot, head, count, capacity, return value).
// The oracle src is the timed values with -0 forced into the first sample that survives the call (so every
// chunk, 1 included, writes a -0).
// Wrapper mutants (oracle teeth, never timed, checked before and after timing): MUT_OBO (last written slot
// takes the previous slot's value), MUT_HEAD (head one past) and MUT_NEGZERO (every -0 in data stored as +0;
// only an Object.is oracle sees it, a !== oracle passes it). checks.uniqueSrc: every col / driver text built
// here is distinct.
// TurboFan: bit 32 calibrated on a trivial function first (unset -> exit 1); all 6 drivers (5 timed + BOX)
// must be TurboFan after warmup and at the end; the methods' own status is reported only.
// Exit 0 = ran (checks recorded; the driver judges them); 1 = harness precondition failed (natives, gc,
// total_allocated_bytes, tfCalib, sha8, two module instances, pushBatch missing, Smi range); 2 = usage error.
// Test tooling only: not shipped.
import v8 from 'node:v8';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const die = (code, m) => { process.stderr.write('pushbatch-probe: ' + m + '\n'); process.exit(code); };

// ---- options (strict) ---------------------------------------------------------------------------------
const VALUE_OPTS = ['--ref', '--ref-sha8', '--cand', '--cand-sha8', '--chunk', '--src', '--layout', '--K', '--control'];
const opt = Object.create(null);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!VALUE_OPTS.includes(a)) die(2, 'unknown argument ' + JSON.stringify(a));
    if (a in opt) die(2, a + ' given twice');
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) die(2, a + ' needs a value');
    opt[a] = v;
    i++;
}
for (const k of ['--ref', '--ref-sha8', '--cand', '--cand-sha8', '--chunk', '--src', '--layout']) {
    if (!(k in opt)) die(2, k + ' is required');
}
const N = Number(opt['--chunk']);
const srcKind = opt['--src'];
const layout = opt['--layout'];
const K = Number(opt['--K'] ?? '21');
const CONTROL = opt['--control'] ?? '';
if (!/^[0-9]+$/.test(opt['--chunk']) || !(N >= 1 && N <= 4096) || (N & (N - 1)) !== 0) die(2, '--chunk must be a power of two in 1..4096');
if (srcKind !== 'f32' && srcKind !== 'f64') die(2, '--src f32|f64');
if (layout !== 'whole' && layout !== 'slice' && layout !== 'over') die(2, '--layout whole|slice|over');
if (layout === 'over' && !(N >= 32)) die(2, '--layout over needs --chunk >= 32');
if (!/^[0-9]+$/.test(opt['--K'] ?? '21') || !(K >= 5 && K <= 1001)) die(2, '--K must be an integer 5..1001');
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'aa') die(2, '--control box|aa');

// ---- preconditions (fail closed) ----------------------------------------------------------------------
let optStatus;
try { optStatus = new Function('f', 'return %GetOptimizationStatus(f);'); } catch { die(1, 'needs --allow-natives-syntax'); }
if (typeof globalThis.gc !== 'function') die(1, 'needs --expose-gc');
const hs0 = v8.getHeapStatistics();
if (!('total_allocated_bytes' in hs0) || !Number.isFinite(hs0.total_allocated_bytes)) die(1, 'v8 total_allocated_bytes missing or not finite');
const TURBOFANNED = 32; // V8 14.6: bit 5; calibrated below, never trusted blind
const calib = new Function('return function calibTrivialPb(x) { return (x + 1) | 0; };')();
new Function('f', '%PrepareFunctionForOptimization(f); f(1); f(2); %OptimizeFunctionOnNextCall(f); f(3);')(calib);
const tfCalib = (optStatus(calib) & TURBOFANNED) !== 0;
if (!tfCalib) die(1, 'TurboFan bit ' + TURBOFANNED + ' calibration failed (status ' + optStatus(calib) + ')');

function loadSide(key) {
    const p = opt['--' + key];
    let st;
    try { st = statSync(p); } catch { die(1, '--' + key + ' not found: ' + p); }
    if (!st.isFile()) die(1, '--' + key + ' is not a file: ' + p);
    const s8 = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);
    if (s8 !== opt['--' + key + '-sha8']) die(1, '--' + key + ' sha256/8 ' + s8 + ' != expected ' + opt['--' + key + '-sha8']);
    return { p, s8 };
}
const SR = loadSide('ref');
const SC = loadSide('cand');
if (SR.p === SC.p) die(1, 'ref and cand must be two staged paths (two module instances)');
const RB_R = (await import(pathToFileURL(SR.p).href)).RingBuffer;
const RB_C = (await import(pathToFileURL(SC.p).href)).RingBuffer;
if (typeof RB_R !== 'function' || typeof RB_C !== 'function') die(1, 'RingBuffer export missing');
if (RB_R === RB_C) die(1, 'ref and cand resolved to one module instance');
if (typeof RB_C.prototype.pushBatch !== 'function') die(1, 'pushBatch missing on the cand side');
if (typeof RB_R.prototype.push !== 'function' || typeof RB_C.prototype.push !== 'function') die(1, 'push missing');

const S = srcKind === 'f32' ? Float32Array : Float64Array;
const BIG = Math.max(4096, 2 * N);
const L = layout === 'whole' ? { cap: BIG, len: N, off: 0, H0: 0 }
    : layout === 'slice' ? { cap: BIG, len: N + 8, off: 3, H0: 0 }
        : { cap: N >> 2, len: N, off: 0, H0: 1 };

// ---- values, rings ------------------------------------------------------------------------------------
// research VAL: values that round when stored as float32, plus NaN, -0, overflow to Infinity, underflow to 0.
const VAL = (i) => {
    switch (i % 11) {
        case 0: return 0.1 * i; case 1: return 1 / 3 + i; case 2: return NaN; case 3: return -0;
        case 4: return 1e39; case 5: return -7e-46; case 6: return -1e300; case 7: return 16777217 + i;
        default: return (i * 0.37) - 100.125;
    }
};
function mkSrc() { const s = new S(L.len); for (let i = 0; i < L.len; i++) s[i] = VAL(i + 1); return s; }
function mkRing(RB) {
    const r = new RB(L.cap);
    if (r.capacity !== L.cap) die(1, 'capacity ' + r.capacity + ' != ' + L.cap);
    for (let i = 0; i < L.cap; i++) r.data[i] = -1000 - i * 0.5;
    r.head = L.H0; r.count = L.cap;
    return r;
}

// ---- columns ------------------------------------------------------------------------------------------
// Every col / driver built here is recorded; checks.uniqueSrc proves no two share source text (D11).
const BUILT = [];
const reg = (fn) => { BUILT.push(String(fn)); return fn; };
const mkCol = (name, body) => reg(new Function('return function col_' + name + '(rb, src, srcOffset, count) {\n' + body + '\n};')());
const BODY = {
    pushn: 'for (let i = 0; i < count; i++) rb.push(src[srcOffset + i]);\nreturn count;',
    cand: 'return rb.pushBatch(src, srcOffset, count);',
    slow: 'const h = rb.head;\nrb.pushBatch(src, srcOffset, count);\nrb.head = h;\nreturn rb.pushBatch(src, srcOffset, count);',
    empty: 'return count;',
    // wrapper mutants (oracle teeth only, never timed)
    mutObo: 'const r = rb.pushBatch(src, srcOffset, count);\nconst m = rb.mask;\nrb.data[(rb.head - 1) & m] = rb.data[(rb.head - 2) & m];\nreturn r;',
    mutHead: 'const r = rb.pushBatch(src, srcOffset, count);\nrb.head = (rb.head + 1) & rb.mask;\nreturn r;',
    mutNegZero: 'const r = rb.pushBatch(src, srcOffset, count);\nconst d = rb.data;\nfor (let i = 0; i < d.length; i++) if (d[i] === 0) d[i] = 0;\nreturn r;',
};
const DRIVE_HEAD = '(reps) { let r = 0; for (let k = 0; k < reps; k++) { rb.head = ' + L.H0 + '; r = (r + col(rb, src, ' + L.off + ', ' + N + ')) | 0;';
const mkDrive = (name, col, rb, src) => reg(new Function('col', 'rb', 'src',
    'return function drive_' + name + DRIVE_HEAD + ' } return r; };')(col, rb, src));
const BOXES = [null]; // PACKED_ELEMENTS: a fractional double stored here is a fresh HeapNumber
const mkBoxDrive = (name, col, rb, src) => reg(new Function('col', 'rb', 'src', 'BOXES',
    'return function drive_' + name + DRIVE_HEAD + ' BOXES[0] = r + 0.5; } return r; };')(col, rb, src, BOXES));

const TIMED = ['PUSHN', 'PUSHN_AA', 'CAND', 'CAND_AA', 'SLOW'];
const LANES = TIMED.concat(['BOX']); // B/op lanes = timed + BOX
const colBody = {
    PUSHN: BODY.pushn, PUSHN_AA: BODY.pushn, CAND: BODY.cand,
    CAND_AA: CONTROL === 'aa' ? BODY.slow : BODY.cand, SLOW: BODY.slow, BOX: BODY.cand,
};
const cols = {}, rbs = {}, srcs = {}, drives = {};
for (const nm of LANES) {
    cols[nm] = mkCol(nm, colBody[nm]);
    rbs[nm] = mkRing(RB_C);
    srcs[nm] = mkSrc();
    drives[nm] = nm === 'BOX' || (nm === 'CAND' && CONTROL === 'box')
        ? mkBoxDrive(nm, cols[nm], rbs[nm], srcs[nm])
        : mkDrive(nm, cols[nm], rbs[nm], srcs[nm]);
}
const mutCols = { MUT_OBO: mkCol('MUT_OBO', BODY.mutObo), MUT_HEAD: mkCol('MUT_HEAD', BODY.mutHead), MUT_NEGZERO: mkCol('MUT_NEGZERO', BODY.mutNegZero) };
const emptyDrive = mkDrive('EMPTY', mkCol('EMPTY', BODY.empty), mkRing(RB_C), mkSrc());
const uniqueSrc = new Set(BUILT).size === BUILT.length && BUILT.length === LANES.length * 2 + 3 + 2;

// ---- oracle -------------------------------------------------------------------------------------------
// One call of col on a fresh full CAND ring vs N x REF push on an identical REF ring.
const oracleSrc = mkSrc();
oracleSrc[L.off + Math.max(0, N - L.cap)] = -0;
function oracle(col) {
    const ref = mkRing(RB_R), t = mkRing(RB_C);
    for (let i = 0; i < N; i++) ref.push(oracleSrc[L.off + i]);
    let r;
    try { r = col(t, oracleSrc, L.off, N); } catch { return false; }
    if (r !== N || t.head !== ref.head || t.count !== ref.count || t.capacity !== ref.capacity) return false;
    for (let i = 0; i < L.cap; i++) if (!Object.is(t.data[i], ref.data[i])) return false;
    return true;
}
const oracleAll = () => Object.fromEntries(TIMED.map((nm) => [nm, oracle(cols[nm])]));
const checks = {
    tfCalib, uniqueSrc,
    oracle: oracleAll(),
    mutObo: { before: !oracle(mutCols.MUT_OBO) },
    mutHead: { before: !oracle(mutCols.MUT_HEAD) },
    mutNegZero: { before: !oracle(mutCols.MUT_NEGZERO) },
};

// ---- timing -------------------------------------------------------------------------------------------
const sink = new Float64Array(1);
const tns = new Float64Array(1);
function timeNs(drive, reps) {
    const t0 = process.hrtime.bigint();
    sink[0] += drive(reps);
    const t1 = process.hrtime.bigint();
    tns[0] = Number(t1 - t0) / reps;
    return tns[0];
}
// warmup: interleaved, until every driver reads TurboFan (or the budget runs out)
for (let i = 0; i < 5; i++) for (const nm of LANES) drives[nm](200);
const nsCal = Math.max(timeNs(drives.CAND, 2000), timeNs(drives.PUSHN, 2000));
if (!(nsCal > 0)) die(1, 'calibration time ' + nsCal);
// reps target ~1 ms per sample at the speed of this 2000-call calibration, which runs BEFORE the TurboFan
// warmup: optimized samples run shorter (80-600 us per sample in the 4c dry run, review r1).
const reps = Math.max(1, Math.min(1000000, Math.round(1e6 / nsCal)));
const warmReps = Math.max(1, Math.round(reps * 4));
for (let pass = 0; pass < 10; pass++) {
    for (const nm of LANES) drives[nm](warmReps);
    if (pass >= 4 && LANES.every((nm) => (optStatus(drives[nm]) & TURBOFANNED) !== 0)) break;
}
const optAfterWarm = Object.fromEntries(LANES.map((nm) => [nm, optStatus(drives[nm])]));

// ---- B/op lane (D6 v4) --------------------------------------------------------------------------------
const W = 6;
const NB_MIN = 200000;
const alloc = () => v8.getHeapStatistics().total_allocated_bytes;
const nb = Math.max(NB_MIN, reps * 20);
// drivers wrap r with | 0; the assertion keeps every per-window sum inside the Smi range anyway
if (!(nb * N < 1073741824) || !(reps * N < 1073741824)) die(1, 'nb ' + nb + ' x chunk ' + N + ' would leave the Smi range');
for (let i = 0; i < 3; i++) emptyDrive(nb);
const emptyNs = timeNs(emptyDrive, nb);
const nbE = Object.fromEntries(LANES.map((nm) => [nm, Math.max(nb, Math.round(nb * timeNs(drives[nm], reps) / emptyNs))]));
const bestL = Object.fromEntries(LANES.map((nm) => [nm, Infinity]));
const bestE = Object.fromEntries(LANES.map((nm) => [nm, Infinity]));
for (let w = 0; w < W; w++) {
    for (let j = 0; j < LANES.length; j++) {
        const nm = LANES[(j + w) % LANES.length];
        gc();
        const a0 = alloc(); sink[0] += emptyDrive(nbE[nm]); gc(); const a1 = alloc();
        gc();
        const b0 = alloc(); sink[0] += drives[nm](nb); gc(); const b1 = alloc();
        if (w > 0) { bestE[nm] = Math.min(bestE[nm], a1 - a0); bestL[nm] = Math.min(bestL[nm], b1 - b0); }
    }
}
const bop = Object.fromEntries(LANES.map((nm) => [nm, (bestL[nm] - bestE[nm]) / nb]));

// ---- K interleaved rounds, order rotated each round ---------------------------------------------------
const load0 = os.loadavg()[0];
const rounds = [];
for (let r = 0; r < K; r++) {
    const row = {};
    for (let j = 0; j < TIMED.length; j++) {
        const nm = TIMED[(j + r) % TIMED.length];
        row[nm] = timeNs(drives[nm], reps);
    }
    rounds.push(row);
}
const load1 = os.loadavg()[0];
const optAtEnd = Object.fromEntries(LANES.map((nm) => [nm, optStatus(drives[nm])]));
const methodOpt = { cand_pushBatch: optStatus(RB_C.prototype.pushBatch), cand_push: optStatus(RB_C.prototype.push) };
checks.oracleAfter = oracleAll();
checks.mutObo.after = !oracle(mutCols.MUT_OBO);
checks.mutHead.after = !oracle(mutCols.MUT_HEAD);
checks.mutNegZero.after = !oracle(mutCols.MUT_NEGZERO);
// the 5 timed drivers and BOX (its B/op is gated) must be TurboFan after warmup and at the end
checks.turbofan = LANES.every((nm) => (optAfterWarm[nm] & TURBOFANNED) !== 0 && (optAtEnd[nm] & TURBOFANNED) !== 0);

process.stdout.write(JSON.stringify({
    chunk: N, src: srcKind, layout, cap: L.cap, H0: L.H0, off: L.off, K, reps, nb, W, control: CONTROL,
    sha8: { ref: SR.s8, cand: SC.s8 },
    node: process.version, v8: process.versions.v8,
    host: process.env.QUIET_LOCK_HOST || 'unlocked', hostWhy: process.env.QUIET_LOCK_WHY || '',
    load: [load0, load1], checks, bop, optAfterWarm, optAtEnd, methodOpt, rounds, sink: sink[0] !== 0,
}) + '\n');
