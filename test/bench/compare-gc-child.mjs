// compare-gc-child.mjs -- ONE cell (mode x lib x n) of the GC lane / memory-per-window bench (Q2 group B).
// Spawned by test/bench/compare-gc.mjs, one fresh `node --expose-gc` per cell; never spawns anything itself.
// Never run by `npm test` / `npm run verify`. Test tooling only: not shipped.
//
//   node --expose-gc test/bench/compare-gc-child.mjs --mode gc|mem --lib L --n 64|256|1024
//        --rb FILE --rb-sha8 HEX --o1 FILE --o1-sha8 HEX --mn FILE --mn-sha8 HEX
//        [--control alloc|leak|mem] [--smoke]
//
// ---- FIXED CONTRACT (copy: .handoff/q2/B/child-schema.txt; change only with a report) -----------------
// Exit: 0 = ran, exactly ONE JSON line on stdout (the cell; the driver judges it). 1 = precondition failed
//   (no --expose-gc, v8 total_allocated_bytes missing / not finite, a file missing, a sha256/8 mismatch,
//   mnCheck(<pkg root>/node_modules) not ok, --mn not the createRequire-resolved mnemonist/circular-buffer.js,
//   an export missing). 2 = usage (unknown / repeated / valueless argument, missing required argument, bad
//   --mode / --lib / --n / --control, a control that does not apply). Nothing on stdout unless exit 0.
// Arguments: all of --mode --lib --n --rb --rb-sha8 --o1 --o1-sha8 --mn --mn-sha8 are required in BOTH modes
//   (every sha8 is checked in every cell). --n is one of 64 | 256 | 1024.
//   --mode gc  libs: RB F32H ARR DEQ MN_EACH MN_ARR CTL
//   --mode mem libs: RB F32H ARR DEQ MN
//   --control alloc: --mode gc AND --lib RB only (RB's driver is built from CTL's body). leak: either mode,
//   any lib (the instance(s) stay reachable from a global, so leak.live > 0). mem: --mode mem only, any lib
//   (perInstB leaves out the arrayBuffers term). Any other pairing -> exit 2.
// Constants: WARM 50,000 frames; FRAMES 40,000 per window; W 5 windows (3 with --smoke); CHUNK 1000 frames per
//   driver call; M 512 instances (64 with --smoke); drain <= 20 rounds of gc() + 25 ms.
// JSON numbers: a NaN / non-finite value serializes as null (the driver treats null as VOID).
//
// gc line (--mode gc):
//   mode        'gc'
//   lib         string, the --lib value
//   n           number, ring capacity
//   control     string, '' | 'alloc' | 'leak'
//   node        string, process.version
//   v8          string, process.versions.v8
//   sha8        {rb, o1, mn}: strings; rb / o1 = sha256/8 of the --rb / --o1 file bytes, mn = MN_SHA256/8
//               (mn-pin.mjs combined digest recomputed by mnCheck); each equals the matching --*-sha8
//   oracle      {before, after}: booleans. before = (fresh RB after P = 3n + n/2 + 1 pushes equals the
//               Math.fround keep-last-N model, Object.is per element) AND (the lib's own driver run P frames
//               on a fresh instance yields a window equal to RB's, Object.is per element, no write past n).
//               after = the same re-run after the timed windows AND the timed instance's current window
//               equals the model of its last n pushes.
//   major       number, GcProfiler summary gc.major over windows 1..W-1
//   minor       number, gc.minor over windows 1..W-1
//   maxPauseMs  number, gc.maxMs over windows 1..W-1
//   noGc        string, checkNoGc(summary, {maxMajor:0, maxMinor:0, maxPauseMs:2}).verdict for EVERY lib:
//               'pass' | 'fail' | 'inconclusive' (the judge reads it on RB)
//   bpf         number, min over windows 1..W-1 of total_allocated_bytes delta / FRAMES (V8 heap bytes per
//               frame; off-heap backing stores not counted, SPEC A7)
//   bpfWin      number[W], every window's B/frame, window 0 included (printed, never used for bpf)
//   baseBpf     number, the empty driver's B/frame, min over its own windows 1..W-1; window w of the empty
//               driver runs just before lib window w, read the same way, under the same profiler (the
//               counter-read floor: ranges ~0.15-5.8 B/frame at FRAMES 40,000 on Node v26.8.2 and varies per
//               window; REPORTED alongside, bpf is NOT netted here -- the driver nets it for RB, SPEC A10/A12)
//   abDelta     number, memoryUsage().arrayBuffers after the last window minus after warmup, both after gc()
//               + 25 ms, instance alive (bytes; retained off-heap, a gauge after gc -- not an allocation witness,
//               SPEC A7b/A13; the GC counts are the allocation witness)
//   retainedB   number, (used_heap_size + arrayBuffers) after the last window minus the same after warmup,
//               both after gc() + 25 ms, instance alive (bytes)
//   leak        {live, rounds}: numbers. The timed instance and its store are tracked (lite-leak), dropped,
//               drained; live = tracker.size() after the drain (0 = reclaimed), rounds = gc rounds used.
//
// mem line (--mode mem):
//   mode        'mem'
//   lib, n, control ('' | 'leak' | 'mem'), node, v8, sha8   as in the gc line
//   oracle      {before, after}: booleans. before = one fresh instance, filled with P pushes, window read
//               equals the model; after = every one of the M held instances' window equals the model,
//               re-read after measuring.
//   M           number, instances held
//   perInstB    number, (delta used_heap_size + delta arrayBuffers) / M  (control mem: heapB only)
//   heapB       number, delta used_heap_size / M
//   abB         number, delta memoryUsage().arrayBuffers / M
//               (deltas: after building + holding the M instances, minus before; each side after 3 rounds
//               of gc() + 25 ms; the holder array is allocated before the first gauge)
//   leak        {live, rounds}: numbers. After measuring: every instance and its store tracked (2M), the holder
//               cleared, drained; live = tracker.size() after the drain.
// ---------------------------------------------------------------------------------------------------------
//
// Hot body: one frame driver per lib, `drive_<LIB>(ring, src, dst, frames)`, built by `new Function` from
// its own source text. A frame pushes src[k & 1023] then reads the whole window: RB push + copyTo(dst, 0);
// F32H / ARR hand-rolled plain-object ring (Float32Array / `new Array(n).fill(0.5)`, & mask) + masked copy
// loop; DEQ lite-o1 RingDeque keep-last-N (`if (size === capacity) popFront(); pushBack(v)`) + forEach(CB);
// MN_EACH mnemonist CircularBuffer(Float32Array, n) push + forEach(CB); MN_ARR push + KEEP[0] = toArray()
// (allocates by design, REPORTED); CTL RB push + KEEP[0] = a fresh Float32Array(n) as the copy dst (the
// must-allocate control). No driver branches on the lib; CB is hoisted; frames is a Smi (CHUNK); the
// chunk loop sums driver results into the Float64Array SINK. Everything else (argv, pins, oracle, warmup,
// counter / gauge reads, lite-leak drain) is cold.
import v8 from 'node:v8';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mnCheck, MN_SHA256 } from './mn-pin.mjs';

const die = (code, m) => { process.stderr.write('compare-gc-child: ' + m + '\n'); process.exit(code); };

// ---- options (strict, as compare-probe.mjs) ------------------------------------------------------------
const VALUE_OPTS = ['--mode', '--lib', '--n', '--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8', '--control'];
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
for (const k of ['--mode', '--lib', '--n', '--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8']) {
    if (!(k in opt)) die(2, k + ' is required');
}
const MODE = opt['--mode'];
if (MODE !== 'gc' && MODE !== 'mem') die(2, '--mode gc|mem');
const GC_LIBS = ['RB', 'F32H', 'ARR', 'DEQ', 'MN_EACH', 'MN_ARR', 'CTL'];
const MEM_LIBS = ['RB', 'F32H', 'ARR', 'DEQ', 'MN'];
const LIBS = MODE === 'gc' ? GC_LIBS : MEM_LIBS;
const LIB = opt['--lib'];
if (!LIBS.includes(LIB)) die(2, '--lib for --mode ' + MODE + ': ' + LIBS.join('|'));
if (!['64', '256', '1024'].includes(opt['--n'])) die(2, '--n 64|256|1024');
const N = Number(opt['--n']);
const CONTROL = opt['--control'] ?? '';
if (CONTROL !== '' && CONTROL !== 'alloc' && CONTROL !== 'leak' && CONTROL !== 'mem') die(2, '--control alloc|leak|mem');
if (CONTROL === 'alloc' && !(MODE === 'gc' && LIB === 'RB')) die(2, '--control alloc applies to --mode gc --lib RB only');
if (CONTROL === 'mem' && MODE !== 'mem') die(2, '--control mem applies to --mode mem only');
const SMOKE = opt['--smoke'] === true;

const WARM = 50000;
const FRAMES = 40000;
const CHUNK = 1000;
const W = SMOKE ? 3 : 5;
const M = SMOKE ? 64 : 512;
const DRAIN_MAX = 20;

// ---- preconditions (fail closed) ------------------------------------------------------------------------
if (typeof globalThis.gc !== 'function') die(1, 'needs --expose-gc');
const hs0 = v8.getHeapStatistics();
if (!('total_allocated_bytes' in hs0) || !Number.isFinite(hs0.total_allocated_bytes)) die(1, 'v8 total_allocated_bytes missing or not finite');

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
// mnemonist (SPEC A1 / A8): pin check BEFORE anything is required; --mn must be the file the pin covers.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MN_CK = mnCheck(join(ROOT, 'node_modules'));
if (!MN_CK.ok) die(1, 'mnemonist pin: ' + MN_CK.why);
const MN_S8 = MN_SHA256.slice(0, 8);
if (opt['--mn-sha8'] !== MN_S8) die(1, '--mn-sha8 ' + opt['--mn-sha8'] + ' != MN_SHA256/8 ' + MN_S8);
if (MN_CK.sha256.slice(0, 8) !== MN_S8) die(1, 'mnemonist digest/8 ' + MN_CK.sha256.slice(0, 8) + ' != ' + MN_S8);
const rootRequire = createRequire(join(ROOT, 'package.json'));
let mnResolved;
try { mnResolved = realpathSync(rootRequire.resolve('mnemonist/circular-buffer.js')); } catch (e) { die(1, 'cannot resolve mnemonist/circular-buffer.js: ' + e.message); }
let mnGiven;
try { mnGiven = realpathSync(opt['--mn']); } catch { die(1, '--mn not found: ' + opt['--mn']); }
if (mnGiven !== mnResolved) die(1, '--mn ' + mnGiven + ' is not the pinned ' + mnResolved);
const CircularBuffer = rootRequire(mnResolved);
const RingBuffer = (await import(pathToFileURL(FRB.p).href)).RingBuffer;
const RingDeque = (await import(pathToFileURL(FO1.p).href)).RingDeque;
if (typeof RingBuffer !== 'function') die(1, 'RingBuffer export missing');
if (typeof RingDeque !== 'function') die(1, 'RingDeque export missing');
if (typeof CircularBuffer !== 'function') die(1, 'mnemonist CircularBuffer is not a constructor');
let GcProfiler, checkNoGc, createLeakTracker;
try {
    ({ GcProfiler, checkNoGc } = await import('@zakkster/lite-gc-profiler'));
    ({ createLeakTracker } = await import('@zakkster/lite-leak'));
} catch (e) {
    die(1, 'missing devDependency (' + e.message + ')');
}

// ---- values: float32-exact, never NaN; -0, +Infinity, -Infinity every 16 (compare-probe.mjs) -----------
const SRC = new Float64Array(1024);
for (let i = 0; i < 1024; i++) {
    const r = i & 15;
    SRC[i] = r === 5 ? -0 : r === 7 ? Infinity : r === 11 ? -Infinity : ((i * 37) % 1000) * 0.25 - 100.125;
    if (!(SRC[i] === SRC[i]) || !Object.is(Math.fround(SRC[i]), SRC[i])) die(1, 'SRC[' + i + '] not float32-exact');
}
const SENT = 12345.5;

// ---- harness state: typed slots, one hoisted callback ---------------------------------------------------
const DST = new Float32Array(N + 1);   // window target; DST[N] is the no-overrun sentinel
const SINK = new Float64Array(4);
const A = new Float64Array(2);         // counter reads
const G = new Float64Array(4);         // gauges: [0] heap before, [1] ab before, [2] heap after, [3] ab after
const KEEP = [null];                   // escape slot for CTL / MN_ARR windows
function CB(v, i) { DST[i] = v; }      // forEach store (DEQ, MN_EACH, mem DEQ / MN)

// ---- ring kinds (cold) ----------------------------------------------------------------------------------
const mkState = (data, cap) => ({ data, head: 0, count: 0, mask: cap - 1, capacity: cap });
const KIND = {
    rb: { mk: (cap) => new RingBuffer(cap), store: (r) => r.data },
    f32: { mk: (cap) => mkState(new Float32Array(cap), cap), store: (r) => r.data },
    arr: { mk: (cap) => mkState(new Array(cap).fill(0.5), cap), store: (r) => r.data },
    deq: { mk: (cap) => new RingDeque(cap), store: (r) => r._store },
    mn: { mk: (cap) => new CircularBuffer(Float32Array, cap), store: (r) => r.items },
};

// ---- driver sources (gc mode) ---------------------------------------------------------------------------
const PUSH = 'src[k & 1023]';
const PRE_HR = 'const m = ring.mask;\nconst c = ring.capacity;';
const BODY = {
    rb: 'ring.push(' + PUSH + ');\nring.copyTo(dst, 0);',
    hr: 'ring.data[ring.head] = ' + PUSH + ';\nring.head = (ring.head + 1) & m;\nif (ring.count < c) ring.count++;\n' +
        'const cnt = ring.count;\nconst d = ring.data;\nconst s = (ring.head - cnt) & m;\nfor (let i = 0; i < cnt; i++) dst[i] = d[(s + i) & m];',
    deq: 'if (ring.size === ring.capacity) ring.popFront();\nring.pushBack(' + PUSH + ');\nring.forEach(CB);',
    mnEach: 'ring.push(' + PUSH + ');\nring.forEach(CB);',
    mnArr: 'ring.push(' + PUSH + ');\nKEEP[0] = ring.toArray();',
    ctl: 'ring.push(' + PUSH + ');\nconst t = new Float32Array(c);\nring.copyTo(t, 0);\nKEEP[0] = t;',
};
// out: where the window lands ('dst' = DST, 'keep' = KEEP[0])
const GC_SPEC = {
    RB: { kind: 'rb', pre: '', body: BODY.rb, out: 'dst' },
    F32H: { kind: 'f32', pre: PRE_HR, body: BODY.hr, out: 'dst' },
    ARR: { kind: 'arr', pre: PRE_HR, body: BODY.hr, out: 'dst' },
    DEQ: { kind: 'deq', pre: '', body: BODY.deq, out: 'dst' },
    MN_EACH: { kind: 'mn', pre: '', body: BODY.mnEach, out: 'dst' },
    MN_ARR: { kind: 'mn', pre: '', body: BODY.mnArr, out: 'keep' },
    CTL: { kind: 'rb', pre: 'const c = ring.capacity;', body: BODY.ctl, out: 'keep' },
};
function drvSrc(name, pre, body) {
    return 'return function drive_' + name + '(ring, src, dst, frames) {\n' + (pre ? pre + '\n' : '') +
        'for (let k = 0; k < frames; k++) {\n' + body + '\n}\nreturn frames;\n};';
}
const mkDrv = (name, pre, body) => new Function('KEEP', 'CB', drvSrc(name, pre, body))(KEEP, CB);

// The chunk loop: the only caller of the drivers on the timed path.
function runFrames(drv, ring, total) {
    for (let c = 0; c < total; c += CHUNK) SINK[0] += drv(ring, SRC, DST, CHUNK);
}

// ---- oracle helpers (cold) ------------------------------------------------------------------------------
const fr = Math.fround;
const P = 3 * N + (N >> 1) + 1;
// Model: the last n of the pushes SRC[0..p-1] (one driver call of p frames), oldest first.
const modelOf = (p) => { const w = []; for (let i = p - N; i < p; i++) w.push(fr(SRC[i & 1023])); return w; };
// The last n pushes of a timed instance (chunked calls: k restarts at 0 every CHUNK frames, >= 2 chunks run).
const steadyModel = () => {
    const s = [];
    for (let c = 0; c < 2; c++) for (let k = 0; k < CHUNK; k++) s.push(fr(SRC[k & 1023]));
    return s.slice(-N);
};
function sameWin(win, want) {
    if (win === null || win === undefined || !(win.length >= N)) return false;
    for (let i = 0; i < N; i++) if (!Object.is(win[i], want[i])) return false;
    return true;
}
function rbModelOk() {
    const rb = new RingBuffer(N);
    for (let i = 0; i < P; i++) rb.push(SRC[i & 1023]);
    const out = new Float32Array(N);
    rb.copyTo(out, 0);
    const want = modelOf(P);
    return sameWin(out, want) ? Array.from(out) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allocated = () => v8.getHeapStatistics().total_allocated_bytes;
async function drain(t) {
    let live = t.size();
    let g = 0;
    for (; g < DRAIN_MAX && live > 0; g++) {
        globalThis.gc();
        await sleep(25);
        live = t.size();
    }
    return { live, rounds: g };
}
const noop = () => {};
const warns = [];
const mkTracker = () => createLeakTracker({ name: 'compare-gc-child', onWarning: (w) => warns.push(w.kind + ':' + w.reason) });
const HOLD = [null];
const LEAK_KEY = '__compareGcChildLeakControl';

function head(extra) {
    return Object.assign({
        mode: MODE, lib: LIB, n: N, control: CONTROL, node: process.version, v8: process.versions.v8,
        sha8: { rb: FRB.s8, o1: FO1.s8, mn: MN_CK.sha256.slice(0, 8) },
    }, extra);
}

// ---- mode gc --------------------------------------------------------------------------------------------
async function modeGc() {
    const spec = GC_SPEC[LIB];
    const useSpec = CONTROL === 'alloc' ? GC_SPEC.CTL : spec;     // build time, never a driver branch
    const kind = KIND[spec.kind];
    const drv = mkDrv(LIB, useSpec.pre, useSpec.body);
    const empty = mkDrv('EMPTY', '', 'dst[k & 7] = k;');
    const outOf = () => (useSpec.out === 'keep' ? KEEP[0] : DST);

    const oracleFresh = () => {
        const rbWin = rbModelOk();
        if (rbWin === null) return false;
        const r = kind.mk(N);
        DST.fill(SENT);
        KEEP[0] = null;
        drv(r, SRC, DST, P);
        if (useSpec.out === 'dst' && !Object.is(DST[N], SENT)) return false;
        const win = outOf();
        if (useSpec.out === 'keep' && !(win !== null && win.length === N)) return false;
        return sameWin(win, rbWin);
    };
    const before = oracleFresh();

    HOLD[0] = kind.mk(N);
    const ring = HOLD[0];
    runFrames(drv, ring, WARM);
    runFrames(empty, ring, WARM);

    // Every counter-read pair carries a floor that does not scale with frames and varies per window (Node
    // v26.8.2: ~0.15-5.8 B/frame at FRAMES 40,000, SPEC A10/A13), so each lib window is paired with an
    // empty-driver window read the same way, just before it, under the same profiler: baseBpf is that floor.
    // The profiler is constructed before the warm gauge so its own buffers are not in abDelta / retainedB.
    const baseWin = new Float64Array(W);
    const win = new Float64Array(W);
    const prof = new GcProfiler();

    globalThis.gc();
    await sleep(25);
    G[0] = v8.getHeapStatistics().used_heap_size;
    G[1] = process.memoryUsage().arrayBuffers;

    for (let w = 0; w < W; w++) {
        if (w === 1) prof.start();
        A[0] = allocated();
        runFrames(empty, ring, FRAMES);
        A[1] = allocated();
        baseWin[w] = (A[1] - A[0]) / FRAMES;
        A[0] = allocated();
        runFrames(drv, ring, FRAMES);
        A[1] = allocated();
        win[w] = (A[1] - A[0]) / FRAMES;
    }
    await sleep(50);
    const s = prof.summary();
    prof.stop();
    const rep = checkNoGc(s, { maxMajor: 0, maxMinor: 0, maxPauseMs: 2 });

    globalThis.gc();
    await sleep(25);
    G[2] = v8.getHeapStatistics().used_heap_size;
    G[3] = process.memoryUsage().arrayBuffers;

    // after: the timed instance's current window, then a fresh re-run
    DST.fill(SENT);
    KEEP[0] = null;
    drv(ring, SRC, DST, CHUNK);                                  // one more chunk: window = steady model
    const steadyOk = (useSpec.out === 'keep' || Object.is(DST[N], SENT)) && sameWin(outOf(), steadyModel());
    const after = steadyOk && oracleFresh();

    let bpf = Infinity, baseBpf = Infinity;
    for (let w = 1; w < W; w++) {
        if (win[w] < bpf) bpf = win[w];
        if (baseWin[w] < baseBpf) baseBpf = baseWin[w];
    }

    const tracker = mkTracker();
    tracker.track(ring, noop, 'ring');
    tracker.track(kind.store(ring), noop, 'store');
    if (CONTROL === 'leak') globalThis[LEAK_KEY] = ring;
    HOLD[0] = null;
    KEEP[0] = null;

    return {
        tracker,
        line: head({
            oracle: { before, after },
            major: s.gc.major, minor: s.gc.minor, maxPauseMs: s.gc.maxMs, noGc: String(rep.verdict),
            bpf, bpfWin: Array.from(win), baseBpf,
            abDelta: G[3] - G[1],
            retainedB: (G[2] + G[3]) - (G[0] + G[1]),
        }),
    };
}

// ---- mode mem -------------------------------------------------------------------------------------------
const MEM_KIND = { RB: 'rb', F32H: 'f32', ARR: 'arr', DEQ: 'deq', MN: 'mn' };
function memFill(k, r) {
    for (let i = 0; i < P; i++) {
        const v = SRC[i & 1023];
        if (k === 'rb' || k === 'mn') r.push(v);
        else if (k === 'deq') { if (r.size === r.capacity) r.popFront(); r.pushBack(v); }
        else { r.data[r.head] = v; r.head = (r.head + 1) & r.mask; if (r.count < r.capacity) r.count++; }
    }
}
function memRead(k, r) {
    DST.fill(SENT);
    if (k === 'rb') r.copyTo(DST, 0);
    else if (k === 'deq' || k === 'mn') r.forEach(CB);
    else { const s = (r.head - r.count) & r.mask; for (let i = 0; i < r.count; i++) DST[i] = r.data[(s + i) & r.mask]; }
    return Object.is(DST[N], SENT);
}
async function gc3() {
    for (let i = 0; i < 3; i++) { globalThis.gc(); await sleep(25); }
}
async function modeMem() {
    const k = MEM_KIND[LIB];
    const kind = KIND[k];
    const want = modelOf(P);

    const r0 = kind.mk(N);
    memFill(k, r0);
    const before = memRead(k, r0) && sameWin(DST, want);

    const held = new Array(M).fill(null);
    HOLD[0] = held;
    await gc3();
    G[0] = v8.getHeapStatistics().used_heap_size;
    G[1] = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < M; i++) {
        const r = kind.mk(N);
        memFill(k, r);
        memRead(k, r);
        held[i] = r;
    }
    await gc3();
    G[2] = v8.getHeapStatistics().used_heap_size;
    G[3] = process.memoryUsage().arrayBuffers;

    let after = true;
    for (let i = 0; i < M; i++) if (!(memRead(k, held[i]) && sameWin(DST, want))) after = false;

    const heapB = (G[2] - G[0]) / M;
    const abB = (G[3] - G[1]) / M;
    const perInstB = CONTROL === 'mem' ? heapB : heapB + abB;

    const tracker = mkTracker();
    for (let i = 0; i < M; i++) {
        tracker.track(held[i], noop, 'inst');
        tracker.track(kind.store(held[i]), noop, 'store');
    }
    if (CONTROL === 'leak') globalThis[LEAK_KEY] = held.slice();
    held.fill(null);
    HOLD[0] = null;

    return { tracker, line: head({ oracle: { before, after }, M, perInstB, heapB, abB }) };
}

const res = MODE === 'gc' ? await modeGc() : await modeMem();
res.line.leak = await drain(res.tracker);
process.stdout.write(JSON.stringify(res.line) + '\n');
process.exit(0);
