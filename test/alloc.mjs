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
 * Method: V8's `total_allocated_bytes` counter (present on Node v26.8.2, absent
 * through v24.22.3) read around a window of N calls in a hot loop, minus an
 * empty-loop baseline measured the same way.
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
 * MEGA lanes (audit 2026-11-12 F1): appended LAST, because they poison
 * copyTo's feedback for the rest of the process. Before the first MEGA lane
 * the run loop calls megaPollute(): copyTo into every other element type
 * (Int8 .. Uint32, + Float16 when defined) + 3 Float64Array subclasses (the
 * Float64 site then holds 4 maps, still polymorphic; a site shared with
 * Float32 would hold 5 and box), at 32 and 1023 samples, so a single shared
 * store site would be megamorphic and box every non-integer sample (~512 B
 * per 32-sample copy, ~16 kB per 1023). The gated MEGA lanes then copy into
 * Float32Array / Float64Array and must still read 0: each element family has
 * its own store site. 'MEGA 1024 F32, full, start 768' guards the rotCopy
 * path; it passes on 63eb5bc1 too (a guard, not a revert-checked gate).
 * 'MEGA 32 -> Int16Array' (the megamorphic site itself) is a must-allocate
 * CONTROL (>= 256 B/op): it fails if the pollution did not happen.
 * The LAST lane adds 4 Float32Array subclasses and is REPORTED: 5 classes on
 * the Float32 site is the documented residual (F1b). Self-check: once a MEGA
 * lane appears every later lane is MEGA, and the subclass lane is last, else
 * exit 2.
 *
 * pushBatch lanes (R2): 128 samples per call (values x + 0.5), N calls per
 * window like every lane. Float32Array src: whole + contiguous (the intrinsic
 * `set` path, capacity 1024), a +3 slice (masked loop), wrapped (capacity 128,
 * head 64) and count > capacity (capacity 64); Float64Array src: contiguous,
 * wrapped, count > capacity. All gated at 0. The BIGINT lane runs the Float64
 * wrapped call after ONE pushBatch(BigInt64Array) that must throw (exit 2 if it
 * does not): a BigInt src is rejected before any store site, so it cannot
 * pollute a float loop. Its must-allocate CONTROL is maskBig, a one-loop MASK
 * shape defined in this file with the same history (warm Float64, one caught
 * BigInt64Array call): label 'boxes', >= 1024 B/op (nominal 2048 = one 16 B
 * HeapNumber per sample).
 * After 'MEGA 32 -> Int16Array' the run loop calls pbPollute(): 400 loop-path
 * pushBatch calls (srcOffset 3) for each of Float32Array + 3 subclasses and
 * Float64Array + 3 subclasses (never copyTo), so each family's loop site holds
 * its 4-class budget and a single shared loop would hold 8 (megamorphic). The
 * 'MEGA pushBatch' lanes (Float32 and Float64 src, wrapped) must still read 0;
 * maskMega, fed the same 8 classes, is their 'boxes' CONTROL. Self-check: the
 * pushBatch MEGA lanes and their controls come after the Int16 lane and
 * before the MEGA copyLast lanes, and no earlier MEGA lane names them.
 *
 * copyLast lanes (R3): copyLast(dst, 0, n) with n 120 on a full capacity-1024
 * ring and n 1024 on a full capacity-2048 ring, each contiguous (start + n <=
 * capacity) and straddling (the newest n wrap past slot capacity-1), into a
 * Float32Array and a Float64Array (the masked loops: k < capacity); plus the
 * whole window copyLast(dst, 0, count) of a full 1024 ring into a Float32Array
 * at head 768 (the rotCopy path) and into a Float64Array. All gated at 0.
 * copyLastFast 120 contiguous and straddling (set + subarray, one view per
 * ring half it spans) is REPORTED, never gated.
 * After the pushBatch MEGA block the run loop calls clPollute(): 400
 * copyLast(d, 0, 120) calls into every other element type (Int8 .. Uint32,
 * + Float16 when defined, as megaPollute) and 3 Float64Array subclasses
 * (never copyTo / pushBatch), so copyLast's Float64 site holds 4 maps and a
 * site shared with the other kinds would be megamorphic. 'MEGA copyLast 120
 * F32 / F64 straddling' must still read 0 (a merged Float64 branch reads
 * nominal 1920 B/op = 120 x 16 B); 'MEGA copyLast 32 -> Int16Array' is their
 * must-allocate 'mega' CONTROL. Self-check: the MEGA copyLast lanes come after
 * the pushBatch MEGA block and right before the subclass lane, and the Int16
 * control is among them, else exit 2.
 *
 * A build without copyToFast, pushBatch or copyLast / copyLastFast: the
 * default target fails closed (exit 2); an explicit build path (revert /
 * must-fail runs on an older build) prints those rows as 'n/a'. A gated 'n/a'
 * row fails (a revert run must fail); a reported one does not.
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
const HAS_PB = typeof RingBuffer.prototype.pushBatch === 'function';
if (!HAS_PB && !target) {
    process.stderr.write('alloc: RingBuffer.js has no pushBatch (fail closed; pass an explicit build path for a revert run)\n');
    process.exit(2);
}
const HAS_CL = typeof RingBuffer.prototype.copyLast === 'function' &&
    typeof RingBuffer.prototype.copyLastFast === 'function';
if (!HAS_CL && !target) {
    process.stderr.write('alloc: RingBuffer.js has no copyLast / copyLastFast (fail closed; pass an explicit build path for a revert run)\n');
    process.exit(2);
}

if (typeof globalThis.gc !== 'function') {
    process.stderr.write('alloc: needs node --expose-gc\n');
    process.exit(2);
}
if (!('total_allocated_bytes' in v8.getHeapStatistics())) {
    process.stderr.write('alloc: v8.getHeapStatistics().total_allocated_bytes missing (present on Node v26.8.2, absent through v24.22.3)\n');
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

// pushBatch: samples per call, and a src of class K holding x + 0.5 (not Smi-representable).
const PB = 128;
function srcOf(K, len) {
    const s = new K(len);
    for (let i = 0; i < len; i++) s[i] = i + 0.5;
    return s;
}
const BIG = new BigInt64Array(PB);

// The MASK shape (one masked loop for every src family), as two separate
// functions so each control has its own feedback: the must-allocate controls.
function maskBig(data, src, h, o, n, mask) {
    for (let i = 0; i < n; i++) data[(h + i) & mask] = src[o + i];
}
function maskMega(data, src, h, o, n, mask) {
    for (let i = 0; i < n; i++) data[(h + i) & mask] = src[o + i];
}

/** One BigInt64Array call that must throw; exit 2 if it does not (the BigInt lane / control would prove nothing). */
function bigThrows(name, call) {
    try {
        call();
    } catch (e) {
        return;
    }
    process.stderr.write('alloc: ' + name + ': the BigInt64Array call did not throw\n');
    process.exit(2);
}

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
    // pushBatch, 128 samples per call. Capacity 1024 from head 0: head stays a multiple of 128 (contiguous);
    // capacity 128 from head 64: every call wraps; capacity 64: count > capacity.
    ['pushBatch F32 128 whole, cap 1024 (set)', 0, HAS_PB ? () => { const rb = filled(1024, 1024); const s = srcOf(Float32Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    ['pushBatch F32 128 slice +3, cap 1024', 0, HAS_PB ? () => { const rb = filled(1024, 1024); const s = srcOf(Float32Array, PB + 3); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s, 3, PB); }; } : null],
    ['pushBatch F32 128 wrapped, cap 128 h64', 0, HAS_PB ? () => { const rb = filled(128, 192); const s = srcOf(Float32Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    ['pushBatch F32 128 > cap 64', 0, HAS_PB ? () => { const rb = filled(64, 64); const s = srcOf(Float32Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    ['pushBatch F64 128, cap 1024 contiguous', 0, HAS_PB ? () => { const rb = filled(1024, 1024); const s = srcOf(Float64Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    ['pushBatch F64 128 wrapped, cap 128 h64', 0, HAS_PB ? () => { const rb = filled(128, 192); const s = srcOf(Float64Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    ['pushBatch F64 128 > cap 64', 0, HAS_PB ? () => { const rb = filled(64, 64); const s = srcOf(Float64Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    // BigInt: one throwing call, then the Float64 wrapped lane again (loopF64 already warm from the lane above).
    ['BIGINT pushBatch F64 128 wrapped', 0, HAS_PB ? () => {
        const rb = filled(128, 192);
        const s = srcOf(Float64Array, PB);
        bigThrows('BIGINT pushBatch', () => rb.pushBatch(BIG, 0, PB));
        return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); };
    } : null],
    ['CONTROL maskBig F64 128 wrapped', 'boxes', () => {
        const rb = filled(128, 192);
        const d = rb.data;
        const s = srcOf(Float64Array, PB);
        for (let i = 0; i < 400; i++) maskBig(d, s, 64, 0, PB, 127);
        bigThrows('CONTROL maskBig', () => maskBig(d, BIG, 64, 0, PB, 127));
        return (n) => { for (let i = 0; i < n; i++) maskBig(d, s, 64, 0, PB, 127); };
    }],
    // copyLast (R3). Full rings: cap 1024 at 1536 pushes -> head 512 (n 120 starts at 392, contiguous); 1084 -> head 60
    // (start 964, straddles); cap 2048 at 3584 -> head 1536 (n 1024 starts at 512); 2560 -> head 512 (start 1536,
    // straddles). k < capacity: the masked loops. copyLast(count) on a full 1024 ring at head 768: F32 = rotCopy.
    ['copyLast 120 F32, cap 1024 contiguous', 0, HAS_CL ? () => { const rb = filled(1024, 1536); const out = new Float32Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 120); }; } : null],
    ['copyLast 120 F32, cap 1024 straddling', 0, HAS_CL ? () => { const rb = filled(1024, 1084); const out = new Float32Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 120); }; } : null],
    ['copyLast 120 F64, cap 1024 contiguous', 0, HAS_CL ? () => { const rb = filled(1024, 1536); const out = new Float64Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 120); }; } : null],
    ['copyLast 120 F64, cap 1024 straddling', 0, HAS_CL ? () => { const rb = filled(1024, 1084); const out = new Float64Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 120); }; } : null],
    ['copyLast 1024 F32, cap 2048 contiguous', 0, HAS_CL ? () => { const rb = filled(2048, 3584); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 1024); }; } : null],
    ['copyLast 1024 F32, cap 2048 straddling', 0, HAS_CL ? () => { const rb = filled(2048, 2560); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 1024); }; } : null],
    ['copyLast 1024 F64, cap 2048 contiguous', 0, HAS_CL ? () => { const rb = filled(2048, 3584); const out = new Float64Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 1024); }; } : null],
    ['copyLast 1024 F64, cap 2048 straddling', 0, HAS_CL ? () => { const rb = filled(2048, 2560); const out = new Float64Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 1024); }; } : null],
    ['copyLast(count) F32 1024 full, head 768', 0, HAS_CL ? () => { const rb = filled(1024, 1792); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, rb.count); }; } : null],
    ['copyLast(count) F64 1024 full, head 768', 0, HAS_CL ? () => { const rb = filled(1024, 1792); const out = new Float64Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, rb.count); }; } : null],
    ['copyLastFast 120, cap 1024 contiguous', 'report', HAS_CL ? () => { const rb = filled(1024, 1536); const out = new Float32Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLastFast(out, 0, 120); }; } : null],
    ['copyLastFast 120, cap 1024 straddling', 'report', HAS_CL ? () => { const rb = filled(1024, 1084); const out = new Float32Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLastFast(out, 0, 120); }; } : null],
    // Controls: must allocate, or the counter is blind and the gate has no teeth.
    ['CONTROL subarray per op', 'view', () => { const rb = filled(32, 50); return (n) => { for (let i = 0; i < n; i++) keep[0] = rb.data.subarray(0, 4); }; }],
    // MEGA lanes: keep them last (see header). The run loop calls megaPollute() before the first one.
    ['MEGA 32 F32, wrapped', 0, () => { const rb = filled(32, 50); const out = new Float32Array(32); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['MEGA 1023 F32, non-full', 0, () => { const rb = filled(1024, 1023); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['MEGA 1024 -> Float64Array, wrapped', 0, () => { const rb = filled(1024, 1300); const out = new Float64Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    // rotCopy guard: the full-ring rotate never used the shared site (passes on 63eb5bc1 too).
    ['MEGA 1024 F32, full, start 768', 0, () => { const rb = filled(1024, 1792); const out = new Float32Array(1024); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    ['MEGA 32 -> Int16Array, wrapped', 'mega', () => { const rb = filled(32, 50); const out = new Int16Array(32); return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); }; }],
    // The run loop calls pbPollute() before the first 'MEGA pushBatch' lane (8 src classes, 4 per family).
    ['MEGA pushBatch F32 128 wrapped', 0, HAS_PB ? () => { const rb = filled(128, 192); const s = srcOf(Float32Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    ['MEGA pushBatch F64 128 wrapped', 0, HAS_PB ? () => { const rb = filled(128, 192); const s = srcOf(Float64Array, PB); return (n) => { for (let i = 0; i < n; i++) rb.pushBatch(s); }; } : null],
    ['MEGA CONTROL maskMega F32 128 wrapped', 'boxes', () => { const rb = filled(128, 192); const d = rb.data; const s = srcOf(Float32Array, PB); return (n) => { for (let i = 0; i < n; i++) maskMega(d, s, 64, 0, PB, 127); }; }],
    ['MEGA CONTROL maskMega F64 128 wrapped', 'boxes', () => { const rb = filled(128, 192); const d = rb.data; const s = srcOf(Float64Array, PB); return (n) => { for (let i = 0; i < n; i++) maskMega(d, s, 64, 0, PB, 127); }; }],
    // The run loop calls clPollute() before the first 'MEGA copyLast' lane (copyLast into 7+ other kinds + 3 F64 subclasses).
    ['MEGA copyLast 120 F32, straddling', 0, HAS_CL ? () => { const rb = filled(1024, 1084); const out = new Float32Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 120); }; } : null],
    ['MEGA copyLast 120 F64, straddling', 0, HAS_CL ? () => { const rb = filled(1024, 1084); const out = new Float64Array(120); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 120); }; } : null],
    ['MEGA copyLast 32 -> Int16Array', 'mega', HAS_CL ? () => { const rb = filled(32, 50); const out = new Int16Array(32); return (n) => { for (let i = 0; i < n; i++) rb.copyLast(out, 0, 32); }; } : null],
    // LAST: 4 Float32Array subclasses + the plain class = 5 on the Float32 site (residual F1b).
    ['MEGA 32 F32 after 4 F32 subclasses', 'report', () => {
        const rb = filled(32, 50);
        const rb2 = filled(1024, 1023);
        const subs = [class S1 extends Float32Array {}, class S2 extends Float32Array {},
            class S3 extends Float32Array {}, class S4 extends Float32Array {}];
        for (const K of subs) {
            const d = new K(1024);
            for (let i = 0; i < 400; i++) { rb.copyTo(d); rb2.copyTo(d); }
        }
        const out = new Float32Array(32);
        return (n) => { for (let i = 0; i < n; i++) rb.copyTo(out); };
    }],
];

/** Before the first MEGA lane: copyTo into every non-float element type + 3 Float64Array subclasses, 400 calls each at 32 and 1023 samples. */
function megaPollute() {
    const kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array];
    if (typeof globalThis.Float16Array === 'function') kinds.push(globalThis.Float16Array);
    kinds.push(class P1 extends Float64Array {}, class P2 extends Float64Array {}, class P3 extends Float64Array {});
    const rb = filled(32, 50);
    const rb2 = filled(1024, 1023);
    for (const K of kinds) {
        const d = new K(1024);
        for (let i = 0; i < 400; i++) { rb.copyTo(d); rb2.copyTo(d); }
    }
}

/**
 * Before the first 'MEGA pushBatch' lane: 400 loop-path pushBatch calls (srcOffset 3) and 400 maskMega calls
 * for each of Float32Array + 3 subclasses and Float64Array + 3 subclasses. Never calls copyTo.
 */
function pbPollute() {
    const kinds = [Float32Array, class F32a extends Float32Array {}, class F32b extends Float32Array {},
        class F32c extends Float32Array {}, Float64Array, class F64a extends Float64Array {},
        class F64b extends Float64Array {}, class F64c extends Float64Array {}];
    const rb = filled(128, 192);
    for (const K of kinds) {
        const s = srcOf(K, PB + 3);
        for (let i = 0; i < 400; i++) {
            if (HAS_PB) rb.pushBatch(s, 3, PB);
            maskMega(rb.data, s, 64, 3, PB, 127);
        }
    }
}

/**
 * Before the first 'MEGA copyLast' lane: 400 copyLast(d, 0, 120) calls (straddling) into every non-float element
 * type (+ Float16 when defined) and 3 Float64Array subclasses. Never calls copyTo or pushBatch. On a build without
 * copyLast it does nothing (those lanes are 'n/a' and fail).
 */
function clPollute() {
    if (!HAS_CL) return;
    const kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array];
    if (typeof globalThis.Float16Array === 'function') kinds.push(globalThis.Float16Array);
    kinds.push(class L1 extends Float64Array {}, class L2 extends Float64Array {}, class L3 extends Float64Array {});
    const rb = filled(1024, 1084);
    for (const K of kinds) {
        const d = new K(1024);
        for (let i = 0; i < 400; i++) rb.copyLast(d, 0, 120);
    }
}

// The MEGA lanes poison copyTo's feedback for every later lane: they must be the tail, the subclass lane last.
const megaFirst = lanes.findIndex(([name]) => name.startsWith('MEGA '));
const megaLast = lanes.length - 1;
let megaBad = megaFirst < 0 || !lanes[megaLast][0].includes('subclasses');
for (let i = megaFirst; !megaBad && i <= megaLast; i++) {
    if (!lanes[i][0].startsWith('MEGA ')) megaBad = true;
    if (i !== megaLast && lanes[i][0].includes('subclasses')) megaBad = true;
}
if (megaBad) {
    process.stderr.write('alloc: MEGA lanes must be the last lanes, the subclass lane last of all\n');
    process.exit(2);
}
// clPollute() runs before the first 'MEGA copyLast' lane: after the pushBatch MEGA block, and every lane from there
// up to the subclass lane is a 'MEGA copyLast' lane; the two gated MEGA copyLast lanes and the Int16 control are present.
const isClMega = (name) => name.startsWith('MEGA copyLast');
const clFirst = lanes.findIndex(([name]) => isClMega(name));
const pbFirst = lanes.findIndex(([name]) => name.startsWith('MEGA pushBatch'));
const CL_MEGA = ['MEGA copyLast 120 F32, straddling', 'MEGA copyLast 120 F64, straddling', 'MEGA copyLast 32 -> Int16Array'];
let clBad = pbFirst < 0 || !(clFirst > pbFirst) || !CL_MEGA.every((m) => lanes.some(([name]) => name === m));
for (let i = clFirst; !clBad && i < megaLast; i++) {
    if (!isClMega(lanes[i][0])) clBad = true;
}
if (clBad) {
    process.stderr.write('alloc: MEGA copyLast lanes (both gated lanes + the Int16 control) must follow the pushBatch MEGA block, right before the subclass lane\n');
    process.exit(2);
}
// pbPollute() runs before the first 'MEGA pushBatch' lane: after the Int16 control, and every MEGA lane from there
// up to the first MEGA copyLast lane is a pushBatch lane or a maskMega control (both kinds present); none before it.
const isPbMega = (name) => name.startsWith('MEGA pushBatch') || name.startsWith('MEGA CONTROL maskMega');
const int16At = lanes.findIndex(([name]) => name.startsWith('MEGA 32 -> Int16Array'));
let pbBad = int16At < 0 || !(pbFirst > int16At) ||
    !lanes.some(([name]) => name.startsWith('MEGA CONTROL maskMega'));
for (let i = megaFirst; !pbBad && i < megaLast; i++) {
    if ((i >= pbFirst && i < clFirst) !== isPbMega(lanes[i][0])) pbBad = true;
}
if (pbBad) {
    process.stderr.write('alloc: MEGA pushBatch lanes and maskMega controls must follow the Int16 lane, before the subclass lane\n');
    process.exit(2);
}

// A mistyped label would turn a gated lane into an ungated one.
const LABELS = [null, 0, 'box16', 'view', 'report', 'mega', 'boxes'];
for (const [name, expect] of lanes) {
    if (!LABELS.includes(expect)) {
        process.stderr.write('alloc: lane "' + name + '" has unknown expect label ' + String(expect) + '\n');
        process.exit(2);
    }
}

const rows = [];
let base = 0;
for (let li = 0; li < lanes.length; li++) {
    const [name, expect, make] = lanes[li];
    if (li === megaFirst) megaPollute();
    if (li === pbFirst) pbPollute();
    if (li === clFirst) clPollute();
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
    if (r.expect === 'mega' && !(r.net >= 256)) fails.push(r.name + ' reads ' + fmt(r.net) + ' B/op (want >= 256): the pollution did not make the shared site megamorphic');
    if (r.expect === 'boxes' && !(r.net >= 1024)) fails.push(r.name + ' reads ' + fmt(r.net) + ' B/op (want >= 1024): the MASK control did not box, so its lane proves nothing');
}
if (REPORT) process.exit(0);
if (fails.length) {
    for (const f of fails) process.stderr.write('alloc: FAIL ' + f + '\n');
    process.exit(1);
}
console.log('ok');
