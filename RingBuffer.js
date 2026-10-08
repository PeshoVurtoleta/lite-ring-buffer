/**
 * @zakkster/lite-ring-buffer
 *
 * Zero-allocation circular buffer over a Float32Array.
 * Capacity is rounded UP to the next power of two so wrap-around uses a
 * single bitwise AND instead of a modulo.
 *
 * Contract:
 *  - Stores Float32 samples. Callers SHOULD push only finite numbers;
 *    NaN/Infinity will round-trip correctly but corrupt downstream stats
 *    unless those consumers filter them.
 *  - `requestedCapacity` is rounded up; the original request is preserved
 *    on `.requestedCapacity` and the actual storage size on `.capacity`.
 *  - Methods are NOT safe to call after `destroy()`.
 *  - `copyTo`, `forEach` and iteration are OLDEST-FIRST.
 *  - `get(0)` returns the NEWEST sample. `get(count - 1)` returns the oldest.
 *
 * @example
 *   const rb = new RingBuffer(1024);
 *   for (let i = 0; i < 5000; i++) rb.push(Math.sin(i * 0.01));
 *   rb.peekNewest(); // most recent sample
 *   const out = new Float32Array(rb.count);
 *   rb.copyTo(out, 0); // oldest-first contiguous copy
 */

/**
 * Largest capacity the wrap math can honor. Every index goes through `& mask`,
 * which works on int32, so the mask must fit in 31 bits: 2^31 slots (8 GiB).
 */
export const MAX_CAPACITY = 0x80000000; // 2^31

/**
 * Smallest power of two >= n, for an integer n in [1, 2^32].
 *
 * `n - 1` has `32 - clz32(n - 1)` significant bits, so two to that power is the
 * next power of two. `ceilPow2(1) === 1` falls out naturally (`clz32(0) === 32`).
 * `2 **` rather than `1 <<` because `1 << 31` overflows int32 to a negative.
 *
 * @param {number} n
 * @returns {number}
 */
export function ceilPow2(n) {
    return 2 ** (32 - Math.clz32(n - 1));
}

export class RingBuffer {
    /**
     * @param {number} [requestedCapacity=1024] minimum capacity in [1, 2^31];
     *        fractions are floored, then rounded up to the next power of two.
     * @throws {RangeError} if requestedCapacity is not a number in [1, 2^31].
     */
    constructor(requestedCapacity = 1024) {
        // Number.isFinite never coerces, so strings/BigInts/Symbols are rejected here.
        if (!Number.isFinite(requestedCapacity) ||
            requestedCapacity < 1 || requestedCapacity > MAX_CAPACITY) {
            // String(x), not a template literal: `${Symbol()}` throws a TypeError.
            throw new RangeError(
                'LiteRingBuffer: capacity must be a number in [1, 2^31] (got ' + String(requestedCapacity) + ')'
            );
        }
        /** @type {number} the capacity the caller asked for, before pow2 rounding */
        this.requestedCapacity = Math.floor(requestedCapacity);
        /** @type {number} actual storage size — always a power of two */
        this.capacity = ceilPow2(this.requestedCapacity);
        /** @type {number} bitmask for wrap-around: `i & mask` instead of `i % capacity` */
        this.mask = this.capacity - 1;
        /** @type {Float32Array} backing storage */
        this.data = new Float32Array(this.capacity);
        /** @type {number} write cursor; next push lands at `data[head]` */
        this.head = 0;
        /** @type {number} live samples, 0..capacity */
        this.count = 0;
    }

    /**
     * Push a sample. Always succeeds; oldest sample is overwritten when full.
     * Zero allocation. Hot-path safe.
     * @param {number} value
     */
    push(value) {
        this.data[this.head] = value;
        this.head = (this.head + 1) & this.mask;
        if (this.count < this.capacity) this.count++;
    }

    /**
     * Push with control. When `options.overwrite` is false and the buffer is
     * full, returns false and discards the new sample. Otherwise returns true.
     * `options` is read by property access (no destructuring) so the call
     * site can omit it without allocating a fresh `{}`.
     * @param {number} value
     * @param {{overwrite?: boolean}} [options]
     * @returns {boolean} true if the sample was stored.
     */
    tryPush(value, options) {
        if (this.count === this.capacity && options && options.overwrite === false) return false;
        this.push(value);
        return true;
    }

    /**
     * Sample at offset (0 = newest, count-1 = oldest).
     * Never throws: anything that is not an in-range integer returns undefined.
     * @param {number} offset
     * @returns {number|undefined} the sample, or undefined if out of range.
     */
    get(offset) {
        if (!Number.isInteger(offset) || offset < 0 || offset >= this.count) return undefined;
        // No `+ capacity` needed: a negative int32 ANDed with the mask wraps correctly.
        return this.data[(this.head - 1 - offset) & this.mask];
    }

    /**
     * Sample at offset, or `defaultValue` if out of range.
     * @param {number} offset
     * @param {number} [defaultValue]
     * @returns {number|undefined}
     */
    getOrDefault(offset, defaultValue) {
        const v = this.get(offset);
        return v === undefined ? defaultValue : v;
    }

    /** Newest sample, or 0 when the buffer is empty. */
    peekNewest() {
        return this.count === 0 ? 0 : this.data[(this.head - 1) & this.mask];
    }

    /** Oldest sample, or 0 when the buffer is empty. */
    peekOldest() {
        return this.count === 0 ? 0 : this.data[(this.head - this.count) & this.mask];
    }

    /** True iff the buffer has reached its capacity. */
    isFull()    { return this.count === this.capacity; }

    /** True iff no samples have been pushed (or the buffer was reset). */
    isEmpty()   { return this.count === 0; }

    /**
     * Bulk contiguous copy into `dst` starting at `dstOffset`, oldest-first.
     * Internally this is at most two `TypedArray.set` calls (one per ring half),
     * each backed by a memcpy in V8. The two `subarray` views it creates are
     * small, short-lived objects; no sample data is copied twice.
     *
     * Bounds are checked up front, so a too-small `dst` throws without being
     * partially written.
     *
     * @param {Float32Array|Float64Array} dst destination — caller owns it.
     * @param {number} [dstOffset=0]
     * @returns {number} number of samples written (== this.count).
     * @throws {RangeError} if `dstOffset` is not a non-negative integer or
     *         `dst` cannot hold `count` samples from `dstOffset`.
     */
    copyTo(dst, dstOffset = 0) {
        const c = this.count;
        if (!Number.isInteger(dstOffset) || dstOffset < 0 || dstOffset + c > dst.length) {
            throw new RangeError(
                'LiteRingBuffer: copyTo needs ' + c + ' slots from offset ' + String(dstOffset) +
                ' (dst.length ' + dst.length + ')'
            );
        }
        if (c === 0) return 0;
        const start = (this.head - c) & this.mask;
        const firstLen = Math.min(this.capacity - start, c);

        dst.set(this.data.subarray(start, start + firstLen), dstOffset);
        if (firstLen < c) {
            dst.set(this.data.subarray(0, c - firstLen), dstOffset + firstLen);
        }
        return c;
    }

    /**
     * Visit live samples OLDEST -> NEWEST. Zero allocation with a hoisted callback.
     * @param {(value: number, index: number, rb: RingBuffer) => void} fn
     */
    forEach(fn) {
        const data = this.data;
        const mask = this.mask;
        const c = this.count;
        const start = (this.head - c) & mask;
        for (let i = 0; i < c; i++) fn(data[(start + i) & mask], i, this);
    }

    /** Iterate live samples OLDEST -> NEWEST. Allocates an iterator per protocol. */
    *[Symbol.iterator]() {
        const data = this.data;
        const mask = this.mask;
        const c = this.count;
        const start = (this.head - c) & mask;
        for (let i = 0; i < c; i++) yield data[(start + i) & mask];
    }

    /**
     * Logical reset. Also zeroes storage (O(capacity)) so code that reads
     * `data` directly, bypassing `count`, never sees old samples.
     */
    reset() {
        this.head = 0;
        this.count = 0;
        this.data.fill(0);
    }

    /**
     * Drop all references to backing storage.
     * Calling any other method afterwards is undefined behavior.
     */
    destroy() {
        this.data = null;
        this.count = 0;
        this.head = 0;
        this.capacity = 0;
        this.mask = 0;
    }
}
