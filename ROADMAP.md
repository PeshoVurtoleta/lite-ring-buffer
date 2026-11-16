# lite-ring-buffer roadmap

Hard lessons and refusals: LEDGER.md. Planner, research and audit briefs quote its laws.

Statistical host: local QUIET window, strict (Q-STATHOST ruled 2026-11-11, R1 step 1): the copyTo A/B runs under `quiet-lock run --strict` (the promoted probe first gains a one-16-B-box-per-call must-fail column) on the R1 candidate and on each release touching `copyTo`; NOISY / BUSY = PENDING. Until the build unit promotes the probe into the repo, statistical claims are REPORTED only.

Baseline: 1.5.6 (prepared 2026-11-16: tooling + dev bench + docs patch, Track Q1 82cd5dc + Track Q2 8965b17, over 1.5.5). 1.5.5 was
prepared 2026-11-15 (docs patch, the post-1.5.4 fillers 68b45ce + Track Q3, over 1.5.4). 1.5.4 was prepared
2026-11-15 (docs patch, the post-1.5.3 fillers 0d6ef59, over 1.5.3). 1.5.3 was prepared 2026-11-15
(docs + dev bench patch, B1 acce045 and the M1 drop 6431ec9, over 1.5.2). 1.5.2 was prepared 2026-11-15
(docs patch, the post-1.5.1 housekeeping cb36977, over 1.5.1). 1.5.1 was prepared 2026-11-15
(M1, the copyLast chain trim fd7af97, over 1.5.0; R3 below). 1.5.0 was prepared 2026-11-15
(R3 `copyLast` / `copyLastFast` + the e3c1d42 `pushBatch` doc fixes over 1.4.0; R3 bb0459b, qa 2026-11-15). 1.4.0 was prepared 2026-11-14 (R2 `pushBatch` + LU2 over 1.3.0; LU2 d68b2fd, bench eef921f, R2 f03561c). 1.3.0 was
prepared 2026-11-12 (R1 over 1.2.1). 1.2.1 (`27a8326`) was tooling + docs only (units D / D2,
LEDGER.md); 1.2.0 (`0412025`) shipped the `e3e1df1` audit fixes and the alloc gate. R1 shipped in 1.3.0 (99e8749, bench 5ae2266, R1b fix 7b0f74b, audit fix f66972c / 114af66, qa abc31af): `copyTo`
allocates 0 B at every size while each of its three store sites has seen at most 4 `dst` hidden classes (LEDGER B8) and keeps the nominal 32-sample scalar cutoff (`RingBuffer.js` `COPY_LOOP_MAX`, back
after Q-R1B-ROUTER). R2 `pushBatch` shipped in 1.4.0 (f03561c, review-APPROVED build ff6ee762); strict bench run of record exit 0 (push loop faster at 1 / 8 samples per call, pushBatch at 32 / 128; .handoff/archive/1.4.0/R2/ab/strict-1/).

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
2026-11-10 07:17Z exit 0, host PRELIMINARY (load1 5.14 vs baseline 2.21). Follow-ups: D2 below. Spec and evidence: `.handoff/archive/1.2.1/D/` (gitignored).

ShellyProject's proof layer cites this package's zero-GC claim, so suite law must hold. One tooling batch:
- migrate the tests from vitest to `node:test` (`package.json` `test` script included);
- add `test/torture.mjs` (lite-leak + lite-gc-profiler) and an `npm run torture` script;
- make source and docs ASCII-only (em dashes, plus-minus, arrows in RingBuffer.js, README.md, llms.txt).
Gate: the migrated suite passes with the same test count, torture passes, and an ASCII grep over the shipped
files finds nothing.

### D2 -- gate-teeth follow-ups from unit D's review / qa (small tooling + docs batch)

STATUS 2026-11-10: done in the working tree (reviewer APPROVED, qa PASS), awaiting the maintainer's commit;
closing `npm run verify` under the quiet lock 2026-11-10 07:50Z exit 0, host PRELIMINARY (load1 3.63 vs
baseline 2.21), Node v26.8.2; log .handoff/archive/1.2.1/D2/qa/q7-verify.txt.

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
maintainer's commit. Spec and evidence: `.handoff/archive/1.3.0/LU/` (gitignored). Adds `npm run inline-diff`
(`test/tools/inline-diff.mjs`) over the vendored `test/tools/inlining-budget-diff.sh` (LiteUtils 465881b, pinned
by sha256) and `test/InliningTool.test.js` (31 tests; `npm test` = 59 + 31 = 90). Details: LEDGER C10 / C11.
LU2 STATUS 2026-11-14: done in the working tree (reviewer APPROVED B1 + B2), awaiting the maintainer's commit.
`@zakkster/lite-utils` 1.0.0 is an exact devDependency (the vendored script is deleted); InliningTool 35 tests;
`npm test` = 174; new `npm run deopt-diff` (REPORTED). Details: LEDGER C15 / A14.
Maintainer rulings (AskUserQuestion, 2026-11-11):
- OQ-1 = (a) "REPORTED, by hand": `npm run inline-diff` outside verify; run under the quiet lock before each
  /release and in every unit touching `RingBuffer.js` (R1 / R2 / R3); exit logged in that unit's evidence.
- OQ-2 = (a) "Inside npm test": `test/InliningTool.test.js` in `test/count.mjs` FILES + EXPECTED.
- OQ-3 = (a) "git show HEAD": default before = `git show HEAD:RingBuffer.js` staged to temp, named by commit + sha.
- OQ-4 = (a) "Go red, fail closed": no bash -> `npm test` red.
Follow-ups: the R1 / R2 / R3 coder batches run `npm run inline-diff` (exit in the unit's evidence). Deopt-diff (LEDGER A8) was unparked in the R1 build burst (T7, REPORTED). `inline-diff`'s anchors do not
cover `copyTo`: use `node_modules/@zakkster/lite-utils/inlining-budget-diff.sh --fn copyTo` for it (LEDGER D9).
Parked / refused in unit LU: deopt-diff (A8, since unparked), allocation-diff (A9), alloc-per-op (A10).
Since LU2: ic-diff and bytecode-budget PARKED (A14, LU2); deopt-diff ADOPTED (A8, LU2).

### R1 -- copyTo allocates at the sizes the ecosystem actually uses (bug-grade)

Finding (2026-10-14): `StatsMath.compute` / `quantile` (`LiteStatsMath/StatsMath.js:59,103`) and
`CanvasGraph.render` (`LiteCanvasGraph/CanvasGraph.js:157`) call `copyTo` with a capacity-sized scratch,
typically 1024 samples. In 1.2.1, above 32 samples `copyTo` took the `set` + `subarray` path: 104 B per call
contiguous, 208 B wrapped (measured, Node 26.8.2; fixed by R1, see STATUS). So README's "Each stage holds zero allocation in steady
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
3. DONE in 1.2.0 (0412025): the README Ecosystem line now states the 104 / 208 B per frame; R1 (99e8749) made that line state 0 B (docs batch B4). (Was: until
   then, fix the line; docs-only.)

Gate: alloc lanes for `copyTo` at 1024 contiguous and wrapped, 0 under the ruled (c) ROT + loop (`.handoff/archive/1.5.3/PROPOSAL-r1.md` section 6: also a full-ring head n/2 lane and a non-full lane); DONE, `test/alloc.mjs` copyTo lanes (LEDGER B4).

STATUS 2026-11-11: step 1 DONE as a research pass (`.handoff/archive/1.5.3/research/r1/`, PRELIMINARY; its strict hold of
the deciding rungs is PENDING). Ruled (`.handoff/archive/1.5.3/PROPOSAL-r1.md`): Q-R1 = (c) zero allocation at every size
(full ring + Float32Array dst: `dst.set(data, off)` + `copyWithin` + a loop over the smaller half; else the
masked loop; routing as built: a full Float32 ring above 32 samples -> ROT, everything else -> the masked loop); Q-R1-SURFACE = a separate allocating `copyToFast(dst, dstOffset)`; Q-R1-ALIAS = fail closed on a
`dst` sharing `data`'s buffer (intrinsic `buffer` getter, RangeError); Q-STATHOST = local QUIET, strict.

STATUS 2026-11-12: DONE. R1 build 99e8749 + bench 5ae2266 (`npm run bench:copyto`) + the R1b fix in the working
tree (Q-R1B-FIX = V-split32c, Q-R1B-ROUTER = loop at <= 32, which amends Q-R1 "`COPY_LOOP_MAX` goes"); reviewer
APPROVED. Closing `npm run verify` (`.handoff/archive/1.3.0/r1b-fix/evidence/burst-verify.log`, Node v26.8.2, host PRELIMINARY
load1 4.72 vs baseline 2.21) exit 0, 130 / 130 tests, 1024-sample `copyTo` 0.0-0.2 B/op. Speed (REPORTED from one
strict A/B, host QUIET, `.handoff/archive/1.3.0/r1b-fix/T5-SUMMARY.md`): vs 1.2.1 at 32 samples 1.33-1.38x slower; at 1024 /
Float32 contiguous 0.75x, wrapped 3.10x, partial 3.75x (the worst cells), Float64 dst 0.41-0.61x. Docs batch B4
(README / llms.txt / .d.ts / CHANGELOG / LEDGER / ROADMAP) is in progress. Release 1.3.0 is on HOLD: the
maintainer's call; no version bump here. LEDGER B4 / B5 closed, B7, A12, C12, C13, D8-D10 added.

### R2 -- `pushBatch(src, srcOffset = 0, count = src.length - srcOffset)`

RULED 2026-11-12 (research pass, `.handoff/archive/1.5.3/PROPOSAL-r2.md` section 7, LEDGER A13): the ruled PROPOSAL supersedes
this sketch where they differ -- count > capacity keeps physical n x push parity (head = (head + count) & mask, not
head = 0); src is Float32Array / Float64Array only (other TypedArrays, BigInt included, TypeError); `set` only for a
whole Float32 src; src sharing the ring's buffer -> RangeError. BUILT 2026-11-14 on the working tree (review-APPROVED ff6ee762; adds Q-R2-FROZEN / Q-R2-DATA / Q-R2-TAMPER, LEDGER A13 / B10); shipped in 1.4.0 (f03561c). Post-release light audit 2026-11-15 (one Opus reviewer, read-only, eef921f / eaa32ee7 vs 3860688 / ff6ee762): FINDINGS, no DEFECT -- 3 DOC fixed in the working tree (README destroy / batch-ingest wording, .d.ts frozen count-0), 2 JSDoc NITs deferred to the next unit touching RingBuffer.js, 1 test gap (no alloc lane for a resizable-buffer / other-realm `src`; resizable-buffer views measured <= 0.25 B/op untimed, REPORTED; other-realm not measured) left as a FILLER. Evidence .handoff/archive/1.4.0/audit-1.4.0/.

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

RULED 2026-11-15 (research pass, `.handoff/archive/1.5.0/PROPOSAL-r3.md` section 7, LEDGER A15): the ruled PROPOSAL supersedes this
sketch where they differ -- the bounds check is `dstOffset + n <= dst.length` (n, not k; Q-R3-BOUNDS); k = 0 returns 0
before the alias / storage checks; copyLast has its own check helper and store sites, copyTo stays byte-identical
(Q-R3-BODY); a `copyLastFast(dst, dstOffset, n)` (allocating `set` + `subarray`, the copyToFast pattern) is added
(Q-R3-FAST); copyLast(count) is slower than copyTo on a full Float32 ring (PRELIMINARY, mechanism unknown), the
parity gate is output / throw only (Q-R3-PARGAP); the strict A/B runs in the build unit (Q-R3-STRICT).

BUILT 2026-11-15 (bb0459b / 9765c21e; review APPROVED; qa PASS 2026-11-15, +22 boundary tests in test/qa-r3.test.js); shipped in 1.5.0: `copyLast` + `copyLastFast`, 281 tests;
the strict A/B (`npm run bench:copylast`) exit 0 (see LEDGER A15).
MECHANISM FOUND 2026-11-15 (FILLER R3-M1, research ladder `.handoff/archive/1.5.1/research/r3-m1/`, PRELIMINARY; LEDGER A15 "R3-M1
addition", D13): the copyLast(count) gap is the caller's cumulative-inlining budget (copyLast's inlined chain 791 B is
over 920 / 1.2, copyTo's 737 B is not), not either body. A trimmed lastCheck (SLIM2, chain 765 B) inlines and ties copyTo;
`.handoff/archive/1.5.1/PROPOSAL-r3-m1.md` RULED 2026-11-15 (maintainer, AskUserQuestion, one sitting; PROPOSAL section 6):
Q-M1-ADOPT = "A Build SLIM2"; Q-M1-GATE = "A Chain-size gate in npm test"; Q-M1-STRICT = "A In the build unit".
SLIM2 BUILD PARKED 2026-11-15 (`.handoff/archive/1.5.1/M1/`, review APPROVED, then RULING Q-M1-HOOK = "B Park, research first"):
on a failing call the double `dst instanceof DataView` lets a stateful user hasInstance hook or a Proxy prototype trap
change which error is thrown. Parked as `.handoff/rejected/M1-slim2/` (restored by the unpark unit; now `.handoff/archive/1.5.1/rejected/M1-slim2.restored-1794720601539/`). Next: a research pass for a cold path that
observes DataView-ness once with the chain <= 766 B (LEDGER A15 SLIM2 build unit, D14). The waiver (Q-R3-PARGAP A) stands.
R3-M2 RULED 2026-11-15 (`.handoff/archive/1.5.1/PROPOSAL-r3-m2.md`): Q-M2-ADOPT = "A Unpark with C" (candidate GLB_O_MIN2
5a2e12e1: new hot check order, the hot `instanceof` answer carried in a module `var`, min rewritten; chain 765 B,
parity 0 incl. 31,464 stage-H hook rows, suite 281/281); Q-M2-O3 = "A Out of contract, documented"; Q-M2-TEST =
"A Port stage H to npm test". Next: the unpark unit (restore M1-slim2, apply C, re-review, strict A/B, docs, qa,
1.5.1). The waiver (Q-R3-PARGAP A) stands until the strict A/B passes (LEDGER A15 R3-M2 addition, D15).
M1 BUILT 2026-11-15 (fd7af97 / 9e70b525; review APPROVED, qa PASS; npm test 281 -> 294): candidate C, chain 765 B,
copyTo chain 737 B unchanged, every error unchanged from 1.5.0. Strict A/B two runs, both exit 0 QUIET; RULING
Q-M1-STRICT = "A Pass on medians" (maintainer, 2026-11-15): the waiver (Q-R3-PARGAP A) is LIFTED; Float32 1024
copyLast(count) / copyTo 1.01-1.02 on the medians (1.5.0: 1.17 / 1.52). Shipped in 1.5.1 (LEDGER A15 "M1 unpark
addition", C17, D16).

Real gap. A sparkline or oscilloscope trace wants the last 120 or 512 samples of a 1024 ring, not all of
`count`. Today the caller copies everything and slices: O(capacity) work and a second buffer.
- Copies `min(n, count)` samples, oldest-first, ending at the newest; returns the number copied.
- `copyLast(dst, off, count)` must equal `copyTo(dst, off)` exactly. That is the parity gate.
- Fail closed, same rules as `copyTo`: `dst` must be a TypedArray (intrinsic length getter), else
  TypeError; `n` and `dstOffset` must be non-negative integers, and `!(dstOffset + k <= length)` throws (AMENDED to `dstOffset + n` by Q-R3-BOUNDS);
  nothing is written on any throw.
- Allocation: the R1 strategy, so it ships AFTER R1. Alloc lanes at n = 120 / 1024, contiguous and wrapped,
  plus the case where the tail straddles the wrap.

Oracle: for every (capacity, head, count, n) in a small matrix, the result equals the last k elements of the
`copyTo` output.

### B1 -- public comparison benchmark (post-1.3.0, REPORTED only)
After 1.3.0 ships. One small burst: planner -> coder -> reviewer, then ONE run under `quiet-lock run --strict`.
(Maintainer-approved 2026-11-12.)
- Compare against what users would use instead: a plain `Array` ring, a hand-rolled `Float32Array` ring, and
  lite-o1 `RingDeque`.
- Operations: push, get / getOrDefault, copyTo (n 32 / 1024) and B/op.
- Reuse the copyto-ab machinery: A/A twin, SLOW control, B/op lane, K interleaved rounds + IQR, 3 compilations.
- Dev-only `npm run bench:compare`, not in verify; gates nothing.
- README gets one table with provenance (date, host, load, Node, run count).
- Either backs README.md:205 "roughly 3-5x cheaper" with a REPORTED source, or that claim is removed.
Not a demo: the maintainer ruled no demo is needed for this package (2026-11-12).
The M1 research burst closed 2026-11-15 (M1 dropped, see Parked).
STATUS 2026-11-15: done, committed acce045 (unit B1: bench + strict run + docs), released in 1.5.3. `npm run bench:compare` (dev-only, REPORTED); one strict QUIET run, every row VALID, evidence `.handoff/archive/1.5.3/B1/strict-1/compare.md`. The README "3-5x" claim is replaced by the measured figures and the README has the comparison table (LEDGER B12 / C18).

## Track Q -- queued 2026-11-15 from an external review (maintainer: "Yes, add"; Q-ids RULED 2026-11-16, see Q1)

### Q1 -- CI (tooling; no runtime change)
RULINGS (maintainer, 2026-11-16, AskUserQuestion, one sitting; option text as asked):
- Q-Q1-LAYOUT = "Suite pattern": copy the LiteFastBit32 / LiteUtils ci.yml; DETERMINISTIC gates only; Node 18-26
  x ubuntu + macos, plus a 26.8.2 leg per OS running the full verify (chain-size gate included); other legs run a
  new `test:core` subset (npm test fails closed off 26.8.2, Q-M1-GATE A unchanged).
- Q-Q1-ENGINES = "Keep >=18, prove it": the core lane runs on Node 18 / 20 / 22 / 24 / 26; lanes needing newer
  Node (alloc 24+, lite-leak torture 20+) are named SKIPs, as in LiteFastBit32.
- Q-Q1-TYPES = "Add test:types": typescript devDependency only, a typed usage file under `tsc --noEmit`.
- Q-Q2-MNEMONIST = "Yes, devDependency": pinned by version + sha256 like lite-o1. Order: Q1 first, then Q2
  (needs a quiet strict window).
- Q-Q1-FEATURES (2026-11-16, Q1 burst) = "Tiered, named SKIP": test:core = a base file set that runs on Node 18+
  with a fixed count, plus a feature tier (ArrayBuffer#transfer / resizable ArrayBuffer: qa-r1, qa-r3, qa-m1) that
  runs and is count-gated when the engine has the feature, else a named SKIP with a printed reason; no test file
  source changes.
- Q-Q1-LOCALNODE (2026-11-16, Q1 burst) = "Yes, fetch 18/20/22/24": local lane evidence on npm `node@N` binaries.
- A pinned job: `npm run verify` on Node v26.8.2, macos-arm64 (the host of record), so the fail-closed chain-size
  gate keeps its meaning (Q-M1-GATE A unchanged).
- A portable core lane on the LTS matrix: the behavioural test files only (no engine pin, no bash / git tools).
- (queued text, superseded by the rulings above) `engines: >=18` was a claim nothing tested (`npm test` needs exactly
  v26.8.2; the "dev scripts need >= 24" line was false: `total_allocated_bytes` is absent through v24.22.3, LEDGER D18).
- Design reference: the lite-fastbit32 nightly-CI program (see Track R R1, `PLAN-nightly-ci.md`). STATISTICAL claims
  stay out of CI gates.
STATUS 2026-11-16: done in the working tree (Q1 burst), not committed. `.github/workflows/ci.yml` (12 legs),
`npm run test:core` (`test/core.mjs`: 206 base tests on Node 18+, 41 feature-tier tests where transfer / resize / grow
exist), `npm run test:types` (typescript ^7.0.2 devDependency), ascii scans `.github/`. Local evidence on v18.20.8 /
v20.20.2 / v22.23.5 / v24.22.3 / v26.8.2 in `.handoff/archive/1.5.6/q1/evidence/`. The workflow is UNVERIFIED on GitHub until the
maintainer pushes.

### Q2 -- B2: extend the comparison bench (REPORTED only; one strict run)
STATUS 2026-11-16: done in the working tree (not committed); one strict quiet-lock run, exit 0 (`.handoff/archive/1.5.6/q2/strict-1/`,
2026-11-16T01:13Z..01:16Z). Rulings: Q-Q2-MNEMONIST (devDependency) and exactly 0.40.8 (version + sha256 pin). Review r1
REJECT -> maintainer "Fix once, re-review" -> r2 APPROVED (LEDGER C19, D19..D21). README Comparison, llms.txt and CHANGELOG carry the numbers (B1's "no cause measured": the gap is split by strict-1).
- A "checked" hand-rolled Float32Array column with the same argument checks as RingBuffer, so B1's `getOrDefault`
  0.59x and `copyTo` n 32 0.52x gaps split into validation cost vs loop cost (today: no cause measured).
- A mnemonist `CircularBuffer(Float32Array, n)` column (the closest real competitor), pinned by version + sha256 like
  lite-o1; devDependency needs a maintainer ruling. Each library used through its own best API.
- A cross-library GC lane (minor / major counts, retained bytes; lite-gc-profiler + lite-leak) and a
  memory-per-window table: the zero-GC read path vs allocating `toArray` is where this package differs.
- Reuse `test/bench/compare.mjs` (A/A, SLOW / BOX controls, oracle + mutants, per-compilation medians); LEDGER D17.

### Q3 -- README FAQ "u32-backed sibling library" (docs; rides the next patch)
The FAQ answer on integers points to a u32-backed sibling library; the suite catalog has none (checked 2026-11-15).
Reword: pack into the 24-bit mantissa, or keep a Uint32Array ring of your own.
STATUS 2026-11-15: done (working tree), rides 1.5.5; the mantissa-packing advice was dropped (a full-range u32 cannot pack losslessly).

### Considered from the same review, not queued (orchestrator assessment 2026-11-15; the maintainer may reopen)
- `toJSON()`: fixes the documented double serialization of `_bufOf` / `_buf` without touching the cache, but it is
  new public surface: research burst first, if wanted.
- `toArray()` / `RingBuffer.from()`: two lines each with `copyTo` / `pushBatch`; migration convenience that does not
  serve the Positioning rule. A README migration cheat-sheet covers it.
- Two-span store loop for `copyTo`: the review read README's 3.03x / 3.85x (1024 f32 wrap / part) as "vs
  copyToFast"; they are "now vs 1.2.1". The wrapped full ring already uses `set` + `copyWithin`; M1 measured a
  two-span walk 1.55x slower (LEDGER A7 / D17); B1 has `copyTo` n 1024 ahead of a hand-rolled ring (277 vs 390 ns).
- p95 / p99 per op: at 1-25 ns per op the timer cannot resolve per-op tails; tails come from GC and deopts, gated by
  counts.
- x86 / browser replication: valid but costly; the 0 B claims are already labelled Node v26.8.2 arm64. A browser
  smoke lane is the cheapest useful form, if ever.
- `requestedCapacity` after `destroy()`: Settled (use after destroy is misuse; do not reopen).

## Docs-only fillers

- README Ecosystem line: DONE in 1.2.0 (0412025), R1 step 3; the README states the 104 / 208 B per frame; R1 (99e8749) made that line state 0 B (docs batch B4).
- README / llms.txt NOT FOR ("integers above 2^24"): add the monotonic energy-counter example (Wh totals
  belong in the caller's Float64 columns, not in this ring). DONE 2026-11-15 (post-1.5.1 housekeeping, working tree).

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

Ping 2026-11-16 (maintainer, from the ShellyProject research thread): NOT NOW. R4 stays Parked; revisit when
pulse-core v0 exists (ShellyProject week 3). Why:
- The unpark rule above is unmet: no ShellyProject doc names RingBank.
- A memory probe by that thread (10,000 rings, REPORTED there; provenance not recorded here) found 10,000
  RingBuffers vs one flat bank at 5.85 vs 2.64 MB (64 samples), 13.5 vs 10.3 MB (256), 44.2 vs 41.0 MB (1024): a
  constant ~329 B of heap per ring, ~3.3 MB once at startup; steady state 0 B per sample either way.
- 10,000 devices x 10 Hz = 100,000 pushes / s (nominal arithmetic, untimed): no throughput case.
- ShellyProject weeks 0-2 do not touch per-device history. Week 3 writes it as a plain pulse-core column (one
  `Float32Array(N * K)` + an `Int32Array` of heads, indexed by arena slot).
New unpark trigger: that column needs zero-allocation window copies in several places, or must feed
lite-canvas-graph / lite-stats-math directly. Then the research burst above.

Design notes for that research burst (two external sketches, 2026-11-16; orchestrator assessment, NOT ruled):
- Agreed: uniform capacity (Q-B1 yes); copies only in v1 (Q-B2); companions read a copied window (Q-B3); one
  buffer identity makes the alias / storage checks simpler (`length === rings * capacity`); rings share one
  lifetime (`reset(r)`, `destroy()` of the whole bank; independent lifetimes = N RingBuffers); `pushBatch` keeps an
  intrinsic `set` (its offset argument is the destination offset).
- Every method validates `r`: an out-of-range or fractional `r` reads `undefined` from the Int32Arrays and the
  store is silently dropped (fail-open).
- Correction: both sketches say the zero-alloc `copyTo` "must" be the two-span loop. A masked loop
  (`data[base + ((start + i) & mask)]`) is zero-alloc too, and M1 measured the two-span walk 1.55x SLOWER on a
  wrapped full ring (LEDGER A7 / D17). It is an A/B, masked loop first.
- A cost the sketches skip: a bank ring cannot use `rotCopy` (one `set` of the WHOLE storage), so a full-ring
  `copyTo` falls back to a scalar loop. B1 at n 1024: RingBuffer 277 ns vs a hand-rolled loop 390 ns (REPORTED,
  2026-11-15 strict run).
- Counter width: cap the bank total (`rings * capacity <= 2^30`, 4 GiB of samples) so `head`, `count` and
  `base + h` stay int32 / Smi; no Uint32Array needed.
- `r * capacity` vs a bases column vs `r << log2(capacity)`: an A/B, not a guess.

### M1 -- two-span `forEach` (and the `copyTo` loop) -- DROPPED 2026-11-15

Splitting the oldest-first walk into its two contiguous halves drops the `& mask` per element; that V8 then
hoists bounds checks is not measured, and per-element cost is likely dominated by the callback. Adopt only on
a STATISTICAL win (interleaved A/B at 1024 and 8192 samples, quiet host, must-fail control). If it has not
run by the release after R3, record a null result here and drop it. An engine detail is not a reason to ship
code.

RULING Q-M1-DEADLINE 2026-11-15 (maintainer, AskUserQuestion, the post-1.5.1 housekeeping burst): 1.5.1 is the
release after R3 and M1 never ran; options were A "Drop it", B "Keep it parked", C "Measure it next"; ruled "C Measure
it next", "Make it a research burst (spike-first ladder, its own session) before B1; nothing is dropped now." The
deadline rule above is superseded by that research burst: it adopts M1 only on a STATISTICAL win as written above,
else records the null result here and drops M1. (This M1 is the Parked item, not the "M1 unpark unit", the copyLast
chain fix shipped in 1.5.1.)

DROPPED 2026-11-15. The research burst (spike-first ladder, `.handoff/archive/1.5.3/research/m1-twospan/`) ran the same day and
found a measured LOSS, not only no win. Two two-span candidates (C1, C2) were timed against the shipped masked
`forEach` (REF) on a `store` callback (`OUT[i] = v`), K 21 x 3 compilations, on the wrapped full ring (`wrap` rows,
the steady state of a telemetry ring and the only layout where the walk has two spans). Both strict runs (REPORTED,
QUIET host): C1 and C2 are a LOSS at 1024 and 8192 samples in both runs. Row medians (candidate / REF): C1 1.526-1.553
and C2 1.539-1.563 over the four wrap rows of the two runs. Provenance: ONE `quiet-lock run --strict` hold, lock exit
0, inner exits 0 0 (2 runs), 2026-11-15T16:19:54Z-16:23:32Z, load1 2.42 at the gate vs baseline 2.21, no other node >=
10% CPU, Apple M4 Pro (12 cores), Node v26.8.2 / V8 14.6.202.34-node.28, HEAD 55b6ea9 / `RingBuffer.js` sha256/8
90f7ad7c; no slow compilation on any wrap row (every per-compilation median 1.513-1.570); the one slow compilation off
the wrap rows is store-2 C2 1024 h0, 0.984 vs 0.920 / 0.920 (the row stays WIN). C2 reads a WIN only at h0
(0.921-0.926), where its second loop never runs on a head-0 ring (single-span case), so C2 meets the WIN-row half of
the bar (h0, both sizes, both strict runs) and fails it on its wrap LOSS rows (the bar also needs NO loss row). C1 has
no WIN row (h0 LOSS 1.045-1.061). The earlier PRELIMINARY rung 1b run on the same callback agreed (wrap C1
1.542-1.574, C2 1.556-1.563). The first rungs' sum-callback runs are VOID: the masked body ran in per-compilation
modes, so no A/B on it carries a verdict (LEDGER D17). Rung 3 (the `copyTo` loop, "only if rung 1 showed a win") never
ran: it has no premise, so the `copyTo` half is dropped with `forEach`, unmeasured. Maintainer ruling
(AskUserQuestion, 2026-11-15): "Strict re-run, then drop". Sources: LEDGER A7 / D17 and
`.handoff/archive/1.5.3/research/m1-twospan/PROGRESS.md`.

Reopen condition (law 13): a new mechanism that removes the wrap-row cost (a two-span walk no slower than the masked
one on a full wrapped ring), re-measured by the same strict A/B (interleaved, K x 3 compilations, `quiet-lock run
--strict`, must-fail control, A/A twin) on a store callback, with a WIN row at 1024 and 8192 and no loss row.

### M2 -- `forEachNewest(fn)` (newest-first walk)

Small and additive, but no consumer needs it: EMA and decay weights can be computed oldest-first. Unpark only
when a consumer (lite-canvas-graph trails) asks for it.

### R5 -- monotonic write counter + "since my last read" (LEAD, not a plan; added 2026-11-15)
Idea: count every push in a field that only grows (`written`), so a reader that polls slower than the writer (UI at
60 Hz, ingest at 1 kHz) can ask what is new since its last read (`copyLast(dst, off, written - seen)`, or a
`copySince`) and detect an overrun (`written - seen > capacity`). Today the caller counts pushes itself. Prior art:
the free-running positions of rtrb / ringbuf (Rust); an external review (2026-11-15) asked for the same gap detection.
- Cost: one more field store in `push` (at parity with a hand-rolled ring today, 1.01 vs 1.01 ns, B1) and `pushBatch`.
  Needs an interleaved A/B on `push` and the chain-size gate re-checked.
- Trap: V8's Smi range. A counter that grows forever leaves it at 2^31 - 1 (2^30 - 1 under pointer compression):
  ~24.9 days at 1 kHz, ~12.4 h at 48 kHz. The field then changes representation (Smi -> Double): a map change and a
  deopt of every inlined caller, weeks into a long-running process. Options to research: an int32-wrapping counter
  (`(w + 1) | 0`, gap `(w - r) | 0`, correct while a reader polls within 2^31 pushes) or a Double field from birth.
  Either needs a torture lane that crosses the wrap (seed the counter near the edge).
- Unpark: only if ShellyProject (or a dependent) names a reader slower than its writer. Research burst first (new
  public surface).

### X1 -- `lite-spsc-ring` prior art (a separate package, not this one; LEAD, added 2026-11-15)
See Rejected "worker mode". Prior art read 2026-11-15, ideas only:
- ringbuf.js (padenot, MPL-2.0: no code may be copied into an MIT package): 8-byte header (write index, read index,
  Uint32), `capacity + 1` slots (one wasted, so no pow2 mask), each side `Atomics.store`s only its own index after
  copying, partial `push` / `pop` returning counts, a `.set()` fast path plus a loop unrolled by 16, and
  `writeCallbackWithOffset` (zero-copy write into storage + two spans). Defect not to copy: `return cb(...) ||
  to_write` publishes the whole reservation when a callback returns 0 (fail-open).
- rtrb (Rust): `write_chunk(n)` / `read_chunk(n)` reserve, fill up to two slices, `commit(n)`; a request larger than
  the free space is an error (`TooFewSlots`), not a partial move; each side caches the other side's index and reloads
  it only when the cache says full / empty; the indices sit on separate cache lines; `is_abandoned()`.
- ringbuf (agerasev, Rust): positions kept modulo 2 x capacity (as recalled, not checked against its source): no
  wasted slot and no pow2 requirement.
- Rigtorp SPSCQueue (C++): the write-up of the cached-index + padding technique.
- JS limit: `Atomics` are sequentially consistent only; acquire / release tricks do not transfer.
- Bar: ringbuf.js already holds this niche (SAB + Atomics, typed, maintained). Build only if it adds something real:
  zero-GC reserve / commit through a caller-owned Int32Array of offsets, no wasted slot with a pow2 mask, a
  fail-closed commit, an abandonment word, MIT. Otherwise document interop with ringbuf.js.
- Unpark: ShellyProject needs live cross-thread streaming (rechecked 2026-11-06: it shares only fixed-layout
  summaries across workers).

## Rejected (with reasons)

- **M1: two-span `forEach` / `copyTo` loop** (dropped 2026-11-15). A measured LOSS on the wrapped full ring in both
  strict runs; see Parked and LEDGER A7 / D17.
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
