# Changelog

All notable changes to `@zakkster/lite-ring-buffer` are documented here. The
format follows Keep a Changelog; this project adheres to Semantic Versioning.

Allocation figures below are bytes per call from `npm run alloc`
(`test/alloc.mjs`: V8 `total_allocated_bytes`, 1M calls per window, minimum
over 5 steady-state windows, empty-loop baseline subtracted), Node 26.8.2
arm64, 2026-10-14. Not timed, so host load does not affect them.

## [Unreleased]

Release 1.3.0 is on hold; nothing here is versioned yet. Runtime change to `copyTo` (R1 + R1b) plus tooling and docs. Alloc figures: `npm run alloc` inside `npm run verify`, 2026-11-12, Node v26.8.2 arm64 (DETERMINISTIC, gated). Timing: STATISTICAL, REPORTED only.

### Changed

- `copyTo` allocates 0 B at every size (1.2.1: scalar loop up to 32 samples, `set` over two `subarray` views above, 104 B contiguous / 208 B wrapped). Every `copyTo` lane in `npm run alloc` is <= 0.2 B per call against the < 1 B gate.
- `copyTo` uses the %TypedArray%.prototype `set` / `copyWithin` / `buffer` intrinsics, so a `dst` subclass that overrides them no longer changes the result.
- Full Float32 rings of <= 32 samples take the masked loop; only above 32 (`COPY_LOOP_MAX = 32`, nominal) a full Float32 ring takes `set` + `copyWithin` rotation plus a loop over the smaller half. The loop may quiet a signalling-NaN payload.
- Validation moved into a shared helper (`copyCheck`, used by `copyTo` and `copyToFast`): error stacks gain two frames vs 1.2.1 (the error builder and `copyCheck`); messages are unchanged. `this.data` is read once per call, before the checks.
- The ring carries two enumerable own keys, `_bufOf` and `_buf` (alias-check cache; they show in `Object.keys`, and `JSON.stringify` of a ring that has copied serializes its storage twice). A replaced `data` (and its buffer) stays referenced until the next non-empty copy or `destroy()`; `reset()` does not release it.
- Speed vs 1.2.1, one strict QUIET run 2026-11-12 (Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, load1 2.10 -> 1.36, baseline 2.21, K 21 x 3 compilations): n = 32 is 1.33-1.38x slower; n = 64 and 128 are faster in every layout; a Float64 `dst` is faster at every n >= 64; Float32 rings are 1.26-1.30x slower at 256 (wrapped, count n-1) and 3.10x (full, wrapped) / 3.75x (count n-1) slower at 1024. Use `copyToFast` when large wrapped or partly filled Float32 copies are hot and 104 / 208 B per call is acceptable.

### Added

- `copyToFast(dst, dstOffset)`: the 1.2.1 `set` + `subarray` copy with identical validation and errors; allocates 104 B (contiguous) / 208 B (wrapped) per call (REPORTED: 104.0 / 208.1 B/op in `npm run alloc`).
- Dev-only `npm run bench:copyto` (`test/bench/copyto-ab.mjs`; STATISTICAL: strict quiet lock, not in `verify`, not shipped): interleaved before/after `copyTo` A/B with A/A and must-fail controls.

### Fixed

- A `dst` sharing the ring's ArrayBuffer made `copyTo` silently corrupt a wrapped ring; it now throws `RangeError` and writes nothing.

### Tests

- `npm test` count 90 -> 130: `test/RingBuffer.test.js` 60, `test/InliningTool.test.js` 31, new `test/copyto.test.js` 30 and `test/copyto-r1b.test.js` 9 (`EXPECTED` and `FILES` in `test/count.mjs`). New lanes cover alias, overriding-subclass, validation and full-ring parity cases for `copyTo` / `copyToFast`.
- `npm run torture` gains a gated `copyTo` 1024 Float32 lane (start walks 0..1023) and a buffer tracker: the backing `ArrayBuffer` of 256 live instances is reclaimed after `destroy()`.
- New `npm run inline-diff` (`test/tools/inline-diff.mjs`, REPORTED tier: not in `verify`, run by hand under the quiet lock before each release and in any unit that edits `RingBuffer.js`). It stages `git show HEAD:RingBuffer.js` (or `--before FILE` / `--before-ref REF`) and the working-tree file, plus three must-fail controls (copies whose `getOrDefault`, `peekNewest` or `peekOldest` is padded past V8's default 460-byte max-inlined-bytecode-size), and runs the vendored script with `--fn getOrDefault,peekNewest,peekOldest` on turbo and maglev. Exit 0 = A/A SAME and every control DIFF naming only its own function in every tier; 1 = A/A DIFF or a blind control; 2 = NO-VERDICT.
- New `test/InliningTool.test.js` (31 tests, in `npm test`): vendored-script sha pin and its teeth, the script's `--self-test`, five script mutants that must go red plus a driver-exit mutant caught against real V8, and the `inline-diff.mjs` verdict / fail-closed rows against a stub script. A missing bash, git or node fails red; nothing skips.
- `npm test` count 59 -> 90 (`test/RingBuffer.test.js` 59 + `test/InliningTool.test.js` 31; `EXPECTED` in `test/count.mjs`).
- Vendored `test/tools/inlining-budget-diff.sh`: byte-identical copy of `@zakkster/lite-utils` (unpublished) commit 465881b, sha256 f13f33c2dfa8d5891313125d98d298260c019900989339bd751239c8eb9f19c1, 1530 lines. Never edited here; fixes go to LiteUtils.
- Census 2026-11-11 ~01:02Z, Node v26.8.2 arm64, HEAD 27a8326, host QUIET at start (load1 2.72 vs baseline 2.21): 5 full runs of the pre-review inline-diff.mjs (e1e63ad8), all exit 0, ~7 s each; 1 run of the shipped 3fae616d, exit 0, host PRELIMINARY load1 3.78 (fix-run.log) (REPORTED).

## [1.2.1] - 2026-11-11

Tooling and docs only: no runtime change. `RingBuffer.js` and `RingBuffer.d.ts` differ from 1.2.0 only in three comment characters.

### Tests

- `npm test` = `node test/count.mjs`: runs `test/RingBuffer.test.js` through `node:test` `run()` under `--expose-gc` and is count-gated (exactly 59 tests pass, 0 fail, 0 skipped or todo; an empty, skipped, crashed or early-exiting file fails). `--test-name-pattern` passthrough is lost (extra args are read as test files). The 1M-push heap smoke test fails, not skips, when gc is not exposed. The test file moved from the package root to `test/`.
- New `npm run torture` (`test/torture.mjs`, dev-only): lite-leak retention (all 4096 churned instances tracked mid-run, exact count gated, then drained to tracker size 0; the backing `data` of 256 live instances is reclaimed after `destroy()`) and a lite-gc-profiler budget of major 0 / minor 0 over 2,000,000 ops on each of 6 lanes, with a control lane that must collect. `copyTo` of more than 32 samples and `get(i)` are reported, not gated. GC-count resolution is nominal: torture prints it as `res=` and it depends on the V8 new-space size, so a gated lane reading minor 0 proves it allocates less than `res` B/op, not 0 B/op; `npm run alloc` stays the per-op byte gate.
- `npm run torture` GATE line prints `res=` (CONTROL lane B/op divided by its minor-GC count). `test/ascii.mjs` self-control is flat module code (output unchanged).
- New `npm run ascii` (`test/ascii.mjs`): flags any code point above U+007F other than U+00D7 and U+00B5 in `package.json`, the `files[]` entries and `test/`; self-checked, exit 2 if the check itself is broken.
- New `npm run verify` = `npm test && npm run alloc && npm run torture && npm run ascii`.
- `devDependencies` swapped `vitest` for `@zakkster/lite-gc-profiler`, `@zakkster/lite-leak` and `@zakkster/lite-signal` (dev-only; `dependencies` stays empty).
- The dev scripts need Node >= 24 (`test/alloc.mjs` uses V8 `total_allocated_bytes`). The runtime `engines` field stays `>=18`.

### Docs

- README and llms.txt are ASCII-only (em dash -> `--`, arrow -> `->`, and so on); U+00D7 is kept. `RingBuffer.js` and `RingBuffer.d.ts` differ from 1.2.0 only in comment characters (U+2014 -> `--`); no behavior change.
- README gains a Testing section; the smoke-test claim in README and llms.txt now states the `--expose-gc` and fail-not-skip facts.

## [1.2.0] - 2026-10-14

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
- README Companion libraries: "Each stage holds zero allocation in steady
  state" was false. `lite-stats-math` (`compute`, `quantile`) and
  `lite-canvas-graph` (`render`) call `copyTo` with a capacity-sized
  scratch, so once the ring holds more than 32 samples each call allocates
  104 B contiguous or 208 B wrapped. The README now says so.

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
