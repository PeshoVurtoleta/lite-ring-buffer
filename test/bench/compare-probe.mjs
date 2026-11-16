// compare-probe.mjs -- ONE row x ONE compilation of the public comparison bench (B1).
// Spawned by test/bench/compare.mjs (never run by `npm test` / `npm run verify`); prints one JSON line.
// Machinery copied from test/bench/copyto-probe.mjs (strict options, TurboFan calibration, v4 B/op lane,
// K interleaved rounds with rotation); nothing is imported from another bench file except the mnemonist
// pin (test/bench/mn-pin.mjs, Q2 SPEC A1).
//
//   node --allow-natives-syntax --expose-gc test/bench/compare-probe.mjs
//        --rb FILE --rb-sha8 HEX --o1 FILE --o1-sha8 HEX --mn FILE --mn-sha8 HEX
//        --row push|get|copyto32|copyto1024|wrap-step|wrap-push [--K 21] [--control box|aa|slow] [--smoke]
//        [--dump-src]
//
// FILE --rb is a staged RingBuffer.mjs (HEAD); FILE --o1 is the installed @zakkster/lite-o1 O1.js. Each
// sha256/8 is checked here (mismatch -> exit 1). FILE --mn is the ABSOLUTE path of
// <root>/node_modules/mnemonist/circular-buffer.js; before anything is required, mnCheck(<root>/node_modules)
// must pass (exact 0.40.8, obliterator 2.0.5, combined digest === MN_SHA256) and --mn-sha8 must equal
// MN_SHA256.slice(0, 8), else exit 1. It is required through createRequire (SPEC A8: the subpath has a
// `require`-only exports condition); afterwards every require.cache entry under mnemonist/ or obliterator/
// must be exactly the MN_FILES set at <root>/node_modules (realpath), else exit 1.
// --dump-src: print {name: driver source} for every column + mutant as JSON and exit 0 before the oracle.
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
//   New columns (Q2 group A; wrap rows get none):
//   CHK             F32H's loop plus RingBuffer's own argument checks, copied as TEXT (push: F32H renamed --
//                   push validates nothing; get: getOrDefault's guard, default 0; copy: copyCheck's statements,
//                   throws reduced to `new TypeError/RangeError('CHK')`), on a plain-object ring that also carries
//                   the alias cache (`_bufOf`, `_buf`). Only CHK's build receives the captured intrinsics.
//   MN              mnemonist 0.40.8 CircularBuffer(Float32Array, n) through its own API: push = push(v);
//                   get = get(size - 1 - i) (oldest-relative; valid only on a full ring, asserted at setup);
//                   copy = forEach with the hoisted store callback
//   MN_TA           copy rows only: out.set(ring.toArray(), 0) (toArray allocates a Float32Array per call)
// checks.uniqueSrc: every driver source distinct. checks.sameTpl (push, get, copyto): ARR source == F32H
// source with only the name replaced. checks.wrapOnly (wrap rows): MOD source == MASK source with only the
// wrap expression (and the name) replaced, MOD_NP2 == MOD with only the name replaced.
// checks.chkTpl (push, get, copyto): CHK source == the stated transform of F32H's source. checks.chkArgs (get,
// copyto): untimed functions built from the SAME guard text agree with the staged RingBuffer's
// getOrDefault(x, 0) / copyTo(dst, off) (outcome `ok` + value / count, or the error class; Object.is) on mirrored
// rings (empty, count = n/2 + 3, full, full after a cache-warming copy with `data` kept (copy rows only: the next
// copy reads the CACHED buffer, so dst = `data` must still throw the alias RangeError), `data` replaced with a
// wrong-length array, `data` swapped for a same-value full-length array after a cache-warming copy with the old
// array as dst) over the offset / dst / dstOffset sets below; after every ok outcome both alias caches must agree on
// being keyed on the current `data`. Mutants MUT_CHK_COUNT / MUT_CHK_INT (get) and MUT_CHK_BOUNDS / MUT_CHK_ALIAS /
// MUT_CHK_STALE / MUT_CHK_NOCACHE / MUT_CHK_NOBUF (copy) are guard mutants: caught means the ARG oracle fails on their
// guard text (the driver oracle never sees a bad arg).
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
// at the end. The library methods' own optimization status (methodOpt, incl. mn_*) is REPORTED only (D13).
// Exit 0 = ran (checks recorded; the driver judges them); 1 = harness precondition failed; 2 = usage error.
// Test tooling only: not shipped.
import v8 from 'node:v8';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { MN_FILES, MN_SHA256, mnCheck } from './mn-pin.mjs';

const die = (code, m) => { process.stderr.write('compare-probe: ' + m + '\n'); process.exit(code); };

// ---- options (strict) ---------------------------------------------------------------------------------
const VALUE_OPTS = ['--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8', '--row', '--K', '--control'];
const FLAG_OPTS = ['--smoke', '--dump-src'];
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
for (const k of ['--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8', '--row']) if (!(k in opt)) die(2, k + ' is required');
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

// mnemonist (SPEC A1 / A8): verify the bytes of every MN_FILES entry BEFORE executing any of them, then require
// through createRequire from the package root, then pin the require.cache delta to exactly MN_FILES.
const FMN = opt['--mn'];
if (!isAbsolute(FMN)) die(1, '--mn must be an absolute path: ' + FMN);
if (basename(FMN) !== 'circular-buffer.js' || basename(dirname(FMN)) !== 'mnemonist' ||
    basename(dirname(dirname(FMN))) !== 'node_modules') die(1, '--mn is not <root>/node_modules/mnemonist/circular-buffer.js: ' + FMN);
const MN_NM = dirname(dirname(FMN));
const MN_SHA8 = MN_SHA256.slice(0, 8);
if (opt['--mn-sha8'] !== MN_SHA8) die(1, '--mn-sha8 ' + opt['--mn-sha8'] + ' != MN_SHA256/8 ' + MN_SHA8);
const mnPin = mnCheck(MN_NM);
if (mnPin.ok !== true) die(1, 'mnemonist pin: ' + mnPin.why);
let mnReq, mnReal, mnNmReal;
try {
    mnReq = createRequire(join(dirname(MN_NM), 'package.json'));
    mnReal = realpathSync(FMN);
    mnNmReal = realpathSync(MN_NM);
} catch (e) { die(1, 'mnemonist resolve: ' + (e && e.message ? e.message : String(e))); }
let mnResolved;
try { mnResolved = mnReq.resolve('mnemonist/circular-buffer.js'); } catch (e) { die(1, 'mnemonist resolve: ' + (e && e.message ? e.message : String(e))); }
if (mnResolved !== mnReal) die(1, 'mnemonist resolves to ' + mnResolved + ', not --mn ' + mnReal);
let CircularBuffer;
try { CircularBuffer = mnReq(mnResolved); } catch (e) { die(1, 'mnemonist require: ' + (e && e.message ? e.message : String(e))); }
if (typeof CircularBuffer !== 'function') die(1, 'mnemonist CircularBuffer export missing');
const NM_SEG = sep + 'node_modules' + sep;
const mnSeen = new Set();
for (const key of Object.keys(mnReq.cache)) {
    const at = key.lastIndexOf(NM_SEG);
    if (at < 0) continue;
    const rel = key.slice(at + NM_SEG.length).split(sep).join('/');
    if (!rel.startsWith('mnemonist/') && !rel.startsWith('obliterator/')) continue;
    if (!MN_FILES.includes(rel) || key !== join(mnNmReal, ...rel.split('/'))) die(1, 'require.cache holds unpinned ' + key);
    mnSeen.add(rel);
}
if (mnSeen.size !== MN_FILES.length) die(1, 'require.cache holds ' + mnSeen.size + ' of ' + MN_FILES.length + ' MN_FILES');

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
// CHK rings are that state plus copyCheck's alias cache fields (`_bufOf`, `_buf`); MN = mnemonist CircularBuffer.
const mkState = (data, cap) => ({ data, head: 0, count: 0, mask: cap - 1, capacity: cap });
const mkChk = (data, cap) => ({ data, head: 0, count: 0, mask: cap - 1, capacity: cap, _bufOf: null, _buf: null });
const KIND = {
    rb: { mk: (cap) => new RingBuffer(cap) },
    f32: { mk: (cap) => mkState(new Float32Array(cap), cap) },
    arr: { mk: (cap) => mkState(new Array(cap).fill(0.5), cap) },
    deq: { mk: (cap) => new RingDeque(cap) },
    chk: { mk: (cap) => mkChk(new Float32Array(cap), cap) },
    mn: { mk: (cap) => new CircularBuffer(Float32Array, cap) },
};
function fill(kind, ring, p) {
    for (let i = 0; i < p; i++) {
        const v = SRC[i & 1023];
        if (kind === 'rb' || kind === 'mn') ring.push(v);
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
    if (kind === 'mn') {
        // mnemonist's own fields (oldest at items[start]), not its forEach (the MN copy column times forEach)
        for (let i = 0; i < ring.size; i++) outA.push(ring.items[(ring.start + i) % ring.capacity]);
        return outA;
    }
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

// ---- CHK: RingBuffer's argument checks, copied as TEXT from RingBuffer.js (HEAD 82cd5dc / 414bba0d) ----------
// Intrinsics, as RingBuffer.js:92 (TA_LENGTH), :124 (TA_PROTO) and :126 (TA_BUFFER). :125 TA_TAG is not
// captured: CHK has no TA_TAG dispatch (and no rotCopy). Only CHK's build (and the arg oracle) receives them.
const TA_LENGTH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float32Array.prototype), 'length').get;
const TA_PROTO = Object.getPrototypeOf(Float32Array.prototype);
const TA_BUFFER = Object.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get;
// G_GET = the getOrDefault guard, RingBuffer.js:661 (`offset` -> `o`, `this` -> `ring`).
const G_GET = '!Number.isInteger(o) || o < 0 || o >= ring.count';
// G_COPY = copyCheck's statements, RingBuffer.js:200-221 (`rb` -> `ring`; comment lines 199 / 203 / 216-217
// dropped; dstTypeError -> `new TypeError('CHK')`, boundsError / aliasError / storageError -> `new RangeError('CHK')`;
// the `return c` at :222 is not part of the guard).
const G_COPY = [
    "if (!ArrayBuffer.isView(dst) || dst instanceof DataView) throw new TypeError('CHK');",
    'const dlen = TA_LENGTH.call(dst);',
    'const c = ring.count;',
    'if (!Number.isInteger(dstOffset) || dstOffset < 0 || !(dstOffset + c <= dlen)) {',
    "    throw new RangeError('CHK');",
    '}',
    'if (c !== 0) {',
    '    let buf = ring._buf;',
    '    if (data !== ring._bufOf) {',
    '        buf = TA_BUFFER.call(data);',
    '        if (Object.isExtensible(ring)) {',
    '            ring._buf = buf;',
    '            ring._bufOf = data;',
    '        }',
    '    }',
    "    if (TA_BUFFER.call(dst) === buf) throw new RangeError('CHK');",
    '    const len = TA_LENGTH.call(data);',
    "    if (len !== ring.capacity) throw new RangeError('CHK');",
    '}',
].join('\n');
// CHK bodies. get: F32H's read with `(k & 1023)` -> `o`, behind the guard (default 0). copy: the copyTo locals
// (dstOffset fixed 0, as the RB column calls copyTo(out, 0)), G_COPY, then F32H's masked loop unchanged.
const IX_GET_O = '(ring.head - 1 - o) & m';
const CHK_GET = (g) => 'const o = k & 1023;\nout[k & 7] = (' + g + ') ? 0 : ring.data[' + IX_GET_O + '];';
const CHK_COPY_PRE = 'const data = ring.data, dst = out, dstOffset = 0;';
const CHK_COPY = (g) => CHK_COPY_PRE + '\n' + g + '\n' + T.copy(CP_MASK);
// Guard mutants (never timed; the ARG oracle must catch each). once() is enforced at build.
const MUT_G = {
    MUT_CHK_COUNT: [G_GET, 'o >= ring.count', 'o > ring.count'],
    MUT_CHK_INT: [G_GET, '!Number.isInteger(o) || ', ''],
    MUT_CHK_BOUNDS: [G_COPY, '!(dstOffset + c <= dlen)', '!(dstOffset + c < dlen)'],
    MUT_CHK_ALIAS: [G_COPY, 'TA_BUFFER.call(dst) === buf', 'dst === data'],
    // alias-cache mutants (SPEC A11 c): a stale cache key, a cache that never records its key, and one that records
    // the key but never the buffer (a cache hit then alias-checks against a stale `_buf`; caught by the 'warm' state)
    MUT_CHK_STALE: [G_COPY, 'data !== ring._bufOf', 'ring._bufOf === null'],
    MUT_CHK_NOCACHE: [G_COPY, '\n            ring._bufOf = data;', ''],
    MUT_CHK_NOBUF: [G_COPY, '\n            ring._buf = buf;', ''],
};
function mutGuard(nm) {
    const [g, a, b] = MUT_G[nm];
    if (g.split(a).length !== 2) die(1, nm + ': mutation target not found exactly once');
    return g.replace(a, b);
}
// MN bodies (mnemonist CircularBuffer through its own API).
const MN_BODY = {
    push: 'ring.push(src[k & 1023]);',
    get: 'out[k & 7] = ring.get(ring.size - 1 - (k & 1023));',
    copy: 'ring.forEach(CB);',
    copyTa: 'out.set(ring.toArray(), 0);',
};

// ---- row specs ----------------------------------------------------------------------------------------
// col: { kind, cap, pre, body, post, times (1 or 2: model multiplicity), out: 'o8' | 'dst' }
const n = ROW === 'copyto32' ? 32 : 1024;
const ROWDEF = {
    push: { form: 'push', ref: 'RB', aa: 'RB_AA', cols: {
        RB: { kind: 'rb', body: BODY.rbPush }, RB_AA: { kind: 'rb', body: BODY.rbPush },
        F32H: { kind: 'f32', pre: PRE_T, body: T.push(W_MASK) }, ARR: { kind: 'arr', pre: PRE_T, body: T.push(W_MASK) },
        DEQ: { kind: 'deq', body: BODY.deqPush },
        CHK: { kind: 'chk', intr: true, pre: PRE_T, body: T.push(W_MASK) }, MN: { kind: 'mn', body: MN_BODY.push },
    }, mutants: { MUT_WRAP: { kind: 'f32', pre: PRE_T, body: T.push(W_MUT) }, MUT_OBO: { kind: 'f32', pre: PRE_T, body: T.push(W_OBO) } } },
    get: { form: 'get', ref: 'GOD', aa: 'GOD_AA', cols: {
        GOD: { kind: 'rb', body: BODY.god }, GOD_AA: { kind: 'rb', body: BODY.god }, GET: { kind: 'rb', body: BODY.get },
        F32H: { kind: 'f32', pre: PRE_T, body: T.getIdx(IX_GET) }, ARR: { kind: 'arr', pre: PRE_T, body: T.getIdx(IX_GET) },
        CHK: { kind: 'chk', intr: true, guard: G_GET, pre: PRE_T, body: CHK_GET(G_GET) }, MN: { kind: 'mn', body: MN_BODY.get },
    }, mutants: {
        MUT_WRAP: { kind: 'f32', pre: PRE_T, body: T.getIdx(IX_GET_MUT) }, MUT_GET: { kind: 'rb', body: BODY.godMut },
        MUT_OBO: { kind: 'f32', pre: PRE_T, body: T.getIdx(IX_GET_OBO) },
        MUT_CHK_COUNT: { kind: 'chk', intr: true, guard: mutGuard('MUT_CHK_COUNT'), pre: PRE_T, body: CHK_GET(mutGuard('MUT_CHK_COUNT')) },
        MUT_CHK_INT: { kind: 'chk', intr: true, guard: mutGuard('MUT_CHK_INT'), pre: PRE_T, body: CHK_GET(mutGuard('MUT_CHK_INT')) },
    } },
    copy: { form: 'copy', ref: 'RB', aa: 'RB_AA', cols: {
        RB: { kind: 'rb', body: BODY.rbCopy }, RB_AA: { kind: 'rb', body: BODY.rbCopy },
        F32H: { kind: 'f32', pre: PRE_T, body: T.copy(CP_MASK) }, ARR: { kind: 'arr', pre: PRE_T, body: T.copy(CP_MASK) },
        DEQ: { kind: 'deq', body: BODY.deqCopy },
        CHK: { kind: 'chk', intr: true, guard: G_COPY, pre: PRE_T, body: CHK_COPY(G_COPY) },
        MN: { kind: 'mn', body: MN_BODY.copy }, MN_TA: { kind: 'mn', body: MN_BODY.copyTa },
    }, mutants: {
        MUT_WRAP: { kind: 'f32', pre: PRE_T, body: T.copy(CP_MUT) }, MUT_OBO: { kind: 'rb', body: BODY.rbCopyObo },
        MUT_CHK_BOUNDS: { kind: 'chk', intr: true, guard: mutGuard('MUT_CHK_BOUNDS'), pre: PRE_T, body: CHK_COPY(mutGuard('MUT_CHK_BOUNDS')) },
        MUT_CHK_ALIAS: { kind: 'chk', intr: true, guard: mutGuard('MUT_CHK_ALIAS'), pre: PRE_T, body: CHK_COPY(mutGuard('MUT_CHK_ALIAS')) },
        MUT_CHK_STALE: { kind: 'chk', intr: true, guard: mutGuard('MUT_CHK_STALE'), pre: PRE_T, body: CHK_COPY(mutGuard('MUT_CHK_STALE')) },
        MUT_CHK_NOCACHE: { kind: 'chk', intr: true, guard: mutGuard('MUT_CHK_NOCACHE'), pre: PRE_T, body: CHK_COPY(mutGuard('MUT_CHK_NOCACHE')) },
        MUT_CHK_NOBUF: { kind: 'chk', intr: true, guard: mutGuard('MUT_CHK_NOBUF'), pre: PRE_T, body: CHK_COPY(mutGuard('MUT_CHK_NOBUF')) },
    } },
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
    const drv = spec.intr === true
        ? new Function('BOXES', 'CB', 'TA_LENGTH', 'TA_BUFFER', src)(BOXES, cb, TA_LENGTH, TA_BUFFER)
        : new Function('BOXES', 'CB', src)(BOXES, cb);
    return { name, kind: spec.kind, cap, times, src, out, drv, ring: null, guard: spec.guard };
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

// ---- --dump-src: {name: src} for every column + mutant, then exit 0 (no oracle, no timing) -------------------
if (opt['--dump-src'] === true) {
    const D = {};
    for (const [k, c] of Object.entries(cols)) D[k] = c.src;
    for (const [k, c] of Object.entries(muts)) { if (k in D) die(1, 'dump-src: duplicate name ' + k); D[k] = c.src; }
    // a pipe write is asynchronous on macOS: wait for the flush before exiting
    await new Promise((res) => { process.stdout.write(JSON.stringify(D, null, 2) + '\n', res); });
    process.exit(0);
}

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
    // chkTpl: CHK's source is exactly the stated transform of F32H's source (written here from F32H's TEXT,
    // independent of how CHK was built)
    const f = cols.F32H.src;
    const named = f.replace('drive_F32H(', 'drive_CHK(');
    const LOOP = 'for (let k = 0; k < reps; k++) {\n';
    const READ = 'out[k & 7] = ring.data[' + IX_GET + '];';
    let want = null;
    if (FORM === 'push') want = named;
    else if (FORM === 'get' && once(f, READ)) {
        want = named.replace(READ, 'const o = k & 1023;\nout[k & 7] = (' + G_GET + ') ? 0 : ring.data[' + IX_GET.replace('(k & 1023)', 'o') + '];');
    } else if (FORM === 'copy' && once(f, LOOP)) {
        want = named.replace(LOOP, LOOP + 'const data = ring.data, dst = out, dstOffset = 0;\n' + G_COPY + '\n');
    }
    checks.chkTpl = once(f, 'drive_F32H(') && want !== null && cols.CHK.src === want;
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

// ---- CHK argument oracle: untimed functions from the SAME guard text vs the staged RingBuffer --------------
// A CHK mismatch prints its first failing case to stderr (mutants stay silent: they are expected to fail).
// get:  (G) ? 0 : <CHK's read>                          vs  rb.getOrDefault(x, 0)
// copy: copyTo's signature (RingBuffer.js:757, `dstOffset = 0`) + copyTo's `data` local + G + a copy loop
//       vs rb.copyTo(dst, off). Outcome: ok + value / count (Object.is; copy also compares the written dst), or
//       the error class; an ok outcome also needs alias-cache parity (cacheSame, SPEC A11 b). Each case runs on a FRESH mirrored pair of rings (RingBuffer and a CHK ring) filled with
//       the same nonzero float32-exact values, so an out-of-range read cannot hide behind a 0 default.
const chkFnCache = new Map();
function chkFn(guard) {
    let fn = chkFnCache.get(guard);
    if (fn !== undefined) return fn;
    const src = FORM === 'get'
        ? 'return function chkArgGet(ring, o) {\nconst m = ring.mask;\nreturn (' + guard + ') ? 0 : ring.data[' + IX_GET_O + '];\n};'
        : 'return function chkArgCopy(ring, dst, dstOffset = 0) {\nconst m = ring.mask;\nconst data = ring.data;\n' + guard +
          '\nconst s = (ring.head - c) & m;\nfor (let i = 0; i < c; i++) dst[dstOffset + i] = data[(s + i) & m];\nreturn c;\n};';
    fn = new Function('TA_LENGTH', 'TA_BUFFER', src)(TA_LENGTH, TA_BUFFER);
    chkFnCache.set(guard, fn);
    return fn;
}
// 'warm' (copy rows only): full, then one cache-warming copy with `data` kept, so every case below runs on a cache HIT
const ARG_STATES = ['empty', 'half', 'full', 'warm', 'badData', 'swapData'];
function argPair(state, fn) {
    const rb = new RingBuffer(n);
    const ck = mkChk(new Float32Array(n), n);
    const p = state === 'empty' ? 0 : state === 'half' ? (n >> 1) + 3 : n + 5;
    for (let i = 0; i < p; i++) {
        const v = (i % 251) + 1.5;
        rb.push(v);
        ck.data[ck.head] = v;
        ck.head = (ck.head + 1) & ck.mask;
        if (ck.count < ck.capacity) ck.count++;
    }
    const oldA = rb.data, oldB = ck.data;
    if (state === 'warm' || state === 'badData' || state === 'swapData') {
        // copy rows: warm both alias caches with a valid copy first (through the function under test), then
        // keep `data` (warm: every case hits the cache) or replace it: badData with a wrong-length array; swapData
        // (SPEC A11 a) with a new full-length array holding the same values (the cache key goes stale; dst 'oldData' =
        // the replaced array)
        if (FORM === 'copy') {
            rb.copyTo(new Float32Array(n), 0);
            try { fn(ck, new Float32Array(n), 0); } catch { /* a mutant may throw here; the cases below judge it */ }
        }
        if (state === 'badData') {
            const a = new Float32Array(n >> 1), b = new Float32Array(n >> 1);
            for (let i = 0; i < a.length; i++) { a[i] = i + 0.25; b[i] = i + 0.25; }
            rb.data = a;
            ck.data = b;
        } else if (state === 'swapData') {
            rb.data = Float32Array.from(oldA);
            ck.data = Float32Array.from(oldB);
        }
    }
    return { rb, ck, oldA, oldB };
}
// cache parity (SPEC A11 b), read after every ok outcome: RingBuffer and CHK agree on whether the alias cache is
// keyed on the current `data`
const cacheSame = (rb, ck) => (rb._bufOf === rb.data) === (ck._bufOf === ck.data);
const errClass = (e) => (e instanceof TypeError ? 'TypeError' : e instanceof RangeError ? 'RangeError' : 'other:' + String(e && e.name));
const ARG_OFFSETS = (cnt) => [0, -0, 1, cnt - 1, cnt, cnt + 1, n, -1, 0.5, 1.5, NaN, Infinity, -Infinity, '1', null, undefined, true, 2 ** 31, 2 ** 53];
const ARG_DSTS = ['f32cap1', 'f32cnt1', 'f64cap', 'array', 'dataview', 'null', 'ringData', 'ringSub1'];
const ARG_DSTS_SWAP = ARG_DSTS.concat(['oldData']);
const ARG_DOFFS = [0, -0, 1, -1, 1.5, NaN, '0', null, undefined];
function mkDst(kind, ring, cnt, old) {
    if (kind === 'oldData') return old;
    if (kind === 'f32cap1') return new Float32Array(n + 1).fill(SENT);
    if (kind === 'f32cnt1') return new Float32Array(Math.max(0, cnt - 1)).fill(SENT);
    if (kind === 'f64cap') return new Float64Array(n).fill(SENT);
    if (kind === 'array') return new Array(n).fill(SENT);
    if (kind === 'dataview') return new DataView(new ArrayBuffer(16));
    if (kind === 'null') return null;
    if (kind === 'ringData') return ring.data;
    return ring.data.subarray(1);
}
function outcome(f) {
    try { return { ok: true, v: f(), cls: '' }; } catch (e) { return { ok: false, v: undefined, cls: errClass(e) }; }
}
const fmt = (x) => (typeof x === 'string' ? JSON.stringify(x) : Object.is(x, -0) ? '-0' : String(x));
function argOracle(guard, label) {
    const fn = chkFn(guard);
    for (const st of ARG_STATES) {
        if (st === 'warm' && FORM !== 'copy') continue; // get has no cache: 'warm' would repeat 'full'
        const cnt = st === 'empty' ? 0 : st === 'half' ? (n >> 1) + 3 : n; // full, warm, badData, swapData: n
        if (FORM === 'get') {
            for (const o of ARG_OFFSETS(cnt)) {
                const { rb, ck } = argPair(st, fn);
                const a = outcome(() => rb.getOrDefault(o, 0));
                const b = outcome(() => fn(ck, o));
                if (a.ok !== b.ok || a.cls !== b.cls || !Object.is(a.v, b.v) || (a.ok && !cacheSame(rb, ck))) {
                    if (label === 'CHK') process.stderr.write('compare-probe: chkArgs ' + label + ' ' + st + ' offset ' + fmt(o) + ': rb ' +
                        (a.ok ? 'ok:' + fmt(a.v) : a.cls) + ' chk ' + (b.ok ? 'ok:' + fmt(b.v) : b.cls) + (a.ok && !cacheSame(rb, ck) ? ' (alias-cache parity broken)' : '') + '\n');
                    return false;
                }
            }
            continue;
        }
        for (const dk of st === 'swapData' ? ARG_DSTS_SWAP : ARG_DSTS) {
            for (const off of ARG_DOFFS) {
                const { rb, ck, oldA, oldB } = argPair(st, fn);
                const dA = mkDst(dk, rb, cnt, oldA), dB = mkDst(dk, ck, cnt, oldB);
                const a = outcome(() => rb.copyTo(dA, off));
                const b = outcome(() => fn(ck, dB, off));
                let same = a.ok === b.ok && a.cls === b.cls && Object.is(a.v, b.v);
                if (same && a.ok && ArrayBuffer.isView(dA) && !(dA instanceof DataView)) {
                    if (dA.length !== dB.length) same = false;
                    for (let i = 0; same && i < dA.length; i++) if (!Object.is(dA[i], dB[i])) same = false;
                }
                const cacheOk = !(same && a.ok) || cacheSame(rb, ck);
                if (!same || !cacheOk) {
                    if (label === 'CHK') process.stderr.write('compare-probe: chkArgs ' + label + ' ' + st + ' dst ' + dk + ' dstOffset ' + fmt(off) + ': rb ' +
                        (a.ok ? 'ok:' + fmt(a.v) : a.cls) + ' chk ' + (b.ok ? 'ok:' + fmt(b.v) : b.cls) + (cacheOk ? '' : ' (alias-cache parity broken)') + '\n');
                    return false;
                }
            }
        }
    }
    return true;
}
if (FORM === 'get' || FORM === 'copy') checks.chkArgs = argOracle(cols.CHK.guard, 'CHK');
// mutants: a guard mutant (MUT_CHK_*) is caught when the ARG oracle fails on its guard; every other mutant when
// the driver oracle fails on its driver
checks.mutants = Object.fromEntries(Object.keys(muts).map((nm) => [nm,
    muts[nm].guard !== undefined ? !argOracle(muts[nm].guard, nm) : !oracle(muts[nm])]));

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
        const kd = cols[nm].kind;
        // mnemonist: head = (start + size) % capacity; its get body is valid only on a full ring (SPEC A8)
        if (kd === 'mn' && r.size !== r.capacity) die(1, 'ring setup ' + nm + ' mnemonist size ' + r.size + ' != capacity ' + r.capacity);
        const head = kd === 'deq' ? r._head : kd === 'mn' ? (r.start + r.size) % r.capacity : r.head;
        const cnt = kd === 'deq' || kd === 'mn' ? r.size : r.count;
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
    methodOpt.mn_push = optStatus(CircularBuffer.prototype.push);
} else if (FORM === 'get') {
    methodOpt.rb_getOrDefault = optStatus(RingBuffer.prototype.getOrDefault);
    methodOpt.rb_get = optStatus(RingBuffer.prototype.get);
    methodOpt.mn_get = optStatus(CircularBuffer.prototype.get);
} else if (FORM === 'copy') {
    methodOpt.rb_copyTo = optStatus(RingBuffer.prototype.copyTo);
    methodOpt.deq_forEach = optStatus(RingDeque.prototype.forEach);
    methodOpt.mn_forEach = optStatus(CircularBuffer.prototype.forEach);
    methodOpt.mn_toArray = optStatus(CircularBuffer.prototype.toArray);
}
checks.oracleAfter = Object.fromEntries(TIMED.map((nm) => [nm, oracle(cols[nm])]));
checks.turbofan = LANES.every((nm) => (optAfterWarm[nm] & TURBOFANNED) !== 0 && (optAtEnd[nm] & TURBOFANNED) !== 0);

process.stdout.write(JSON.stringify({
    row: ROW, n, K, reps, nb, W, control: CONTROL, smoke: SMOKE, ref: REF, aa: AA, cols: TIMED, lanes: LANES,
    sha8: { rb: FRB.s8, o1: FO1.s8, mn: MN_SHA8 },
    node: process.version, v8: process.versions.v8,
    host: process.env.QUIET_LOCK_HOST || 'unlocked', hostWhy: process.env.QUIET_LOCK_WHY || '',
    load: [load0, load1], checks, bop, bopWindow0: win0, optAfterWarm, optAtEnd, methodOpt, rounds, sink: sink[0] > 0,
}) + '\n');
