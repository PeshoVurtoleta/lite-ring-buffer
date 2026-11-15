// Kills the engine mutants of audit 2026-11-12 (F4), O4 (tryPush default) and M7
// (copyCheck reads the storage length through the intrinsic getter), and the R3 copyLast
// mutants only a copyWithin spy can see (PLAN-G1 TASK 8): the ROT arguments (vs copyTo's)
// and MB-tag (copyLast reading dst[Symbol.toStringTag] instead of the intrinsic getter).
// R3 mutant M7 (copyLast without its `k === 0` return) is NOT equivalent (PLAN-G1
// addendum A5): n = -0 on a non-empty ring returns -0, not addendum A1's literal +0;
// copylast.test.js A2 ('n = -0 and n = 0 return +0') kills it; no test here targets it.
// M7F (copyLastFast without it) is
// NOT equivalent: a BigInt dst's `set` throws even for an empty view (copylast.test.js A3).
// Expected values come from the documented contract (README / .d.ts / audit
// ruling Q-AUD-4), never from a run of the build.
// Build under test: RB_BUILD (absolute or package-relative) else ../RingBuffer.js.
// The %TypedArray%.prototype.copyWithin spy must be live BEFORE the build is imported.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TA_PROTO = Object.getPrototypeOf(Float32Array.prototype);
const realCopyWithin = TA_PROTO.copyWithin;
let cwArgs = null;
TA_PROTO.copyWithin = function copyWithin(target, start, end) {
    cwArgs = [target, start, end];
    return realCopyWithin.apply(this, arguments);
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.RB_BUILD ? path.resolve(ROOT, process.env.RB_BUILD) : path.join(ROOT, 'RingBuffer.js');
const { RingBuffer } = await import(pathToFileURL(BUILD).href);
TA_PROTO.copyWithin = realCopyWithin; // the build holds the spy already; later files in this process see the real one

describe('mutant kills (audit 2026-11-12, F4)', () => {
    // kills M-rot-first / M-rot-second
    it('rotate: copyWithin moves the larger ring half, the scalar loop gets the smaller', () => {
        const cap = 64, off = 3;
        const rb = new RingBuffer(cap);
        for (let i = 0; i < cap; i++) rb.push(i + 0.5);
        let first = 0, second = 0;
        for (let h = 0; h < cap; h++) {
            const start = rb.head, a = cap - start;
            cwArgs = null;
            assert.equal(rb.copyTo(new Float32Array(cap + off), off), cap);
            if (start === 0) assert.equal(cwArgs, null, 'start 0: nothing to rotate');
            else if (start < a) { assert.deepEqual(cwArgs, [off, off + start, off + cap], 'start ' + start); first++; }
            else if (start > a) { assert.deepEqual(cwArgs, [off + a, off, off + start], 'start ' + start); second++; }
            else assert.ok(cwArgs !== null, 'tie: either branch');
            rb.push(h + 100.5);
        }
        assert.equal(first, 31);
        assert.equal(second, 31);
    });

    // kills M-peeknew-nan / M-peekold-nan / M-peeknew-guard / M-peekold-guard
    it('peekNewest / peekOldest return 0 on an empty ring, also when its storage is not zero', () => {
        const fresh = new RingBuffer(4);
        assert.ok(Object.is(fresh.peekNewest(), 0));
        assert.ok(Object.is(fresh.peekOldest(), 0));
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i + 0.5);
        rb.count = 0; // logical clear without reset(): storage keeps the old samples
        assert.equal(rb.peekNewest(), 0);
        assert.equal(rb.peekOldest(), 0);
        const d = new RingBuffer(4);
        d.push(7.5);
        d.destroy();
        assert.equal(d.peekNewest(), 0);
        assert.equal(d.peekOldest(), 0);
    });

    // kills M-trypush-falsy
    it('tryPush on a full ring overwrites unless overwrite is exactly false', () => {
        for (const opts of [{}, { overwrite: undefined }, { overwrite: true }, { overwrite: 0 }, { overwrite: null }]) {
            const rb = new RingBuffer(2);
            rb.push(1); rb.push(2);
            assert.equal(rb.tryPush(3, opts), true, JSON.stringify(opts));
            assert.equal(rb.peekNewest(), 3);
            assert.equal(rb.peekOldest(), 2);
        }
    });

    // kills M-ctor-fraction
    it('rejects a fractional capacity below 1', () => {
        // Match the message: on the mutant the oversize allocation could also throw a RangeError.
        for (const n of [0.5, 0.999]) assert.throws(() => new RingBuffer(n), { name: 'RangeError', message: /capacity must be a number/ }, String(n));
        assert.equal(new RingBuffer(1.5).capacity, 1);
    });

    // kills M-bounds-symbol
    it('copyTo / copyToFast throw RangeError (not TypeError) for a Symbol dstOffset', () => {
        for (const m of ['copyTo', 'copyToFast']) {
            const rb = new RingBuffer(8);
            rb.push(1.5);
            const dst = new Float32Array(8).fill(9);
            assert.throws(() => rb[m](dst, Symbol('off')), RangeError, m);
            assert.equal(dst[0], 9);
        }
    });

    // kills M-isempty-head / M-isfull-early
    it('isEmpty / isFull at the boundaries: capacity - 1, capacity (head back at 0), capacity + 1', () => {
        const rb = new RingBuffer(4);
        for (let i = 0; i < 3; i++) rb.push(i + 0.5);
        assert.deepEqual([rb.isEmpty(), rb.isFull(), rb.head], [false, false, 3]);
        rb.push(3.5); // full, head wrapped to 0
        assert.deepEqual([rb.isEmpty(), rb.isFull(), rb.head], [false, true, 0]);
        rb.push(4.5);
        assert.deepEqual([rb.isEmpty(), rb.isFull(), rb.head], [false, true, 1]);
        const one = new RingBuffer(1);
        assert.deepEqual([one.isEmpty(), one.isFull()], [true, false]);
        one.push(1.5);
        assert.deepEqual([one.isEmpty(), one.isFull()], [false, true]);
    });

    // kills M-fast-default
    it('copyToFast defaults dstOffset to 0', () => {
        for (const pushes of [5, 13, 100]) {
            const rb = new RingBuffer(pushes > 16 ? 64 : 8);
            for (let i = 0; i < pushes; i++) rb.push(i + 0.5);
            const n = rb.count;
            const dst = new Float32Array(n + 1).fill(9);
            assert.equal(rb.copyToFast(dst), n);
            assert.equal(dst[0], pushes - n + 0.5);
            assert.equal(dst[n - 1], pushes - 0.5);
            assert.equal(dst[n], 9);
        }
    });

    // kills M7 (`TA_LENGTH.call(data)` -> `data.length` in copyCheck)
    it('copyTo / copyToFast read the storage length intrinsically: a lying length getter cannot hide a 56-slot data', () => {
        class LyingF32 extends Float32Array { get length() { return 64; } }
        for (const m of ['copyTo', 'copyToFast']) {
            const rb = new RingBuffer(64);
            for (let i = 0; i < 3; i++) rb.push(i + 0.5);
            rb.data = new LyingF32(56);
            const dst = new Float32Array(8).fill(9);
            assert.throws(() => rb[m](dst, 0), { name: 'RangeError', message: /storage holds 56 slots/ }, m);
            assert.ok(dst.every((v) => v === 9), m + ': dst untouched');
        }
    });
});

describe('mutant kills (R3 copyLast, PLAN-G1 TASK 8)', () => {
    // kills a copyLast ROT that drifts from copyTo's (start / cap / dstOffset arguments)
    it('copyLast ROT: copyWithin arguments equal copyTo\'s at every head of a full 64 ring', () => {
        const cap = 64, off = 3;
        const rb = new RingBuffer(cap);
        for (let i = 0; i < cap; i++) rb.push(i + 0.5);
        let hits = 0;
        for (let h = 0; h < cap; h++) {
            cwArgs = null;
            assert.equal(rb.copyTo(new Float32Array(cap + off), off), cap);
            const want = cwArgs;
            for (const n of [cap, cap + 5]) { // bounds are on n: dst holds off + n
                cwArgs = null;
                assert.equal(rb.copyLast(new Float32Array(off + n), off, n), cap, 'head ' + rb.head + ' n ' + n);
                assert.deepEqual(cwArgs, want, 'head ' + rb.head + ' n ' + n);
            }
            if (want !== null) hits++;
            rb.push(h + 100.5);
        }
        assert.equal(hits, cap - 1); // every head but 0 rotates
    });

    // kills MB-tag (`dst[Symbol.toStringTag]` in place of TA_TAG in copyLast)
    it('copyLast picks its store site by the intrinsic tag: a lying toStringTag neither enters nor leaves ROT', () => {
        class F32AsI8 extends Float32Array { get [Symbol.toStringTag]() { return 'Int8Array'; } }
        class I8AsF32 extends Int8Array { get [Symbol.toStringTag]() { return 'Float32Array'; } }
        const cap = 64;
        const rb = new RingBuffer(cap);
        for (let i = 0; i < cap + 5; i++) rb.push(i + 0.5); // full, head 5: ROT rotates
        assert.equal(rb.head, 5);
        cwArgs = null;
        assert.equal(rb.copyLast(new F32AsI8(cap), 0, cap), cap);
        assert.notEqual(cwArgs, null, 'a Float32Array that claims Int8Array still takes ROT');
        cwArgs = null;
        assert.equal(rb.copyLast(new I8AsF32(cap), 0, cap), cap);
        assert.equal(cwArgs, null, 'an Int8Array that claims Float32Array never takes ROT');
    });
});
