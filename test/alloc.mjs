/**
 * @zakkster/lite-ring-buffer -- allocation gate.
 *
 *     node --expose-gc test/alloc.mjs                -> table + "ok", exit 0
 *     node --expose-gc test/alloc.mjs --report       -> table only, never fails
 *     node --expose-gc test/alloc.mjs <path/to/RingBuffer.js> --report
 *
 * Measures bytes allocated per call (B/op) for every method the docs call
 * allocation-free, plus the documented allocating paths, and gates on them.
 *
 * Method: V8's `total_allocated_bytes` counter (Node >= 24) read around a window
 * of N calls in a hot loop, minus an empty-loop baseline measured the same way.
 * It counts every allocation, including boxes that die young -- a heapUsed delta
 * cannot see those once a scavenge runs. Steady state is the MINIMUM over windows
 * 1..W-1: window 0 runs pre-TurboFan code, which does not inline and boxes. The
 * driver keeps its accumulator in a Float64Array slot so the harness itself does
 * not box.
 *
 * Teeth: the control lanes must read their known size (`get(i)` one bare
 * 16 B box, a `subarray` view >= 100 B), the empty-loop baseline must sit
 * within +/-1 B, and every comparison fails on NaN, so a blind or broken
 * counter cannot pass.
 *
 * copyTo lanes: a capacity-1024 ring covers both copy routes -- a full ring
 * into a Float32Array (intrinsic set + copyWithin + rotate: head 0, start n/2,
 * start > n/2) and the masked loop (non-full, and every Float64Array dst). The
 * capacity-8 lane keeps data and dst ON-HEAP: the alias check reads their
 * intrinsic `buffer`, which materializes an ArrayBuffer once (window 0, never
 * floored on); the steady state must still be 0. copyToFast (set + subarray,
 * one view per ring half) is REPORTED, never gated.
 *
 * A build without copyToFast: the default target fails closed (exit 2); an
 * explicit build path (revert / must-fail runs on an older build) prints its
 * copyToFast rows as 'n/a' and gates the rest.
 *
 * Inlining matters: a method that returns a non-integer double boxes its result
 * whenever the call is NOT inlined (V8 returns tagged values). Run with
 * `--no-turbo-inlining` to see that lane; the docs state it.
 */

import v8 from 'node:v8';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const REPORT = args.includes('--report');
const target = args.find((a) => !a.startsWith('--'));
const url = target ? pathToFileURL(resolve(target)).href : new URL('../RingBuffer.js', import.meta.url).href;
const { RingBuffer } = await import(url);
const HAS_FAST = typeof RingBuffer.prototype.copyToFast === 'function';
if (!HAS_FAST && !target) {
    process.stderr.write('alloc: RingBuffer.js has no copyToFast (fail closed; pass an explicit build path for a revert run)\n');
    process.exit(2);
}

if (typeof globalThis.gc !== 'function') {
    process.stderr.write('alloc: needs node --expose-gc\n');
    process.exit(2);
}
if (!('total_allocated_bytes' in v8.getHeapStatistics())) {
    process.stderr.write('alloc: v8.getHeapStatistics().total_allocated_bytes missing (Node >= 24 needed)\n');
    process.exit(2);
}

const N = 1_000_000;
const WINDOWS = 6;
const sink = new Float64Array(1);
const keep = [null];

function allocated() {
    return v8.getHeapStatistics().total_allocated_bytes;
}

/** B/op for `body(n)`, which must run its op n times. Min over windows 1..W-1. */
function measure(body) {
    let best = Infinity;
    let first = 0;
    for (let w = 0; w < WINDOWS; w++) {
        const a = allocated();
        body(N);
        const b = allocated();
        const per = (b - a) / N;
        if (w === 0) first = per;
        else if (per < best) best = per;
    }
    return { best, first };
}

// Each lane is its own function so type feedback never crosses lanes.
// 8 live samples at x + 0.5 (not Smi-representable), capacity 8, wrapped.
function filled(cap, n) {
    const rb = new RingBuffer(cap);
    for (let i = 0; i < n; i++) rb.push(i + 0.5);
    return rb;
}

const vals = new Float64Array(16);
for (let i = 0; i < 16; i++) vals[i] = i + 0.25;

const lanes = [
    ['baseline (empty loop)', null, () => (n) => { for (let i = 0; i < n; i++) sink[0] += i & 7; }],
    ['push(v)', 0, () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) rb.push(vals[i & 15]); }; }],
    ['tryPush(v)', 0, () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) rb.tryPush(vals[i & 15]); }; }],
    ['CONTROL get(i), one 16 B box', 'box16', () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) sink[0] += rb.get(i & 7); }; }],
    ['getOrDefault(i, 0)', 0, () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) sink[0] += rb.getOrDefault(i & 7, 0); }; }],
    ['getOrDefault(i, 0) out of range', 0, () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) sink[0] += rb.getOrDefault((i & 7) + 8, 0); }; }],
    ['peekNewest()', 0, () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) sink[0] += rb.peekNewest(); }; }],
    ['peekOldest()', 0, () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) sink[0] += rb.peekOldest(); }; }],
    ['isFull() / isEmpty()', 0, () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) sink[0] += (rb.isFull() ? 1 : 0) + (rb.isEmpty() ? 1 : 0); }; }],
    ['forEach(hoisted fn), 8 samples', 0, () => {
        const rb = filled(8, 13);
        const fn = (v) => { sink[0] += v; };
        return (n) => { for (let i = 0; i < n; i++) rb.forEach(fn); };
    }],
    ['copyTo 32, contiguous', 0, () => { const rb = filled(32, 32); const out = new Float32Array(32); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 32, wrapped', 0, () => { const rb = filled(32, 50); const out = new Float32Array(32); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 32 -> Float64Array, wrapped', 0, () => { const rb = filled(32, 50); const out = new Float64Array(32); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 33, contiguous', 0, () => { const rb = filled(64, 33); const out = new Float32Array(64); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 64, wrapped', 0, () => { const rb = filled(64, 100); const out = new Float32Array(64); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    // Capacity 1024: 1024 pushes -> head 0 (start 0); +512 -> start n/2; +768 -> start > n/2.
    ['copyTo 1024 F32, full, head 0', 0, () => { const rb = filled(1024, 1024); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 1024 F32, full, start 512', 0, () => { const rb = filled(1024, 1536); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 1024 F32, full, start 768', 0, () => { const rb = filled(1024, 1792); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 1023 F32, non-full', 0, () => { const rb = filled(1024, 1023); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 1024 -> Float64Array, contiguous', 0, () => { const rb = filled(1024, 1024); const out = new Float64Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyTo 1024 -> Float64Array, wrapped', 0, () => { const rb = filled(1024, 1300); const out = new Float64Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    // On-heap data (32 B) and dst: window 0 materializes their `buffer` once.
    ['copyTo 8 full wrapped, on-heap', 0, () => { const rb = filled(8, 13); const out = new Float32Array(8); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['copyToFast 1024, contiguous', 'report', HAS_FAST ? () => { const rb = filled(1024, 1024); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyToFast(out); }; } : null],
    ['copyToFast 1024, wrapped', 'report', HAS_FAST ? () => { const rb = filled(1024, 1300); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyToFast(out); }; } : null],
    ['getOrDefault(i) no default', 'report', () => { const rb = filled(8, 13); return (n) => { for (let i = 0; i < n; i++) keep[0] = rb.getOrDefault(i & 7); }; }],
    // Controls: must allocate, or the counter is blind and the gate has no teeth.
    ['CONTROL subarray per op', 'view', () => { const rb = filled(32, 50); return (n) => { for (let i = 0; i < n; i++) keep[0] = rb.data.subarray(0, 4); }; }],
];

// A mistyped label would turn a gated lane into an ungated one.
const LABELS = [null, 0, 'box16', 'view', 'report'];
for (const [name, expect] of lanes) {
    if (!LABELS.includes(expect)) {
        process.stderr.write('alloc: lane "' + name + '" has unknown expect label ' + String(expect) + '\n');
        process.exit(2);
    }
}

const rows = [];
let base = 0;
for (const [name, expect, make] of lanes) {
    // null make: the method is missing on an explicit (older) build -> 'n/a'.
    if (make === null) { rows.push({ name, expect, net: NaN, first: NaN }); continue; }
    globalThis.gc();
    const { best, first } = measure(make());
    if (expect === null) base = best;
    const net = expect === null ? best : best - base;
    rows.push({ name, expect, net, first: first - base });
}

const pad = (s, w) => (s + ' '.repeat(w)).slice(0, w);
const fmt = (x) => (x === x ? (Math.round(x * 10) / 10).toFixed(1) : 'n/a');
console.log('alloc: ' + process.version + ' ' + process.arch + ' execArgv=' + (process.execArgv.join(' ') || '-') +
    ' N=' + N + ' windows=' + WINDOWS + ' build=' + (target || 'RingBuffer.js'));
console.log(pad('lane', 40) + pad('B/op', 10) + 'window0 B/op');
const fails = [];
for (const r of rows) {
    console.log(pad(r.name, 40) + pad(fmt(r.net), 10) + fmt(r.first));
    // Below 1 B/op is counter noise at N=1M (< 1 MB over the window). Every
    // test is written so that NaN fails it.
    if (r.expect === null && !(Math.abs(r.net) < 1)) fails.push('baseline reads ' + fmt(r.net) + ' B/op (want |x| < 1): counter is unreliable');
    if (r.expect === 0 && !(r.net < 1)) fails.push(r.name + ' allocates ' + fmt(r.net) + ' B/op (want 0)');
    if (r.expect === 'box16' && !(r.net >= 15 && r.net < 17)) fails.push(r.name + ' reads ' + fmt(r.net) + ' B/op (want 16): counter is blind');
    if (r.expect === 'view' && !(r.net >= 100)) fails.push(r.name + ' reads ' + fmt(r.net) + ' B/op (want >= 100): counter is blind');
}
if (REPORT) process.exit(0);
if (fails.length) {
    for (const f of fails) process.stderr.write('alloc: FAIL ' + f + '\n');
    process.exit(1);
}
console.log('ok');
