# Changelog

All notable changes to `@zakkster/lite-ring-buffer` are documented here. The
format follows Keep a Changelog; this project adheres to Semantic Versioning.

Allocation figures below are bytes per call from `npm run alloc`
(`test/alloc.mjs`: V8 `total_allocated_bytes`, 1M calls per window, minimum
over 5 steady-state windows, empty-loop baseline subtracted), Node 26.8.2
arm64, 2026-10-14. Not timed, so host load does not affect them.

## [Unreleased]

### Docs

- One package-wide out-of-contract note for `copyTo`, `copyToFast`, `copyLast`, `copyLastFast` and `pushBatch` (README "Edge cases & guarantees", `llms.txt`, the `RingBuffer.d.ts` class JSDoc, and the matching `RingBuffer.js` comments; comments only, no code change): the `%TypedArray%.prototype` getters and `set` / `copyWithin` are captured at load, while the globals `ArrayBuffer.isView`, `Number.isInteger`, `DataView`, `Object.isExtensible` (and `Math.min`, `data.subarray` and the `constructor` / `Symbol.species` lookups it makes, for the Fast methods) and every captured intrinsic's `call` resolve at call time; replacing them is unsupported. The existing `copyLast` lists now name every builtin the checks consult and point to the note for the full set.

## [1.5.4] - 2026-11-15

### Docs

- README "Why" item 2 now says it describes the naive `push` / `shift` array, not a preallocated Array ring, points to the Comparison section, and no longer says every entry is a boxed double (boxing only when values leave the packed-double path); the "Naive Array" diagram's push node matches.
- The out-of-contract note for the `copyLast` / `copyLastFast` checks (README, `llms.txt`, `RingBuffer.d.ts`, and the matching `RingBuffer.js` comments; comments only, no code change) now names the whole class: anything that changes what the intrinsic length getter's `call` resolves to (replacing or deleting `Function.prototype.call`, an own `call` property on the getter, or a changed prototype of the getter).

### Tests

- `test/bench/compare.mjs` (dev-only, not shipped): the probe-output accept check is now a pure `acceptProbe` with self-test cases for every clause (self-test 106 -> 125 checks); a bare run's default output dir is `.handoff/bench-compare/compare-<ISO>/`.

## [1.5.3] - 2026-11-15

### Docs

- README: the unsourced wrap-cost claim (`& mask` roughly 3-5x cheaper than `%`) is replaced by measured figures (REPORTED, one strict QUIET run 2026-11-15, Apple M4 Pro, Node v26.8.2, load1 2.62 at start / 1.68 at end, K 21 x 3 compilations): per wrap step `% capacity` is 1.784x [1.759..1.829] the `& mask` step at the same power-of-two capacity and 5.630x [5.583..5.799] at a non-power-of-two one; inside a hand-rolled Float32Array push 1.057x [1.042..1.203] and 3.204x [3.186..3.249]. The FAQ no longer says `%` is a division.
- README: new "Comparison (REPORTED)" table (push, get / getOrDefault, copyTo n 32 / 1024 against hand-rolled Float32Array and Array rings and lite-o1 RingDeque), with provenance.

### Tests

- New dev-only `npm run bench:compare` (`test/bench/compare.mjs` + `compare-probe.mjs`; REPORTED, not in `verify`, not shipped).
- devDependency `@zakkster/lite-o1` ^1.11.3 (maintainer-ruled 2026-11-15); runtime `dependencies` stays empty.

## [1.5.2] - 2026-11-15

### Docs

- README / llms.txt integer-precision note gains the monotonic energy-counter example (Wh totals belong in the caller's Float64 columns).
- Comments only, no code change: `RingBuffer.js` comment clarifications from the 1.5.1 review: `lastCheck`'s length-read note (twice only on a bounds failure with valid `n` and `dstOffset`), the `lastDv` window note (an own `call` on the length getter is out of contract), `copyLast`'s whole-window note now matches the docs (`copyTo` is the safe choice).

### Tests

- `test/copylast-hooks.test.js` offset rows gain a fractional and a non-number `dstOffset` (31,464 -> 43,776 stage-H rows, 9 -> 11 golden rows; test count unchanged).

## [1.5.1] - 2026-11-15

### Changed

- `copyLast` / `copyLastFast`: the check helper (`lastCheck`) is trimmed so the inlined chain copyLast + `lastCheck` + `rotCopy` is 765 B of bytecode (<= 766 B, V8's cumulative-inlining reserve on Node v26.8.2 / V8 14.6.202.34-node.28; 1.5.0: 791 B) so `copyLast` is inlinable into its caller (DETERMINISTIC: the chain size is gated by `test/chainsize.test.js` on the pinned engine; whether a given caller inlines it depends on that caller's remaining inlining budget). Parity `copyLast(dst, off, count)` / `copyTo` (REPORTED, STATISTICAL; two runs of `quiet-lock run --strict`, exit 0 both, host QUIET both: strict-1 2026-11-15T05:55:32Z..05:56:50Z (load1 1.09 at start, 1.66 at end) and strict-2 2026-11-15T06:08:14Z..06:09:32Z (load1 2.20 at start, 1.73 at end), baseline 2.21; Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28; K 21 rounds x 3 compilations = 63 paired rounds per row; every timed column 0.00 B/op; candidate 9e70b525 vs reference 9765c21e = HEAD). The 1.5.0 gap (1.17x / 1.52x) is closed on the medians (Q-M1-STRICT, medians of both runs; strict-1 ; strict-2): Float32 1024 is 1.02 [0.97..1.04] ; 1.01 [0.96..1.02] at head 0 and 1.02 [1.01..1.17] ; 1.01 [1.00..1.03] at head 768; Float64 1024 is 1.00 [1.00..1.01] ; 0.99 [0.91..1.00] at head 0 and 1.00 [0.99..1.00] ; 1.00 [1.00..1.19] at head 768; a 32-sample ring is 1.02 ; 1.02 (Float32) and 1.02 ; 1.01 (Float64). One compilation was slow in each run: strict-1 Float32 head 768 one of three compilation medians read 1.18 (the others 1.02 / 1.01); strict-2 Float64 head 768 one read 1.19 (the others 1.00 / 1.00), on a row that showed no gap in 1.5.0; every strict-2 Float32 compilation median is <= 1.05. Against the caller workaround (`copyTo` the whole window + copy its last n), full 1024 ring, each claim = minimum over both heads and the lower of the two runs: n 120 is 2.1x (Float32) / 2.2x (Float64) faster, n 512 is 1.5x (Float32) / 1.2x (Float64) (1.5.0 said 1.5x at n 512 for both). Parity is not guaranteed: it depends on the caller's inlining budget (a caller with no budget left inlines neither method).
- Observable behaviour: the thrown error for every input is unchanged from 1.5.0 (same order: TypeError `dst`, other-realm DataView native TypeError at the length read, `n` RangeError, bounds RangeError, return 0, alias, storage). A view `dst` sees exactly one `dst instanceof DataView` per call (a user `DataView[Symbol.hasInstance]` runs once, as in 1.5.0). Differences vs 1.5.0 are visible only to replaced builtins: `n` / `dstOffset` are tested before the DataView check on every call (1.5.0: after); a failing call may call the global `ArrayBuffer.isView` / `Number.isInteger` more often; a call with a valid `dstOffset` that fails the bounds test reads `dst`'s length twice (a bad `dstOffset` reads it once). The checks call the GLOBAL `ArrayBuffer.isView`, `Number.isInteger` and `DataView` and the intrinsic length getter's `call` at call time; a replaced builtin, a replaced `Function.prototype.call` or an own `call` property on the intrinsic length getter is unsupported (out of contract).
- Internals: a module-scope boolean carries the hot DataView answer to the cold error builder (a boolean, nothing retained).

### Tests

- `npm test` count 281 -> 294 (`EXPECTED` and `FILES` in `test/count.mjs`): new `test/chainsize.test.js` (5, DETERMINISTIC: the inlined chain is <= 766 B on the pinned engine Node v26.8.2 / V8 14.6.202.34-node.28 and the test fails on any other Node; must-fail controls) and `test/copylast-hooks.test.js` (4: 31,464 stage-H rows, 6 `hasInstance` hooks x 19 `dst` values including Proxy prototypes, event sequence compared with a transcription of 1.5.0; 9 golden rows; 30 hook re-entry rows; 30 replaced-`Number.isInteger` re-entry rows, out of contract but pinned) and `test/qa-m1.test.js` (4, an independent boundary suite: a `hasInstance` hook that resets, destroys or pushes into the ring, or resizes / transfers a resizable `dst` buffer, during the check gets 1.5.0's result).

## [1.5.0] - 2026-11-15

New `copyLast(dst, dstOffset, n)` and `copyLastFast` (R3), plus the `pushBatch` doc fixes of the 1.4.0 post-release audit. Alloc and torture figures below are from the R3 build 9765c21e (Node v26.8.2 arm64, 2026-11-15), PRELIMINARY host (another node process >= 100% CPU; load1 1.54 at the release verify start vs baseline 2.21); both are untimed counts.

### Added

- `copyLast(dst, dstOffset, n)`: copies the newest `min(n, count)` samples oldest-first into a Float32Array / Float64Array from `dstOffset` (`undefined` means 0) and returns that count. `n` is required; the bounds check is on `dstOffset + n` (not on the copied count), so an `n` larger than `dst` can hold throws even on an empty ring; a count of 0 returns 0 before the alias and storage checks. `copyLast(dst, off, rb.count)` writes, returns and throws exactly as `copyTo(dst, off)` (the messages name `copyLast`). Allocates 0 B under `copyTo`'s per-store-site 4-class rule, with one exception: the whole-window Float32 path runs `copyTo`'s `rotCopy`, whose store site is shared with `copyTo`, so the Float32 `dst` classes either method passes through `rotCopy` count against one budget. For a whole-window copy prefer `copyTo`. Against copying the whole window and then its last n, `copyLast` is 2.2-2.3x faster at n 120 and 1.5x at n 512 on a full 1024 ring (REPORTED, strict A/B 2026-11-15, Node v26.8.2 arm64).
- `copyLastFast(dst, dstOffset, n)`: the same contract and errors with at most two `set` calls over `subarray` views; allocates one view per ring half it spans (REPORTED: 104.0 B contiguous / 208.0 B straddling, `npm run alloc`, 2026-11-15, Node v26.8.2 arm64) and never boxes a sample.

### Tests

- `npm test` count 229 -> 281: new `test/copylast.test.js` (19), `test/copylast-parity.test.js` (9) and `test/qa-r3.test.js` (22, an independent boundary suite: cap 1 / 2 rings, `dst` edges, -0, resizable / growable / detached / other-realm / offset-subarray `dst`, destroyed and frozen rings, interleaved cache states, a `copyLastFast` parity matrix), and `test/mutant-kills.test.js` 8 -> 10 (`EXPECTED` and `FILES` in `test/count.mjs`). The R3 mutant set (24 mutants) is killed in full.
- `npm run alloc` gains the `copyLast` lanes (n 120 / 1024, contiguous and straddling, Float32 and Float64 `dst`; the whole window at head 768), the REPORTED `copyLastFast` lanes and the `MEGA copyLast` lanes with an Int16 must-allocate control. `npm run torture` gains the gated lanes `copyLast 120 straddling F32+F64` (250,000 ops) and `copyLast(count) ROT full 1024` (125,000 ops), and its buffer-retention tracker covers `copyLast`.
- New dev-only `npm run bench:copylast` (`test/bench/copylast-ab.mjs` + `test/bench/copylast-probe.mjs`; STATISTICAL: strict quiet lock, not in `verify`, not shipped): interleaved A/B of `copyLast` against a caller's `copyTo` + loop and of `copyLast(count)` against `copyTo`.

### Docs

- README / `.d.ts` / `llms.txt`: `pushBatch` doc truth from the 1.4.0 post-release audit. After `destroy()` only valid arguments are a silent no-op (invalid ones still throw); a frozen ring throws from the `head` store only for `count` > 0 (`count` 0 returns 0); the batch-ingest summary no longer says "exactly" (NaN payload bits unspecified: the whole-Float32 `set` path keeps a signalling-NaN payload that `push` quiets (audit probe, Node v26.8.2 arm64)). No code change.
- `RingBuffer.js` JSDoc: the `pushBatch` doc fixes of the 1.4.0 post-release audit (AUDIT N1 / N2, R2-9) now live in the JSDoc as well as README / `.d.ts` / `llms.txt`.

## [1.4.0] - 2026-11-14

New `pushBatch(src, srcOffset, count)` (R2), plus test tooling. Alloc and torture figures below are from the R2 build ff6ee762 run of 2026-11-14 (Node v26.8.2 arm64), PRELIMINARY host (load1 4.03 at the verify start vs baseline 2.21).

### Added

- `pushBatch(src, srcOffset = 0, count = src.length - srcOffset)`: pushes `count` samples from a Float32Array / Float64Array and returns `count`. The state is that of `count` calls of `push` (same `data` slots, `head`, `count`; values round through float32, same values by `Object.is`, NaN payload bits unspecified). `count` > `capacity` keeps the last `capacity` samples; `count` 0 is a no-op after validation.
- `pushBatch` errors, all before the first data store (nothing written): `TypeError` for a non-TypedArray `src` or any TypedArray other than Float32Array / Float64Array (BigInt kinds, even at count 0), for count > 0 a `this.data` that is not a Float32Array (intrinsic tag, every call; the `capacity`-slots RangeError is checked first), and, for count > 0, a frozen ring (from the `head` store); `RangeError` for `srcOffset` / `count` not non-negative integers (no coercion), `srcOffset + count > src.length` (before the element-type check), and for count > 0 a `data` not holding `capacity` slots or a `src` sharing the ring's ArrayBuffer. Only a whole-ring `Object.freeze` is covered; per-property tampering is unsupported and may leave `head` written, as with `push`. After `destroy()` it returns `count` and stores nothing (like `push`); a detached or out-of-bounds `src` reads as length 0 (`count` omitted -> 0, explicit `count` >= 1 -> `RangeError`). The alias cache (`_bufOf`, `_buf`) is shared with `copyTo`.
- Allocation: `pushBatch` allocates nothing for a Float32Array / Float64Array `src` while each family's load / store site has seen at most 4 `src` hidden classes (Node 26.8.2 arm64); gated by the `npm run alloc` lanes below.
- Speed: for a few samples per call a loop of `push` is faster (1 and 8 samples per call); `pushBatch` is faster at 32 and 128 (strict A/B, see `npm run bench:pushbatch` below; the crossover between 8 and 32 was not measured).
- Bytecode size, REPORTED (`bytecode-budget.sh` GATE `--max pushBatch=459,batchCheck=459 --node-version v26.8.2`, exit 0, Node v26.8.2): `pushBatch` 322 B, `batchCheck` 294 B, under the 460 B inline limit; a padded must-fail control (`pushBatch` 736 B) exits 1. Run by hand, not in `npm test`.

### Tests

- The inlining tool now reads `inlining-budget-diff.sh` from the new devDependency `@zakkster/lite-utils`, pinned exactly to "1.0.0" (`dependencies` stays empty). The vendored `test/tools/inlining-budget-diff.sh` (LiteUtils 465881b) is deleted. Resolution is fail closed: only `node_modules/@zakkster/lite-utils`, package name + version 1.0.0 + script present, else exit 2 with a named reason; a version row also fails on a dependency bump.
- `test/InliningTool.test.js` 31 -> 35 tests; the script's `--self-test` is now 92 checks (was 89) and six script mutants are red (the null-control mutant m4 that survived every deterministic row at 465881b is now killed).
- New dev-only `npm run deopt-diff` (`test/tools/deopt-diff.mjs`, REPORTED, not in `verify`): deopt-diff of `copyTo` (or `--fn LIST`), HEAD vs the working tree, f32 and f64 drivers plus a blind control that must read DIFF; new `test/DeoptTool.test.js` (7 deterministic tests).
- `npm test` 163 -> 174 tests (LU2), then 174 -> 222 with new `test/pushbatch.test.js` (48 tests: physical parity with `push`, defaults and return values, bad arguments, storage / alias / sealed / frozen rings, replaced storage element type), then 222 -> 229 with new `test/qa-r2.test.js` (7 qa tests: `src` / `data` read through the intrinsic `length` / `buffer` getters, never a spoofable property; cross-realm Float32Array / Float64Array `src` accepted; the destroyed-ring and detached-`src` behaviours).
- `npm run alloc` gains 7 `pushBatch` lanes (Float32 / Float64 `src`; whole, sliced, wrapped, over-capacity), a BIGINT lane and 2 MEGA lanes (Float32 / Float64): every one 0.0-0.2 B per call against the < 1 B gate, with must-allocate controls `maskBig` and `maskMega` (F32 / F64) at about 2048 B per call (PRELIMINARY host, load1 4.03, 2026-11-14, `npm run verify` of build ff6ee762).
- `npm run torture` gains the gated lane `pushBatch 1024 set+slice+F64+over-cap` (125,000 ops): major 0 / minor 0.
- The deopt-diff driver (`test/tools/deopt-driver.mjs`) gains a guarded `pushBatch` phase.
- New dev-only `npm run bench:pushbatch` (`test/bench/pushbatch-ab.mjs` + `test/bench/pushbatch-probe.mjs`, committed in eef921f): strict interleaved A/B harness for `pushBatch` vs a caller's `push` loop. STATISTICAL, not in `verify`. Run of record on build ff6ee762 (`quiet-lock run --strict`, exit 0, QUIET at start (a docs run may have overlapped part of the 52 s window; A/A bands held), load1 3.17 -> 3.57, 2026-11-14T21:17Z, Apple M4 Pro, Node v26.8.2, 21 rounds x 3 compilations = 63 paired rounds per config, 20 configs): a `push` loop is faster at 1 and 8 samples per call, `pushBatch` is faster at 32 and 128, in every Float32 / Float64 `src` cell; every A/A median 0.968-1.024.

## [1.3.0] - 2026-11-12

`copyTo` allocates 0 B at every size while each of its store sites has seen at most 4 `dst` hidden classes (R1 + R1b + the 2026-11-12 audit fix); new allocating `copyToFast`; a `dst` that aliases the ring, or a ring whose storage was replaced or detached, now throws `RangeError` and writes nothing. Alloc figures: `npm run alloc` inside `npm run verify`, 2026-11-12, Node v26.8.2 arm64 (DETERMINISTIC, gated). Timing: STATISTICAL, REPORTED only.

### Added

- `copyToFast(dst, dstOffset)`: the 1.2.1 `set` + `subarray` copy with identical validation and errors; allocates 104 B (contiguous) / 208 B (wrapped) per call (REPORTED: 104.0 / 208.1 B/op in `npm run alloc`).
- Dev-only `npm run bench:copyto` (`test/bench/copyto-ab.mjs`; STATISTICAL: strict quiet lock, not in `verify`, not shipped): interleaved before/after `copyTo` A/B with A/A and must-fail controls.

### Changed

- `copyTo` allocates 0 B at every size (1.2.1: scalar loop up to 32 samples, `set` over two `subarray` views above, 104 B contiguous / 208 B wrapped), with one residual: each of its three store sites (Float32Array `dst`, Float64Array `dst`, every other element type) allocates nothing until it has seen more than 4 distinct `dst` hidden classes in the process (each subclass, realm and resizable-buffer variant counts as one); past that the site boxes every non-integer sample (16 B each, Node 26.8.2 arm64). `copyToFast` is unaffected. Every gated `copyTo` lane in `npm run alloc` (MEGA lanes included) is <= 0.2 B per call against the < 1 B gate; the MEGA lanes gate the family split and an Int16 must-allocate control, and REPORT the residual (5 Float32Array classes, ~512 B per 32-sample call, not gated). A small (<= 64 B) on-heap `dst` has its ArrayBuffer materialized once by the alias check (about 32-61 B off-heap per fresh small `dst`, REPORTED).
- `copyTo` uses the %TypedArray%.prototype `set` / `copyWithin` / `buffer` intrinsics, so a `dst` subclass that overrides them no longer changes the result.
- Full Float32 rings of <= 32 samples take the masked loop; only above 32 (`COPY_LOOP_MAX = 32`, nominal) a full Float32 ring takes `set` + `copyWithin` rotation plus a loop over the smaller half. The loop may quiet a signalling-NaN payload.
- Validation moved into a shared helper (`copyCheck`, used by `copyTo` and `copyToFast`): error stacks gain two frames vs 1.2.1 (the error builder and `copyCheck`); messages are unchanged. `this.data` is read once per call, before the checks.
- `copyTo` / `copyToFast` throw a new storage `RangeError` (only when count > 0, after the alias check) when `this.data` no longer holds `capacity` slots (replaced, resized or detached); `copyToFast` on detached storage was a V8 `TypeError` before. Nothing is written.
- A frozen, sealed or non-extensible ring copies correctly: the alias-check cache is not stored, so each copy re-reads the buffer. The array cached before the lock stays referenced until `destroy()`, or for the ring's lifetime when frozen.
- The ring carries two enumerable own keys, `_bufOf` and `_buf` (alias-check cache; they show in `Object.keys`, and `JSON.stringify` of a ring that has copied serializes its storage twice). A replaced `data` (and its buffer) stays referenced until the next non-empty copy or `destroy()`; `reset()` does not release it.
- Speed vs 1.2.1 (43adb369) of the audit-fix build (c450e686), one strict QUIET run 2026-11-12 (STATISTICAL, REPORTED; Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, load1 2.74 -> 1.54, baseline 2.21, K 21 x 3 compilations, A/A 0.987..1.014): n = 32 is 1.47-1.52x slower; n = 64 and 128 are faster in every layout; a Float64 `dst` is faster at every n >= 64; Float32 rings are 1.29x (wrapped) / 1.34x (count n-1) slower at 256 and 3.03x (full, wrapped) / 3.85x (count n-1) slower at 1024. Cost of the audit fix against the previous build (63eb5bc1), same day, K 21 x 3, one quiet-lock hold, QUIET at hold start (load1 1.64; 4.40 at this run's start after the hold's earlier steps, 3.99 at end): TIE in 30 of 30 configs, medians 0.99-1.11x. Use `copyToFast` when large wrapped or partly filled Float32 copies are hot and 104 / 208 B per call is acceptable.

### Fixed

- An aliasing BigInt64Array / BigUint64Array `dst` gets the alias `RangeError` (the alias and storage checks run before the first store); a non-aliasing one still gets the `TypeError`.
- A `dst` sharing the ring's ArrayBuffer made `copyTo` silently corrupt a wrapped ring; it now throws `RangeError` and writes nothing.

### Docs

- `forEach`: "zero allocation with a hoisted callback" holds for ONE callback function per process; a second distinct callback boxes (about 128 B per 8-sample call, REPORTED from the 2026-11-12 audit).
- `push` / `tryPush` coerce like a typed-array store: `null`, `''`, `[]` store 0; `undefined` stores NaN; map missing readings to NaN yourself.
- A null-prototype object or an object with a throwing `toString` as capacity or `dstOffset` throws `TypeError` / the user's error, not the documented `RangeError` (a Symbol, BigInt or plain object still gets the `RangeError`).
- `ceilPow2`: a finite `n` in (-2^31, 0] gives 2^32; at or below -2^31 the uint32 wrap decides (`ceilPow2(-(2 ** 31)) === 2 ** 31`).
- The alias check is ArrayBuffer identity: two SharedArrayBuffer objects over one memory block are not detected.
- README Companion paragraph no longer says the read side is not allocation-free.
- README / llms.txt: a finite value with `|x| >= 2^128 - 2^103` (about 3.4e38) stores as +/-Infinity (`push(1e39)` stores `+Infinity` though it passes `v === v`); the docs said only that values round-trip through float32.
- README Worker FAQ / llms.txt: the claim that the same head/mask discipline works across Workers over a `SharedArrayBuffer` was false (both threads would write `count`); cross-thread use needs a separate SPSC ring with Atomics-published single-writer indices, which this package is not.
- README integer FAQ: integers with `|x| <= 2^24` read back exactly (it said "any value `|x| < 2^24`", which excluded 2^24 itself and implied fractions are exact); now matches llms.txt.

### Tests

- `npm test` count 90 -> 163: `test/RingBuffer.test.js` 60, `test/InliningTool.test.js` 31, new `test/copyto.test.js` 30, `test/copyto-r1b.test.js` 9, `test/audit-fix.test.js` 10, `test/mutant-kills.test.js` 8 and `test/qa-r1.test.js` 15 (`EXPECTED` and `FILES` in `test/count.mjs`). The new files cover the storage error, frozen / sealed rings and 13 engine mutants. New lanes cover alias, overriding-subclass, validation and full-ring parity cases for `copyTo` / `copyToFast`.
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
