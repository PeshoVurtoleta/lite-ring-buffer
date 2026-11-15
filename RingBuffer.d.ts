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
     * Push `count` samples from `src[srcOffset ...]`, oldest first. Same state
     * as `count` calls of {@link push}: the same `data` slots, `head` and
     * `count`; values round through float32 and read back as the same values
     * (`Object.is`), NaN payload bits unspecified. When `count` > `capacity`
     * the last `capacity` samples are kept (still the state of `count` pushes).
     * `count` 0 is a no-op after validation. `srcOffset` defaults to 0 and
     * `count` to `src.length - srcOffset`.
     *
     * Allocates nothing for a Float32Array / Float64Array `src` while each
     * family's load / store site has seen at most 4 `src` hidden classes
     * (Node 26.8.2 arm64). The checks and `this.data` read happen once per call;
     * the alias cache (`_bufOf`, `_buf`) is shared with {@link copyTo}; a sealed or
     * non-extensible ring works (the cache is then not stored).
     *
     * For a few samples per call a loop of {@link push} is faster: in a strict
     * interleaved A/B run (STATISTICAL, REPORTED; 2026-11-14, Apple M4 Pro, Node v26.8.2,
     * QUIET at start, load1 3.17, 63 paired rounds per config) a push loop won at 1 and 8 samples per call and `pushBatch`
     * won at 32 and 128, for Float32Array and Float64Array `src` alike; the
     * crossover between 8 and 32 was not measured.
     *
     * Every check runs before the first data store; for `count` > 0 a frozen
     * ring throws from the `head` store (`count` 0 returns 0). Only a
     * whole-ring `Object.freeze` is covered: per-property tampering (a
     * non-writable `count` alone, accessors on `head` / `count` / `data`) is
     * unsupported and may leave `head` written, as with `push`. After
     * `destroy()`, with valid arguments, it returns `count` and stores nothing
     * (like `push`); invalid arguments still throw. A detached or
     * out-of-bounds `src` reads as length 0:
     * `count` omitted returns 0; an explicit `count` >= 1 throws RangeError.
     * @returns `count`.
     * @throws TypeError if `src` is not a TypedArray, or is any TypedArray other
     *         than Float32Array / Float64Array (BigInt kinds included), even at
     *         count 0; or, when count > 0, if `this.data` is not a Float32Array
     *         (intrinsic tag, checked on every call; the `capacity`-slots
     *         RangeError is checked first); or, when count > 0 and the ring is
     *         frozen (`Object.freeze`), from the `head` store. Nothing is written.
     * @throws RangeError if `srcOffset` or `count` is not a non-negative integer
     *         (no coercion; no user `valueOf` runs), or `srcOffset + count >
     *         src.length` (checked before the element-type check); or, when
     *         count > 0, if `this.data` does not hold `capacity` slots
     *         (replaced, resized or detached), or if `src` shares the ring's
     *         ArrayBuffer. Nothing is written.
     */
    pushBatch(src: Float32Array | Float64Array, srcOffset?: number, count?: number): number;

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
     * replaced `data` stays referenced until the next non-empty copy, non-empty `pushBatch` or `destroy()`.
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
     * Copies the newest `k = min(n, count)` samples into `dst` from
     * `dstOffset`, oldest-first (the last sample written is the newest).
     * Returns k. `copyLast(dst, off, rb.count)` writes, returns and throws
     * exactly as {@link copyTo}`(dst, off)` (the messages name `copyLast`).
     * For a whole-window copy {@link copyTo} is the safe choice: the parity
     * ratio `copyLast(dst, off, count)` / `copyTo` has medians of 0.99-1.02
     * over two strict runs (Float32 1024 ring 1.02 / 1.01 at head 0 and
     * 1.02 / 1.01 at head 768, Float64 1.00 / 0.99 at head 0 and 1.00 / 1.00
     * at head 768, ring 32: 1.02 / 1.02 (Float32), 1.02 / 1.01 (Float64)),
     * with one slow compilation at head 768 in each run (Float32 1.18 in the
     * first, Float64 1.19 in the second); parity is not guaranteed, it
     * depends on the caller's inlining budget (a caller with no budget left
     * inlines neither method). Against
     * copying the whole window and then its last n, copyLast is 2.1x
     * (Float32) / 2.2x (Float64) faster at n 120 and 1.5x (Float32) / 1.2x
     * (Float64) at n 512 of a full 1024 ring (the lower of the two runs; all
     * REPORTED: `npm run bench:copylast`, two strict runs 2026-11-15, 63
     * paired rounds per row, host QUIET, Apple M4 Pro, Node v26.8.2). The inlined
     * chain copyLast + lastCheck + rotCopy is 765 B of bytecode, within V8's
     * 766 B reserve on that Node (1.5.0: 791 B), held by
     * `test/chainsize.test.js` (DETERMINISTIC, pinned engine).
     *
     * `n` is REQUIRED (an omitted `n` is a RangeError); `dstOffset` may be
     * `undefined` (then 0). Checks, in order, all before the first store:
     * TypeError (`dst` not a TypedArray), RangeError (`n` not a non-negative
     * integer; no coercion, no user `valueOf` / `toString` runs), RangeError
     * (bounds, on `dstOffset + n`, not on k: an `n` larger than `dst` can hold
     * throws even on an empty ring), return 0 when k is 0 (before the alias
     * and storage checks), RangeError (alias), RangeError (storage), then the
     * first store (a BigInt64Array / BigUint64Array `dst` with k > 0 throws
     * TypeError there). The error for every input is unchanged from 1.5.0. A
     * view `dst` sees exactly one `dst instanceof DataView` per call (a user
     * `DataView[Symbol.hasInstance]` runs once). Only replaced builtins can
     * tell it from 1.5.0: `n` / `dstOffset` are tested before the DataView
     * check, a failing call may call the global `ArrayBuffer.isView` /
     * `Number.isInteger` more often, and a bounds failure with a valid
     * `dstOffset` reads `dst`'s length twice. The checks use the GLOBAL
     * `ArrayBuffer.isView`, `Number.isInteger`, `DataView` and the intrinsic
     * length getter's `call` at call time; replacing any of them, or
     * anything that changes what that getter's `call` resolves to (replacing
     * or deleting `Function.prototype.call`, an own `call` property on the
     * getter, or a changed prototype of the getter), is unsupported (out of
     * contract).
     *
     * ALLOCATION: 0 B in steady state under the same rule as {@link copyTo}:
     * each of its three store sites (a Float32Array `dst`, a Float64Array
     * `dst`, every other element type) stays typed while it has seen at most
     * 4 distinct `dst` hidden classes in the process (each subclass, realm and
     * resizable-buffer variant counts as one), Node 26.8.2 arm64; past that a
     * site boxes every non-integer sample. The three sites are copyLast's own,
     * not copyTo's, so each method has its own 4-class budget, EXCEPT the
     * whole-window Float32 path: a full ring copied whole (n >= count ===
     * capacity > 32) into a Float32Array runs copyTo's `rotCopy`, whose scalar
     * loop is ONE store site shared with copyTo, so every Float32 `dst` class
     * either method has passed through `rotCopy` counts against that one
     * 4-class budget. The first alias check on a fresh on-heap (<= 64 B)
     * `dst` materializes its ArrayBuffer once, as for copyTo (hoist the
     * `dst`). For the `set` + `subarray` copy see {@link copyLastFast}.
     * @param dst destination; the caller owns it.
     * @param dstOffset first slot written; `undefined` means 0.
     * @param n samples wanted; k = min(n, count) are copied.
     * @returns number of samples written (k = min(n, count)).
     * @throws TypeError if `dst` is not a TypedArray (an Array or a
     *         DataView), or is a BigInt64Array / BigUint64Array and k > 0.
     *         Nothing is written.
     * @throws TypeError (or the user's own error) if `dstOffset` is a
     *         null-prototype object or its `toString` throws, as {@link copyTo}
     *         (the bounds message is built with `String(dstOffset)`).
     * @throws RangeError if `n` is not a non-negative integer (NaN, Infinity,
     *         1.5, '1', null, undefined, 1n); if `dstOffset` is not a
     *         non-negative integer or `dst.length < dstOffset + n`; when
     *         k > 0, if `dst` shares the ring's ArrayBuffer or `this.data` does
     *         not hold `capacity` slots. Nothing is written.
     */
    copyLast(dst: Float32Array | Float64Array, dstOffset: number | undefined, n: number): number;

    /**
     * Same copy, result, validation order and errors as {@link copyLast} (the
     * messages name `copyLastFast`; one `dst instanceof DataView` per call and
     * the same out-of-contract rule for replaced builtins, see
     * {@link copyLast}), including the alias RangeError and the
     * k = 0 early return before the alias and storage checks: the newest
     * `k = min(n, count)` samples, oldest-first. Copies with at most two
     * intrinsic `set` calls over `subarray` views, so it ALLOCATES one view
     * per ring half it spans (nominally the `copyToFast` figures, 104 B
     * contiguous / 208 B straddling; REPORTED by the `npm run alloc` lanes
     * `copyLastFast 120, cap 1024 contiguous` / `straddling`, 104.0 / 208.0
     * B/op, Node v26.8.2 arm64, 2026-11-15). Having no per-sample store site
     * it never boxes a sample, whatever the number of `dst` classes. Not for
     * a zero-GC hot path; {@link copyLast} is the zero-allocation form (within
     * its 4-class rule and the `rotCopy` budget it shares with copyTo; see
     * {@link copyLast}).
     * `copyLastFast(dst, off, rb.count)` writes, returns and throws exactly as
     * {@link copyToFast}`(dst, off)` (the messages name `copyLastFast`).
     * @param dst destination; the caller owns it.
     * @param dstOffset first slot written; `undefined` means 0.
     * @param n samples wanted (required); k = min(n, count) are copied.
     * @returns number of samples written (k = min(n, count)).
     * @throws TypeError as {@link copyLast}. Nothing is written.
     * @throws TypeError (or the user's own error) if `dstOffset` is a
     *         null-prototype object or its `toString` throws, as {@link copyTo}
     *         (the bounds message is built with `String(dstOffset)`).
     * @throws RangeError as {@link copyLast} (bad `n`, bad offset, `dst` too
     *         small for `dstOffset + n`; when k > 0, `dst` sharing the ring's
     *         buffer or `this.data` not holding `capacity` slots). Nothing
     *         is written.
     */
    copyLastFast(dst: Float32Array | Float64Array, dstOffset: number | undefined, n: number): number;

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
