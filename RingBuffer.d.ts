/** Largest capacity the int32 wrap math can honor: 2^31 slots. */
export declare const MAX_CAPACITY: number;

/**
 * Smallest power of two >= n, for an integer n in [1, 2^32].
 * `ceilPow2(1) === 1`. Inputs are not validated: a fraction above 1 behaves
 * as `Math.floor(n)` (`ceilPow2(1.5) === 1`); `0 < n < 1`, NaN and +/-Infinity
 * give 1; a finite `n` with -2^31 < n <= 0 gives 2^32 (at or below -2^31 the
 * uint32 wrap of `n - 1` decides: `ceilPow2(-(2 ** 31)) === 2 ** 31`, `ceilPow2(-1e300) === 1`); `n > 2^32` wraps mod 2^32.
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
     * @throws TypeError (or the user's own error) if requestedCapacity cannot be
     *         turned into text for the message: a null-prototype object, or an
     *         object whose `toString` throws. A Symbol or BigInt gets the RangeError.
     */
    constructor(requestedCapacity?: number);

    /**
     * Push a sample. Always succeeds; oldest sample is overwritten when full.
     * Zero allocation. Hot-path safe.
     *
     * The value is coerced like a typed-array store: `null`, `''` and `[]`
     * store 0; `undefined` stores NaN. Map a missing reading to NaN yourself.
     */
    push(value: number): void;

    /**
     * Push with control. When `options.overwrite` is `false` and the buffer
     * is full, returns `false` and discards the new sample.
     * Reads `options` by property access so a missing argument does not
     * allocate a fresh object. `value` is coerced as in {@link push}
     * (`null` -> 0, `undefined` -> NaN).
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
     * Allocates nothing in steady state while each of its three store sites
     * (Float32Array `dst`, Float64Array `dst`, every other element type) has
     * seen at most 4 distinct `dst` hidden classes in the process; each subclass,
     * realm and resizable-buffer variant counts as one. Past that, the site boxes
     * every non-integer sample (one HeapNumber per sample, 16 B on Node 26.8.2
     * arm64). `copyToFast` is unaffected. The `npm run alloc` MEGA lanes gate the family split and REPORT the 5-class residual.
     * The first alias check on an on-heap (<= 64 B) ring or `dst` materializes
     * its ArrayBuffer once (about 32-61 B off-heap per fresh small `dst`, REPORTED: audit and review runs, Node 26.8.2 arm64). A full ring of more than 32 samples into a
     * Float32Array is one intrinsic `set` + `copyWithin` rotation plus a scalar
     * loop over the smaller ring half; every other copy, including every copy
     * of at most 32 samples, is a scalar loop. `set`, `copyWithin`, `buffer` and
     * `length` are the %TypedArray%.prototype intrinsics, so a subclass that
     * overrides them cannot change what is written.
     *
     * The ring caches its storage's buffer in two own keys (`_bufOf`, `_buf`): a
     * replaced `data` stays referenced until the next non-empty copy or `destroy()`.
     * On a non-extensible ring the keys are never updated: the array cached before
     * the lock stays referenced until `destroy()`, or for the ring's lifetime when
     * frozen (`destroy()` cannot write a frozen ring).
     * `this.data` is read once per call, before the checks (an accessor `data`
     * runs first). Checks run in this order, all before the first store: TypeError (not a
     * TypedArray), RangeError (bounds), return 0 when the ring is empty,
     * RangeError (alias), RangeError (storage: `data` does not hold `capacity`
     * slots), then the first store -- so an aliasing BigInt `dst`
     * gets the alias RangeError, not a TypeError.
     * @returns number of samples written (== this.count).
     * @throws TypeError if `dst` is not a TypedArray, e.g. an Array or a DataView,
     *         or is a BigInt64Array / BigUint64Array and count > 0 (nothing is
     *         written). The bound uses the intrinsic TypedArray length, so a
     *         subclass that overrides `length` cannot widen it.
     * @throws RangeError if `dstOffset` is not a non-negative integer or
     *         `dst.length < dstOffset + this.count`; or, when count > 0, if
     *         `dst` shares the ring's ArrayBuffer (read through the intrinsic
     *         `buffer` getter), or, when count > 0, if `this.data` does not hold
     *         exactly `capacity` slots (replaced, resized or detached storage).
     *         Nothing is written. An aliasing BigInt64Array / BigUint64Array
     *         `dst` gets this alias RangeError, not the TypeError.
     * @throws TypeError (or the user's own error) if `dstOffset` is a
     *         null-prototype object or its `toString` throws, since the message
     *         cannot be built; a Symbol or BigInt `dstOffset` gets the RangeError.
     *         The alias check compares ArrayBuffer identity: two
     *         SharedArrayBuffer objects over the same memory pass it (reachable
     *         only after a caller replaces `data`).
     */
    copyTo(dst: Float32Array | Float64Array, dstOffset?: number): number;

    /**
     * Same copy, result, validation order and errors as {@link copyTo} (the
     * messages name `copyToFast`), including the alias RangeError. Copies with
     * at most two intrinsic `set` calls over `subarray` views, one per ring
     * half, so it ALLOCATES: 104 B per contiguous call, 208 B per wrapped call
     * (`npm run alloc` lanes `copyToFast 1024, contiguous` / `wrapped`,
     * Node 26.8.2 arm64). Not for a zero-GC hot path; `copyTo` is the zero-allocation
     * form (see {@link copyTo} for its residual).
     * @returns number of samples written (== this.count).
     * @throws TypeError as `copyTo`. Nothing is written.
     * @throws RangeError as `copyTo` (bad offset, `dst` too small, `dst`
     *         sharing the ring's buffer, or, when count > 0, `this.data` not
     *         holding exactly `capacity` slots). Detached storage is this
     *         RangeError, not a TypeError. Nothing is written.
     */
    copyToFast(dst: Float32Array | Float64Array, dstOffset?: number): number;

    /**
     * Visit live samples oldest -> newest. Zero allocation with a hoisted
     * callback, for ONE callback function per process: a second distinct
     * callback costs about 128 B per 8-sample call (REPORTED, audit 2026-11-12).
     */
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
