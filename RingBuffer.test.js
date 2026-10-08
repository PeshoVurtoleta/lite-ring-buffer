import { describe, it, expect, beforeEach } from 'vitest';
import { RingBuffer, ceilPow2, MAX_CAPACITY } from './RingBuffer.js';

describe('ceilPow2', () => {
    it('returns the smallest power of two >= n', () => {
        const cases = [[1, 1], [2, 2], [3, 4], [4, 4], [5, 8], [100, 128], [1024, 1024], [1025, 2048]];
        for (const [n, want] of cases) expect(ceilPow2(n)).toBe(want);
    });

    it('is exact at the 32-bit edges', () => {
        expect(ceilPow2(2 ** 30 + 1)).toBe(2 ** 31);
        expect(ceilPow2(2 ** 31 - 1)).toBe(2 ** 31);
        expect(ceilPow2(2 ** 31)).toBe(2 ** 31);
        expect(ceilPow2(2 ** 31 + 1)).toBe(2 ** 32);
        expect(ceilPow2(2 ** 32)).toBe(2 ** 32);
    });
});

describe('RingBuffer — construction & validation', () => {
    it('rounds capacity up to next power of two', () => {
        expect(new RingBuffer(1).capacity).toBe(1);
        expect(new RingBuffer(2).capacity).toBe(2);
        expect(new RingBuffer(3).capacity).toBe(4);
        expect(new RingBuffer(5).capacity).toBe(8);
        expect(new RingBuffer(100).capacity).toBe(128);
        expect(new RingBuffer(1024).capacity).toBe(1024);
        expect(new RingBuffer(1025).capacity).toBe(2048);
    });

    it('preserves the original requested capacity', () => {
        const rb = new RingBuffer(100);
        expect(rb.requestedCapacity).toBe(100);
        expect(rb.capacity).toBe(128);
    });

    it('floors fractional capacities before rounding', () => {
        const rb = new RingBuffer(99.9);
        expect(rb.requestedCapacity).toBe(99);
        expect(rb.capacity).toBe(128);
    });

    it('defaults to 1024 when no argument is given', () => {
        const rb = new RingBuffer();
        expect(rb.capacity).toBe(1024);
    });

    it('rejects non-finite or non-positive capacities', () => {
        expect(() => new RingBuffer(0)).toThrow(RangeError);
        expect(() => new RingBuffer(-1)).toThrow(RangeError);
        expect(() => new RingBuffer(NaN)).toThrow(RangeError);
        expect(() => new RingBuffer(Infinity)).toThrow(RangeError);
        expect(() => new RingBuffer('8')).toThrow(RangeError);
    });

    it('rejects capacities above 2^31 instead of silently shrinking them', () => {
        // Previously 2**32 became capacity 1, and anything above 2^31 capacity 0.
        expect(MAX_CAPACITY).toBe(2 ** 31);
        expect(() => new RingBuffer(2 ** 31 + 1)).toThrow(RangeError);
        expect(() => new RingBuffer(2 ** 32)).toThrow(RangeError);
        expect(() => new RingBuffer(3e9)).toThrow(RangeError);
    });

    it('throws a RangeError (not a TypeError) for a Symbol', () => {
        expect(() => new RingBuffer(Symbol('x'))).toThrow(RangeError);
    });

    it('mask = capacity - 1', () => {
        expect(new RingBuffer(64).mask).toBe(63);
        expect(new RingBuffer(1).mask).toBe(0);
    });

    it('starts empty', () => {
        const rb = new RingBuffer(8);
        expect(rb.count).toBe(0);
        expect(rb.head).toBe(0);
        expect(rb.isEmpty()).toBe(true);
        expect(rb.isFull()).toBe(false);
    });
});

describe('RingBuffer — push & wrap', () => {
    let rb;
    beforeEach(() => { rb = new RingBuffer(4); });

    it('fills then wraps, overwriting oldest', () => {
        rb.push(1); rb.push(2); rb.push(3); rb.push(4);
        expect(rb.count).toBe(4);
        expect(rb.isFull()).toBe(true);
        expect(rb.peekOldest()).toBe(1);
        expect(rb.peekNewest()).toBe(4);

        rb.push(5);
        expect(rb.count).toBe(4); // capped
        expect(rb.peekOldest()).toBe(2);
        expect(rb.peekNewest()).toBe(5);
    });

    it('count saturates at capacity, never exceeds', () => {
        for (let i = 0; i < 100; i++) rb.push(i);
        expect(rb.count).toBe(4);
        expect(rb.peekNewest()).toBe(99);
        expect(rb.peekOldest()).toBe(96);
    });

    it('round-trips ±Infinity', () => {
        rb.push(Infinity); rb.push(-Infinity);
        expect(rb.get(0)).toBe(-Infinity);
        expect(rb.get(1)).toBe(Infinity);
    });

    it('round-trips NaN', () => {
        rb.push(NaN);
        expect(Number.isNaN(rb.get(0))).toBe(true);
    });
});

describe('RingBuffer — tryPush', () => {
    it('overwrites by default (matches push)', () => {
        const rb = new RingBuffer(2);
        rb.push(1); rb.push(2);
        expect(rb.tryPush(3)).toBe(true);
        expect(rb.peekOldest()).toBe(2);
        expect(rb.peekNewest()).toBe(3);
    });

    it('refuses when full and overwrite=false', () => {
        const rb = new RingBuffer(2);
        rb.push(1); rb.push(2);
        expect(rb.tryPush(3, { overwrite: false })).toBe(false);
        expect(rb.peekOldest()).toBe(1);
        expect(rb.peekNewest()).toBe(2);
    });

    it('still accepts when not full and overwrite=false', () => {
        const rb = new RingBuffer(2);
        rb.push(1);
        expect(rb.tryPush(2, { overwrite: false })).toBe(true);
        expect(rb.count).toBe(2);
    });

    it('does not allocate when called without options (smoke check)', () => {
        const rb = new RingBuffer(64);
        // No assertion target — just exercise the path.
        for (let i = 0; i < 1000; i++) rb.tryPush(i);
        expect(rb.count).toBe(64);
    });

    it('treats null options like no options', () => {
        const rb = new RingBuffer(1);
        rb.push(1);
        expect(rb.tryPush(2, null)).toBe(true);
        expect(rb.peekNewest()).toBe(2);
    });
});

describe('RingBuffer — get / getOrDefault', () => {
    let rb;
    beforeEach(() => {
        rb = new RingBuffer(4);
        rb.push(10); rb.push(20); rb.push(30);
    });

    it('get(0) is the newest', () => {
        expect(rb.get(0)).toBe(30);
    });

    it('get(count-1) is the oldest', () => {
        expect(rb.get(2)).toBe(10);
    });

    it('returns undefined when out of range', () => {
        expect(rb.get(-1)).toBeUndefined();
        expect(rb.get(3)).toBeUndefined();
        expect(rb.get(100)).toBeUndefined();
    });

    it('returns undefined for non-integer offsets', () => {
        // Previously NaN / undefined / 0.5 / '1' all read some live slot.
        expect(rb.get(NaN)).toBeUndefined();
        expect(rb.get()).toBeUndefined();
        expect(rb.get(0.5)).toBeUndefined();
        expect(rb.get('1')).toBeUndefined();
        expect(rb.get(Symbol('x'))).toBeUndefined();
        expect(rb.getOrDefault(NaN, -1)).toBe(-1);
    });

    it('getOrDefault without a default returns undefined when out of range', () => {
        expect(rb.getOrDefault(3)).toBeUndefined();
    });

    it('getOrDefault returns default for out-of-range', () => {
        expect(rb.getOrDefault(-1, -999)).toBe(-999);
        expect(rb.getOrDefault(100, 0)).toBe(0);
        expect(rb.getOrDefault(0, -999)).toBe(30);
    });

    it('addresses correctly after wrap', () => {
        const wrap = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) wrap.push(i); // overwrites 1, 2
        expect(wrap.get(0)).toBe(6);
        expect(wrap.get(1)).toBe(5);
        expect(wrap.get(2)).toBe(4);
        expect(wrap.get(3)).toBe(3);
        expect(wrap.peekOldest()).toBe(3);
    });
});

describe('RingBuffer — copyTo', () => {
    it('writes oldest-first in the unwrapped case', () => {
        const rb = new RingBuffer(8);
        for (let i = 1; i <= 5; i++) rb.push(i);
        const out = new Float32Array(8);
        const n = rb.copyTo(out, 0);
        expect(n).toBe(5);
        expect(Array.from(out.subarray(0, 5))).toEqual([1, 2, 3, 4, 5]);
    });

    it('writes oldest-first in the wrapped case', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 7; i++) rb.push(i); // overwrites 1, 2, 3
        const out = new Float32Array(4);
        rb.copyTo(out, 0);
        expect(Array.from(out)).toEqual([4, 5, 6, 7]);
    });

    it('respects dstOffset', () => {
        const rb = new RingBuffer(4);
        rb.push(1); rb.push(2); rb.push(3);
        const out = new Float32Array(8);
        const n = rb.copyTo(out, 3);
        expect(n).toBe(3);
        expect(Array.from(out)).toEqual([0, 0, 0, 1, 2, 3, 0, 0]);
    });

    it('returns 0 when empty and does not touch destination', () => {
        const rb = new RingBuffer(4);
        const out = new Float32Array([99, 99, 99, 99]);
        expect(rb.copyTo(out, 0)).toBe(0);
        expect(Array.from(out)).toEqual([99, 99, 99, 99]);
    });

    it('throws on a too-small destination without a partial write', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i); // wrapped: two-segment copy
        const out = new Float32Array([9, 9, 9]);
        expect(() => rb.copyTo(out, 0)).toThrow(RangeError);
        expect(Array.from(out)).toEqual([9, 9, 9]);
        expect(() => rb.copyTo(new Float32Array(8), 5)).toThrow(RangeError);
    });

    it('rejects negative or non-integer offsets', () => {
        const rb = new RingBuffer(4);
        rb.push(1);
        expect(() => rb.copyTo(new Float32Array(4), -1)).toThrow(RangeError);
        expect(() => rb.copyTo(new Float32Array(4), 0.5)).toThrow(RangeError);
    });

    it('copies into a Float64Array', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i);
        const out = new Float64Array(4);
        rb.copyTo(out);
        expect(Array.from(out)).toEqual([3, 4, 5, 6]);
    });
});

describe('RingBuffer — iteration', () => {
    it('forEach visits oldest-first with index', () => {
        const rb = new RingBuffer(4);
        for (let i = 1; i <= 6; i++) rb.push(i);
        const seen = [];
        rb.forEach((v, i, self) => { seen.push([v, i]); expect(self).toBe(rb); });
        expect(seen).toEqual([[3, 0], [4, 1], [5, 2], [6, 3]]);
    });

    it('is iterable oldest-first and matches copyTo', () => {
        const rb = new RingBuffer(8);
        for (let i = 1; i <= 11; i++) rb.push(i);
        const out = new Float32Array(rb.count);
        rb.copyTo(out);
        expect([...rb]).toEqual(Array.from(out));
        expect([...rb]).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it('yields nothing when empty', () => {
        const rb = new RingBuffer(4);
        expect([...rb]).toEqual([]);
        let calls = 0;
        rb.forEach(() => calls++);
        expect(calls).toBe(0);
    });
});

describe('RingBuffer — reset & destroy', () => {
    it('reset zeroes data and resets state', () => {
        const rb = new RingBuffer(4);
        rb.push(1); rb.push(2); rb.push(3);
        rb.reset();
        expect(rb.count).toBe(0);
        expect(rb.head).toBe(0);
        expect(rb.isEmpty()).toBe(true);
        for (let i = 0; i < rb.capacity; i++) expect(rb.data[i]).toBe(0);
    });

    it('reset preserves capacity and storage identity', () => {
        const rb = new RingBuffer(4);
        const before = rb.data;
        rb.push(1);
        rb.reset();
        expect(rb.data).toBe(before);
        expect(rb.capacity).toBe(4);
    });

    it('destroy nulls the backing storage', () => {
        const rb = new RingBuffer(4);
        rb.push(1);
        rb.destroy();
        expect(rb.data).toBeNull();
        expect(rb.capacity).toBe(0);
        expect(rb.count).toBe(0);
        expect(rb.mask).toBe(0);
    });
});

describe('RingBuffer — zero-GC hot-path smoke test', () => {
    it('pushes 1M samples without throwing', () => {
        const rb = new RingBuffer(8192);
        for (let i = 0; i < 1_000_000; i++) rb.push(Math.sin(i * 0.001));
        expect(rb.count).toBe(8192);
        expect(rb.isFull()).toBe(true);
    });

    it('measured heap delta over 1M pushes is sub-MB', () => {
        if (!global.gc) return; // requires --expose-gc; skip otherwise
        const rb = new RingBuffer(4096);
        // warm up
        for (let i = 0; i < 10_000; i++) rb.push(i);
        global.gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 1_000_000; i++) rb.push(i);
        global.gc();
        const after = process.memoryUsage().heapUsed;
        const deltaMB = (after - before) / (1024 * 1024);
        expect(deltaMB).toBeLessThan(1);
    });
});
