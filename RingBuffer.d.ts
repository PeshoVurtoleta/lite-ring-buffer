/** Largest capacity the int32 wrap math can honor: 2^31 slots. */
export declare const MAX_CAPACITY: number;

/**
 * Smallest power of two >= n, for an integer n in [1, 2^32].
 * `ceilPow2(1) === 1`.
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

    /** Actual storage size — always a power of two. */
    readonly capacity: number;

    /** `capacity - 1`. Used in the wrap math. */
    readonly mask: number;

    /** Backing storage. Set to `null` by `destroy()`. */
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
     */
    get(offset: number): number | undefined;

    /**
     * Sample at offset, or `defaultValue` if out of range.
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
     * @returns number of samples written (== this.count).
     * @throws RangeError if `dstOffset` is not a non-negative integer or
     *         `dst.length < dstOffset + this.count` (nothing is written).
     */
    copyTo(dst: Float32Array | Float64Array, dstOffset?: number): number;

    /** Visit live samples oldest -> newest. Zero allocation with a hoisted callback. */
    forEach(fn: (value: number, index: number, rb: RingBuffer) => void): void;

    /** Iterate live samples oldest -> newest. */
    [Symbol.iterator](): IterableIterator<number>;

    /** Logical reset. Also zeroes underlying storage (O(capacity)). */
    reset(): void;

    /**
     * Drop all references to backing storage.
     * Calling any other method afterwards is undefined behavior.
     */
    destroy(): void;
}
