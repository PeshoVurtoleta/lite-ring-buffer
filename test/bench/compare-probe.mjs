// compare-probe.mjs -- ONE row x ONE compilation of the public comparison bench (B1).
// Spawned by test/bench/compare.mjs (never run by `npm test` / `npm run verify`); prints one JSON line.
// Machinery copied from test/bench/copyto-probe.mjs (strict options, TurboFan calibration, v4 B/op lane,
// K interleaved rounds with rotation); nothing is imported from another bench file.
//
//   node --allow-natives-syntax --expose-gc test/bench/compare-probe.mjs
//        --rb FILE --rb-sha8 HEX --o1 FILE --o1-sha8 HEX
//        --row push|get|copyto32|copyto1024|wrap-step|wrap-push [--K 21] [--control box|aa|slow] [--smoke]
//
// FILE --rb is a staged RingBuffer.mjs (HEAD); FILE --o1 is the installed @zakkster/lite-o1 O1.js. Each
// sha256/8 is checked here (mismatch -> exit 1).
// Every timed column is a driver `drive_<NAME>(ring, src, out, reps)` built by `new Function` from unique
// source text (D11 / D12: no two columns share an eval-cache entry or feedback). The ring is a driver
// PARAMETER, never a closure constant, so V8 cannot fold mask / capacity into the code (D17). The workload
// stores: pushes write the ring, reads and copies write `out`.
// Rows (REF = the reference column; *_AA its twin on a second ring; SLOW = REF's body twice per rep;
// BOX = REF's body plus `BOXES[0] = k + 0.5`, a 16 B HeapNumber per rep, B/op lane only):
//   push n1024      RB = rb.push(v) | RB_AA | F32H, ARR (one template: plain-object ring over a Float32Array /
//                   `new Array(cap).fill(0.5)`, & mask) | DEQ (emulated keep-last-N on lite-o1 RingDeque:
//                   `if (size === capacity) popFront(); pushBack(v)`) | SLOW
//   get n1024       GOD = getOrDefault(i, 0) (REF) | GOD_AA | GET = get(i) | F32H, ARR | SLOW
//                   (RingDeque has no indexed read: N/A)
//   copyto32/1024   full ring, head n/2, Float32 dst: RB = copyTo(dst, 0) | RB_AA | F32H, ARR masked loop |
//                   DEQ (emulated: forEach with a hoisted store callback) | SLOW
//   wrap-step n1024 `h = (h + 1) & m` (MASK, REF) vs `% c` (MOD, pow2 runtime capacity; MOD_NP2, capacity
//                   n - 1), then `out[k & 7] = h` | MASK_AA | SLOW
//   wrap-push n1024 a hand-rolled Float32Array ring push, the same MASK / MOD / MOD_NP2 split
// checks.uniqueSrc: every driver source distinct. checks.sameTpl (push, get, copyto): ARR source == F32H
// source with only the name replaced. checks.wrapOnly (wrap rows): MOD source == MASK source with only the
// wrap expression (and the name) replaced, MOD_NP2 == MOD with only the name replaced.
// Push values come from a Float64Array of float32-exact non-NaN values incl. -0, +Infinity, -Infinity.
// Oracle before AND after timing: every timed column vs a keep-last-N model built from the TRUE definition
// (Math.fround, Object.is), on fresh rings. Mutants (never timed): MUT_WRAP (& (mask >> 1)), MUT_OBO
// (off by one), and on the get row MUT_GET (offset + 1); each must be caught by the oracle.
// --control box: REF's driver is built as the BOX driver; aa: REF_AA's body runs twice per rep; slow: SLOW's
// body runs once. Picked at build time, never a branch inside a driver.
// --smoke: reps capped at 1e5 (default cap 1e6).
// B/op (v4 method): v8 total_allocated_bytes; per lane (min over windows 1..W-1 of the lane delta - min of
// its own time-matched empty-driver delta) / nb, nb >= 200,000 calls, gc() around every window, windows
// interleaved across lanes with the lane order rotated per window. Window 0 is never used.
// TurboFan: bit 32 calibrated on a trivial function first; every driver must be TurboFan after warm-up and
// at the end. The library methods' own optimization status is REPORTED only (D13).
// Exit 0 = ran (checks recorded; the driver judges them); 1 = harness precondition failed; 2 = usage error.
// Test tooling only: not shipped.
import v8 from 'node:v8';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const die = (code, m) => { process.stderr.write('compare-probe: ' + m + '\n'); process.exit(code); };

// ---- options (strict) ---------------------------------------------------------------------------------
const VALUE_OPTS = ['--rb', '--rb-sha8', '--o1', '--o1-sha8', '--row', '--K', '--control'];
const FLAG_OPTS = ['--smoke'];
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
for (const k of ['--rb', '--rb-sha8', '--o1', '--o1-sha8', '--row']) if (!(k in opt)) die(2, k + ' is required');
const ROW_NAMES = ['push', 'get', 'copyto32', 'copyto1024', 'wrap-step', 'wrap-push'];
const ROW = opt['--row'];
if (!ROW_NAMES.includes(ROW)) die(2, '--row ' + ROW_NAMES.join('|'));
const K = Number(opt['--K'] ?? '21');
if (!/^[0-9]+$/.test(opt['--K'] ?? '21') || !(K >= 5 && K <= 1001)) die(2, '--K must be an integer 5..1001');
const CONTROL = opt['--control'] ?? '';
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'aa' && CONTROL !== 'slow') die(2, '--control box|aa|slow');
const SMOKE = opt['--smoke'] === true;
const REPS_CAP = SMOKE ? 100000 : 1000000;

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

function loadFile(key) {
    const p = opt['--' + key];
    let st;
    try { st = statSync(p); } catch { die(1, '--' + key + ' not found: ' + p); }
    if (!st.isFile()) die(1, '--' + key + ' is not a file: ' + p);
    const s8 = createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);
    if (s8 !== opt['--' + key + '-sha8']) die(1, '--' + key + ' sha256/8 ' + s8 + ' != expected ' + opt['--' + key + '-sha8']);
    return { p, s8 };
}
const FRB = loadFile('rb');
const FO1 = loadFile('o1');
const RingBuffer = (await import(pathToFileURL(FRB.p).href)).RingBuffer;
const RingDeque = (await import(pathToFileURL(FO1.p).href)).RingDeque;
if (typeof RingBuffer !== 'function') die(1, 'RingBuffer export missing');
if (typeof RingDeque !== 'function') die(1, 'RingDeque export missing');

// ---- values: float32-exact, never NaN; -0, +Infinity, -Infinity every 16 ---------------------------------
const SRC = new Float64Array(1024);
for (let i = 0; i < 1024; i++) {
    const r = i & 15;
    SRC[i] = r === 5 ? -0 : r === 7 ? Infinity : r === 11 ? -Infinity : ((i * 37) % 1000) * 0.25 - 100.125;
    if (!(SRC[i] === SRC[i]) || !Object.is(Math.fround(SRC[i]), SRC[i])) die(1, 'SRC[' + i + '] not float32-exact');
}
const SENT = 12345.5;

// ---- ring kinds: factory, cold fill (keep-last-N push), oldest-first reader ---------------------------
// Plain-object rings (F32H, ARR, wrap rows) share one shape: { data, head, count, mask, capacity }.
const mkState = (data, cap) => ({ data, head: 0, count: 0, mask: cap - 1, capacity: cap });
const KIND = {
    rb: { mk: (cap) => new RingBuffer(cap) },
    f32: { mk: (cap) => mkState(new Float32Array(cap), cap) },
    arr: { mk: (cap) => mkState(new Array(cap).fill(0.5), cap) },
    deq: { mk: (cap) => new RingDeque(cap) },
};
function fill(kind, ring, p) {
    for (let i = 0; i < p; i++) {
        const v = SRC[i & 1023];
        if (kind === 'rb') ring.push(v);
        else if (kind === 'deq') { if (ring.size === ring.capacity) ring.popFront(); ring.pushBack(v); }
        else {
            ring.data[ring.head] = v;
            ring.head = (ring.head + 1) % ring.capacity;
            if (ring.count < ring.capacity) ring.count++;
        }
    }
}
function readOldest(kind, ring) {
    const outA = [];
    if (kind === 'deq') { ring.forEach((v) => { outA.push(v); }); return outA; }
    const cap = ring.capacity;
    for (let i = 0; i < ring.count; i++) outA.push(ring.data[(((ring.head - ring.count + i) % cap) + cap) % cap]);
    return outA;
}

// ---- driver sources -----------------------------------------------------------------------------------
const PRE_T = 'const m = ring.mask;\nconst c = ring.capacity;';
const W_MASK = (x) => '(' + x + ' + 1) & m';
const W_MOD = (x) => '(' + x + ' + 1) % c';
const W_MUT = (x) => '(' + x + ' + 1) & (m >> 1)';
const W_OBO = (x) => '(' + x + ' + 1) % m';
const T = {
    // push: one template for F32H / ARR / wrap-push MASK / MOD (only the wrap expression varies)
    push: (w) => 'ring.data[ring.head] = src[k & 1023];\nring.head = ' + w('ring.head') + ';\nif (ring.count < c) ring.count++;',
    step: (w) => 'h = ' + w('h') + ';\nout[k & 7] = h;',
    getIdx: (ix) => 'out[k & 7] = ring.data[' + ix + '];',
    copy: (w) => 'const cnt = ring.count;\nconst d = ring.data;\nconst s = (ring.head - cnt) & m;\nfor (let i = 0; i < cnt; i++) out[i] = d[' + w('s', 'i') + '];',
};
const IX_GET = '(ring.head - 1 - (k & 1023)) & m';
const IX_GET_MUT = '(ring.head - 1 - (k & 1023)) & (m >> 1)';
const IX_GET_OBO = '(ring.head - (k & 1023)) & m';
const CP_MASK = (s, i) => '(' + s + ' + ' + i + ') & m';
const CP_MUT = (s, i) => '(' + s + ' + ' + i + ') & (m >> 1)';
const BODY = {
    rbPush: 'ring.push(src[k & 1023]);',
    deqPush: 'if (ring.size === ring.capacity) ring.popFront();\nring.pushBack(src[k & 1023]);',
    god: 'out[k & 7] = ring.getOrDefault(k & 1023, 0);',
    godMut: 'out[k & 7] = ring.getOrDefault((k & 1023) + 1, 0);',
    get: 'out[k & 7] = ring.get(k & 1023);',
    rbCopy: 'ring.copyTo(out, 0);',
    rbCopyObo: 'ring.copyTo(out, 0);\nout[ring.count - 1] = out[ring.count - 2];',
    deqCopy: 'ring.forEach(CB);',
};
const BOX_LINE = 'BOXES[0] = k + 0.5;';
const POST_PLAIN = 'return reps;';
const PRE_STEP = PRE_T + '\nlet h = ring.head;';
const POST_STEP = 'ring.head = h;\nreturn h;';
function drvSrc(name, pre, body, post) {
    return 'return function drive_' + name + '(ring, src, out, reps) {\n' + (pre ? pre + '\n' : '') +
        'for (let k = 0; k < reps; k++) {\n' + body + '\n}\n' + post + '\n};';
}
const BOXES = [null]; // PACKED_ELEMENTS: a fractional double stored here is a fresh HeapNumber

// ---- row specs ----------------------------------------------------------------------------------------
// col: { kind, cap, pre, body, post, times (1 or 2: model multiplicity), out: 'o8' | 'dst' }
const n = ROW === 'copyto32' ? 32 : 1024;
const ROWDEF = {
    push: { form: 'push', ref: 'RB', aa: 'RB_AA', cols: {
        RB: { kind: 'rb', body: BODY.rbPush }, RB_AA: { kind: 'rb', body: BODY.rbPush },
        F32H: { kind: 'f32', pre: PRE_T, body: T.push(W_MASK) }, ARR: { kind: 'arr', pre: PRE_T, body: T.push(W_MASK) },
        DEQ: { kind: 'deq', body: BODY.deqPush },
    }, mutants: { MUT_WRAP: { kind: 'f32', pre: PRE_T, body: T.push(W_MUT) }, MUT_OBO: { kind: 'f32', pre: PRE_T, body: T.push(W_OBO) } } },
    get: { form: 'get', ref: 'GOD', aa: 'GOD_AA', cols: {
        GOD: { kind: 'rb', body: BODY.god }, GOD_AA: { kind: 'rb', body: BODY.god }, GET: { kind: 'rb', body: BODY.get },
        F32H: { kind: 'f32', pre: PRE_T, body: T.getIdx(IX_GET) }, ARR: { kind: 'arr', pre: PRE_T, body: T.getIdx(IX_GET) },
    }, mutants: {
        MUT_WRAP: { kind: 'f32', pre: PRE_T, body: T.getIdx(IX_GET_MUT) }, MUT_GET: { kind: 'rb', body: BODY.godMut },
        MUT_OBO: { kind: 'f32', pre: PRE_T, body: T.getIdx(IX_GET_OBO) },
    } },
    copy: { form: 'copy', ref: 'RB', aa: 'RB_AA', cols: {
        RB: { kind: 'rb', body: BODY.rbCopy }, RB_AA: { kind: 'rb', body: BODY.rbCopy },
        F32H: { kind: 'f32', pre: PRE_T, body: T.copy(CP_MASK) }, ARR: { kind: 'arr', pre: PRE_T, body: T.copy(CP_MASK) },
        DEQ: { kind: 'deq', body: BODY.deqCopy },
    }, mutants: { MUT_WRAP: { kind: 'f32', pre: PRE_T, body: T.copy(CP_MUT) }, MUT_OBO: { kind: 'rb', body: BODY.rbCopyObo } } },
    'wrap-step': { form: 'step', ref: 'MASK', aa: 'MASK_AA', cols: {
        MASK: { kind: 'f32', pre: PRE_STEP, post: POST_STEP, body: T.step(W_MASK) },
        MASK_AA: { kind: 'f32', pre: PRE_STEP, post: POST_STEP, body: T.step(W_MASK) },
        MOD: { kind: 'f32', pre: PRE_STEP, post: POST_STEP, body: T.step(W_MOD) },
        MOD_NP2: { kind: 'f32', cap: n - 1, pre: PRE_STEP, post: POST_STEP, body: T.step(W_MOD) },
    }, mutants: {
        MUT_WRAP: { kind: 'f32', pre: PRE_STEP, post: POST_STEP, body: T.step(W_MUT) },
        MUT_OBO: { kind: 'f32', pre: PRE_STEP, post: POST_STEP, body: T.step(W_OBO) },
    } },
    'wrap-push': { form: 'push', ref: 'MASK', aa: 'MASK_AA', cols: {
        MASK: { kind: 'f32', pre: PRE_T, body: T.push(W_MASK) }, MASK_AA: { kind: 'f32', pre: PRE_T, body: T.push(W_MASK) },
        MOD: { kind: 'f32', pre: PRE_T, body: T.push(W_MOD) }, MOD_NP2: { kind: 'f32', cap: n - 1, pre: PRE_T, body: T.push(W_MOD) },
    }, mutants: { MUT_WRAP: { kind: 'f32', pre: PRE_T, body: T.push(W_MUT) }, MUT_OBO: { kind: 'f32', pre: PRE_T, body: T.push(W_OBO) } } },
};
const DEF = ROWDEF[ROW === 'copyto32' || ROW === 'copyto1024' ? 'copy' : ROW];
const FORM = DEF.form;
const REF = DEF.ref;
const AA = DEF.aa;

function build(name, spec, times, box) {
    const cap = spec.cap ?? n;
    const one = spec.body;
    const body = (times === 2 ? one + '\n' + one : one) + (box ? '\n' + BOX_LINE : '');
    const src = drvSrc(name, spec.pre || '', body, spec.post || POST_PLAIN);
    const out = FORM === 'copy' ? new Float32Array(n + 1) : new Float64Array(8);
    const cb = new Function('D', 'return function store_' + name + '(v, i) { D[i] = v; };')(out);
    const drv = new Function('BOXES', 'CB', src)(BOXES, cb);
    return { name, kind: spec.kind, cap, times, src, out, drv, ring: null };
}
const cols = {};
for (const [nm, spec] of Object.entries(DEF.cols)) {
    const twice = nm === AA && CONTROL === 'aa';
    cols[nm] = build(nm, spec, twice ? 2 : 1, nm === REF && CONTROL === 'box');
}
cols.SLOW = build('SLOW', DEF.cols[REF], CONTROL === 'slow' ? 1 : 2, false);
const TIMED = Object.keys(cols);
cols.BOX = build('BOX', DEF.cols[REF], 1, true);
const LANES = Object.keys(cols);
const muts = Object.fromEntries(Object.entries(DEF.mutants).map(([nm, spec]) => [nm, build(nm, spec, 1, false)]));
const EMPTY = { name: 'EMPTY', drv: new Function('BOXES', 'CB', drvSrc('EMPTY', '', 'out[k & 7] = k;', POST_PLAIN))(BOXES, null), out: new Float64Array(8), ring: null };

// ---- source checks ------------------------------------------------------------------------------------
const allSrc = Object.values(cols).map((c) => c.src).concat(Object.values(muts).map((c) => c.src), [drvSrc('EMPTY', '', 'out[k & 7] = k;', POST_PLAIN)]);
const once = (s, sub) => s.split(sub).length === 2;
const checks = { tfCalib, uniqueSrc: new Set(allSrc).size === allSrc.length };
if (FORM === 'step' || ROW === 'wrap-push') {
    const x = FORM === 'step' ? 'h' : 'ring.head';
    const sM = cols.MASK.src, sD = cols.MOD.src, sN = cols.MOD_NP2.src;
    checks.wrapOnly = once(sM, W_MASK(x)) && once(sM, 'drive_MASK(') &&
        sD === sM.replace('drive_MASK(', 'drive_MOD(').replace(W_MASK(x), W_MOD(x)) &&
        sN === sD.replace('drive_MOD(', 'drive_MOD_NP2(') && cols.MOD.cap === n && cols.MOD_NP2.cap === n - 1;
} else {
    checks.sameTpl = once(cols.F32H.src, 'drive_F32H(') && cols.ARR.src === cols.F32H.src.replace('drive_F32H(', 'drive_ARR(');
}

// ---- oracle: the TRUE keep-last-N / modulo definition, fresh rings ------------------------------------
const fr = Math.fround;
function seqOf(r, times) {
    const s = [];
    for (let k = 0; k < r; k++) for (let t = 0; t < times; t++) s.push(SRC[k & 1023]);
    return s;
}
function oracle(col) {
    const cap = col.cap;
    const mk = KIND[col.kind].mk;
    if (FORM === 'push') {
        for (const r of [1, 5, cap - 1, cap, cap + 3, 3 * cap + 7]) {
            const ring = mk(cap);
            col.drv(ring, SRC, col.out, r);
            const got = readOldest(col.kind, ring);
            const want = seqOf(r, col.times).slice(-cap);
            if (got.length !== want.length) return false;
            for (let i = 0; i < want.length; i++) if (!Object.is(got[i], fr(want[i]))) return false;
        }
        return true;
    }
    if (FORM === 'get') {
        const fillN = cap + (cap >> 1);
        const newest = seqOf(fillN, 1).slice(-cap).reverse();
        for (const r of [8, 100, 517, 1029, 2047, 2048]) {
            const ring = mk(cap);
            fill(col.kind, ring, fillN);
            col.out.fill(SENT);
            col.drv(ring, SRC, col.out, r);
            for (let k = r - 8; k < r; k++) if (!Object.is(col.out[k & 7], fr(newest[k & 1023]))) return false;
        }
        return true;
    }
    if (FORM === 'copy') {
        for (const p of [cap, cap + (cap >> 1), cap + 3, 3 * cap + 1]) {
            for (const r of [1, 2]) {
                const ring = mk(cap);
                fill(col.kind, ring, p);
                col.out.fill(SENT);
                col.drv(ring, SRC, col.out, r);
                const want = seqOf(p, 1).slice(-cap);
                for (let i = 0; i < cap; i++) if (!Object.is(col.out[i], fr(want[i]))) return false;
                if (!Object.is(col.out[cap], SENT)) return false;
            }
        }
        return true;
    }
    // step
    for (const h0 of [0, 5, cap - 1]) {
        for (const r of [1, 7, cap + 9, 3 * cap + 1]) {
            const ring = mk(cap);
            ring.head = h0;
            col.out.fill(SENT);
            col.drv(ring, SRC, col.out, r);
            const w = new Array(8).fill(SENT);
            let h = h0;
            for (let k = 0; k < r; k++) for (let t = 0; t < col.times; t++) { h = (h + 1) % cap; w[k & 7] = h; }
            if (ring.head !== h) return false;
            for (let i = 0; i < 8; i++) if (!Object.is(col.out[i], w[i])) return false;
        }
    }
    return true;
}
checks.oracle = Object.fromEntries(TIMED.map((nm) => [nm, oracle(cols[nm])]));
checks.mutants = Object.fromEntries(Object.keys(muts).map((nm) => [nm, !oracle(muts[nm])]));

// ---- timed rings: steady state (push rows full; get / copy full, head n/2; step head 0) ----------------
for (const nm of LANES) {
    const col = cols[nm];
    col.ring = KIND[col.kind].mk(col.cap);
    if (FORM !== 'step') fill(col.kind, col.ring, col.cap + (col.cap >> 1));
}
EMPTY.ring = cols[REF].ring;
if (FORM === 'copy' || FORM === 'get') {
    for (const nm of LANES) {
        const r = cols[nm].ring;
        const head = cols[nm].kind === 'deq' ? r._head : r.head;
        const cnt = cols[nm].kind === 'deq' ? r.size : r.count;
        if (cnt !== n || head !== n / 2) die(1, 'ring setup ' + nm + ' head ' + head + ' count ' + cnt);
    }
}

// ---- timing -------------------------------------------------------------------------------------------
const sink = new Float64Array(1);
const tns = new Float64Array(1);
function run(col, reps) { return col.drv(col.ring, SRC, col.out, reps); }
function timeNs(col, reps) {
    const t0 = process.hrtime.bigint();
    sink[0] += run(col, reps);
    const t1 = process.hrtime.bigint();
    tns[0] = Number(t1 - t0) / reps;
    return tns[0];
}
const isTF = (f) => (optStatus(f) & TURBOFANNED) !== 0;
// warm-up first (many short calls, so each driver tiers up as a whole function, not only through OSR),
// then size reps from WARMED code (D12), then warm again at reps
const WARM = FORM === 'copy' && n === 1024 ? 4000 : 20000;
for (let pass = 0; pass < 10; pass++) {
    for (const nm of LANES) for (let i = 0; i < 50; i++) run(cols[nm], WARM / 40);
    if (pass >= 4 && LANES.every((nm) => isTF(cols[nm].drv))) break;
}
let nsRef = Infinity;
for (let i = 0; i < 3; i++) nsRef = Math.min(nsRef, timeNs(cols[REF], WARM));
if (!(nsRef > 0)) die(1, 'calibration time ' + nsRef);
const reps = Math.max(1, Math.min(REPS_CAP, Math.round(1e6 / nsRef))); // ~1 ms per REF sample
for (let pass = 0; pass < 10; pass++) {
    for (const nm of LANES) run(cols[nm], reps);
    if (pass >= 2 && LANES.every((nm) => isTF(cols[nm].drv))) break;
}
const optAfterWarm = Object.fromEntries(LANES.map((nm) => [nm, optStatus(cols[nm].drv)]));

// ---- B/op lane (v4) -----------------------------------------------------------------------------------
const W = 6;
const NB_MIN = 200000;
const alloc = () => v8.getHeapStatistics().total_allocated_bytes;
const nb = Math.max(NB_MIN, reps * 20);
for (let i = 0; i < 3; i++) run(EMPTY, nb);
const emptyNs = timeNs(EMPTY, nb);
const nbE = Object.fromEntries(LANES.map((nm) => [nm, Math.max(nb, Math.round(nb * timeNs(cols[nm], reps) / emptyNs))]));
const bestL = Object.fromEntries(LANES.map((nm) => [nm, Infinity]));
const bestE = Object.fromEntries(LANES.map((nm) => [nm, Infinity]));
const win0 = {};
for (let w = 0; w < W; w++) {
    for (let j = 0; j < LANES.length; j++) {
        const nm = LANES[(j + w) % LANES.length];
        gc();
        const a0 = alloc(); sink[0] += run(EMPTY, nbE[nm]); gc(); const a1 = alloc();
        gc();
        const b0 = alloc(); sink[0] += run(cols[nm], nb); gc(); const b1 = alloc();
        if (w > 0) { bestE[nm] = Math.min(bestE[nm], a1 - a0); bestL[nm] = Math.min(bestL[nm], b1 - b0); }
        else win0[nm] = (b1 - b0 - (a1 - a0)) / nb;
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
        row[nm] = timeNs(cols[nm], reps);
    }
    rounds.push(row);
}
const load1 = os.loadavg()[0];
const optAtEnd = Object.fromEntries(LANES.map((nm) => [nm, optStatus(cols[nm].drv)]));
const methodOpt = {};
if (FORM === 'push' && ROW === 'push') {
    methodOpt.rb_push = optStatus(RingBuffer.prototype.push);
    methodOpt.deq_pushBack = optStatus(RingDeque.prototype.pushBack);
    methodOpt.deq_popFront = optStatus(RingDeque.prototype.popFront);
} else if (FORM === 'get') {
    methodOpt.rb_getOrDefault = optStatus(RingBuffer.prototype.getOrDefault);
    methodOpt.rb_get = optStatus(RingBuffer.prototype.get);
} else if (FORM === 'copy') {
    methodOpt.rb_copyTo = optStatus(RingBuffer.prototype.copyTo);
    methodOpt.deq_forEach = optStatus(RingDeque.prototype.forEach);
}
checks.oracleAfter = Object.fromEntries(TIMED.map((nm) => [nm, oracle(cols[nm])]));
checks.turbofan = LANES.every((nm) => (optAfterWarm[nm] & TURBOFANNED) !== 0 && (optAtEnd[nm] & TURBOFANNED) !== 0);

process.stdout.write(JSON.stringify({
    row: ROW, n, K, reps, nb, W, control: CONTROL, smoke: SMOKE, ref: REF, aa: AA, cols: TIMED, lanes: LANES,
    sha8: { rb: FRB.s8, o1: FO1.s8 },
    node: process.version, v8: process.versions.v8,
    host: process.env.QUIET_LOCK_HOST || 'unlocked', hostWhy: process.env.QUIET_LOCK_WHY || '',
    load: [load0, load1], checks, bop, bopWindow0: win0, optAfterWarm, optAtEnd, methodOpt, rounds, sink: sink[0] > 0,
}) + '\n');
