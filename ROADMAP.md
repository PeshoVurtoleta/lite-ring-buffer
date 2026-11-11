# lite-ring-buffer roadmap

Hard lessons and refusals: LEDGER.md. Planner, research and audit briefs quote its laws.

Statistical host: local QUIET window, strict (Q-STATHOST ruled 2026-11-11, R1 step 1): the copyTo A/B runs under `quiet-lock run --strict` (the promoted probe first gains a one-16-B-box-per-call must-fail column) on the R1 candidate and on each release touching `copyTo`; NOISY / BUSY = PENDING. Until the build unit promotes the probe into the repo, statistical claims are REPORTED only.

Baseline: 1.2.1 (prepared 2026-11-11: units D / D2 tooling + docs and LEDGER.md over 1.2.0, no runtime
change). 1.2.0 (`0412025`) shipped the `e3e1df1` audit fixes and the alloc gate. R1 and R2 are still open: `copyTo` keeps the 32-sample scalar cutoff (`RingBuffer.js` `COPY_LOOP_MAX`), and there is no
`pushBatch`.

Scope trimmed 2026-11-10 (maintainer). lite-o1 `RingLog` / `RingDeque` do NOT supersede this package (see
Positioning). The work left is small: pay the suite-law debt, fix R1 (bug-grade), then add R2 / R3. R4 and
Track M are parked. The 2026-11-06 fleet-telemetry addendum (ShellyProject) is folded into the items below.

Order: D (carried debt) -> R1 -> R2 -> R3 (maintainer, 2026-11-10; was R1 -> R2 -> D -> R3). D goes first
because it needs no input and no timed run, so it can fill a session while the R1 A/B waits for a quiet host,
and every later gate is written in `node:test` from the start instead of being migrated from vitest.

## Positioning (SETTLED, maintainer 2026-10-14; rechecked 2026-11-10)

This package is the Float32 telemetry ring that feeds `lite-canvas-graph` and `lite-stats-math`. General
O(1) structures live in `@zakkster/lite-o1` and are not duplicated here: `RingLog` (keep-last-N,
oldest-relative `get(i)`, `oldest()` / `newest()`), `RingDeque`, `MonoDeque` (sliding min / max),
`WindowFold` (SUM / MIN / MAX / PRODUCT, worst-case O(1) per push).

Why lite-o1 does not replace it (checked against lite-o1 1.11.3, 2026-11-10):
- Storage: `RingBuffer.data` is a `Float32Array`. `RingLog` / `RingDeque` use `Float64Array`, which is twice
  the memory per window.
- NaN: `push(NaN)` is stored and read back here, so a telemetry gap survives into `lite-stats-math`, which
  filters NaN. `RingLog` / `RingDeque` throw on NaN.
- Full ring: this ring overwrites the oldest sample. `RingDeque` throws when full.
- Bulk read: `copyTo` and the exposed `data` are how both companions read the window. Neither lite-o1
  class has a bulk copy.
- Dependents: LiteCanvasGraph, LiteStatsMath, LiteProfiler, LiteProfilerScheduler, LiteGPUProfiler.

A new feature here must serve the telemetry -> canvas / stats pipeline, keep `data` a monomorphic
`Float32Array`, and hold 0 B/op under `npm run alloc`.

## Settled

- **destroy() keeps a shared empty Float32Array** (maintainer, 2026-10-14). Use after `destroy()` is
  cleanup-time misuse; a silent no-op and a throw are equally acceptable. Do not reopen.

## Track R -- planned, in order

### D -- carried debt (suite law, not features)

STATUS 2026-11-10: committed 1d6e368 (2026-11-10); closing `npm run verify` under the quiet lock
2026-11-10 07:17Z exit 0, host PRELIMINARY (load1 5.14 vs baseline 2.21). Follow-ups: D2 below. Spec and evidence: `.handoff/D/` (gitignored).

ShellyProject's proof layer cites this package's zero-GC claim, so suite law must hold. One tooling batch:
- migrate the tests from vitest to `node:test` (`package.json` `test` script included);
- add `test/torture.mjs` (lite-leak + lite-gc-profiler) and an `npm run torture` script;
- make source and docs ASCII-only (em dashes, plus-minus, arrows in RingBuffer.js, README.md, llms.txt).
Gate: the migrated suite passes with the same test count, torture passes, and an ASCII grep over the shipped
files finds nothing.

### D2 -- gate-teeth follow-ups from unit D's review / qa (small tooling + docs batch)

STATUS 2026-11-10: done in the working tree (reviewer APPROVED, qa PASS), awaiting the maintainer's commit;
closing `npm run verify` under the quiet lock 2026-11-10 07:50Z exit 0, host PRELIMINARY (load1 3.63 vs
baseline 2.21), Node v26.8.2; log .handoff/D2/qa/q7-verify.txt.

- Test-count floor (DONE, R-2): `npm test` = `node test/count.mjs` (node:test `run()` over the explicit file
  list with `--expose-gc`; fails unless exactly 59 tests pass, 0 fail, 0 skipped / todo, no failed suite, no
  empty file). `verify` is unchanged and there is no separate count script; `FILES` and `EXPECTED` live together
  in `test/count.mjs`. This deviates from the original first bullet (a separate `"count"` script appended to
  `verify`). Every later unit that adds or removes a test updates `EXPECTED` (a test file: `FILES` too). Lost: `npm test --
  --test-name-pattern` passthrough (extra args are read as test files).
- Docs label (DONE): the GC-count resolution is nominal; torture prints it as `res=`; no value is stated in
  docs because it depends on V8 new-space size.
- Torture (DONE): retention requires exactly 4096 instances tracked mid-run.
- `get(i)` lane (DONE, R-4): stays REPORTED in torture; its 16 B tooth is `test/alloc.mjs` `CONTROL get(i)`.
- `test/ascii.mjs` (DONE): self-control flattened to flat module code.
- FILLER: `count.mjs` passes no `run()` timeout: a never-settling test hangs the gate (plain `node --test`
  behaves the same); add a bounded timeout + a must-fail control.

### LU -- inlining-budget gate (tooling + docs; no runtime change)

STATUS 2026-11-11: done in the working tree (reviewer APPROVED B1 + B2; B3 docs; qa: see NEXT.md), awaiting the
maintainer's commit. Spec and evidence: `.handoff/LU/` (gitignored). Adds `npm run inline-diff`
(`test/tools/inline-diff.mjs`) over the vendored `test/tools/inlining-budget-diff.sh` (LiteUtils 465881b, pinned
by sha256) and `test/InliningTool.test.js` (31 tests; `npm test` = 59 + 31 = 90). Details: LEDGER C10 / C11.
Maintainer rulings (AskUserQuestion, 2026-11-11):
- OQ-1 = (a) "REPORTED, by hand": `npm run inline-diff` outside verify; run under the quiet lock before each
  /release and in every unit touching `RingBuffer.js` (R1 / R2 / R3); exit logged in that unit's evidence.
- OQ-2 = (a) "Inside npm test": `test/InliningTool.test.js` in `test/count.mjs` FILES + EXPECTED.
- OQ-3 = (a) "git show HEAD": default before = `git show HEAD:RingBuffer.js` staged to temp, named by commit + sha.
- OQ-4 = (a) "Go red, fail closed": no bash -> `npm test` red.
Follow-ups: the R1 / R2 / R3 coder batches run `npm run inline-diff` (exit in the unit's evidence). The R1 / R2 coder batch unparks
deopt-diff (LEDGER A8: `--fn copyTo` plus `pushBatch`, HEAD vs candidate, Float32 / Float64 dst, REPORTED).
Parked / refused here: deopt-diff (A8), allocation-diff (A9), alloc-per-op (A10).

### R1 -- copyTo allocates at the sizes the ecosystem actually uses (bug-grade)

Finding (2026-10-14): `StatsMath.compute` / `quantile` (`LiteStatsMath/StatsMath.js:59,103`) and
`CanvasGraph.render` (`LiteCanvasGraph/CanvasGraph.js:157`) call `copyTo` with a capacity-sized scratch,
typically 1024 samples. Above 32 samples `copyTo` takes the `set` + `subarray` path: 104 B per call
contiguous, 208 B wrapped (measured, Node 26.8.2). So README's "Each stage holds zero allocation in steady
state" (the Ecosystem diagram) was false until 1.2.0 (fixed in 0412025, step 3): every frame of a graph or stats
readout allocates.

At fleet scale (NOMINAL arithmetic, not a measurement): 10,000 windows x 10 Hz is 100,000 `copyTo` calls per
second, about 10-20 MB/s of garbage from one rendering path.

`TypedArray.set` takes no source offset / length, so the only allocation-free bulk copy over a ring half is
a JS loop. Plan:
1. Timed A/B (STATISTICAL: quiet-lock, interleaved, K rounds, must-fail control): scalar loop vs `set` +
   `subarray` at 32 / 64 / 256 / 1024 / 4096 / 16384 samples, Float32 and Float64 dst, contiguous and
   wrapped. The PENDING <= 32 cutoff timing is the first row of this table. If local quiet windows keep
   ending PENDING, run it as a workflow_dispatch / nightly lane on hosted CI; the lite-fastbit32 NIGHTLY
   program (`LiteFastBit32/.handoff/PLAN-nightly-ci.md`) is the reference design. A one-off local number
   stays PRELIMINARY.
2. Decide from the numbers. Expected options: (a) loop at every size (0 B/op, slower per sample at large
   n); (b) loop up to the size where it falls behind, plus an opt-in `copyTo(dst, off, { fast: true })` for
   memcpy. Option (b) must not allocate an options object at the call site. A cutoff tuned above 1024
   covers both companions.
3. DONE in 1.2.0 (0412025): the README Ecosystem line now states the 104 / 208 B per frame. (Was: until
   then, fix the line; docs-only.)

Gate: alloc lanes for `copyTo` at 1024 contiguous and wrapped, expected 0 under the ruled (c) ROT + loop (`.handoff/PROPOSAL-r1.md` section 6: also a full-ring head n/2 lane and a non-full lane).

STATUS 2026-11-11: step 1 DONE as a research pass (`.handoff/research/r1/`, PRELIMINARY; its strict hold of
the deciding rungs is PENDING). Ruled (`.handoff/PROPOSAL-r1.md`): Q-R1 = (c) zero allocation at every size
(full ring + Float32Array dst: `dst.set(data, off)` + `copyWithin` + a loop over the smaller half; else the
masked loop); Q-R1-SURFACE = a separate allocating `copyToFast(dst, dstOffset)`; Q-R1-ALIAS = fail closed on a
`dst` sharing `data`'s buffer (intrinsic `buffer` getter, RangeError); Q-STATHOST = local QUIET, strict.
Next: the R1 build unit (planner pass on the PROPOSAL).

### R2 -- `pushBatch(src, srcOffset = 0, count = src.length - srcOffset)`

Real gap: AudioWorklet blocks (128 frames), WebSocket chunks and physics sub-steps arrive as slices. lite-o1
`RingLog` has no bulk push either.
- Do not use `data.set(src.subarray(...))`: it allocates a 104 B view per call, which breaks zero-GC on the
  exact per-block hot path this targets. Use `data.set(src, head)` with no view only when the whole `src`
  lands contiguously (`srcOffset === 0 && count === src.length && head + count <= capacity`). Every other
  case uses a scalar loop (or the R1 strategy).
- `src` may be a Float32Array or a Float64Array (fixture replay and server-side decoders produce float64).
  `data.set(src, head)` converts float64 -> float32 with no view; the scalar path converts per element.
- `count >= capacity`: copy only the last `capacity` samples, set `head = 0` and `count = capacity`. It must
  take the same 0 B path.
- Fail closed before writing anything: `src` not a TypedArray -> TypeError (intrinsic length getter, as
  `copyTo` does); `srcOffset` / `count` not integers, negative, or past `src.length` -> RangeError. Values
  are not validated, same as `push` (NaN round-trips).
- `count === 0` is a no-op. Returns `count` (samples consumed).

Oracle: `pushBatch(s, o, n)` gives the same `data` / `head` / `count` as n `push` calls (which also round
through float32), across a (capacity, head, srcOffset, count) matrix with the wrap at every position, for
Float32 and Float64 `src`. Alloc lanes: 128-sample block contiguous, wrapped, and with `count > capacity`,
each for Float32 and Float64 `src`.

### R3 -- `copyLast(dst, dstOffset, n)`: copy only the newest n samples, oldest-first

Real gap. A sparkline or oscilloscope trace wants the last 120 or 512 samples of a 1024 ring, not all of
`count`. Today the caller copies everything and slices: O(capacity) work and a second buffer.
- Copies `min(n, count)` samples, oldest-first, ending at the newest; returns the number copied.
- `copyLast(dst, off, count)` must equal `copyTo(dst, off)` exactly. That is the parity gate.
- Fail closed, same rules as `copyTo`: `dst` must be a TypedArray (intrinsic length getter), else
  TypeError; `n` and `dstOffset` must be non-negative integers, and `!(dstOffset + k <= length)` throws;
  nothing is written on any throw.
- Allocation: the R1 strategy, so it ships AFTER R1. Alloc lanes at n = 120 / 1024, contiguous and wrapped,
  plus the case where the tail straddles the wrap.

Oracle: for every (capacity, head, count, n) in a small matrix, the result equals the last k elements of the
`copyTo` output.

## Docs-only fillers

- README Ecosystem line: DONE in 1.2.0 (0412025), R1 step 3; the README states the 104 / 208 B per frame.
- README / llms.txt NOT FOR ("integers above 2^24"): add the monotonic energy-counter example (Wh totals
  belong in the caller's Float64 columns, not in this ring).

## Parked

### R4 -- `RingBank(rings, capacity)`: N rings in ONE Float32Array

Parked 2026-11-10. Its only driver is the ShellyProject fleet case (10,000 `RingBuffer` instances are 10,000
objects plus 10,000 ArrayBuffers; see the lite-arena F-track lesson). Unpark only when ShellyProject is
committed and names RingBank as a dependency. Then: research burst plus a ruled PROPOSAL before any planner
pass (rule 2026-11-04), and only after D, so it lands with full gates.

Sketch for that PROPOSAL (NOT ruled): ring r lives at `data[r * capacity .. (r + 1) * capacity)`; `head` /
`count` in two Int32Arrays; a separate class so `RingBuffer`'s hidden class is untouched. Draft surface:
`push(r, v)`, `getOrDefault(r, offset, dflt)`, `peekNewest(r)`, `copyTo(r, dst, off)`,
`copyLast(r, dst, off, n)`, `reset(r)`, getters `rings` / `capacity`, `count(r)`. Open questions:
- Q-B1: per-ring capacity uniform only (yes) or variable (no: needs an offsets column).
- Q-B2: does `forEach(r, fn)` belong here, or only the copies?
- Q-B3: do lite-canvas-graph / lite-stats-math take (bank, r) directly, or only a copied window?
Gate: parity with N independent `RingBuffer`s under a random interleaved push stream, alloc lanes, torture.

### M1 -- two-span `forEach` (and the `copyTo` loop)

Splitting the oldest-first walk into its two contiguous halves drops the `& mask` per element; that V8 then
hoists bounds checks is not measured, and per-element cost is likely dominated by the callback. Adopt only on
a STATISTICAL win (interleaved A/B at 1024 and 8192 samples, quiet host, must-fail control). If it has not
run by the release after R3, record a null result here and drop it. An engine detail is not a reason to ship
code.

### M2 -- `forEachNewest(fn)` (newest-first walk)

Small and additive, but no consumer needs it: EMA and decay weights can be computed oldest-first. Unpark only
when a consumer (lite-canvas-graph trails) asks for it.

## Rejected (with reasons)

- **Deprecate in favour of lite-o1 `RingLog`** (rechecked 2026-11-10). See Positioning: Float64 storage,
  NaN throws, no bulk copy. Five dependents would lose `copyTo` and NaN gaps for no gain.
- **`getOldest(index)`.** lite-o1 `RingLog.get(i)` is oldest-relative already, and here it is
  `get(count - 1 - i)`. It would also inherit `get`'s `number | undefined` box (16 B per call), which pulls
  in a `getOldestOrDefault` twin: two methods for one subtraction. The proposed formula also had no bounds
  check (index >= count reads stale slots).
- **`sum()` / `mean()` / `min()` / `max()` / `stats(out)`.** O(n) per call duplicates `lite-stats-math`
  (which already filters NaN and does quantiles) and is strictly worse than lite-o1 `WindowFold` /
  `MonoDeque` (O(1) per push). A profiler that wants a running min / max / sum pairs this ring with
  `WindowFold`.
- **Float64 storage mode.** It makes `data` polymorphic. Float32 is enough for instantaneous telemetry (W, V,
  A, pf: about 7 significant digits); monotonic energy counters above 2^24 belong in the caller's Float64
  columns.
- **`RingBuffer.fromBuffer(typedArray)` / SharedArrayBuffer view / worker mode.** The "zero-copy worklet <->
  main thread" claim does not hold: `head` and `count` are JS fields on the instance, not in shared memory,
  so the other thread cannot tell which samples are live. Making it work needs an Atomics header and SPSC
  publish / consume ordering: a different structure (a lock-free SPSC ring), and the docs already say "Not
  thread-safe". Accepting Float64Array / Int32Array storage would also make `data` polymorphic. If wanted,
  it is a separate package (`lite-spsc-ring`). ShellyProject shares only fixed-layout summaries across
  workers, never live rings (rechecked 2026-11-06).
