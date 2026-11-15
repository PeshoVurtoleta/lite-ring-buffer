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
 *  - `push` / `tryPush` do not validate the value; the typed-array store
 *    coerces it: `push(null)`, `push('')` and `push([])` store 0,
 *    `push(undefined)` stores NaN. null is not zero: map a missing reading
 *    to NaN yourself.
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
 *  - a finite `n` in (-2^31, 0] gives 2^32 (`clz32(-1) === 0`); at or below
 *    -2^31 the uint32 wrap of `n - 1` decides: `ceilPow2(-(2 ** 31)) === 2 ** 31`,
 *    `ceilPow2(-1e300) === 1`;
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
 * Copies of at most this many samples take `copyTo`'s masked scalar loop,
 * even a full ring into a Float32Array; only a full Float32 ring of more
 * samples takes the intrinsic `set` + `copyWithin` rotate (`rotCopy`).
 * Ruling Q-R1B-ROUTER ("loop at <= 32"); the value 32 is nominal.
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

/**
 * The rest of the %TypedArray%.prototype intrinsics `copyTo` / `copyToFast`
 * use, captured once at module load so a subclass (or a patched prototype)
 * cannot change what they read or write:
 *  - TA_TAG: the Symbol.toStringTag getter, the array's real element type
 *    ('Float32Array' for a subclass too; undefined for a non-TypedArray).
 *  - TA_BUFFER: the `buffer` getter, for the alias check. A subclass's own
 *    `buffer` getter can lie; this one cannot.
 *  - TA_SET / TA_COPY_WITHIN: the `set` and `copyWithin` methods.
 */
const TA_PROTO = Object.getPrototypeOf(Float32Array.prototype);
const TA_TAG = Object.getOwnPropertyDescriptor(TA_PROTO, Symbol.toStringTag).get;
const TA_BUFFER = Object.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get;
const TA_SET = TA_PROTO.set;
const TA_COPY_WITHIN = TA_PROTO.copyWithin;

/**
 * EMPTY_F32's buffer, read through the intrinsic getter: the empty state of
 * the alias-check cache (`_bufOf` = EMPTY_F32, `_buf` = EMPTY_BUF), set by
 * the constructor and by `destroy()`. Every store keeps
 * `_buf === TA_BUFFER.call(_bufOf)`.
 */
const EMPTY_BUF = TA_BUFFER.call(EMPTY_F32);

/**
 * Cold-path error builders shared by `copyTo` and `copyToFast`; `name` is the
 * calling method, so each message names the method that threw. Kept out of
 * the method bodies so the string building costs no bytes there.
 */
function dstTypeError(name, dst) {
    // typeof, not String(dst): an Array would be joined, a null-prototype object throws.
    return new TypeError(
        'LiteRingBuffer: ' + name + ' needs a TypedArray dst (got ' + (dst === null ? 'null' : typeof dst) + ')'
    );
}

function boundsError(name, c, dstOffset, dlen) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' needs ' + c + ' slots from offset ' + String(dstOffset) +
        ' (dst.length ' + dlen + ')'
    );
}

function aliasError(name) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' dst shares the ring\'s buffer (copy into a separate array); nothing written'
    );
}

function storageError(name, len, cap) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' storage holds ' + len + ' slots, capacity is ' + cap +
        ' (data replaced, resized or detached); nothing written'
    );
}

/**
 * The shared prologue of `copyTo` and `copyToFast` (so the two validate
 * identically by construction). Checks, in order, all before the first
 * store: TypeError (not a TypedArray), RangeError (bounds), then -- only
 * when count > 0 -- the alias RangeError, then the storage RangeError
 * (`data`'s length, read through the intrinsic `length` getter, is not
 * `capacity`: `data` was replaced, resized or detached). Returns count; the
 * caller returns 0 when it is 0. `data` is the array the caller will copy
 * from (read once by the caller), so both checks cover exactly the copied
 * array.
 *
 * `data`'s buffer comes from an identity-keyed cache on the ring (`_bufOf`
 * / `_buf`): re-read through the intrinsic `buffer` getter whenever `data`
 * is not the cached array, and the key is stored only AFTER that read, so a
 * `data` that is not a TypedArray throws the getter's TypeError on every
 * call. A TypedArray's buffer never changes, so the cache cannot go stale.
 * On a non-extensible ring (frozen, sealed or `Object.preventExtensions`)
 * the cache is never stored: every miss re-reads the buffer and the ring is
 * not written. `dst`'s buffer is read through the intrinsic getter on every
 * call.
 *
 * The alias check is ArrayBuffer IDENTITY. Two SharedArrayBuffer objects over
 * one memory block (a structuredClone / postMessage copy of a
 * SharedArrayBuffer, a shared WebAssembly.Memory after grow) are different
 * objects and are not detected. The constructor never builds such storage;
 * only a caller that replaced `data` with a view of shared memory can reach
 * this.
 */
function copyCheck(rb, data, dst, dstOffset, name) {
    // isView alone also admits a DataView, which has no indexed slots or `set`.
    if (!ArrayBuffer.isView(dst) || dst instanceof DataView) throw dstTypeError(name, dst);
    const dlen = TA_LENGTH.call(dst);
    const c = rb.count;
    // `!(x <= len)`, not `x > len`: a NaN on either side must fail the check.
    if (!Number.isInteger(dstOffset) || dstOffset < 0 || !(dstOffset + c <= dlen)) {
        throw boundsError(name, c, dstOffset, dlen);
    }
    if (c !== 0) {
        let buf = rb._buf;
        if (data !== rb._bufOf) {
            buf = TA_BUFFER.call(data);
            if (Object.isExtensible(rb)) {
                rb._buf = buf;
                rb._bufOf = data;
            }
        }
        // Fail closed: copying a ring into its own storage would overwrite
        // samples before they are read.
        if (TA_BUFFER.call(dst) === buf) throw aliasError(name);
        const len = TA_LENGTH.call(data);
        if (len !== rb.capacity) throw storageError(name, len, rb.capacity);
    }
    return c;
}

/**
 * The full-ring Float32 path of `copyTo` (count === capacity, count >
 * COPY_LOOP_MAX, dst tagged Float32Array). Full ring: start === head. Copy
 * storage as-is with one intrinsic `set`, then rotate it into order with one
 * intrinsic `copyWithin` and a scalar loop over the smaller ring half.
 */
function rotCopy(dst, data, dstOffset, start, cap) {
    const a = cap - start;
    TA_SET.call(dst, data, dstOffset);
    if (start !== 0) {
        if (start <= a) {
            TA_COPY_WITHIN.call(dst, dstOffset, dstOffset + start, dstOffset + cap);
            for (let i = 0; i < start; i++) dst[dstOffset + a + i] = data[i];
        } else {
            TA_COPY_WITHIN.call(dst, dstOffset + a, dstOffset, dstOffset + start);
            for (let i = 0; i < a; i++) dst[dstOffset + i] = data[start + i];
        }
    }
}

/**
 * Cold-path error builders for `pushBatch`. `batchBoundsError` prints a
 * number argument as its value and anything else as its `typeof` (`null` as
 * null), so no user `toString` / `valueOf` runs while the message is built.
 */
function batchBoundsError(srcOffset, count, slen) {
    return new RangeError(
        'LiteRingBuffer: pushBatch needs non-negative integer srcOffset and count with srcOffset + count <= ' +
        'src.length (got srcOffset ' +
        (typeof srcOffset === 'number' ? '' + srcOffset : srcOffset === null ? 'null' : typeof srcOffset) +
        ', count ' + (typeof count === 'number' ? '' + count : count === null ? 'null' : typeof count) +
        ', src.length ' + slen + '); nothing written'
    );
}

function batchTypeError(tag) {
    return new TypeError(
        'LiteRingBuffer: pushBatch needs a Float32Array or Float64Array src (got ' + tag + '); nothing written'
    );
}

function batchAliasError() {
    return new RangeError(
        'LiteRingBuffer: pushBatch src shares the ring\'s buffer (push from a separate array); nothing written'
    );
}

function batchDataError(tag) {
    return new TypeError('LiteRingBuffer: pushBatch storage is a ' + tag + ', not a Float32Array; nothing written');
}

/**
 * The prologue of `pushBatch`; every check runs before the first state
 * write. In order: RangeError (bounds: `srcOffset` / `count` not
 * non-negative integers, or `srcOffset + count` past `slen`, NaN-safe),
 * TypeError (`src` is not tagged Float32Array / Float64Array, read through
 * the intrinsic Symbol.toStringTag getter: BigInt kinds included, even at
 * count 0), then -- only when count > 0 -- the storage RangeError (`data`'s
 * intrinsic length is not `capacity`), the data TypeError (`data` is not
 * tagged Float32Array: replaced storage, checked on every call, before the
 * cache is read or written) and the alias RangeError (`src`'s buffer is
 * `data`'s). Returns the tag. `data` is the array the caller
 * stores into (read once by the caller).
 *
 * `data`'s buffer comes from the same identity-keyed cache as `copyCheck`
 * (`_bufOf` / `_buf`), with the same rules: re-read through the intrinsic
 * getter whenever `data` is not the cached array, the key stored only
 * after that read and only on an extensible ring. `src`'s buffer is read
 * through the intrinsic getter on every call. The alias check is
 * ArrayBuffer identity, with `copyCheck`'s SharedArrayBuffer limit.
 */
function batchCheck(rb, data, src, slen, srcOffset, count) {
    // `!(x <= len)`, not `x > len`: a NaN on either side must fail the check.
    if (!Number.isInteger(srcOffset) || srcOffset < 0 || !Number.isInteger(count) || count < 0 ||
        !(srcOffset + count <= slen)) {
        throw batchBoundsError(srcOffset, count, slen);
    }
    const tag = TA_TAG.call(src);
    if (tag !== 'Float32Array' && tag !== 'Float64Array') throw batchTypeError(tag);
    if (count !== 0) {
        const len = TA_LENGTH.call(data);
        if (len !== rb.capacity) throw storageError('pushBatch', len, rb.capacity);
        const dtag = TA_TAG.call(data);
        if (dtag !== 'Float32Array') throw batchDataError(dtag);
        let buf = rb._buf;
        if (data !== rb._bufOf) {
            buf = TA_BUFFER.call(data);
            if (Object.isExtensible(rb)) {
                rb._buf = buf;
                rb._bufOf = data;
            }
        }
        // Fail closed: pushing a ring's own storage into it would overwrite
        // samples before they are read.
        if (TA_BUFFER.call(src) === buf) throw batchAliasError();
    }
    return tag;
}

/**
 * The masked store loops of `pushBatch`, one per `src` family, so a Float32
 * and a Float64 `src` never share a load or store site (each site stays
 * typed while it has seen at most 4 `src` hidden classes).
 */
function loopF32(data, src, h, o, n, mask) {
    for (let i = 0; i < n; i++) data[(h + i) & mask] = src[o + i];
}

function loopF64(data, src, h, o, n, mask) {
    for (let i = 0; i < n; i++) data[(h + i) & mask] = src[o + i];
}

/**
 * Cold-path error builder for the `n` of `copyLast` / `copyLastFast`; `name`
 * is the calling method. A number prints as its value, anything else as its
 * `typeof` (`null` as null), so no user `toString` / `valueOf` runs while
 * the message is built.
 */
function lastNError(name, n) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' needs a non-negative integer n (got ' +
        (typeof n === 'number' ? '' + n : n === null ? 'null' : typeof n) + ')'
    );
}

/**
 * Carries `lastCheck`'s `dst instanceof DataView` answer to `lastArgError`,
 * so a call observes `dst`'s DataView-ness at most once. A boolean, never a
 * reference: nothing is retained. Shared by every ring and by both
 * `copyLast` and `copyLastFast`; correct because nothing within the contract
 * runs between the hot write and the cold read (the one call in that window
 * is the intrinsic length getter's `call`; anything that changes what that
 * `call` resolves to -- a replaced or deleted `Function.prototype.call`, an
 * own `call` property on the getter, a changed prototype of the getter --
 * would run user code in that window and is unsupported). The file's
 * only `var`: a module `let` costs 7 B of the chain's 1 B margin (LEDGER
 * A15 R3-M2).
 */
var lastDv = false;

/**
 * Cold-path builder for `lastCheck`'s type / `n` / bounds throw site. Called
 * only after one of those checks failed, it returns the error 1.5.0 threw:
 * TypeError (not a TypedArray, or a DataView), then the native TypeError of
 * the intrinsic length read (an other-realm DataView, X10), then the `n`
 * RangeError, else the bounds RangeError. It reads `lastDv` first, before
 * any builtin call. When `n` and `dstOffset` passed, the hot body asked
 * `instanceof` and `lastDv` is that answer; only when one of them failed
 * does it ask `dst instanceof DataView` itself (the call's only ask). So a
 * view `dst` sees exactly one `instanceof DataView` per call.
 */
function lastArgError(name, dst, n, dstOffset) {
    // Read first: nothing within the contract runs between the hot write and this read.
    const dv = lastDv;
    if (!ArrayBuffer.isView(dst)) return dstTypeError(name, dst);
    // The hot body asked `instanceof` iff n and dstOffset passed; then lastDv is its answer of THIS call.
    if (Number.isInteger(n) && n >= 0 && Number.isInteger(dstOffset) && dstOffset >= 0 ? dv : dst instanceof DataView) return dstTypeError(name, dst);
    const dlen = TA_LENGTH.call(dst);
    if (!Number.isInteger(n) || n < 0) return lastNError(name, n);
    return boundsError(name, n, dstOffset, dlen);
}

/**
 * Cold-path builder for `lastCheck`'s alias / storage throw site. Called only
 * after one of those checks failed; alias first, then storage. It compares
 * `dst`'s buffer with the same `buf` the hot body compared: the cached
 * `_buf` when `data` is the cached array (the hot body has just keyed it on
 * a miss), else `data`'s buffer re-read through the intrinsic getter (a miss
 * on a non-extensible ring, which stores no key).
 */
function lastStateError(rb, data, dst, name) {
    if (TA_BUFFER.call(dst) === (data === rb._bufOf ? rb._buf : TA_BUFFER.call(data))) return aliasError(name);
    return storageError(name, TA_LENGTH.call(data), rb.capacity);
}

/**
 * The shared prologue of `copyLast` and `copyLastFast` (so the two validate
 * identically by construction): `copyCheck`'s checks with `n` validated and
 * the bounds taken on `n`. It reuses `copyTo`'s error builders and
 * `copyCheck`'s cache rules. Checks, in order, all before the first store:
 * TypeError (not a TypedArray), RangeError (`n` not a non-negative integer:
 * no coercion, no user `valueOf` / `toString` runs), RangeError (bounds:
 * `dstOffset` not a non-negative integer, or `dstOffset + n` past `dst`'s
 * intrinsic length, NaN-safe; the message reports `n`, so an `n` larger than
 * `dst` can hold throws even on an empty ring), then -- only when
 * `k = min(n, count)` > 0 -- the alias RangeError, then the storage
 * RangeError. Returns k; the caller returns 0 when it is 0, before any
 * store. `data` is the array the caller will copy from (read once by the
 * caller), so both checks cover exactly the copied array.
 *
 * The body has two throw sites: a failing type / `n` / bounds check throws
 * the error `lastArgError` builds, a failing alias / storage check the one
 * `lastStateError` builds; each cold builder re-tests, so the error thrown
 * is the first failing check's in the order above. The hot body tests
 * isView, `n`, `dstOffset`, `dst instanceof DataView` (its answer stored in
 * `lastDv`), then the bounds (1.5.0: isView, `instanceof`, the length read,
 * `n`, the bounds); the errors are still chosen in 1.5.0's order: TypeError
 * (`dst`), the native TypeError of the intrinsic length read for an
 * other-realm DataView (X10), the `n` RangeError, the bounds RangeError.
 * The `n` / `dstOffset` tests run no user code, so moving them first
 * changes no outcome, and `instanceof` still runs before the length read.
 * A view `dst` sees exactly one `instanceof DataView` per call (a user
 * `DataView[Symbol.hasInstance]` sees one call): the hot answer is reused
 * when `n` and `dstOffset` passed, and `lastArgError` asks itself only when
 * one of them failed.
 *
 * The checks call the GLOBAL `ArrayBuffer.isView`, `Number.isInteger` and
 * `DataView` (its Symbol.hasInstance) and the intrinsic length getter's
 * `call` at call time. A failing call may call `isView` / `isInteger` more
 * times than 1.5.0. A bounds failure with `n` and `dstOffset` both
 * non-negative integers reads `dst`'s length twice (the hot body, then
 * `lastArgError`); on an `n` / `dstOffset` failure the hot body never
 * reads it. A replaced builtin, or anything that changes what the length
 * getter's `call` resolves to (a replaced or deleted
 * `Function.prototype.call`, an own `call` property on the getter, a changed
 * prototype of the getter), is unsupported (out of contract). A failing
 * alias / storage call re-reads the intrinsic getters.
 *
 * The inlined chain copyLast + lastCheck + rotCopy is held at <= 766 B of
 * bytecode (V8's cumulative-inlining reserve, 920 / 1.2; 765 B on the
 * pinned V8) by test/chainsize.test.js, so copyLast stays inlinable into
 * its caller: a byte added to any of the three can bring the call back.
 *
 * `data`'s buffer comes from `copyCheck`'s identity-keyed cache on the ring
 * (`_bufOf` / `_buf`, shared with `copyTo` / `copyToFast` / `pushBatch`),
 * with the same rules: re-read through the intrinsic getter whenever `data`
 * is not the cached array, the key stored only after that read and only on
 * an extensible ring. `dst`'s buffer is read through the intrinsic getter on
 * every call. The alias check is ArrayBuffer identity, with `copyCheck`'s
 * SharedArrayBuffer limit.
 */
function lastCheck(rb, data, dst, dstOffset, n, name) {
    // One throw site for the type / n / bounds checks; lastArgError picks the error in order.
    // `!(x <= len)`, not `x > len`: a NaN on either side must fail the check.
    if (!ArrayBuffer.isView(dst) || !Number.isInteger(n) || n < 0 || !Number.isInteger(dstOffset) ||
        dstOffset < 0 || (lastDv = dst instanceof DataView) || !(dstOffset + n <= TA_LENGTH.call(dst))) {
        throw lastArgError(name, dst, n, dstOffset);
    }
    let k = rb.count;
    if (n < k) k = n;
    if (k !== 0) {
        let buf = rb._buf;
        if (data !== rb._bufOf) {
            buf = TA_BUFFER.call(data);
            if (Object.isExtensible(rb)) {
                rb._buf = buf;
                rb._bufOf = data;
            }
        }
        // Fail closed: copying a ring into its own storage would overwrite
        // samples before they are read. One throw site; lastStateError picks alias, then storage.
        if (TA_BUFFER.call(dst) === buf || TA_LENGTH.call(data) !== rb.capacity) throw lastStateError(rb, data, dst, name);
    }
    return k;
}

export class RingBuffer {
    /**
     * @param {number} [requestedCapacity=1024] minimum capacity in [1, 2^31];
     *        fractions are floored, then rounded up to the next power of two.
     * @throws {RangeError} if requestedCapacity is not a number in [1, 2^31].
     *         Exception: the error message is built with `String(x)`, so an
     *         object that `String()` cannot convert throws while the message is
     *         built: a null-prototype object gives a TypeError, an object
     *         whose `toString` / `Symbol.toPrimitive` throws gives that error
     *         (and a user `toString` runs). Nothing is constructed either way.
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
        /** @type {number} actual storage size -- always a power of two */
        this.capacity = ceilPow2(this.requestedCapacity);
        /** @type {number} bitmask for wrap-around: `i & mask` instead of `i % capacity` */
        this.mask = this.capacity - 1;
        /** @type {Float32Array} backing storage */
        this.data = new Float32Array(this.capacity);
        /** @type {number} write cursor; next push lands at `data[head]` */
        this.head = 0;
        /** @type {number} live samples, 0..capacity */
        this.count = 0;
        /**
         * @private
         * @type {Float32Array} alias-check cache key: the array `_buf` was read
         *       from (see copyCheck). Starts empty; filled by the first non-empty copy.
         */
        this._bufOf = EMPTY_F32;
        /**
         * @private
         * @type {ArrayBuffer} `_bufOf`'s buffer, read through the intrinsic getter
         */
        this._buf = EMPTY_BUF;
    }

    /**
     * Push a sample. Always succeeds; oldest sample is overwritten when full.
     * Zero allocation. Hot-path safe.
     *
     * `value` is not validated; the Float32Array store coerces it (`tryPush`
     * too): `push(null)`, `push('')` and `push([])` store 0, `push(undefined)`
     * stores NaN. null is not zero: map a missing reading to NaN yourself.
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
     * Push `count` samples `src[srcOffset] .. src[srcOffset + count - 1]`,
     * oldest first. The ring ends in exactly the state `count` calls of
     * `push` would leave: the same `data` slots, `head` and `count` (each
     * value rounds through float32; NaN round-trips (payload bits
     * unspecified: the `set` path keeps a signalling NaN that `push`
     * quiets); values are not validated). A `count` above `capacity`
     * keeps the last `capacity` samples. `count === 0` is a no-op, after
     * validation.
     *
     * `srcOffset` defaults to 0 and `count` to `src.length - srcOffset`
     * (`src`'s length read through the intrinsic `length` getter; the
     * default is computed only for an integer `srcOffset`).
     *
     * Allocates nothing for a Float32Array / Float64Array `src` while each
     * family's load / store site has seen at most 4 `src` hidden classes
     * (each subclass, realm and resizable-buffer variant counts as one),
     * Node 26.8.2 arm64. A whole Float32Array `src` that fits before the wrap
     * is one intrinsic `set`; every other call is a masked scalar loop.
     *
     * `head` and `count` are stored before the first sample, so for
     * `count` > 0 a frozen ring throws a TypeError with `data`, `head` and
     * `count` unchanged (`count` 0 returns 0) (`push` stores its sample
     * first). A sealed or
     * `Object.preventExtensions` ring works; its alias-check cache is not
     * stored (see `copyTo`). The cache (`_bufOf` / `_buf`) is shared with
     * `copyTo` / `copyToFast`.
     *
     * @param {Float32Array|Float64Array} src samples to push -- caller owns it.
     * @param {number} [srcOffset=0]
     * @param {number} [count=src.length - srcOffset]
     * @returns {number} `count` (samples consumed; may exceed `capacity`).
     * @throws {TypeError} if `src` is not a TypedArray (the intrinsic
     *         `length` getter throws; a DataView too), or is any TypedArray
     *         other than Float32Array / Float64Array (a subclass counts as
     *         its element type; BigInt64Array / BigUint64Array included),
     *         even when count is 0; or, when count > 0, if `this.data` is
     *         not a Float32Array (replaced storage, intrinsic tag, checked
     *         on every call; the `capacity`-slots RangeError is checked
     *         first); or, when count > 0 and the ring is frozen
     *         (`Object.freeze`), from the `head` store. Nothing is written.
     * @throws {RangeError} if `srcOffset` or `count` is not a non-negative
     *         integer (no coercion: a string, BigInt, Symbol, null or object
     *         is rejected, and no user `valueOf` / `toString` runs), or
     *         `srcOffset + count > src.length`; checked before the element-type check.
     *         Then, only when count > 0: if `this.data` does not hold
     *         `capacity` slots (replaced, resized or detached), or if `src`
     *         shares the ring's buffer (its ArrayBuffer, read through the
     *         intrinsic `buffer` getter, is `this.data`'s). Nothing is written.
     */
    pushBatch(src, srcOffset, count) {
        const slen = TA_LENGTH.call(src);
        if (srcOffset === undefined) srcOffset = 0;
        if (count === undefined && Number.isInteger(srcOffset)) count = slen - srcOffset;
        // Read once: batchCheck checks the same array the stores write.
        const data = this.data;
        const tag = batchCheck(this, data, src, slen, srcOffset, count);
        if (count === 0) return 0;
        const cap = this.capacity;
        const mask = this.mask;
        let h = this.head, o = srcOffset, n = count;
        if (n > cap) {
            o += n - cap;
            h = (h + n - cap) & mask;
            n = cap;
        }
        // head / count before the first data store: a frozen ring throws here, nothing written.
        this.head = (h + n) & mask;
        const c = this.count + n;
        this.count = c < cap ? c : cap;
        if (tag === 'Float32Array') {
            if (o === 0 && n === slen && h + n <= cap) TA_SET.call(data, src, h);
            else loopF32(data, src, h, o, n, mask);
        } else {
            loopF64(data, src, h, o, n, mask);
        }
        return count;
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
     * Allocates nothing, at any count, while V8 keeps the loop's stores typed:
     * each of the three store sites below (a Float32Array `dst`, a Float64Array
     * `dst`, every other element type) allocates nothing until it has seen
     * more than 4 distinct `dst` hidden classes in the process (each subclass,
     * each realm and each resizable-buffer variant counts as one). Past that
     * the site is megamorphic and boxes every non-integer sample: one
     * HeapNumber per sample, 16 B on Node 26.8.2 arm64. `copyToFast` is
     * unaffected. The `npm run alloc` MEGA lanes gate the split (Float32 and
     * Float64 `dst` stay at 0 B after every other element type has been
     * copied into) and REPORT the residual (5 Float32Array classes on the
     * Float32 site).
     *
     * Steady state only: the alias check reads `dst`'s buffer through the
     * intrinsic getter, which materializes an off-heap ArrayBuffer (a backing
     * store of `dst.byteLength`) the first time it is read on an on-heap
     * (<= 64 B) `dst` -- once per array, so a fresh small `dst` per call
     * allocates a backing store on every call (hoist it). The ring's own
     * storage (capacity <= 16) is materialized the same way on its first
     * non-empty copy.
     *
     * A full ring of more than 32 samples (COPY_LOOP_MAX) copied into a
     * Float32Array (a subclass counts; the type is read through the intrinsic
     * Symbol.toStringTag getter) is one intrinsic `set` of the whole storage,
     * then one intrinsic `copyWithin` and a scalar loop over the smaller ring
     * half to rotate it into order. Every other case, including every copy of
     * at most 32 samples, is a masked scalar loop. `set`, `copyWithin`, `buffer` and `length`
     * are the %TypedArray%.prototype intrinsics captured at module load, so a
     * subclass that overrides them cannot change what is written. For the
     * `set` + `subarray` copy (allocates one view per ring half), see
     * `copyToFast`.
     *
     * Arguments are checked up front, so a bad call throws without `dst`
     * being partially written. Order: TypeError (not a TypedArray), RangeError
     * (bounds), return 0 when the ring is empty, RangeError (alias), RangeError
     * (storage: `this.data` no longer holds `capacity` slots because it was
     * replaced, resized or detached) -- all before the first store -- then a
     * BigInt `dst` throws TypeError from that first store. So an aliasing
     * BigInt64Array gets the alias RangeError.
     * The checks live in a shared helper (`copyCheck`, also used by
     * `copyToFast`): an error's stack has one `copyCheck` frame between the
     * error and this method; the messages are unchanged.
     *
     * The alias check caches `data`'s buffer, keyed on the `data` array
     * itself (`_bufOf` / `_buf`, internal). After a caller replaces
     * `this.data`, the cache keeps the replaced array (and its buffer)
     * referenced until the next non-empty `copyTo` / `copyToFast` or
     * `destroy()`; `reset()` does not release it. A non-extensible ring
     * (frozen, sealed or `Object.preventExtensions`) stores nothing: each
     * call re-reads the buffer when `data` is not the cached array. On a
     * non-extensible ring the keys are never updated: the array cached
     * before the lock stays referenced until `destroy()`, or for the ring's
     * lifetime when frozen (`destroy()` cannot write a frozen ring).
     *
     * @param {Float32Array|Float64Array} dst destination -- caller owns it.
     * @param {number} [dstOffset=0]
     * @returns {number} number of samples written (== this.count).
     * @throws {TypeError} if `dst` is not a TypedArray (a DataView is rejected
     *         too), or is a BigInt64Array / BigUint64Array and count > 0.
     *         Nothing is written.
     * @throws {RangeError} if `dstOffset` is not a non-negative integer or
     *         `dst` cannot hold `count` samples from `dstOffset` (a Symbol
     *         or BigInt `dstOffset` included; but the message is built with
     *         `String(dstOffset)`, so a null-prototype object `dstOffset`
     *         throws a TypeError, and one whose `toString` /
     *         `Symbol.toPrimitive` throws gives that error, a user `toString`
     *         having run; empty ring too, nothing written); or, when
     *         count > 0, if `dst` shares the ring's buffer (its ArrayBuffer,
     *         read through the intrinsic `buffer` getter, is `this.data`'s);
     *         or, when count > 0, if `this.data` does not hold `capacity`
     *         slots (replaced, resized or detached; checked after the alias
     *         check). Both run before the first store, so an aliasing
     *         BigInt `dst` gets this RangeError, not the TypeError.
     *         Nothing is written.
     */
    copyTo(dst, dstOffset = 0) {
        // Read once: copyCheck alias-checks the same array the loop copies.
        const data = this.data;
        const c = copyCheck(this, data, dst, dstOffset, 'copyTo');
        if (c === 0) return 0;
        const mask = this.mask;
        const start = (this.head - c) & mask;
        // One keyed store site per element family: a site that has seen more than 4 dst
        // hidden classes goes megamorphic and boxes every non-integer sample (one
        // HeapNumber per sample, 16 B on Node 26.8.2 arm64), so Float32 and Float64 dsts
        // never share a site with each other or other kinds. Each site can still go
        // megamorphic on its own (5+ subclasses / realms / resizable variants of one
        // family; REPORTED by the last `npm run alloc` MEGA lane). copyToFast has no such site.
        const tag = TA_TAG.call(dst);
        if (tag === 'Float32Array') {
            if (c > COPY_LOOP_MAX && c === this.capacity) rotCopy(dst, data, dstOffset, start, c);
            else for (let i = 0; i < c; i++) dst[dstOffset + i] = data[(start + i) & mask];
            return c;
        }
        if (tag === 'Float64Array') {
            for (let i = 0; i < c; i++) dst[dstOffset + i] = data[(start + i) & mask];
            return c;
        }
        for (let i = 0; i < c; i++) dst[dstOffset + i] = data[(start + i) & mask];
        return c;
    }

    /**
     * Same copy, result, validation and errors as `copyTo` (the messages name
     * `copyToFast`), including the alias RangeError. Copies with at most two
     * intrinsic `set` calls over `subarray` views, one per ring half, so it
     * allocates: one view per ring half (104 B for a contiguous copy, 208 B
     * wrapped: `npm run alloc` lanes `copyToFast 1024, contiguous` /
     * `wrapped`, Node 26.8.2 arm64). `copyTo` allocates nothing (within V8's
     * 4-class limit per store site; see `copyTo`). Having no per-sample store
     * site, `copyToFast` never boxes a sample, however many `dst` classes the
     * process uses.
     *
     * @param {Float32Array|Float64Array} dst destination -- caller owns it.
     * @param {number} [dstOffset=0]
     * @returns {number} number of samples written (== this.count).
     * @throws {TypeError} as `copyTo`. Nothing is written.
     * @throws {RangeError} as `copyTo` (bad offset, `dst` too small, `dst`
     *         sharing the ring's buffer, or `this.data` not holding `capacity`
     *         slots -- so detached storage is this RangeError, not the
     *         TypeError `subarray` threw before). The alias and storage checks
     *         run before the first store, so an aliasing BigInt `dst` gets
     *         this RangeError, not the TypeError. Nothing is written.
     */
    copyToFast(dst, dstOffset = 0) {
        const data = this.data;
        const c = copyCheck(this, data, dst, dstOffset, 'copyToFast');
        if (c === 0) return 0;
        const start = (this.head - c) & this.mask;
        const firstLen = Math.min(this.capacity - start, c);
        TA_SET.call(dst, data.subarray(start, start + firstLen), dstOffset);
        if (firstLen < c) {
            TA_SET.call(dst, data.subarray(0, c - firstLen), dstOffset + firstLen);
        }
        return c;
    }

    /**
     * Copies the newest `k = min(n, count)` samples into `dst` from
     * `dstOffset`, oldest-first (the last one written is the newest sample).
     * Returns k. `copyLast(dst, off, rb.count)` writes, returns and throws
     * exactly as `copyTo(dst, off)` (the messages name `copyLast`). For a
     * whole-window copy `copyTo` is the safe choice.
     *
     * Allocates nothing in steady state under the same rule as `copyTo`: each
     * of its three store sites (a Float32Array `dst`, a Float64Array `dst`,
     * every other element type) stays typed while it has seen at most 4
     * distinct `dst` hidden classes in the process (each subclass, realm and
     * resizable-buffer variant counts as one), Node 26.8.2 arm64. The three
     * sites are copyLast's own, not copyTo's, so each method has its own
     * 4-class budget, except the whole-window Float32 path below: it runs
     * copyTo's `rotCopy`, whose scalar loop is one store site shared with
     * copyTo, so every Float32 `dst` class either method has passed through
     * `rotCopy` counts against that one 4-class budget. Past 4 a site is
     * megamorphic and boxes every non-integer sample (one HeapNumber per
     * sample, as `copyTo`). The first alias check on a fresh on-heap
     * (<= 64 B) `dst` materializes its ArrayBuffer once, as for `copyTo`
     * (hoist the `dst`).
     *
     * A full ring copied whole (n >= count === capacity > 32, COPY_LOOP_MAX)
     * into a Float32Array (a subclass counts; the type is read through the
     * intrinsic Symbol.toStringTag getter) uses copyTo's intrinsic `set` +
     * `copyWithin` rotation (`rotCopy`); every other copy is a masked scalar
     * loop over the k samples. For the `set` + `subarray` copy (allocates one
     * view per ring half it spans), see `copyLastFast`.
     *
     * `n` is required (an omitted n is a RangeError); `dstOffset` may be
     * `undefined` (then 0). Checks, in order, all before the first store:
     * TypeError (`dst` not a TypedArray), RangeError (`n` not a non-negative
     * integer), RangeError (bounds, on `dstOffset + n`, not k: an `n` larger
     * than `dst` can hold throws even on an empty ring), return 0 when k is
     * 0, RangeError (alias), RangeError (storage), then the first store (a
     * BigInt `dst` with k > 0 throws TypeError there). That error order is
     * unchanged from 1.5.0, and a view `dst` sees exactly one
     * `dst instanceof DataView` per call (a user `DataView[Symbol.hasInstance]`
     * runs once). The checks call the global `ArrayBuffer.isView`,
     * `Number.isInteger` and `DataView` at call time; a replaced builtin, or
     * anything that changes what the length getter's `call` resolves to, is
     * unsupported (see `lastCheck`). The checks live in a shared helper
     * (`lastCheck`, also used by `copyLastFast`). The alias cache
     * (`_bufOf` / `_buf`) is the one `copyTo` / `pushBatch` use, with the
     * same rules (see `copyTo`).
     *
     * @param {Float32Array|Float64Array} dst destination -- caller owns it.
     * @param {number|undefined} dstOffset undefined means 0.
     * @param {number} n samples wanted; k = min(n, count) are copied.
     * @returns {number} number of samples written (k = min(n, count)).
     * @throws {TypeError} if `dst` is not a TypedArray (an Array or a
     *         DataView), or is a BigInt64Array / BigUint64Array and k > 0.
     *         Nothing is written.
     * @throws {RangeError} if `n` is not a non-negative integer (NaN,
     *         Infinity, 1.5, '1', null, undefined, 1n; no coercion, no user
     *         `valueOf` / `toString` runs); if `dstOffset` is not a
     *         non-negative integer or `dst.length < dstOffset + n` (as
     *         `copyTo`, the message is built with `String(dstOffset)`); when
     *         k > 0, if `dst` shares the ring's ArrayBuffer or `this.data`
     *         does not hold `capacity` slots. Nothing is written.
     */
    copyLast(dst, dstOffset = 0, n) {
        // Read once: lastCheck alias-checks the same array the loop copies.
        const data = this.data;
        const k = lastCheck(this, data, dst, dstOffset, n, 'copyLast');
        // The literal 0, not k: an n of -0 returns +0.
        if (k === 0) return 0;
        const mask = this.mask;
        const start = (this.head - k) & mask;
        // copyLast's own three store sites, one per element family, as in copyTo.
        const tag = TA_TAG.call(dst);
        if (tag === 'Float32Array') {
            if (k > COPY_LOOP_MAX && k === this.capacity) rotCopy(dst, data, dstOffset, start, k);
            else for (let i = 0; i < k; i++) dst[dstOffset + i] = data[(start + i) & mask];
            return k;
        }
        if (tag === 'Float64Array') {
            for (let i = 0; i < k; i++) dst[dstOffset + i] = data[(start + i) & mask];
            return k;
        }
        for (let i = 0; i < k; i++) dst[dstOffset + i] = data[(start + i) & mask];
        return k;
    }

    /**
     * Same copy, result, validation and errors as `copyLast` (the messages
     * name `copyLastFast`), including the alias RangeError: the newest
     * `k = min(n, count)` samples, oldest-first. Copies with at most two
     * intrinsic `set` calls over `subarray` views, so it allocates one view
     * per ring half it spans (nominal 104 / 208 B, from `copyToFast`'s
     * figures). Having no per-sample store site, it never boxes a sample,
     * however many `dst` classes the process uses.
     * `copyLastFast(dst, off, rb.count)` writes, returns and throws exactly
     * as `copyToFast(dst, off)` (the messages name `copyLastFast`). The
     * checks are `copyLast`'s (one `dst instanceof DataView` per call for a
     * view `dst`; replaced builtins unsupported): see its note.
     *
     * @param {Float32Array|Float64Array} dst destination -- caller owns it.
     * @param {number|undefined} dstOffset undefined means 0.
     * @param {number} n samples wanted; k = min(n, count) are copied.
     * @returns {number} number of samples written (k = min(n, count)).
     * @throws {TypeError} as `copyLast`. Nothing is written.
     * @throws {RangeError} as `copyLast` (bad `n`, bad offset, `dst` too
     *         small for `dstOffset + n`, `dst` sharing the ring's buffer, or
     *         `this.data` not holding `capacity` slots). Nothing is written.
     */
    copyLastFast(dst, dstOffset = 0, n) {
        const data = this.data;
        const k = lastCheck(this, data, dst, dstOffset, n, 'copyLastFast');
        // Required, not a shortcut: a BigInt dst's `set` throws even for an empty view.
        if (k === 0) return 0;
        const start = (this.head - k) & this.mask;
        const firstLen = Math.min(this.capacity - start, k);
        TA_SET.call(dst, data.subarray(start, start + firstLen), dstOffset);
        if (firstLen < k) {
            TA_SET.call(dst, data.subarray(0, k - firstLen), dstOffset + firstLen);
        }
        return k;
    }

    /**
     * Visit live samples OLDEST -> NEWEST. Allocates nothing only while V8
     * inlines `fn` into this loop, which holds for ONE callback function per
     * process. The `fn(...)` call site below is shared by every ring: once a
     * second distinct callback function has been passed to any `forEach`, the
     * site is megamorphic, and a callback that is not a compile-time constant
     * inside an optimized caller (one passed through a parameter or a
     * property, or a function declaration) is called, not inlined. Every
     * non-integer sample is then boxed (16 B per sample, Node 26.8.2 arm64;
     * ~128 B per 8-sample call, REPORTED from the 2026-11-12 audit). With more
     * than one consumer, read through `copyTo`, or `getOrDefault(i, 0)` in
     * your own loop.
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
     * The alias-check cache (`_bufOf` / `_buf`) is reset to its empty state,
     * so it no longer holds the storage or its buffer either.
     * Calling any other method afterwards is undefined behavior.
     */
    destroy() {
        this.data = EMPTY_F32;
        this._bufOf = EMPTY_F32;
        this._buf = EMPTY_BUF;
        this.count = 0;
        this.head = 0;
        this.capacity = 0;
        this.mask = 0;
    }
}
