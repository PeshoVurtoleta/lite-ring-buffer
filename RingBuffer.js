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
 * Inputs are not validated. `clz32` converts `n - 1` to a uint32 (truncate
 * toward zero, then wrap mod 2^32), so outside the domain the result is not
 * "the next power of two >= n":
 *  - a fraction above 1 behaves as `Math.floor(n)`, so the result can be below
 *    n: `ceilPow2(1.5) === 1`, `ceilPow2(2.5) === 2`;
 *  - `0 < n < 1` gives 1 (`n - 1` truncates to 0);
 *  - a finite `n <= 0` gives 2^32 (`clz32(-1) === 0`);
 *  - NaN and +/-Infinity give 1 (they convert to 0);
 *  - `n > 2^32` wraps: `ceilPow2(2 ** 32 + 1) === 1`, `ceilPow2(2 ** 33) === 2 ** 32`.
 * The RingBuffer constructor floors and range-checks before calling it.
 *
 * @param {number} n
 * @returns {number}
 */
export function ceilPow2(n) {
    return 2 ** (32 - Math.clz32(n - 1));
}

/**
 * What `destroy()` leaves in `data`. Assigning `null` would widen the `data`
 * field's tracked type on the shared hidden class from Float32Array to Any,
 * for every instance in the process; an empty Float32Array keeps it a
 * Float32Array (checked with `--trace-generalization`, Node 26.8.2). It has no
 * slots, so nothing can be stored in it.
 *
 * Trade-off: with `null`, `push`, `tryPush` and `reset` after `destroy()`
 * threw a TypeError. With an empty array they do nothing (`tryPush(v)` returns
 * true without storing), so a use after `destroy()` no longer fails loudly.
 * Reads were already empty (count is 0). It stays undefined behavior.
 */
const EMPTY_F32 = new Float32Array(0);

/**
 * At or below this many samples, `copyTo` uses a scalar loop, which allocates
 * nothing (0 B/op, `test/alloc.mjs`). Above it, `set` + `subarray` allocates
 * one 104 B view per ring half (Node 26.8.2). The cutoff of 32 is nominal: the
 * loop is expected to keep pace with memcpy at this size, but that timing has
 * not been measured yet.
 */
const COPY_LOOP_MAX = 32;

/**
 * The intrinsic %TypedArray%.prototype.length getter. `copyTo` bounds-checks
 * against it, not `dst.length`: a subclass can override `length`, and the
 * scalar loop would then drop its out-of-range stores silently. It also
 * throws a TypeError for a DataView from another realm, which `instanceof`
 * cannot see.
 */
const TA_LENGTH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float32Array.prototype), 'length').get;

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
     *
     * The bounds check is repeated here rather than delegating to `get`:
     * `get` returns `number|undefined`, and when it is inlined that merge of
     * a float and `undefined` boxes every non-integer sample into a heap
     * number (16 B per call). Called with a numeric default, every path here
     * returns a number, so an inlined call allocates nothing.
     *
     * @param {number} offset
     * @param {number} [defaultValue] returned when out of range; omitted, `undefined`.
     * @returns {number|undefined}
     */
    getOrDefault(offset, defaultValue) {
        if (!Number.isInteger(offset) || offset < 0 || offset >= this.count) return defaultValue;
        return this.data[(this.head - 1 - offset) & this.mask];
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
     *
     * Up to 32 samples are copied by a scalar loop, which allocates nothing.
     * Larger copies are at most two `TypedArray.set` calls (one per ring half),
     * each backed by a memcpy in V8; each call allocates one `subarray` view
     * per ring half (104 B each in Node 26.8.2), and no sample data is copied twice.
     *
     * Arguments are checked up front, so a bad call throws without `dst`
     * being partially written.
     *
     * @param {Float32Array|Float64Array} dst destination — caller owns it.
     * @param {number} [dstOffset=0]
     * @returns {number} number of samples written (== this.count).
     * @throws {TypeError} if `dst` is not a TypedArray (a DataView is rejected
     *         too), or is a BigInt64Array / BigUint64Array and count > 0.
     *         Nothing is written.
     * @throws {RangeError} if `dstOffset` is not a non-negative integer or
     *         `dst` cannot hold `count` samples from `dstOffset`.
     */
    copyTo(dst, dstOffset = 0) {
        // isView alone also admits a DataView, which has no indexed slots or `set`.
        if (!ArrayBuffer.isView(dst) || dst instanceof DataView) {
            // typeof, not String(dst): an Array would be joined, a null-prototype object throws.
            throw new TypeError(
                'LiteRingBuffer: copyTo needs a TypedArray dst (got ' + (dst === null ? 'null' : typeof dst) + ')'
            );
        }
        const dlen = TA_LENGTH.call(dst);
        const c = this.count;
        // `!(x <= len)`, not `x > len`: a NaN on either side must fail the check.
        if (!Number.isInteger(dstOffset) || dstOffset < 0 || !(dstOffset + c <= dlen)) {
            throw new RangeError(
                'LiteRingBuffer: copyTo needs ' + c + ' slots from offset ' + String(dstOffset) +
                ' (dst.length ' + dlen + ')'
            );
        }
        if (c === 0) return 0;
        const data = this.data;
        const mask = this.mask;
        const start = (this.head - c) & mask;
        if (c <= COPY_LOOP_MAX) {
            for (let i = 0; i < c; i++) dst[dstOffset + i] = data[(start + i) & mask];
            return c;
        }
        const firstLen = Math.min(this.capacity - start, c);

        dst.set(data.subarray(start, start + firstLen), dstOffset);
        if (firstLen < c) {
            dst.set(data.subarray(0, c - firstLen), dstOffset + firstLen);
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
     * Drop the reference to the backing storage so the GC can reclaim it.
     * `data` becomes a shared empty Float32Array (not `null`; see EMPTY_F32).
     * Calling any other method afterwards is undefined behavior.
     */
    destroy() {
        this.data = EMPTY_F32;
        this.count = 0;
        this.head = 0;
        this.capacity = 0;
        this.mask = 0;
    }
}
