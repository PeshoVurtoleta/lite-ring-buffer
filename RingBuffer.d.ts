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
 * single bitwise AND instead of a modulo. `copyTo` writes oldest-first;
 * `get(0)` returns the newest sample.
 */
export class RingBuffer {
    /** Capacity the caller asked for, before pow2 rounding. */
    readonly requestedCapacity: number;

    /** Actual storage size — always a power of two. */
    readonly capacity: number;

    /** Live samples, 0..capacity. */
    count: number;

    /**
     * @param requestedCapacity minimum capacity; rounded up to next power of two. Defaults to 1024.
     * @throws RangeError if requestedCapacity is not a finite positive number.
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
     * @returns the sample, or `undefined` if out of range.
     */
    get(offset: number): number | undefined;

    /**
     * Sample at offset, or `defaultValue` if out of range.
     */
    getOrDefault(offset: number, defaultValue?: number): number;

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
     * Caller must ensure `dst.length >= dstOffset + this.count`.
     * @returns number of samples written (== this.count).
     */
    copyTo(dstFloat32Array: Float32Array, dstOffset?: number): number;

    /** Logical reset. Also zeroes underlying storage to prevent stale reads. */
    reset(): void;

    /**
     * Drop all references to backing storage.
     * Calling any other method afterwards is undefined behavior.
     */
    destroy(): void;
}
