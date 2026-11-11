// copyto-probe.mjs -- ONE (n, dst type, layout) config x ONE compilation of the copyTo A/B bench.
// Spawned by test/bench/copyto-ab.mjs (never run by `npm test` / `npm run verify`); prints one JSON line.
// Port of the R1 research harness v4 (.handoff/research/r1/probe-copyto.mjs) to the REAL modules.
//
//   node --allow-natives-syntax --expose-gc test/bench/copyto-probe.mjs
//        --before FILE --before-sha8 HEX --after FILE --after-sha8 HEX
//        --n N --dst f32|f64 --layout contig|wrap|part [--K 21] [--no-fast] [--control box|view]
//
// FILE is a staged RingBuffer.mjs (two different paths -> two module instances, even for identical bytes).
// Ring (both classes, identical state): capacity n; contig = full, head 0; wrap = full, head n/2;
// part = count n-1, head n/2 (start n/2+1).
// Timed columns (each its own col_* wrapper and drive_* driver, unique source text so V8's eval cache
// never shares feedback between columns; driver body only `r += col(rb, dst, 0)`):
//   BEFORE   before-class rb.copyTo
//   CAND     after-class rb.copyTo
//   CAND_AA  after-class rb.copyTo through a second driver and a second rb of the same class (A/A)
//   FAST     after-class rb.copyToFast (absent -> exit 2 unless --no-fast)
//   SLOW     must-fail control: CAND twice per rep
// B/op-only controls: VIEW = the v4 SET kernel on rb.data (one or two subarray views per call, 104 / 208 B);
// BOX = CAND plus `BOXES[0] = r + 0.5` into a PACKED_ELEMENTS array (one 16 B HeapNumber per call).
// --control box builds CAND's driver as the BOX driver; --control view builds VIEW's driver as a
// non-allocating CAND driver. Picked at build time, never a branch inside a driver.
// B/op (v4 method): v8 total_allocated_bytes; per lane (min over windows 1..W-1 of the lane delta - min of
// its own time-matched empty-driver delta) / nb, nb >= 200,000 calls, gc() around every window, windows
// interleaved across lanes with the lane order rotated per window.
// Oracle before timing: CAND, CAND_AA, FAST, SLOW vs BEFORE's copyTo at the timed layout and over the D7
// sweep (every head x counts x capacities 8, 64, min(n, 1024)), dstOffset 0 and 1, guard slots on both
// sides, return value checked, Object.is per slot. Wrapper mutants: MUT_OBO (last slot off by one) and
// MUT_D7 (perturbs only when start > cap/2: passes contig + wrap timed oracle, caught by the sweep).
// TurboFan: bit 32 calibrated on a trivial function first (unset -> checks.tfCalib false); every driver
// must be TurboFan after warmup and at the end; the methods' own status is reported only.
// Exit 0 = ran (checks recorded; the driver judges them); 1 = harness precondition failed;
// 2 = usage error or copyToFast missing without --no-fast.
// Test tooling only: not shipped.
import v8 from 'node:v8';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const die = (code, m) => { process.stderr.write('copyto-probe: ' + m + '\n'); process.exit(code); };

// ---- options (strict) ---------------------------------------------------------------------------------
const VALUE_OPTS = ['--before', '--before-sha8', '--after', '--after-sha8', '--n', '--dst', '--layout', '--K', '--control'];
const FLAG_OPTS = ['--no-fast'];
const opt = Object.create(null);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!VALUE_OPTS.includes(a) && !FLAG_OPTS.includes(a)) die(2, 'unknown argument ' + JSON.stringify(a));
    if (a in opt) die(2, a + ' given twice');
    if (FLAG_OPTS.includes(a)) { opt[a] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) die(2, a + ' needs a value');
    opt[a] = v;
    i++;
}
for (const k of ['--before', '--before-sha8', '--after', '--after-sha8', '--n', '--dst', '--layout']) {
    if (!(k in opt)) die(2, k + ' is required');
}
const n = Number(opt['--n']);
const dstKind = opt['--dst'];
const layout = opt['--layout'];
const K = Number(opt['--K'] ?? '21');
const NO_FAST = opt['--no-fast'] === true;
const CONTROL = opt['--control'] ?? '';
if (!/^[0-9]+$/.test(opt['--n']) || !(n >= 32 && n <= 4096) || (n & (n - 1)) !== 0) die(2, '--n must be a power of two in 32..4096');
if (dstKind !== 'f32' && dstKind !== 'f64') die(2, '--dst f32|f64');
if (layout !== 'contig' && layout !== 'wrap' && layout !== 'part') die(2, '--layout contig|wrap|part');
if (!/^[0-9]+$/.test(opt['--K'] ?? '21') || !(K >= 5 && K <= 1001)) die(2, '--K must be an integer 5..1001');
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'view') die(2, '--control box|view');

// ---- preconditions (fail closed) ----------------------------------------------------------------------
let optStatus;
try { optStatus = new Function('f', 'return %GetOptimizationStatus(f);'); } catch { die(1, 'needs --allow-natives-syntax'); }
if (typeof globalThis.gc !== 'function') die(1, 'needs --expose-gc');
const hs0 = v8.getHeapStatistics();
if (!('total_allocated_bytes' in hs0) || !Number.isFinite(hs0.total_allocated_bytes)) die(1, 'v8 total_allocated_bytes missing or not finite');
const TURBOFANNED = 32; // V8 14.6: bit 5; calibrated below, never trusted blind
const calib = new Function('return function calibTrivial(x) { return (x + 1) | 0; };')();
new Function('f', '%PrepareFunctionForOptimization(f); f(1); f(2); %OptimizeFunctionOnNextCall(f); f(3);')(calib);
const tfCalib = (optStatus(calib) & TURBOFANNED) !== 0;

function loadSide(key) {
    const p = opt['--' + key];
    let st;
    try { st = statSync(p); } catch { die(1, '--' + key + ' not found: ' + p); }
    if (!st.isFile()) die(1, '--' + key + ' is not a file: ' + p);
    const s8 = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);
    if (s8 !== opt['--' + key + '-sha8']) die(1, '--' + key + ' sha256/8 ' + s8 + ' != expected ' + opt['--' + key + '-sha8']);
    return { p, s8 };
}
const SB = loadSide('before');
const SA = loadSide('after');
if (SB.p === SA.p) die(1, 'before and after must be two staged paths (two module instances)');
const RB_B = (await import(pathToFileURL(SB.p).href)).RingBuffer;
const RB_A = (await import(pathToFileURL(SA.p).href)).RingBuffer;
if (typeof RB_B !== 'function' || typeof RB_A !== 'function') die(1, 'RingBuffer export missing');
if (RB_B === RB_A) die(1, 'before and after resolved to one module instance');
if (typeof RB_A.prototype.copyToFast !== 'function' && !NO_FAST) die(2, 'after side has no copyToFast (pass --no-fast)');
const HAS_FAST = !NO_FAST;

const TA_LENGTH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get;
const Dst = dstKind === 'f32' ? Float32Array : Float64Array;

// ---- rings: identical state on both classes -----------------------------------------------------------
const SENT = 12345.5;
function fillTimed(rb) {
    if (rb.capacity !== n) die(1, 'capacity ' + rb.capacity + ' != ' + n);
    const total = layout === 'contig' ? n : n + n / 2;
    for (let i = 0; i < total; i++) {
        let v = (i * 0.37) - 100.125;
        const j = i - (total - n);
        if (j === 3) v = NaN; else if (j === 5) v = -0; else if (j === 7) v = Infinity; else if (j === 11) v = -Infinity;
        rb.push(v);
    }
    if (layout === 'part') rb.count = n - 1;
    const wantHead = layout === 'contig' ? 0 : n / 2;
    const wantCount = layout === 'part' ? n - 1 : n;
    if (rb.head !== wantHead || rb.count !== wantCount) die(1, 'ring setup head ' + rb.head + ' count ' + rb.count);
    return rb;
}
const rbB = fillTimed(new RB_B(n));
const rbA = fillTimed(new RB_A(n));
const rbA2 = fillTimed(new RB_A(n));
const C = rbA.count;

// ---- columns ------------------------------------------------------------------------------------------
// Each wrapper / driver has unique source text (its name), so no two share an eval-cache entry.
const mkCol = (name, body) => new Function('TA_LENGTH', 'return function col_' + name + '(rb, dst, o) {\n' + body + '\n};')(TA_LENGTH);
const BODY = {
    copyTo: 'return rb.copyTo(dst, o);',
    copyToFast: 'return rb.copyToFast(dst, o);',
    slow: 'rb.copyTo(dst, o);\nreturn rb.copyTo(dst, o);',
    view: `const c = rb.count;
const data = rb.data;
const start = (rb.head - c) & rb.mask;
const firstLen = Math.min(rb.capacity - start, c);
dst.set(data.subarray(start, start + firstLen), o);
if (firstLen < c) dst.set(data.subarray(0, c - firstLen), o + firstLen);
return c;`,
    empty: 'return rb.count;',
    // wrapper mutants (oracle teeth only, never timed)
    mutObo: 'const r = rb.copyTo(dst, o);\ndst[o + r - 1] = dst[o + r - 2];\nreturn r;',
    mutD7: 'const r = rb.copyTo(dst, o);\nconst start = (rb.head - rb.count) & rb.mask;\nif (start > rb.capacity / 2) dst[o] = dst[o + r - 1];\nreturn r;',
};
const mkDrive = (name, col, rb, dst) => new Function('col', 'rb', 'dst',
    'return function drive_' + name + '(reps) { let r = 0; for (let k = 0; k < reps; k++) r += col(rb, dst, 0); return r; };')(col, rb, dst);
const BOXES = [null]; // PACKED_ELEMENTS: a fractional double stored here is a fresh HeapNumber
const mkBoxDrive = (name, col, rb, dst) => new Function('col', 'rb', 'dst', 'BOXES',
    'return function drive_' + name + '(reps) { let r = 0; for (let k = 0; k < reps; k++) { r += col(rb, dst, 0); BOXES[0] = r + 0.5; } return r; };')(col, rb, dst, BOXES);

const cols = {
    BEFORE: { col: mkCol('BEFORE', BODY.copyTo), rb: rbB, side: 'B' },
    CAND: { col: mkCol('CAND', BODY.copyTo), rb: rbA, side: 'A' },
    CAND_AA: { col: mkCol('CAND_AA', BODY.copyTo), rb: rbA2, side: 'A' },
};
if (HAS_FAST) cols.FAST = { col: mkCol('FAST', BODY.copyToFast), rb: rbA, side: 'A' };
cols.SLOW = { col: mkCol('SLOW', BODY.slow), rb: rbA, side: 'A' };
const TIMED = Object.keys(cols);
const ORACLED = TIMED.filter((k) => k !== 'BEFORE');
cols.VIEW = { col: mkCol('VIEW', BODY.view), rb: rbA, side: 'A' };
cols.BOX = { col: mkCol('BOX', BODY.copyTo), rb: rbA, side: 'A' };
const LANES = Object.keys(cols); // B/op lanes = timed + VIEW + BOX

const drives = {};
for (const nm of LANES) {
    const d = new Dst(n + 1);
    if (nm === 'BOX' || (nm === 'CAND' && CONTROL === 'box')) drives[nm] = mkBoxDrive(nm, cols[nm].col, cols[nm].rb, d);
    else if (nm === 'VIEW' && CONTROL === 'view') drives[nm] = mkDrive(nm, mkCol('VIEW_CTL', BODY.copyTo), rbA, d);
    else drives[nm] = mkDrive(nm, cols[nm].col, cols[nm].rb, d);
}

// ---- oracle (before any timing) -----------------------------------------------------------------------
// One state compare: before rb.copyTo vs col on the after-class (or before-class) ring, offset o, one
// guard slot on each side.
function same(col, colRb, refRb, cnt, o) {
    const ref = new Dst(cnt + 2).fill(SENT);
    const d = new Dst(cnt + 2).fill(SENT);
    const rr = refRb.copyTo(ref, o);
    const r = col(colRb, d, o);
    if (rr !== cnt || r !== cnt) return false;
    if (!Object.is(d[0], SENT) && o === 1) return false;
    if (!Object.is(d[o + cnt], SENT)) return false;
    for (let i = 0; i < cnt + 2; i++) if (!Object.is(d[i], ref[i])) return false;
    return true;
}
function timedOracle(colRec) {
    return same(colRec.col, colRec.side === 'B' ? rbB : rbA, rbB, C, 0) && same(colRec.col, colRec.side === 'B' ? rbB : rbA, rbB, C, 1);
}
// D7 sweep: every head x counts {cap, cap-1, cap/2+1, 33, 1} on capacities 8, 64, min(n, 1024).
function sweep(colRec) {
    for (const cap of [...new Set([8, 64, Math.min(n, 1024)])]) {
        const b = new RB_B(cap), a = new RB_A(cap);
        if (b.capacity !== cap || a.capacity !== cap) return false;
        for (let i = 0; i < cap; i++) { const v = i === 2 ? NaN : i === 4 ? -0 : (i * 1.25) - 7.5; b.data[i] = v; a.data[i] = v; }
        for (const cnt of [...new Set([cap, cap - 1, (cap >> 1) + 1, 33, 1])]) {
            if (cnt < 1 || cnt > cap) continue;
            for (let h = 0; h < cap; h++) {
                b.head = h; b.count = cnt; a.head = h; a.count = cnt;
                const colRb = colRec.side === 'B' ? b : a;
                if (!same(colRec.col, colRb, b, cnt, 0) || !same(colRec.col, colRb, b, cnt, 1)) return false;
            }
        }
    }
    return true;
}
const mutObo = { col: mkCol('MUT_OBO', BODY.mutObo), side: 'A' };
const mutD7 = { col: mkCol('MUT_D7', BODY.mutD7), side: 'A' };
const checks = {
    tfCalib,
    oracle: {}, sweep: {},
    mutObo: { timedCaught: !timedOracle(mutObo), sweepCaught: !sweep(mutObo) },
    mutD7: { timedCaught: !timedOracle(mutD7), sweepCaught: !sweep(mutD7) },
};
for (const nm of ORACLED) { checks.oracle[nm] = timedOracle(cols[nm]); checks.sweep[nm] = sweep(cols[nm]); }
// the sweep moved no timed ring: re-verify the timed state
if (rbA.head !== (layout === 'contig' ? 0 : n / 2) || rbA.count !== C || rbB.count !== C) die(1, 'timed ring state moved');

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
const nsCand = timeNs(drives.CAND, 2000);
if (!(nsCand > 0)) die(1, 'calibration time ' + nsCand);
const reps = Math.max(1, Math.min(1000000, Math.round(1e6 / nsCand))); // ~1 ms per CAND sample
const warmReps = Math.max(1, Math.round(reps * 4));
for (let pass = 0; pass < 10; pass++) {
    for (const nm of LANES) drives[nm](warmReps);
    if (pass >= 4 && LANES.every((nm) => (optStatus(drives[nm]) & TURBOFANNED) !== 0)) break;
}
const optAfterWarm = Object.fromEntries(LANES.map((nm) => [nm, optStatus(drives[nm])]));

// ---- B/op lane (v4) -----------------------------------------------------------------------------------
const W = 6;
const NB_MIN = 200000;
const alloc = () => v8.getHeapStatistics().total_allocated_bytes;
const emptyDrive = new Function('col', 'rb', 'dst',
    'return function drive_EMPTY(reps) { let r = 0; for (let k = 0; k < reps; k++) r = (r + col(rb, dst, 0)) | 0; return r; };')(mkCol('EMPTY', BODY.empty), rbA, new Dst(n + 1));
const nb = Math.max(NB_MIN, reps * 20);
// lane drivers accumulate r += c without a wrap: keep every sum (SLOW returns c, not 2c) below 2^30
if (!(nb * n < 1073741824) || !(reps * n < 1073741824)) die(1, 'nb ' + nb + ' x n ' + n + ' would leave the Smi range');
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
const methodOpt = { before_copyTo: optStatus(RB_B.prototype.copyTo), after_copyTo: optStatus(RB_A.prototype.copyTo) };
if (HAS_FAST) methodOpt.after_copyToFast = optStatus(RB_A.prototype.copyToFast);
checks.oracleAfter = ORACLED.every((nm) => timedOracle(cols[nm]));
// timed drivers must be TurboFan; the B/op-only drivers too (their B/op is gated)
checks.turbofan = LANES.every((nm) => (optAfterWarm[nm] & TURBOFANNED) !== 0 && (optAtEnd[nm] & TURBOFANNED) !== 0);

process.stdout.write(JSON.stringify({
    n, dst: dstKind, layout, K, reps, nb, W, fast: HAS_FAST, control: CONTROL,
    sha8: { before: SB.s8, after: SA.s8 },
    node: process.version, v8: process.versions.v8,
    host: process.env.QUIET_LOCK_HOST || 'unlocked', hostWhy: process.env.QUIET_LOCK_WHY || '',
    load: [load0, load1], checks, bop, optAfterWarm, optAtEnd, methodOpt, rounds, sink: sink[0] > 0,
}) + '\n');
