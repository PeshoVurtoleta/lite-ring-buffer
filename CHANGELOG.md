# Changelog

All notable changes to `@zakkster/lite-ring-buffer` are documented here. The
format follows Keep a Changelog; this project adheres to Semantic Versioning.

Allocation figures below are bytes per call from `npm run alloc`
(`test/alloc.mjs`: V8 `total_allocated_bytes`, 1M calls per window, minimum
over 5 steady-state windows, empty-loop baseline subtracted), Node 26.8.2
arm64, 2026-10-14. Not timed, so host load does not affect them.

## [Unreleased]

### Fixed

- `copyTo(dst)` with a `dst` that has no numeric `length` no longer slips
  past the bounds check. `dstOffset + count > undefined` is false, so an
  empty buffer returned 0 for `copyTo({})` and a non-empty one threw
  `TypeError: dst.set is not a function`. A `dst` that is not a TypedArray
  (`null`, a plain object, an `Array`, a `Map`, a `DataView`) now throws
  `TypeError: LiteRingBuffer: copyTo needs a TypedArray dst`, and the bound
  is written `!(dstOffset + count <= length)` so a NaN can never pass.
  `length` is read through the intrinsic TypedArray getter, so a subclass
  that overrides `length` cannot widen the bound (the new scalar loop would
  otherwise drop its out-of-range stores silently), and a DataView from
  another realm also throws `TypeError`. Nothing is written in any case.
- `getOrDefault(offset, defaultValue)` no longer delegates to `get`. Inlined
  into a hot loop, `get`'s `number | undefined` result boxed every non-integer
  sample: 16 B per call, even with a numeric default. It now does the bounds
  check itself, so with a numeric default every path returns a number:
  16 B -> 0 B per call. Results are unchanged, and `getOrDefault(i)` with no
  default still returns `undefined` out of range (and still boxes, 16 B).
- `destroy()` sets `data` to a shared empty `Float32Array` instead of
  `null`. Writing `null` widened the `data` field's tracked type on the
  shared hidden class from `Float32Array` to `Any` for the rest of the
  process (`--trace-generalization`: `Class;const -> Any;mutable`); now it
  only goes `const -> mutable` and keeps its `Float32Array` type. The
  backing buffer is still released, and `RingBuffer.d.ts`
  (`data: Float32Array`) is now accurate. **Behavior change:** `push`,
  `tryPush` and `reset` after `destroy()` used to throw a `TypeError` on
  `null`; now they do nothing, and `tryPush(v)` returns `true` without
  storing. Reads were already empty. It was and stays undefined behavior.

### Changed

- `copyTo` copies up to 32 samples with a scalar loop and allocates nothing.
  Through `set` + `subarray` each call allocated one 104 B view per ring
  half: 104 B contiguous, 208 B wrapped -> 0 B. Larger copies keep the
  memcpy path and its views; the JSDoc, `.d.ts` and README now state the
  allocation. The cutoff of 32 is nominal: the loop's speed against memcpy
  at that size has not been measured yet.

### Docs

- `ceilPow2` documents its behavior outside `[1, 2^32]`. Inputs are not
  validated: a fraction above 1 behaves as `Math.floor(n)`, so the result can
  be below `n` (`ceilPow2(1.5) === 1`); `0 < n < 1`, `NaN` and `+/-Infinity`
  give 1; a finite `n <= 0` gives 2^32; `n > 2^32` wraps mod 2^32
  (`ceilPow2(2 ** 32 + 1) === 1`).
- README, llms.txt and `.d.ts`: the zero-allocation list was wrong about
  `get(i)`, which allocates 16 B per call on non-integer samples; it now
  points hot loops at `getOrDefault(i, 0)` and states that every figure
  assumes V8 inlines the call. Also `destroy()`, `copyTo` allocation and
  errors, and the "no per-element loop" claim for small copies.

### Tests

- `test/alloc.mjs` (`npm run alloc`, part of `npm run verify`): an
  allocation gate for every method documented as allocation-free, with two
  control lanes (`get(i)`, one bare 16 B box, and a 104 B `subarray`) that
  must read at their known size. A lane that reads NaN, or an empty-loop
  baseline outside +/-1 B, fails the gate. Against 1.1.0 it fails on
  `getOrDefault(i, 0)` and on `copyTo` of 32 samples.
- 17 new cases (42 -> 59): `copyTo` through the loop and set paths,
  contiguous and wrapped, into Float32Array and Float64Array, checked
  against the pushed sequence; other TypedArray kinds; `copyTo({})` on empty
  and non-empty buffers; non-TypedArray `dst` including `Map` and
  `DataView` (same realm and from `node:vm`); a `Float32Array` subclass whose
  `length` getter lies; `ceilPow2` outside its domain; `getOrDefault` agreeing with
  `get` after wrap; `destroy()` leaving one shared empty `Float32Array`. The
  `destroy()` test no longer expects `null`.

## [1.1.0] and earlier

Not recorded in this file; see the git history.
