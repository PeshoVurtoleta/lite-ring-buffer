import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { RingBuffer, ceilPow2, MAX_CAPACITY } from '../RingBuffer.js';

describe('ceilPow2', () => {
    it('returns the smallest power of two >= n', () => {
        const cases = [[1, 1], [2, 2], [3, 4], [4, 4], [5, 8], [100, 128], [1024, 1024], [1025, 2048]];
        for (const [n, want] of cases) assert.strictEqual(ceilPow2(n), want);
    });

    it('is exact at the 32-bit edges', () => {
        assert.strictEqual(ceilPow2(2 ** 30 + 1), 2 ** 31);
        assert.strictEqual(ceilPow2(2 ** 31 - 1), 2 ** 31);
        assert.strictEqual(ceilPow2(2 ** 31), 2 ** 31);
        assert.strictEqual(ceilPow2(2 ** 31 + 1), 2 ** 32);
        assert.strictEqual(ceilPow2(2 ** 32), 2 ** 32);
    });

    it('behaves as documented outside [1, 2^32] (inputs are not validated)', () => {
        const cases = [
            [1.5, 1], [2.5, 2],                  // fraction above 1: as Math.floor(n)
            [0.5, 1], [0.999, 1],                // 0 < n < 1: 1
            [0, 2 ** 32], [-0.5, 2 ** 32], [-5, 2 ** 32], // finite n <= 0: 2^32
            [NaN, 1], [Infinity, 1], [-Infinity, 1],
            [2 ** 32 + 1, 1], [2 ** 32 + 2, 2], [2 ** 33, 2 ** 32], // wraps mod 2^32
        ];
        for (const [n, want] of cases) assert.strictEqual(ceilPow2(n), want);
    });
});

describe('RingBuffer -- construction & validation', () => {
    it('rounds capacity up to next power of two', () => {
        assert.strictEqual(new RingBuffer(1).capacity, 1);
        assert.strictEqual(new RingBuffer(2).capacity, 2);
        assert.strictEqual(new RingBuffer(3).capacity, 4);
        assert.strictEqual(new RingBuffer(5).capacity, 8);
        assert.strictEqual(new RingBuffer(100).capacity, 128);
        assert.strictEqual(new RingBuffer(1024).capacity, 1024);
        assert.strictEqual(new RingBuffer(1025).capacity, 2048);
    });

    it('preserves the original requested capacity', () => {
        const rb = new RingBuffer(100);
        assert.strictEqual(rb.requestedCapacity, 100);
        assert.strictEqual(rb.capacity, 128);
    });

    it('floors fractional capacities before rounding', () => {
        const rb = new RingBuffer(99.9);
        assert.strictEqual(rb.requestedCapacity, 99);
        assert.strictEqual(rb.capacity, 128);
    });

    it('defaults to 1024 when no argument is given', () => {
        const rb = new RingBuffer();
        assert.strictEqual(rb.capacity, 1024);
    });

    it('rejects non-finite or non-positive capacities', () => {
        assert.throws(() => new RingBuffer(0), RangeError);
        assert.throws(() => new RingBuffer(-1), RangeError);
        assert.throws(() => new RingBuffer(NaN), RangeError);
        assert.throws(() => new RingBuffer(Infinity), RangeError);
        assert.throws(() => new RingBuffer('8'), RangeError);
    });

    it('rejects capacities above 2^31 instead of silently shrinking them', () => {
        // Previously 2**32 became capacity 1, and anything above 2^31 capacity 0.
        assert.strictEqual(MAX_CAPACITY, 2 ** 31);
        assert.throws(() => new RingBuffer(2 ** 31 + 1), RangeError);
        assert.throws(() => new RingBuffer(2 ** 32), RangeError);
        assert.throws(() => new RingBuffer(3e9), RangeError);
    });

    it('throws a RangeError (not a TypeError) for a Symbol', () => {
        assert.throws(() => new RingBuffer(Symbol('x')), RangeError);
    });

    it('mask = capacity - 1', () => {
        assert.strictEqual(new RingBuffer(64).mask, 63);
        assert.strictEqual(new RingBuffer(1).mask, 0);
    });

    it('starts empty', () => {
        const rb = new RingBuffer(8);
        assert.strictEqual(rb.count, 0);
        assert.strictEqual(rb.head, 0);
        assert.strictEqual(rb.isEmpty(), true);
        assert.strictEqual(rb.isFull(), false);
    });
});

describe('RingBuffer -- push & wrap', () => {
    let rb;
    beforeEach(() => { rb = new RingBuffer(4); });

    it('fills then wraps, overwriting oldest', () => {
        rb.push(1); rb.push(2); rb.push(3); rb.push(4);
        assert.strictEqual(rb.count, 4);
        assert.strictEqual(rb.isFull(), true);
        assert.strictEqual(rb.peekOldest(), 1);
        assert.strictEqual(rb.peekNewest(), 4);

        rb.push(5);
        assert.strictEqual(rb.count, 4); // capped
        assert.strictEqual(rb.peekOldest(), 2);
        assert.strictEqual(rb.peekNewest(), 5);
    });

    it('count saturates at capacity, never exceeds', () => {
        for (let i = 0; i < 100; i++) rb.push(i);
        assert.strictEqual(rb.count, 4);
        assert.strictEqual(rb.peekNewest(), 99);
        assert.strictEqual(rb.peekOldest(), 96);
    });

    it('round-trips +/-Infinity', () => {
        rb.push(Infinity); rb.push(-Infinity);
        assert.strictEqual(rb.get(0), -Infinity);
        assert.strictEqual(rb.get(1), Infinity);
    });

    it('round-trips NaN', () => {
        rb.push(NaN);
        assert.strictEqual(Number.isNaN(rb.get(0)), true);
    });
});

describe('RingBuffer -- tryPush', () => {
    it('overwrites by default (matches push)', () => {
        const rb = new RingBuffer(2);
        rb.push(1); rb.push(2);
        assert.strictEqual(rb.tryPush(3), true);
        assert.strictEqual(rb.peekOldest(), 2);
        assert.strictEqual(rb.peekNewest(), 3);
    });

    it('refuses when full and overwrite=false', () => {
        const rb = new RingBuffer(2);
        rb.push(1); rb.push(2);
        assert.strictEqual(rb.tryPush(3, { overwrite: false }), false);
        assert.strictEqual(rb.peekOldest(), 1);
        assert.strictEqual(rb.peekNewest(), 2);
    });

    it('still accepts when not full and overwrite=false', () => {
        const rb = new RingBuffer(2);
        rb.push(1);
        assert.strictEqual(rb.tryPush(2, { overwrite: false }), true);
        assert.strictEqual(rb.count, 2);
    });

    it('does not allocate when called without options (smoke check)', () => {
        const rb = new RingBuffer(64);
        // No assertion target -- just exercise the path.
        for (let i = 0; i < 1000; i++) rb.tryPush(i);
        assert.strictEqual(rb.count, 64);
    });

    it('treats null options like no options', () => {
        const rb = new RingBuffer(1);
        rb.push(1);
        assert.strictEqual(rb.tryPush(2, null), true);
        assert.strictEqual(rb.peekNewest(), 2);
    });
});

describe('RingBuffer -- get / getOrDefault', () => {
    let rb;
    beforeEach(() => {
        rb = new RingBuffer(4);
        rb.push(10); rb.push(20); rb.push(30);
    });

    it('get(0) is the newest', () => {
        assert.strictEqual(rb.get(0), 30);
    });

    it('get(count-1) is the oldest', () => {
        assert.strictEqual(rb.get(2), 10);
    });

    it('returns undefined when out of range', () => {
        assert.strictEqual(rb.get(-1), undefined);
        assert.strictEqual(rb.get(3), undefined);
        assert.strictEqual(rb.get(100), undefined);
    });

    it('returns undefined for non-integer offsets', () => {
        // Previously NaN / undefined / 0.5 / '1' all read some live slot.
        assert.strictEqual(rb.get(NaN), undefined);
        assert.strictEqual(rb.get(), undefined);
        assert.strictEqual(rb.get(0.5), undefined);
        assert.strictEqual(rb.get('1'), undefined);
        assert.strictEqual(rb.get(Symbol('x')), undefined);
        assert.strictEqual(rb.getOrDefault(NaN, -1), -1);
    });

    it('getOrDefault without a default returns undefined when out of range', () => {
        assert.strictEqual(rb.getOrDefault(3), undefined);
    });

    it('getOrDefault returns default for out-of-range', () => {
        assert.strictEqual(rb.getOrDefault(-1, -999), -999);
        assert.strictEqual(rb.getOrDefault(100, 0), 0);
        assert.strictEqual(rb.getOrDefault(0, -999), 30);
    });

    it('getOrDefault agrees with get for every in-range offset, including after wrap', () => {
        // getOrDefault no longer delegates to get; pin that the two stay in sync.
        const wrap = new RingBuffer(8);
        for (let i = 1; i <= 13; i++) wrap.push(i + 0.25);
        for (let k = -2; k < 11; k++) {
            const want = wrap.get(k);
            assert.strictEqual(wrap.getOrDefault(k, -1), want === undefined ? -1 : want);
        }
        for (const bad of [NaN, 0.5, '1', undefined, Symbol('x')]) {
            assert.strictEqual(wrap.getOrDefault(bad, -1), -1);
        }
    });

    it('addresses correctly after wrap', () => {
        const wrap = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) wrap.push(i); // overwrites 1, 2
        assert.strictEqual(wrap.get(0), 6);
        assert.strictEqual(wrap.get(1), 5);
        assert.strictEqual(wrap.get(2), 4);
        assert.strictEqual(wrap.get(3), 3);
        assert.strictEqual(wrap.peekOldest(), 3);
    });
});

describe('RingBuffer -- copyTo', () => {
    it('writes oldest-first in the unwrapped case', () => {
        const rb = new RingBuffer(8);
        for (let i = 1; i <= 5; i++) rb.push(i);
        const out = new Float32Array(8);
        const n = rb.copyTo(out, 0);
        assert.strictEqual(n, 5);
        assert.deepStrictEqual(Array.from(out.subarray(0, 5)), [1, 2, 3, 4, 5]);
    });

    it('writes oldest-first in the wrapped case', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 7; i++) rb.push(i); // overwrites 1, 2, 3
        const out = new Float32Array(4);
        rb.copyTo(out, 0);
        assert.deepStrictEqual(Array.from(out), [4, 5, 6, 7]);
    });

    it('respects dstOffset', () => {
        const rb = new RingBuffer(4);
        rb.push(1); rb.push(2); rb.push(3);
        const out = new Float32Array(8);
        const n = rb.copyTo(out, 3);
        assert.strictEqual(n, 3);
        assert.deepStrictEqual(Array.from(out), [0, 0, 0, 1, 2, 3, 0, 0]);
    });

    it('returns 0 when empty and does not touch destination', () => {
        const rb = new RingBuffer(4);
        const out = new Float32Array([99, 99, 99, 99]);
        assert.strictEqual(rb.copyTo(out, 0), 0);
        assert.deepStrictEqual(Array.from(out), [99, 99, 99, 99]);
    });

    it('throws on a too-small destination without a partial write', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i); // wrapped: two-segment copy
        const out = new Float32Array([9, 9, 9]);
        assert.throws(() => rb.copyTo(out, 0), RangeError);
        assert.deepStrictEqual(Array.from(out), [9, 9, 9]);
        assert.throws(() => rb.copyTo(new Float32Array(8), 5), RangeError);
    });

    it('rejects negative or non-integer offsets', () => {
        const rb = new RingBuffer(4);
        rb.push(1);
        assert.throws(() => rb.copyTo(new Float32Array(4), -1), RangeError);
        assert.throws(() => rb.copyTo(new Float32Array(4), 0.5), RangeError);
    });

    it('copies into a Float64Array', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i);
        const out = new Float64Array(4);
        rb.copyTo(out);
        assert.deepStrictEqual(Array.from(out), [3, 4, 5, 6]);
    });

    it('rejects a dst with no length instead of silently returning', () => {
        // Previously `n > undefined` was false: an empty buffer returned 0 for
        // copyTo({}), a non-empty one threw "dst.set is not a function".
        const empty = new RingBuffer(4);
        assert.throws(() => empty.copyTo({}), TypeError);
        assert.throws(() => empty.copyTo({ set() {} }), TypeError);
        const rb = new RingBuffer(4);
        rb.push(1);
        assert.throws(() => rb.copyTo({}), TypeError);
        assert.throws(() => rb.copyTo({ set() {}, length: 4 }), TypeError);
    });

    it('rejects a non-TypedArray dst with a TypeError', () => {
        const rb = new RingBuffer(4);
        rb.push(1);
        assert.throws(() => rb.copyTo(null), TypeError);
        assert.throws(() => rb.copyTo(undefined), TypeError);
        assert.throws(() => rb.copyTo([0, 0, 0, 0]), TypeError);
        assert.throws(() => rb.copyTo(42), TypeError);
        assert.throws(() => rb.copyTo(new Map()), TypeError);
        assert.throws(() => rb.copyTo(new DataView(new ArrayBuffer(16))), TypeError);
        assert.throws(() => rb.copyTo(vm.runInNewContext('new DataView(new ArrayBuffer(64))')), TypeError);
        assert.throws(() => rb.copyTo(Object.create(null)), { message: /copyTo needs a TypedArray dst \(got object\)/ });
    });

    it('bounds-checks against the real length, not an overridden getter', () => {
        // The scalar loop would drop stores past the real end without an error.
        class Liar extends Float32Array { get length() { return 100; } }
        const rb = new RingBuffer(8);
        for (let i = 1; i <= 5; i++) rb.push(i);
        const dst = new Liar(2);
        assert.throws(() => rb.copyTo(dst), RangeError);
        assert.deepStrictEqual(Array.from(new Float32Array(dst.buffer)), [0, 0]);
    });

    it('accepts other TypedArray kinds', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i);
        const i32 = new Int32Array(4);
        assert.strictEqual(rb.copyTo(i32), 4);
        assert.deepStrictEqual(Array.from(i32), [3, 4, 5, 6]);
    });

    // A full ring of more than 32 samples (COPY_LOOP_MAX) copied into a Float32Array
    // takes the rot path (one intrinsic set of the storage, then copyWithin + a
    // scalar loop over the smaller ring half; nothing to rotate at start 0); every
    // other copy, and every Float64Array copy, takes the masked scalar loop.
    // `path` names the Float32 copy. A wrapped ring is always full (wrapping
    // needs more pushes than slots), so every wrapped case with capacity > 32 is
    // rot: start <= n/2 at [64, 80] (start 16), start > n/2 at [64, 97] (start 33)
    // and [128, 200] (start 72). The oracle is the pushed sequence itself, not
    // get().
    const cases = [
        // [capacity, pushes, wrapped, path]
        [32, 1, false, 'loop'],
        [32, 31, false, 'loop'],
        [32, 32, false, 'loop'],
        [8, 13, true, 'loop'],
        [32, 49, true, 'loop'],
        [64, 33, false, 'loop'],
        [64, 64, false, 'rot'],
        [64, 80, true, 'rot'],
        [64, 97, true, 'rot'],
        [128, 100, false, 'loop'],
        [128, 200, true, 'rot'],
    ];
    for (const [cap, pushes, wrapped, path] of cases) {
        const n = Math.min(cap, pushes);
        it(`copies ${n} samples ${wrapped ? 'across the wrap' : 'contiguously'} (Float32 ${path} path + Float64 loop)`, () => {
            const rb = new RingBuffer(cap);
            const seq = [];
            for (let i = 1; i <= pushes; i++) { rb.push(i + 0.25); seq.push(i + 0.25); }
            const want = seq.slice(seq.length - n);
            assert.strictEqual(rb.count, n);
            assert.strictEqual(((rb.head - rb.count) & rb.mask) + rb.count > rb.capacity, wrapped);
            assert.strictEqual(n === cap && n > 32, path === 'rot');

            const f32 = new Float32Array(n + 3).fill(-1);
            assert.strictEqual(rb.copyTo(f32, 2), n);
            assert.deepStrictEqual(Array.from(f32.subarray(2, 2 + n)), want);
            assert.deepStrictEqual([f32[0], f32[1], f32[f32.length - 1]], [-1, -1, -1]);

            const f64 = new Float64Array(n);
            assert.strictEqual(rb.copyTo(f64), n);
            assert.deepStrictEqual(Array.from(f64), want);
        });
    }
    // No-allocation is gated by test/alloc.mjs (npm run alloc). A heapUsed delta
    // here cannot see it: scavenges absorb the views, and the 1.2.1 set +
    // subarray copy (now copyToFast) read 0.96 MB over 100k copies, under a
    // 1 MB bound.
});

describe('RingBuffer -- iteration', () => {
    it('forEach visits oldest-first with index', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i);
        const seen = [];
        rb.forEach((v, i, self) => { seen.push([v, i]); assert.strictEqual(self, rb); });
        assert.deepStrictEqual(seen, [[3, 0], [4, 1], [5, 2], [6, 3]]);
    });

    it('is iterable oldest-first and matches copyTo', () => {
        const rb = new RingBuffer(8);
        for (let i = 1; i <= 11; i++) rb.push(i);
        const out = new Float32Array(rb.count);
        rb.copyTo(out);
        assert.deepStrictEqual([...rb], Array.from(out));
        assert.deepStrictEqual([...rb], [4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it('yields nothing when empty', () => {
        const rb = new RingBuffer(4);
        assert.deepStrictEqual([...rb], []);
        let calls = 0;
        rb.forEach(() => calls++);
        assert.strictEqual(calls, 0);
    });
});

describe('RingBuffer -- reset & destroy', () => {
    it('reset zeroes data and resets state', () => {
        const rb = new RingBuffer(4);
        rb.push(1); rb.push(2); rb.push(3);
        rb.reset();
        assert.strictEqual(rb.count, 0);
        assert.strictEqual(rb.head, 0);
        assert.strictEqual(rb.isEmpty(), true);
        for (let i = 0; i < rb.capacity; i++) assert.strictEqual(rb.data[i], 0);
    });

    it('reset preserves capacity and storage identity', () => {
        const rb = new RingBuffer(4);
        const before = rb.data;
        rb.push(1);
        rb.reset();
        assert.strictEqual(rb.data, before);
        assert.strictEqual(rb.capacity, 4);
    });

    it('destroy releases the backing storage', () => {
        const rb = new RingBuffer(4);
        const before = rb.data;
        rb.push(1);
        rb.destroy();
        assert.notStrictEqual(rb.data, before);
        assert.strictEqual(rb.capacity, 0);
        assert.strictEqual(rb.count, 0);
        assert.strictEqual(rb.mask, 0);
    });

    it('destroy leaves an empty Float32Array, not null', () => {
        // Keeps the `data` field typed Float32Array on the shared hidden class.
        const a = new RingBuffer(4);
        const b = new RingBuffer(8);
        a.destroy();
        b.destroy();
        assert.ok(a.data instanceof Float32Array);
        assert.strictEqual(a.data.length, 0);
        assert.strictEqual(b.data, a.data); // one shared empty array, no per-destroy allocation
    });
});

describe('RingBuffer -- zero-GC hot-path smoke test', () => {
    it('pushes 1M samples without throwing', () => {
        const rb = new RingBuffer(8192);
        for (let i = 0; i < 1_000_000; i++) rb.push(Math.sin(i * 0.001));
        assert.strictEqual(rb.count, 8192);
        assert.strictEqual(rb.isFull(), true);
    });

    it('measured heap delta over 1M pushes is sub-MB', () => {
        // Fails closed: npm test runs node --expose-gc, so gc must be there.
        assert.strictEqual(typeof globalThis.gc, 'function');
        const rb = new RingBuffer(4096);
        // warm up
        for (let i = 0; i < 10_000; i++) rb.push(i);
        globalThis.gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 1_000_000; i++) rb.push(i);
        globalThis.gc();
        const after = process.memoryUsage().heapUsed;
        const deltaMB = (after - before) / (1024 * 1024);
        assert.ok(deltaMB < 1);
    });
});
