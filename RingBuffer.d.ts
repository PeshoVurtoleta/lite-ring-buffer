/** Largest capacity the int32 wrap math can honor: 2^31 slots. */
export declare const MAX_CAPACITY: number;

/**
 * Smallest power of two >= n, for an integer n in [1, 2^32].
 * `ceilPow2(1) === 1`. Inputs are not validated: a fraction above 1 behaves
 * as `Math.floor(n)` (`ceilPow2(1.5) === 1`); `0 < n < 1`, NaN and +/-Infinity
 * give 1; a finite `n <= 0` gives 2^32; `n > 2^32` wraps mod 2^32.
 */
export declare function ceilPow2(n: number): number;

/**
 * Options for {@link RingBuffer.tryPush}.
 */
export interface TryPushOptions {
    /**
     * When `false`, the call returns `false` and discards the sample if the
     * buffer is full. When `true` (default), the oldest sample is overwritten.
     */
    overwrite?: boolean;
}

/**
 * Zero-allocation circular buffer over a Float32Array.
 *
 * Capacity is rounded UP to the next power of two so wrap-around uses a
 * single bitwise AND instead of a modulo. `copyTo`, `forEach` and iteration
 * are oldest-first; `get(0)` returns the newest sample.
 */
export class RingBuffer implements Iterable<number> {
    /** Capacity the caller asked for (floored), before pow2 rounding. */
    readonly requestedCapacity: number;

    /** Actual storage size -- always a power of two. */
    readonly capacity: number;

    /** `capacity - 1`. Used in the wrap math. */
    readonly mask: number;

    /** Backing storage. `destroy()` replaces it with a shared empty Float32Array. */
    readonly data: Float32Array;

    /** Write cursor; the next push lands at `data[head]`. Exposed for direct readers. */
    head: number;

    /** Live samples, 0..capacity. */
    count: number;

    /**
     * @param requestedCapacity minimum capacity in [1, 2^31]; rounded up to next power of two. Defaults to 1024.
     * @throws RangeError if requestedCapacity is not a number in [1, 2^31].
     */
    constructor(requestedCapacity?: number);

    /**
     * Push a sample. Always succeeds; oldest sample is overwritten when full.
     * Zero allocation. Hot-path safe.
     */
    push(value: number): void;

    /**
     * Push with control. When `options.overwrite` is `false` and the buffer
     * is full, returns `false` and discards the new sample.
     * Reads `options` by property access so a missing argument does not
     * allocate a fresh object.
     *
     * @returns `true` if the sample was stored.
     */
    tryPush(value: number, options?: TryPushOptions): boolean;

    /**
     * Sample at offset (0 = newest, count-1 = oldest).
     * @returns the sample, or `undefined` if `offset` is not an in-range integer.
     * The `number | undefined` result boxes a non-integer sample (16 B per
     * call, Node 26.8.2); in a hot loop use `getOrDefault(offset, 0)`.
     */
    get(offset: number): number | undefined;

    /**
     * Sample at offset, or `defaultValue` if out of range (`undefined` when
     * omitted). With a numeric default every path returns a number, so an
     * inlined call does not box the sample.
     */
    getOrDefault(offset: number): number | undefined;
    getOrDefault<D>(offset: number, defaultValue: D): number | D;

    /** Newest sample, or 0 when empty. */
    peekNewest(): number;

    /** Oldest sample, or 0 when empty. */
    peekOldest(): number;

    /** True iff the buffer has reached its capacity. */
    isFull(): boolean;

    /** True iff no samples have been pushed (or the buffer was reset). */
    isEmpty(): boolean;

    /**
     * Bulk contiguous copy into `dst` starting at `dstOffset`, oldest-first.
     * Allocates nothing at any size in steady state (gated by `npm run alloc`);
     * the first alias check on an on-heap (<= 64 B) ring or `dst` materializes
     * its ArrayBuffer once. A full ring of more than 32 samples into a
     * Float32Array is one intrinsic `set` + `copyWithin` rotation plus a scalar
     * loop over the smaller ring half; every other copy, including every copy
     * of at most 32 samples, is a scalar loop. `set`, `copyWithin`, `buffer` and
     * `length` are the %TypedArray%.prototype intrinsics, so a subclass that
     * overrides them cannot change what is written.
     *
     * The ring caches its storage's buffer in two own keys (`_bufOf`, `_buf`): a
     * replaced `data` stays referenced until the next non-empty copy or `destroy()`.
     * `this.data` is read once per call, before the checks (an accessor `data`
     * runs first). Checks run in this order, all before the first store: TypeError (not a
     * TypedArray), RangeError (bounds), return 0 when the ring is empty,
     * RangeError (alias), then the first store -- so an aliasing BigInt `dst`
     * gets the alias RangeError, not a TypeError.
     * @returns number of samples written (== this.count).
     * @throws TypeError if `dst` is not a TypedArray, e.g. an Array or a DataView,
     *         or is a BigInt64Array / BigUint64Array and count > 0 (nothing is
     *         written). The bound uses the intrinsic TypedArray length, so a
     *         subclass that overrides `length` cannot widen it.
     * @throws RangeError if `dstOffset` is not a non-negative integer or
     *         `dst.length < dstOffset + this.count`; or, when count > 0, if
     *         `dst` shares the ring's ArrayBuffer (read through the intrinsic
     *         `buffer` getter). Nothing is written.
     */
    copyTo(dst: Float32Array | Float64Array, dstOffset?: number): number;

    /**
     * Same copy, result, validation order and errors as {@link copyTo} (the
     * messages name `copyToFast`), including the alias RangeError. Copies with
     * at most two intrinsic `set` calls over `subarray` views, one per ring
     * half, so it ALLOCATES: 104 B per contiguous call, 208 B per wrapped call
     * (`npm run alloc` lanes `copyToFast 1024, contiguous` / `wrapped`,
     * Node 26.8.2 arm64). Not for a zero-GC hot path; `copyTo` allocates
     * nothing.
     * @returns number of samples written (== this.count).
     * @throws TypeError as `copyTo`. Nothing is written.
     * @throws RangeError as `copyTo` (bad offset, `dst` too small, or `dst`
     *         sharing the ring's buffer). Nothing is written.
     */
    copyToFast(dst: Float32Array | Float64Array, dstOffset?: number): number;

    /** Visit live samples oldest -> newest. Zero allocation with a hoisted callback. */
    forEach(fn: (value: number, index: number, rb: RingBuffer) => void): void;

    /** Iterate live samples oldest -> newest. */
    [Symbol.iterator](): IterableIterator<number>;

    /** Logical reset. Also zeroes underlying storage (O(capacity)). */
    reset(): void;

    /**
     * Drop the reference to the backing storage so the GC can reclaim it.
     * `data` becomes a shared empty Float32Array (not `null`).
     * Calling any other method afterwards is undefined behavior. `push`,
     * `tryPush` and `reset` no longer throw: they do nothing, and `tryPush(v)`
     * returns true without storing.
     */
    destroy(): void;
}
