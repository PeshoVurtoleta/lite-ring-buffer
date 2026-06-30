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
 *  - `copyTo` writes OLDEST-FIRST: dst[dstOffset] is the oldest sample,
 *    dst[dstOffset + count - 1] is the newest.
 *  - `get(0)` returns the NEWEST sample. `get(count - 1)` returns the oldest.
 *
 * @example
 *   const rb = new RingBuffer(1024);
 *   for (let i = 0; i < 5000; i++) rb.push(Math.sin(i * 0.01));
 *   rb.peekNewest(); // most recent sample
 *   const out = new Float32Array(rb.count);
 *   rb.copyTo(out, 0); // oldest-first contiguous copy
 */
export class RingBuffer {
    /**
     * @param {number} [requestedCapacity=1024] minimum capacity; rounded up to next power of two.
     * @throws {RangeError} if requestedCapacity is not a finite positive number.
     */
    constructor(requestedCapacity = 1024) {
        if (!Number.isFinite(requestedCapacity) || requestedCapacity < 1) {
            throw new RangeError(
                `LiteRingBuffer: capacity must be a finite positive number (got ${requestedCapacity})`
            );
        }
        /** @type {number} the capacity the caller asked for, before pow2 rounding */
        this.requestedCapacity = Math.floor(requestedCapacity);
        /** @type {number} actual storage size — always a power of two */
        this.capacity = this._nextPow2(this.requestedCapacity);
        /** @type {number} bitmask for wrap-around: `i & mask` instead of `i % capacity` */
        this.mask = this.capacity - 1;
        /** @type {Float32Array} backing storage */
        this.data = new Float32Array(this.capacity);
        /** @type {number} write cursor; next push lands at `data[head]` */
        this.head = 0;
        /** @type {number} live samples, 0..capacity */
        this.count = 0;
    }

    /** 32-bit safe next power of two. Always returns >= 1. */
    _nextPow2(v) {
        v = Math.max(1, Math.floor(v) >>> 0);
        v--; v |= v >>> 1; v |= v >>> 2; v |= v >>> 4; v |= v >>> 8; v |= v >>> 16; v++;
        return v;
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
     * Push with control. When `overwrite` is false and the buffer is full,
     * returns false and discards the new sample. Otherwise returns true.
     * `options` is read by property access (no destructuring) so the call
     * site can pass `undefined` without allocating a fresh `{}`.
     * @param {number} value
     * @param {{overwrite?: boolean}} [options]
     * @returns {boolean} true if the sample was stored.
     */
    tryPush(value, options) {
        const overwrite = options ? options.overwrite !== false : true;
        if (!overwrite && this.count === this.capacity) return false;
        this.data[this.head] = value;
        this.head = (this.head + 1) & this.mask;
        if (this.count < this.capacity) this.count++;
        return true;
    }

    /**
     * Sample at offset (0 = newest, count-1 = oldest).
     * @param {number} offset
     * @returns {number|undefined} the sample, or undefined if out of range.
     */
    get(offset) {
        if (offset < 0 || offset >= this.count) return undefined;
        const index = (this.head - 1 - offset + this.capacity) & this.mask;
        return this.data[index];
    }

    /**
     * Sample at offset, or `defaultValue` if out of range.
     * @param {number} offset
     * @param {number} [defaultValue=undefined]
     * @returns {number}
     */
    getOrDefault(offset, defaultValue = undefined) {
        if (offset < 0 || offset >= this.count) return defaultValue;
        const index = (this.head - 1 - offset + this.capacity) & this.mask;
        return this.data[index];
    }

    /** Newest sample, or 0 when the buffer is empty. */
    peekNewest() { return this.getOrDefault(0, 0); }

    /** Oldest sample, or 0 when the buffer is empty. */
    peekOldest() { return this.getOrDefault(this.count - 1, 0); }

    /** True iff the buffer has reached its capacity. */
    isFull()    { return this.count === this.capacity; }

    /** True iff no samples have been pushed (or the buffer was reset). */
    isEmpty()   { return this.count === 0; }

    /**
     * Bulk contiguous copy into `dst` starting at `dstOffset`, oldest-first.
     * Internally this is at most two `TypedArray.set` calls (one per ring half),
     * each backed by a memcpy in V8.
     *
     * @param {Float32Array} dstFloat32Array destination — caller owns it.
     * @param {number} [dstOffset=0]
     * @returns {number} number of samples written (== this.count).
     */
    copyTo(dstFloat32Array, dstOffset = 0) {
        const c = this.count;
        if (c === 0) return 0;
        const start = (this.head - c + this.capacity) & this.mask;
        const firstLen = Math.min(this.capacity - start, c);

        dstFloat32Array.set(this.data.subarray(start, start + firstLen), dstOffset);
        if (firstLen < c) {
            dstFloat32Array.set(this.data.subarray(0, c - firstLen), dstOffset + firstLen);
        }
        return c;
    }

    /** Logical reset. Also zeroes underlying storage to prevent stale reads. */
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
