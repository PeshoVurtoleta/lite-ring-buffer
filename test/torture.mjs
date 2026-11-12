/**
 * @zakkster/lite-ring-buffer -- torture gate.
 *
 *     node --expose-gc test/torture.mjs                      -> lanes + GATE line, exit 0/1
 *     node --expose-gc test/torture.mjs <path/to/RingBuffer.js>  (mutant / revert check)
 *
 * Two jobs, kept separate (torture-harness skill):
 *   - @zakkster/lite-leak        -- retention. Phase 1 churns 4096 RingBuffers
 *     (push past capacity, getOrDefault, forEach, copyTo, copyToFast, reset,
 *     destroy on odd cycles); tracker.size() must drain to 0. A second tracker follows the
 *     `data` arrays of 256 instances that stay ALIVE: after destroy() every one
 *     must be reclaimed (destroy really drops the backing store).
 *   - @zakkster/lite-gc-profiler -- budget. Phase 2 runs each hot lane in its
 *     own function on an instance built outside the loop, HOT ops per lane, and
 *     gates every gated lane at major 0, minor 0, maxPauseMs 2.
 *
 * Teeth: the CONTROL lane allocates one subarray view per op and MUST read
 * minor >= 1, or the profiler is blind and the run fails. copyTo of 1024
 * samples is GATED (COPY1024_HOT ops, one push per op so start walks all 1024
 * positions: the head-0 case and both rotate branches run). Two lanes are
 * REPORTED, never gated: copyToFast of 1024 wrapped samples (set + subarray,
 * 2 views per call) and get(i) (boxes its result).
 * get(i) stays REPORTED, not a second CONTROL: its 16 B/op reads only a few
 * minors over HOT ops and can read 0 once V8 grows new space, which would be a
 * flake in a deterministic gate. Its 16 B teeth are gated deterministically by
 * test/alloc.mjs `CONTROL get(i), one 16 B box`.
 *
 * A build without copyToFast: the default target fails closed (exit 2); an
 * explicit build path (revert / must-fail run on an older build) skips the
 * copyToFast call in churn() and prints that lane as 'n/a'.
 *
 * res= on the GATE line is the minor-GC gate's resolution: the CONTROL lane's
 * alloc B/op divided by its minor count (= control bytes per minor / HOT ops).
 * A gated lane allocating less than res B/op can finish its window with
 * minor 0, so "minor 0" proves less than res B/op, not 0 B/op. 'n/a' when the
 * control read minor 0 or the alloc counter is missing. It drifts upward when
 * V8 grows new space. Printed, never gated (test/alloc.mjs gates B/op).
 * res assumes HOT ops; a lane of n ops resolves res x HOT / n, so the copyTo
 * 1024 lane (COPY1024_HOT = HOT/16) proves only < 16 x res B/op;
 * test/alloc.mjs gates it at < 1 B/op.
 *
 * Retention: churn() must leave exactly CYCLES instances tracked mid-run; a
 * tracker that missed any of them would make "live=0" prove less.
 *
 * alloc B/op on each lane is V8's total_allocated_bytes delta over the window /
 * ops (Node >= 24). One window carries a fixed 0.03-1 MB of tier-up and runtime
 * bytes that do not scale with ops, so the empty-loop BASELINE lane (HOT ops)
 * prints that floor and the GATE line reports the worst gated lane NET of it,
 * the floor rescaled to the lane's own op count (baseline B/op x HOT / n). REPORTED
 * only here; test/alloc.mjs (min over windows) is the B/op gate.
 *
 * Exit: 0 ok, 1 a gate failed, 2 the harness cannot run (no --expose-gc, a
 * devDependency missing, an unusable target).
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import v8 from 'node:v8';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));

if (typeof globalThis.gc !== 'function') {
    process.stderr.write('torture: needs node --expose-gc (npm run torture)\n');
    process.exit(2);
}
let GcProfiler, checkNoGc, createLeakTracker;
try {
    ({ GcProfiler, checkNoGc } = await import('@zakkster/lite-gc-profiler'));
    ({ createLeakTracker } = await import('@zakkster/lite-leak'));
} catch (e) {
    process.stderr.write('torture: missing devDependency (' + e.message + ') -- run: npm install\n');
    process.exit(2);
}
const url = target ? pathToFileURL(resolve(target)).href : new URL('../RingBuffer.js', import.meta.url).href;
let RingBuffer;
try {
    ({ RingBuffer } = await import(url));
} catch (e) {
    process.stderr.write('torture: cannot load ' + url + ' (' + e.message + ')\n');
    process.exit(2);
}
if (typeof RingBuffer !== 'function') {
    process.stderr.write('torture: ' + url + ' exports no RingBuffer\n');
    process.exit(2);
}
const HAS_FAST = typeof RingBuffer.prototype.copyToFast === 'function';
if (!HAS_FAST && !target) {
    process.stderr.write('torture: RingBuffer.js has no copyToFast (fail closed; pass an explicit build path for a revert run)\n');
    process.exit(2);
}

const CYCLES = 4096;
const HELD = 256;
const HOT = 2_000_000;
const CHUNK = 1000;         // ops per lane call: a hot path is called often, briefly
const WARM = 300_000;       // warmup ops per lane, outside the window
const COPY1024_HOT = HOT >> 4; // the 1024 lanes copy 1024 samples per op

const HAS_ALLOC_COUNTER = 'total_allocated_bytes' in v8.getHeapStatistics();
const allocated = () => (HAS_ALLOC_COUNTER ? v8.getHeapStatistics().total_allocated_bytes : NaN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Harness state lives in typed slots so the driver itself never boxes.
const SINK = new Float64Array(4);
const VALS = new Float64Array(16);
for (let i = 0; i < 16; i++) VALS[i] = i + 0.25;
const KEEP = [null];
const NO_OVERWRITE = { overwrite: false };
const SCRATCH_1024 = new Float32Array(1024);
const DST32_F32 = new Float32Array(32);
const DST32_F64 = new Float64Array(32);

// ONE hoisted forEach callback for every phase, so forEach's call site stays
// monomorphic and V8 can inline it (a non-inlined callback boxes its double arg).
function feCb(v) { SINK[1] += v; }
const noop = () => {};

const warns = [];
const tracker = createLeakTracker({
    name: 'lite-ring-buffer',
    onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});
const dataTracker = createLeakTracker({
    name: 'lite-ring-buffer-data',
    onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});
// The ring's buffer, followed beside its data: a copy caches the data's buffer
// in the ring, destroy() must drop that too.
const bufTracker = createLeakTracker({
    name: 'lite-ring-buffer-buf',
    onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});
// No kernels: a RingBuffer owns no timer, listener, observer or DOM node, so
// being collected is the desired outcome. Finalization itself is the proof.

// ---- phase 1: retention ---------------------------------------------------
// Own function: when the frame is torn down no register still holds the last
// instance (conservative stack scanning would pin it otherwise).
function churn() {
    for (let i = 0; i < CYCLES; i++) {
        const rb = new RingBuffer(1024);
        for (let k = 0; k < 1500; k++) rb.push(VALS[k & 15]);
        SINK[0] += rb.getOrDefault(i & 1023, -1);
        SINK[0] += rb.getOrDefault(2048, -1);
        rb.forEach(feCb);
        SINK[0] += rb.copyTo(SCRATCH_1024, 0);
        if (HAS_FAST) SINK[0] += rb.copyToFast(SCRATCH_1024, 0);
        rb.reset();
        if (i & 1) rb.destroy();
        // The cleanup and the tag capture nothing (held-value contract).
        tracker.track(rb, noop, 'ringbuffer', { audit: true });
    }
    return tracker.size();
}

function fillHeld(held) {
    for (let i = 0; i < HELD; i++) {
        const rb = new RingBuffer(1024);
        for (let k = 0; k < 64; k++) rb.push(VALS[k & 15]);
        // One copy before destroy(): the buffer cache starts empty, so without a
        // copy there is nothing for destroy() to drop.
        SINK[0] += rb.copyTo(SCRATCH_1024, 0);
        dataTracker.track(rb.data, noop, 'data');
        bufTracker.track(rb.data.buffer, noop, 'buf');
        held.push(rb);
    }
    return dataTracker.size();
}

function destroyHeld(held) {
    for (let i = 0; i < held.length; i++) held[i].destroy();
}

// FinalizationRegistry callbacks run on their own task: gc + a macrotask turn,
// bounded at 20 rounds so a real retention still fails. Rounds used are printed.
const DRAIN_ROUNDS = [0, 0, 0];
async function drain(t, slot) {
    let live = t.size();
    let g = 0;
    for (; g < 20 && live > 0; g++) {
        globalThis.gc();
        await sleep(25);
        live = t.size();
    }
    DRAIN_ROUNDS[slot] = g;
    return live;
}

const trackedMid = churn();
const live = await drain(tracker, 0);
const findings = tracker.audit();

const held = [];
const dataMid = fillHeld(held);
const bufMid = bufTracker.size();
destroyHeld(held);
const dataLive = await drain(dataTracker, 1);
const bufLive = await drain(bufTracker, 2);
// The instances are still reachable here: their data went, they did not.
let heldAlive = 0;
for (let i = 0; i < held.length; i++) if (held[i] instanceof RingBuffer && held[i].capacity === 0) heldAlive++;
const dataFindings = dataTracker.audit();
const bufFindings = bufTracker.audit();

// ---- phase 2: GC budget, one function per lane ----------------------------
function full(cap) {
    const rb = new RingBuffer(cap);
    for (let k = 0; k < cap + 7; k++) rb.push(VALS[k & 15]);
    return rb;
}

function lanePush(rb, n) {
    let stored = 0;
    for (let i = 0; i < n; i++) {
        const v = VALS[i & 15];
        rb.push(v);
        if (rb.tryPush(v, NO_OVERWRITE)) stored++;
        if (rb.tryPush(v)) stored++;
    }
    SINK[0] += stored;
}

function laneGet(rb, n) {
    for (let i = 0; i < n; i++) {
        SINK[0] += rb.getOrDefault(i & 1023, -1);
        SINK[0] += rb.getOrDefault(1024 + (i & 7), -1);
        SINK[0] += rb.getOrDefault(-1 - (i & 3), -1);
    }
}

function lanePeek(rb, empty, n) {
    let flags = 0;
    for (let i = 0; i < n; i++) {
        SINK[0] += rb.peekNewest() + rb.peekOldest() + empty.peekNewest() + empty.peekOldest();
        if (rb.isFull()) flags++;
        if (empty.isEmpty()) flags++;
        if (rb.isEmpty() || empty.isFull()) flags--;
    }
    SINK[2] += flags;
}

function laneForEach(rb, n) {
    for (let i = 0; i < n; i++) rb.forEach(feCb);
}

// A full capacity-32 ring pushed once per op: start walks 0..31, so the
// contiguous (start 0) and wrapped copies both run, into F32 and F64 dsts.
function laneCopy32(rb, n) {
    for (let i = 0; i < n; i++) {
        rb.push(VALS[i & 15]);
        SINK[0] += rb.copyTo(DST32_F32, 0);
        SINK[0] += rb.copyTo(DST32_F64);
    }
    SINK[1] += DST32_F32[n & 31] + DST32_F64[n & 31];
}

function laneReset(rb, n) {
    for (let i = 0; i < n; i++) {
        for (let k = 0; k < 32; k++) rb.push(VALS[k & 15]);
        rb.reset();
    }
    SINK[0] += rb.count;
}

function laneEmpty(n) {
    for (let i = 0; i < n; i++) SINK[3] += i & 7;
}

function laneControl(rb, n) {
    for (let i = 0; i < n; i++) KEEP[0] = rb.data.subarray(0, 4);
}

// A full capacity-1024 ring pushed once per op: start walks 0..1023, so the
// head-0 copy and both rotate branches (start <= n/2, start > n/2) run.
function laneCopy1024(rb, n) {
    for (let i = 0; i < n; i++) {
        rb.push(VALS[i & 15]);
        SINK[0] += rb.copyTo(SCRATCH_1024, 0);
    }
}

// No push: the ring stays wrapped (start 7), two views per call.
function laneCopyFast1024(rb, n) {
    for (let i = 0; i < n; i++) SINK[0] += rb.copyToFast(SCRATCH_1024, 0);
}

function laneGetBox(rb, n) {
    for (let i = 0; i < n; i++) KEEP[0] = rb.get(i & 1023);
}

const rbPush = full(1024);
const rbGet = full(1024);
const rbPeek = full(1024);
const rbEmpty = new RingBuffer(1024);
const rbEach = full(32);
const rbCopy = full(32);
const rbReset = new RingBuffer(32);
const rbCtl = full(32);
const rbBig = full(1024);
const rbFast = full(1024);
const rbBox = full(1024);

// kind: 'gated' (major 0, minor 0, maxPauseMs 2), 'control' (must read
// minor >= 1), 'reported' (printed, never gated). A null run: the method is
// missing on an explicit (older) build; the row prints 'n/a'.
const LANES = [
    ['BASELINE empty loop (alloc floor)', 'reported', HOT, (n) => laneEmpty(n)],
    ['push + tryPush, full ring', 'gated', HOT, (n) => lanePush(rbPush, n)],
    ['getOrDefault in/out of range', 'gated', HOT, (n) => laneGet(rbGet, n)],
    ['peekNewest/peekOldest/isFull/isEmpty', 'gated', HOT, (n) => lanePeek(rbPeek, rbEmpty, n)],
    ['forEach(hoisted fn), 32 samples', 'gated', HOT, (n) => laneForEach(rbEach, n)],
    ['copyTo 32 contig+wrapped F32+F64', 'gated', HOT, (n) => laneCopy32(rbCopy, n)],
    ['push x32 + reset, cap 32', 'gated', HOT, (n) => laneReset(rbReset, n)],
    ['CONTROL subarray view per op', 'control', HOT, (n) => laneControl(rbCtl, n)],
    ['copyTo 1024 F32, start walks 0..1023', 'gated', COPY1024_HOT, (n) => laneCopy1024(rbBig, n)],
    ['REPORTED copyToFast 1024 wrapped', 'reported', COPY1024_HOT, HAS_FAST ? (n) => laneCopyFast1024(rbFast, n) : null],
    ['REPORTED get(i)', 'reported', HOT, (n) => laneGetBox(rbBox, n)],
];
const GATED_RULES = { maxMajor: 0, maxMinor: 0, maxPauseMs: 2 };

// The window is many short calls, not one long one. One long call enters the
// lane in a low tier and reaches TurboFan only by OSR part-way through; the
// low tiers box doubles (an empty `SINK[k] += x` loop measured 32-48 B/op that
// way, --trace-opt Node 26.8.2), so the minor count would hang on when the
// background compile lands. Short calls get the lane function itself compiled
// during warmup, and every window call enters optimized code.
function drive(run, n) {
    for (let c = n / CHUNK; c > 0; c--) run(CHUNK);
}
// A mistyped kind would fall through to 'reported' and never gate.
const KINDS = ['gated', 'control', 'reported'];
for (const [name, kind] of LANES) {
    if (!KINDS.includes(kind)) {
        process.stderr.write('torture: lane "' + name + '" has unknown kind ' + String(kind) + '\n');
        process.exit(2);
    }
}
for (const [name, , n] of LANES) {
    if (n % CHUNK !== 0) {
        process.stderr.write('torture: lane "' + name + '" ops ' + n + ' not a multiple of ' + CHUNK + '\n');
        process.exit(2);
    }
}

const rows = [];
for (const [name, kind, n, run] of LANES) {
    if (run === null) {
        rows.push({ name, kind, n, ok: kind === 'reported', report: null, major: NaN, minor: NaN, maxMs: NaN, bop: NaN });
        continue;
    }
    drive(run, WARM);
    globalThis.gc();
    await sleep(25);
    const prof = new GcProfiler().start();
    const a0 = allocated();
    drive(run, n);
    const a1 = allocated();
    await sleep(50);
    const s = prof.summary();
    prof.stop();
    const report = kind === 'gated' ? checkNoGc(s, GATED_RULES) : null;
    let ok;
    if (kind === 'gated') ok = report.ok;
    else if (kind === 'control') ok = s.gc.minor >= 1;
    else ok = true;
    rows.push({
        name, kind, n, ok, report,
        major: s.gc.major, minor: s.gc.minor, maxMs: s.gc.maxMs,
        bop: (a1 - a0) / n,
    });
}

// ---- verdict ---------------------------------------------------------------
const pad = (s, w) => (s + ' '.repeat(w)).slice(0, w);
const fmtB = (x) => (x === x ? (Math.round(x * 10) / 10).toFixed(1) : 'n/a');
console.log('torture: ' + process.version + ' ' + process.arch + ' execArgv=' + (process.execArgv.join(' ') || '-') +
    ' HOT=' + HOT + ' CYCLES=' + CYCLES + ' build=' + (target || 'RingBuffer.js'));
console.log(pad('lane', 40) + pad('kind', 10) + pad('ops', 9) + pad('major', 7) + pad('minor', 7) +
    pad('maxMs', 8) + pad('alloc B/op', 12) + 'verdict');
let gMajor = 0;
let gMinor = 0;
let gMaxMs = 0;
let gAlloc = -Infinity;
const baseBop = rows[0].bop;
let lanesOk = true;
for (const r of rows) {
    const na = r.major !== r.major;
    console.log(pad(r.name, 40) + pad(r.kind, 10) + pad(String(r.n), 9) + pad(na ? 'n/a' : String(r.major), 7) +
        pad(na ? 'n/a' : String(r.minor), 7) + pad(na ? 'n/a' : r.maxMs.toFixed(2), 8) + pad(fmtB(r.bop), 12) +
        (na ? 'n/a' : r.kind === 'reported' ? 'reported' : r.ok ? 'ok' : 'FAIL'));
    if (r.kind === 'gated') {
        gMajor += r.major;
        gMinor += r.minor;
        if (r.maxMs > gMaxMs) gMaxMs = r.maxMs;
        const net = r.bop - baseBop * HOT / r.n;
        if (!(net <= gAlloc)) gAlloc = net;
    }
    if (!r.ok) lanesOk = false;
}

const retentionOk = trackedMid === CYCLES && live === 0 && findings.length === 0;
const dataOk = dataMid === HELD && dataLive === 0 && heldAlive === HELD && dataFindings.length === 0 &&
    bufMid === HELD && bufLive === 0 && bufFindings.length === 0;
const ok = lanesOk && retentionOk && dataOk;

console.log('retention: trackedMid=' + trackedMid + ' live=' + live + ' drains=' + DRAIN_ROUNDS[0] + ' findings=' + findings.length +
    ' | held data: tracked=' + dataMid + ' live=' + dataLive + ' drains=' + DRAIN_ROUNDS[1] + ' instancesAlive=' + heldAlive + '/' + HELD +
    ' | held buf: tracked=' + bufMid + ' live=' + bufLive + ' drains=' + DRAIN_ROUNDS[2]);
// Gate resolution: control bytes per minor / HOT ops ('n/a' if minor 0 or NaN).
const ctlRow = rows.find((r) => r.kind === 'control');
const res = ctlRow && ctlRow.minor > 0 ? ctlRow.bop / ctlRow.minor : NaN;
console.log(
    'GATE leak=size ' + live + '/0 findings=' + (findings.length + dataFindings.length + bufFindings.length) +
    ' warnings=' + warns.length +
    ' | gc major=' + gMajor + ' minor=' + gMinor + ' maxMs=' + gMaxMs.toFixed(2) +
    ' res=' + (res === res ? res.toFixed(2) : 'n/a') + ' B/op' +
    ' | alloc=' + fmtB(gAlloc) + ' B/op (worst gated lane net of baseline ' + fmtB(baseBop) + '; reported)' +
    ' | ' + (ok ? 'ok' : 'FAIL')
);
if (!ok) {
    for (const r of rows) {
        if (r.ok) continue;
        if (r.major !== r.major) {
            console.error('  lane "' + r.name + '" not measured (method missing on this build)');
            continue;
        }
        if (r.kind === 'control') {
            console.error('  control "' + r.name + '" read minor=' + r.minor + ' (want >= 1): profiler is blind');
            continue;
        }
        if (r.report.verdict !== 'pass' && r.report.violations.length === 0) {
            console.error('  lane "' + r.name + '" verdict ' + r.report.verdict + ' (' + String(r.report.reason) + ')');
        }
        for (const v of r.report.violations) {
            console.error('  lane "' + r.name + '" violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
        }
    }
    if (trackedMid !== CYCLES) console.error('  retention: tracked ' + trackedMid + ' of ' + CYCLES + ' mid-run (want exact)');
    if (live !== 0) console.error('  retention: ' + live + ' RingBuffer instances outlived their scope');
    for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
    if (dataMid !== HELD) console.error('  held data: tracked ' + dataMid + ' of ' + HELD);
    if (dataLive !== 0) console.error('  held data: ' + dataLive + ' backing arrays survived destroy()');
    if (heldAlive !== HELD) console.error('  held data: only ' + heldAlive + ' destroyed instances still reachable');
    for (const f of dataFindings) console.error('  finding ' + f.kind + ':' + f.reason);
    if (bufMid !== HELD) console.error('  held buf: tracked ' + bufMid + ' of ' + HELD);
    if (bufLive !== 0) console.error('  held buf: ' + bufLive + ' backing buffers survived destroy()');
    for (const f of bufFindings) console.error('  finding ' + f.kind + ':' + f.reason);
    process.exitCode = 1;
}
