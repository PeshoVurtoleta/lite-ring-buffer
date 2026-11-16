// copylast-probe.mjs -- ONE (kind, ring, n, dst type) config x ONE compilation of the copyLast A/B bench.
// Spawned by test/bench/copylast-ab.mjs (never run by `npm test` / `npm run verify`); prints one JSON line.
// Port of pushbatch-probe.mjs and of the R3 research probe (.handoff/archive/1.5.0/research/r3/probe-copylast.mjs: callerCopy,
// values, configs, LEDGER D12 harness v3) to the REAL modules.
//
//   node --allow-natives-syntax --expose-gc test/bench/copylast-probe.mjs
//        --ref FILE --ref-sha8 HEX --cand FILE --cand-sha8 HEX
//        --kind caller|parity --cap N --head H --n N --dst f32|f64 [--K 21] [--control box|aa]
//
// FILE is a staged RingBuffer.mjs (two different paths -> two module instances, even for identical bytes).
// REF is the oracle reference only (the last k of its `copyTo`); every timed call runs on the CAND class.
// Ring: full (count = cap) at head H, research `val` values (float32-exact, with NaN and -0 among them).
//   --cap a power of two in 4..65536, --head 0..cap-1, --n 4..cap (kind parity: n must equal cap).
// Timed columns (each its own col_* wrapper and drive_* driver, own rb + own dst + own scratch; unique source text
// so V8's eval cache never shares feedback between columns, LEDGER D11; every driver body is only
// `r = (r + col(rb, dst, A)) | 0`, n = A[0] and dstOffset = A[1] read from an Int32Array cell on every call):
//   BASE      kind caller: the callerCopy body (rb.copyTo into a Float32Array(cap) scratch, then a loop over its
//             last k into dst; today's workaround). kind parity: rb.copyTo(dst, dstOffset).
//   BASE_AA   BASE through its own text, rb, dst and scratch (A/A twin of the reference, LEDGER D12 (3))
//   CAND      rb.copyLast(dst, dstOffset, n)
//   CAND_AA   CAND through its own text, rb and dst (A/A twin)
//   SLOW      must-fail control: copyLast twice per call
// The A/A twins are TIMING-POSITION twins: own text, own rb + dst, but the same copyLast / copyTo
// SharedFunctionInfo (one class); the fresh processes the driver spawns are the compilation axis.
// Every call in this process uses ONE dst class (the copy sites stay monomorphic).
// B/op-only control: BOX = CAND plus `BOXES[0] = r + 0.5` into a PACKED_ELEMENTS array (one 16 B HeapNumber
// per call). --control box builds CAND's driver as a BOX driver (CAND B/op ~16, the judge must VOID);
// --control aa builds CAND_AA's column as SLOW (the A/A must leave its band). Picked at build time, never a
// branch inside a driver.
// Sizing (LEDGER D12 (2)): warm-up first, THEN reps sized for ~1 ms per sample on the slower of CAND / BASE,
// then warm passes until every driver is TurboFan.
// B/op (LEDGER D6 v4): v8 total_allocated_bytes; per lane (min over windows 1..W-1 of the lane delta - min of
// its own time-matched empty-driver delta) / nb, nb = max(100,000, 20 x reps) calls, gc() around every window,
// windows interleaved across lanes with the lane order rotated per window.
// Oracle before AND after timing: each timed column, one call at dstOffset 1 on a fresh full CAND ring, into a
// dst guarded on both sides, vs the last k of REF copyTo on an identical REF ring (Object.is per slot, both
// guards, the returned k, CAND ring data / head / count unchanged). The oracle ring forces, inside the newest
// k: oldest-of-k = 1.5, newest-1 = -0, newest = NaN.
// Wrapper mutants (oracle teeth, never timed, checked before and after timing): MUT_OBO (newest copied slot takes
// the previous slot's value), MUT_OLDEST (oldest copied slot takes its newer neighbour's value: a start-index
// off by one at the old end) and MUT_NEGZERO (every -0 in dst stored as +0; only an Object.is oracle sees it).
// checks.uniqueSrc: every col / driver text built here is distinct.
// TurboFan: bit 32 calibrated on a trivial function first (unset -> exit 1); all 6 drivers (5 timed + BOX)
// must be TurboFan after warmup and at the end; the methods' own status is reported only.
// Reported only (never a check): copyToSrcSame = cand copyTo source text === ref copyTo source text.
// Exit 0 = ran (checks recorded; the driver judges them); 1 = harness precondition failed (natives, gc,
// total_allocated_bytes, tfCalib, sha8, one module instance, cand copyLast or ref copyTo missing, Smi range, a
// timed column throws); 2 = usage error.
// Test tooling only: not shipped.
import v8 from 'node:v8';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const die = (code, m) => { process.stderr.write('copylast-probe: ' + m + '\n'); process.exit(code); };

// ---- options (strict) ---------------------------------------------------------------------------------
const VALUE_OPTS = ['--ref', '--ref-sha8', '--cand', '--cand-sha8', '--kind', '--cap', '--head', '--n', '--dst', '--K', '--control'];
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
for (const k of ['--ref', '--ref-sha8', '--cand', '--cand-sha8', '--kind', '--cap', '--head', '--n', '--dst']) {
    if (!(k in opt)) die(2, k + ' is required');
}
const INT = /^[0-9]+$/;
// canonical decimal integer: no sign, no leading zero, no exponent, no fraction (same text as compare.mjs's CANON_INT)
const CANON_INT = /^(?:0|[1-9][0-9]*)$/;
const KIND = opt['--kind'];
const CAP = Number(opt['--cap']);
const HEAD = Number(opt['--head']);
const N = Number(opt['--n']);
const dstKind = opt['--dst'];
const K = Number(opt['--K'] ?? '21');
const CONTROL = opt['--control'] ?? '';
if (KIND !== 'caller' && KIND !== 'parity') die(2, '--kind caller|parity');
if (!INT.test(opt['--cap']) || !(CAP >= 4 && CAP <= 65536) || (CAP & (CAP - 1)) !== 0) die(2, '--cap must be a power of two in 4..65536');
if (!INT.test(opt['--head']) || !(HEAD >= 0 && HEAD < CAP)) die(2, '--head must be an integer 0..cap-1');
if (!INT.test(opt['--n']) || !(N >= 4 && N <= CAP)) die(2, '--n must be an integer 4..cap');
if (KIND === 'parity' && N !== CAP) die(2, '--kind parity needs --n equal to --cap (copyLast(count) vs copyTo)');
if (dstKind !== 'f32' && dstKind !== 'f64') die(2, '--dst f32|f64');
if (!CANON_INT.test(opt['--K'] ?? '21') || !(K >= 5 && K <= 1001)) die(2, '--K must be a canonical integer 5..1001');
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'aa') die(2, '--control box|aa');

// ---- preconditions (fail closed) ----------------------------------------------------------------------
let optStatus;
try { optStatus = new Function('f', 'return %GetOptimizationStatus(f);'); } catch { die(1, 'needs --allow-natives-syntax'); }
if (typeof globalThis.gc !== 'function') die(1, 'needs --expose-gc');
const hs0 = v8.getHeapStatistics();
if (!('total_allocated_bytes' in hs0) || !Number.isFinite(hs0.total_allocated_bytes)) die(1, 'v8 total_allocated_bytes missing or not finite');
const TURBOFANNED = 32; // V8 14.6: bit 5; calibrated below, never trusted blind
const calib = new Function('return function calibTrivialCl(x) { return (x + 1) | 0; };')();
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
if (typeof RB_C.prototype.copyLast !== 'function') die(1, 'no copyLast on the cand side');
if (typeof RB_R.prototype.copyTo !== 'function') die(1, 'no copyTo on the ref side');
if (typeof RB_C.prototype.copyTo !== 'function') die(1, 'no copyTo on the cand side');
const copyToSrcSame = String(RB_C.prototype.copyTo) === String(RB_R.prototype.copyTo);

const D = dstKind === 'f32' ? Float32Array : Float64Array;
const OFF = 0; // timed dstOffset (A[1]); the oracle uses 1

// ---- values, rings ------------------------------------------------------------------------------------
// research `val`: float32-exact samples, with NaN and -0 among them (Object.is compares them).
const val = (i) => (i % 13 === 5 ? NaN : i % 11 === 3 ? -0 : Math.fround(i * 0.37 - 3.1));
function mkRing(RB) {
    const r = new RB(CAP);
    if (r.capacity !== CAP) die(1, 'capacity ' + r.capacity + ' != ' + CAP);
    for (let i = 0; i < CAP; i++) r.data[i] = val(i);
    r.head = HEAD; r.count = CAP;
    return r;
}
// oracle ring: inside the newest k, oldest-of-k = 1.5, newest-1 = -0, newest = NaN (n >= 4: no overlap)
function mkOracleRing(RB) {
    const r = mkRing(RB);
    const m = CAP - 1;
    r.data[(HEAD - N) & m] = 1.5;
    r.data[(HEAD - 2) & m] = -0;
    r.data[(HEAD - 1) & m] = NaN;
    return r;
}
const GUARD = 777.5; // exact in float32

// ---- columns ------------------------------------------------------------------------------------------
// Every col / driver built here is recorded; checks.uniqueSrc proves no two share source text (D11).
const BUILT = [];
const reg = (fn) => { BUILT.push(String(fn)); return fn; };
const mkCol = (name, body, scr) => reg(new Function('scr', 'return function col_' + name + '(rb, dst, A) {\n' + body + '\n};')(scr));
const BODY = {
    // callerCopy (research harness v2): copyTo the whole window into a capacity scratch, then its last k
    callerCopy: 'const n = A[0], o = A[1];\nconst c = rb.copyTo(scr, 0);\nconst k = n < c ? n : c;\nconst s = c - k;\n' +
        'for (let i = 0; i < k; i++) dst[o + i] = scr[s + i];\nreturn k;',
    copyTo: 'return rb.copyTo(dst, A[1]);',
    cand: 'return rb.copyLast(dst, A[1], A[0]);',
    slow: 'rb.copyLast(dst, A[1], A[0]);\nreturn rb.copyLast(dst, A[1], A[0]);',
    empty: 'return A[0];',
    // wrapper mutants (oracle teeth only, never timed)
    mutObo: 'const r = rb.copyLast(dst, A[1], A[0]);\nconst o = A[1];\ndst[o + r - 1] = dst[o + r - 2];\nreturn r;',
    mutOldest: 'const r = rb.copyLast(dst, A[1], A[0]);\nconst o = A[1];\ndst[o] = dst[o + 1];\nreturn r;',
    mutNegZero: 'const r = rb.copyLast(dst, A[1], A[0]);\nfor (let i = 0; i < dst.length; i++) if (dst[i] === 0) dst[i] = 0;\nreturn r;',
};
const ARGS = new Int32Array(2); // timed [n, dstOffset]
ARGS[0] = N; ARGS[1] = OFF;
const DRIVE_HEAD = '(reps) { let r = 0; for (let q = 0; q < reps; q++) { r = (r + col(rb, dst, A)) | 0;';
const mkDrive = (name, col, rb, dst) => reg(new Function('col', 'rb', 'dst', 'A',
    'return function drive_' + name + DRIVE_HEAD + ' } return r; };')(col, rb, dst, ARGS));
const BOXES = [null]; // PACKED_ELEMENTS: a fractional double stored here is a fresh HeapNumber
const mkBoxDrive = (name, col, rb, dst) => reg(new Function('col', 'rb', 'dst', 'A', 'BOXES',
    'return function drive_' + name + DRIVE_HEAD + ' BOXES[0] = r + 0.5; } return r; };')(col, rb, dst, ARGS, BOXES));

const TIMED = ['BASE', 'BASE_AA', 'CAND', 'CAND_AA', 'SLOW'];
const LANES = TIMED.concat(['BOX']); // B/op lanes = timed + BOX
const baseBody = KIND === 'caller' ? BODY.callerCopy : BODY.copyTo;
const colBody = {
    BASE: baseBody, BASE_AA: baseBody, CAND: BODY.cand,
    CAND_AA: CONTROL === 'aa' ? BODY.slow : BODY.cand, SLOW: BODY.slow, BOX: BODY.cand,
};
const cols = {}, rbs = {}, dsts = {}, drives = {};
for (const nm of LANES) {
    cols[nm] = mkCol(nm, colBody[nm], new Float32Array(CAP));
    rbs[nm] = mkRing(RB_C);
    dsts[nm] = new D(N + 4);
    drives[nm] = nm === 'BOX' || (nm === 'CAND' && CONTROL === 'box')
        ? mkBoxDrive(nm, cols[nm], rbs[nm], dsts[nm])
        : mkDrive(nm, cols[nm], rbs[nm], dsts[nm]);
}
const mutCols = {
    MUT_OBO: mkCol('MUT_OBO', BODY.mutObo, null),
    MUT_OLDEST: mkCol('MUT_OLDEST', BODY.mutOldest, null),
    MUT_NEGZERO: mkCol('MUT_NEGZERO', BODY.mutNegZero, null),
};
const emptyDrive = mkDrive('EMPTY', mkCol('EMPTY', BODY.empty, null), mkRing(RB_C), new D(N + 4));
const uniqueSrc = new Set(BUILT).size === BUILT.length && BUILT.length === LANES.length * 2 + 3 + 2;

// ---- oracle -------------------------------------------------------------------------------------------
// One call of col at dstOffset 1 on a fresh full CAND oracle ring vs the last k of REF copyTo on an identical
// REF ring. k = min(n, count) = n (the ring is full).
const OA = new Int32Array(2); // oracle [n, dstOffset]
OA[0] = N; OA[1] = 1;
const refFull = new D(CAP);
const refRet = mkOracleRing(RB_R).copyTo(refFull, 0);
if (refRet !== CAP) die(1, 'ref copyTo returned ' + refRet + ' != ' + CAP);
const EXP = Array.from(refFull.subarray(CAP - N, CAP));
const expOk = Object.is(EXP[0], 1.5) && Object.is(EXP[N - 2], -0) && Number.isNaN(EXP[N - 1]);
if (!expOk) die(1, 'ref oracle ring does not hold the forced 1.5 / -0 / NaN in the newest k');
function oracle(col) {
    const t = mkOracleRing(RB_C);
    const before = Array.from(t.data);
    const d = new D(1 + N + 3);
    d.fill(GUARD);
    let r;
    try { r = col(t, d, OA); } catch { return false; }
    if (r !== N || t.head !== HEAD || t.count !== CAP || t.capacity !== CAP || t.data.length !== CAP) return false;
    if (!Object.is(d[0], GUARD)) return false;
    for (let i = 0; i < N; i++) if (!Object.is(d[1 + i], EXP[i])) return false;
    for (let i = 1 + N; i < d.length; i++) if (!Object.is(d[i], GUARD)) return false;
    for (let i = 0; i < CAP; i++) if (!Object.is(t.data[i], before[i])) return false;
    return true;
}
const oracleAll = () => Object.fromEntries(TIMED.map((nm) => [nm, oracle(cols[nm])]));
const checks = {
    tfCalib, uniqueSrc,
    oracle: oracleAll(),
    mutObo: { before: !oracle(mutCols.MUT_OBO) },
    mutOldest: { before: !oracle(mutCols.MUT_OLDEST) },
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
// warm-up first (D12 (2): reps sized from warmed code, not the first cold calls)
const WARM_CALLS = 20000;
// a throwing timed column (a broken cand) exits 1 with its name; an uncaught throw later also exits 1
for (const nm of LANES) {
    try { drives[nm](1); } catch (e) { die(1, 'timed column ' + nm + ' threw: ' + (e && e.name) + ' ' + (e && e.message)); }
}
for (let i = 0; i < 5; i++) for (const nm of LANES) drives[nm](200);
for (const nm of LANES) drives[nm](WARM_CALLS);
const nsCal = Math.max(timeNs(drives.CAND, WARM_CALLS), timeNs(drives.BASE, WARM_CALLS));
if (!(nsCal > 0)) die(1, 'calibration time ' + nsCal);
// reps target ~1 ms per sample on the slower of CAND / BASE
const reps = Math.max(1, Math.min(1000000, Math.round(1e6 / nsCal)));
const warmReps = Math.max(1, Math.round(reps * 4));
for (let pass = 0; pass < 10; pass++) {
    for (const nm of LANES) drives[nm](warmReps);
    if (pass >= 4 && LANES.every((nm) => (optStatus(drives[nm]) & TURBOFANNED) !== 0)) break;
}
const optAfterWarm = Object.fromEntries(LANES.map((nm) => [nm, optStatus(drives[nm])]));

// ---- B/op lane (D6 v4) --------------------------------------------------------------------------------
const W = 6;
const NB_MIN = 100000;
const alloc = () => v8.getHeapStatistics().total_allocated_bytes;
const nb = Math.max(NB_MIN, reps * 20);
// drivers wrap r with | 0; the assertion keeps every per-window sum inside the Smi range anyway
if (!(nb * N < 1073741824) || !(warmReps * N < 1073741824)) die(1, 'nb ' + nb + ' x n ' + N + ' would leave the Smi range');
for (let i = 0; i < 3; i++) emptyDrive(nb);
const emptyNs = timeNs(emptyDrive, nb);
if (!(emptyNs > 0)) die(1, 'empty-driver time ' + emptyNs);
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
const methodOpt = { cand_copyLast: optStatus(RB_C.prototype.copyLast), cand_copyTo: optStatus(RB_C.prototype.copyTo) };
checks.oracleAfter = oracleAll();
checks.mutObo.after = !oracle(mutCols.MUT_OBO);
checks.mutOldest.after = !oracle(mutCols.MUT_OLDEST);
checks.mutNegZero.after = !oracle(mutCols.MUT_NEGZERO);
// the 5 timed drivers and BOX (its B/op is gated) must be TurboFan after warmup and at the end
checks.turbofan = LANES.every((nm) => (optAfterWarm[nm] & TURBOFANNED) !== 0 && (optAtEnd[nm] & TURBOFANNED) !== 0);

process.stdout.write(JSON.stringify({
    kind: KIND, cap: CAP, head: HEAD, n: N, dst: dstKind, off: OFF, K, reps, nb, W, control: CONTROL,
    sha8: { ref: SR.s8, cand: SC.s8 },
    node: process.version, v8: process.versions.v8,
    host: process.env.QUIET_LOCK_HOST || 'unlocked', hostWhy: process.env.QUIET_LOCK_WHY || '',
    load: [load0, load1], checks, bop, optAfterWarm, optAtEnd, methodOpt, copyToSrcSame, rounds, sink: sink[0] !== 0,
}) + '\n');
