import { describe, it, expect, beforeEach } from 'vitest';
import { RingBuffer } from './RingBuffer.js';

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
