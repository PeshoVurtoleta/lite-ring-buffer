# lite-ring-buffer roadmap

Baseline: `main` is 1.2.0 (`0412025`; it shipped the `e3e1df1` audit fixes and the alloc gate). R1 and R2 are
still open: `copyTo` keeps the 32-sample scalar cutoff (`RingBuffer.js` `COPY_LOOP_MAX`), and there is no
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

STATUS 2026-11-10: DONE in the working tree (reviewer APPROVED B1-B4, qa PASS A1-A5), awaiting the
maintainer's commit. The closing `npm run verify` under the quiet lock is PENDING (lock BUSY). Follow-ups:
D2 below. Spec and evidence: `.handoff/D/` (gitignored).

ShellyProject's proof layer cites this package's zero-GC claim, so suite law must hold. One tooling batch:
- migrate the tests from vitest to `node:test` (`package.json` `test` script included);
- add `test/torture.mjs` (lite-leak + lite-gc-profiler) and an `npm run torture` script;
- make source and docs ASCII-only (em dashes, plus-minus, arrows in RingBuffer.js, README.md, llms.txt).
Gate: the migrated suite passes with the same test count, torture passes, and an ASCII grep over the shipped
files finds nothing.

### D2 -- gate-teeth follow-ups from unit D's review / qa (small tooling + docs batch)

- Test-count floor: an emptied `test/RingBuffer.test.js` still passes `npm test` (tests 0 / exit 0). Add
  `test/count.mjs` (node:test `run()` over the explicit file list with `--expose-gc`, exit 1 unless the pass
  count equals the expected count and there is no failure), wire `"count"` and append it to `verify`. Every
  later unit that adds a `*.test.js` updates both the `test` script and the expected count.
- Docs label: "GC-count resolution is about 2 B/op" in README Testing, llms.txt and CHANGELOG is DERIVED
  (control lane 104.2 B/op x 2,000,000 / 49 minor GCs), not measured: label it "nominal" with that
  derivation, or have the torture GATE line print it.
- Torture: `trackedMid >= 1` -> `=== CYCLES` (exact; finalizers cannot run inside the synchronous churn).
- Torture: consider promoting the `get(i)` lane from REPORTED to a second CONTROL (proves the gate sees a
  16 B box every run). Changes the lane taxonomy: planner decides.
- test/ascii.mjs: flatten the self-control's bare `{}` block (lite-law flat module code).

### R1 -- copyTo allocates at the sizes the ecosystem actually uses (bug-grade)

Finding (2026-10-14): `StatsMath.compute` / `quantile` (`LiteStatsMath/StatsMath.js:59,103`) and
`CanvasGraph.render` (`LiteCanvasGraph/CanvasGraph.js:157`) call `copyTo` with a capacity-sized scratch,
typically 1024 samples. Above 32 samples `copyTo` takes the `set` + `subarray` path: 104 B per call
contiguous, 208 B wrapped (measured, Node 26.8.2). So README's "Each stage holds zero allocation in steady
state" (the Ecosystem diagram) is false today: every frame of a graph or stats readout allocates.

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
3. Until then: fix the README Ecosystem line to state the 104 / 208 B per frame. Docs-only; it can go out
   with the next release.

Gate: alloc lanes for `copyTo` at 1024 contiguous and wrapped, expected 0 if option (a) or (b) covers that
size.

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

- README Ecosystem line: state the R1 104 / 208 B per frame until R1 lands (R1 step 3).
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
