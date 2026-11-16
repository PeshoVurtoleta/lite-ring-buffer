# lite-ring-buffer -- the consolidated ledger

*Every design refused, every defect found and fixed, every gate that had to be given teeth,
every measurement trap, and the laws each one produced. This is the evidence base the package
roadmap builds on. Nothing here is re-litigated without a **new mechanism** clearing **every**
gate the entry names.*

Scope: `@zakkster/lite-ring-buffer` (RingBuffer, ceilPow2). Sources: `git log`, `CHANGELOG.md`, `ROADMAP.md`,
`.handoff/HISTORY.md`, `.handoff/archive/1.2.1/D/PLAN.md`, `.handoff/archive/1.2.1/D2/PLAN.md` and the evidence dirs
under them (all `.handoff/` is gitignored), the headers of `test/alloc.mjs`, `test/torture.mjs`, `test/count.mjs`,
`.handoff/archive/1.3.0/LU/PLAN.md` and its evidence dir, `.handoff/archive/1.5.3/research/r1/` and
`.handoff/archive/1.5.3/PROPOSAL-r1.md` (R1 step 1), `.handoff/archive/1.5.3/research/m1-twospan/`, and the auto-memory
note `alloc-gate-total-allocated-bytes`. Numbers are copied from those sources as they state them; a number with no date
/ host / run count there carries none here either, and says so.

Commits cited: 4dd231b (initial, 2026-06-30), 1a5a294 (1.1.0, 2026-10-08), e3e1df1 (audit fixes + alloc gate,
2026-10-14), 0412025 (1.2.0, 2026-10-14), 1d6e368 (unit D, 2026-11-10), b6a8310 (unit D2, 2026-11-10), 27a8326 (1.2.1,
2026-11-11), dc6965f (unit LU, 2026-11-11), 132d003 (R1 step 1 rulings, 2026-11-11), 99e8749 (R1 build, 2026-11-11),
5ae2266 (bench:copyto, 2026-11-11), f66972c (audit fix unit 1, 2026-11-12), 114af66 (unit 2 mutant kills, 2026-11-12),
7b0f74b (R1b fix + B4, 2026-11-12), 2f212c8 (R2 research ledger, 2026-11-12), a6d0220 (1.3.0, 2026-11-12), eef921f
(bench:pushbatch, 2026-11-14), f03561c (R2 pushBatch, 2026-11-14), b690e9c (1.5.0, 2026-11-15), e3c1d42 (pushBatch doc
truth, 2026-11-15), 4b471da (R3 research ruled, 2026-11-15), a771a79 (R3-M1 mechanism, 2026-11-15), c2910c0 (SLIM2
parked, 2026-11-15), 6431ec9 (M1 dropped, 2026-11-15), fd7af97 (M1 copyLast chain, 2026-11-15), 55b6ea9 (1.5.2,
2026-11-15), f0c691a (1.5.4, 2026-11-15), 834dab9 (ROADMAP R4 Parked, 2026-11-16), 82cd5dc (Track Q1, 2026-11-16),
8965b17 (Track Q2, 2026-11-16), 1d91441 (post-1.5.6 archive, 2026-11-16). Unit D was first committed as c2c28e0 (still
named in `.handoff/HISTORY.md`); the maintainer amended it to 1d6e368 only to drop a trailer (trees identical, `git
diff c2c28e0 1d6e368` empty). Not a conflict.

## How to read this file

- Section 0 (the laws) first. Each law cites the entries that prove it.
- Entries are IDs, not a single running number: `A<n>` refused / parked designs, `B<n>` defects
  found and fixed, `C<n>` gate evolution (gates that had to be given teeth), `D<n>` measurement
  traps. Within a section, entries are in rough chronological order. "Unit D" and "unit D2" mean
  the ROADMAP units of those names; `D1`..`D10` are entries in section D of this file.
- Every entry has: what happened, root cause, evidence (commit sha from `git log` plus a file or
  `.handoff` path), the law it produced, and the gate that now holds it (file name + test / lane
  name). A claim with no findable sha or path says `evidence: NOT FOUND` (none remain).
- `.handoff/` is gitignored: those paths exist only in the maintainer's main checkout.
- Tiers: DETERMINISTIC gates run in `npm test` / `npm run verify` every time; STATISTICAL gates run once per release on
  a quiet host; REPORTED numbers gate nothing. DETERMINISTIC gates also run outside `verify`: hosted CI runs `npm run
  test:core` (portable count-gated lane, Node 18..26) and `npm run test:types` (`tsc -p test/types/tsconfig.json`) as
  their own steps (.github/workflows/ci.yml). This package has no STATISTICAL gate in `npm test` / `verify`: its host is
  ruled (local QUIET, strict; R1 step 1) and the copyTo A/B is the dev-only `npm run bench:copyto` (5ae2266), run by
  hand under `quiet-lock run --strict`. `npm run inline-diff` (unit LU, C10) and `npm run deopt-diff` (LU2, C15, A8) are
  REPORTED: run by hand under the quiet lock, outside `verify`; only their deterministic tool tests are in `npm test`.

## How to add an entry

1. Take the next free number in the section (never renumber).
2. Title in one line. Then: **What happened**, **Root cause**, **Evidence** (sha + path),
   **Law**, **Gate** (file + test / lane name).
3. A measurement enters only from a run log of that cycle, with date, host, load, Node / V8 and
   run count as the source states them. An estimate is labelled "nominal".
4. An entry is never re-litigated without the new mechanism it demands: the entry names what
   would have to be true, and the reopening change must clear every gate listed there.

---

## 0. The laws (read this first)

1. **A gate that cannot fail is not a gate.** Every gate needs a must-fail control that fails for its own reason
   (test/count.mjs has none committed yet; its controls are scratch under `.handoff/archive/1.2.1/D2/mut/`), and every
   comparison is written so NaN fails it. *(A6, A10, B1, C1, C2, C3, C5, C6, C7, C8, C10, C11, C15, C17, C18, C19, C20,
   C21, C22, D7, D18, D20, B10, A13, A15, B7, B8, B9, C12, C13, C14, C16, D8, D9, D10, D12, D14, D15)*
2. **Fail closed on every unverified state, including the harness.** A zero-match glob, a missing
   path, a missing `files[]`, a missing summary event, a missing `global.gc` and a NaN counter each
   passed silently once; a missing tier output read exit 1, not NO-VERDICT.
   *(B1, B10, C1, C2, C3, C6, C8, C10, C11, C15, C18, C19, C20, C21, C22, D18, A12, B7, B9, C12, C13, D14, D15)*
3. **A zero-GC claim names its resolution.** GC counts prove "less than res B/op", not 0 B/op;
   the per-op byte gate is `test/alloc.mjs`. *(A6, A9, C4, D3, D4, D6, D19, B8, C12, D8)*
4. **Measure allocation with the counter that sees transient boxes.** V8 `total_allocated_bytes`,
   not a `heapUsed` delta; steady state is the minimum over windows 1..W-1, never window 0, and a
   lane must run in optimized code. *(B2, C8, D1, D2, D3, D6, D12, D19, D20, A13, B8, D11)*
5. **Measured numbers enter docs from a run log of this cycle; an estimate is "nominal".** A figure derived from another
   measurement is not a measurement. *(A11, B4, B12, C9, D4, D16, D17, D18, D20, D21, A15, D9, D10)*
6. **A status line names a run that exists on the final tree.** A verify that hit a BUSY lock, ran
   unlocked and predated the final code is not "closing verify PRELIMINARY". *(C9)*
7. **A doc claim is a claim about every caller path (allocation, and any list that reads as exhaustive).** "Zero
   allocation" holds only for the paths the gate lanes cover; `get(i)` allocates and the docs say so (`copyTo` allocates
   nothing at any size since R1 only while each store site has seen <= 4 dst classes, B4 / B8); `copyToFast` allocates
   by design. *(A1, A11, B2, B4, B5, B6, B8, B13, A13, A15, B11)*
8. **General O(1) structures belong to lite-o1; this package is the Float32 telemetry ring** that
   feeds lite-canvas-graph and lite-stats-math. A feature that does not serve that pipeline is
   refused. *(A1, A2, A3, A4, A5)*
9. **Float32 `data` stays monomorphic and a field never widens to `Any`.** No Float64 or shared
   storage mode; `destroy()` keeps a typed (shared empty) array, never `null`. *(A3, A4, B3)*
10. **NaN is data here; null is not zero.** `push(NaN)` is stored and read back so a telemetry gap
    reaches lite-stats-math; a bad `dst` throws, a NaN bound never passes. *(A5, B1)*
11. **A test-count floor is part of `npm test`.** An emptied, skipped, crashed or early-exiting test
    file must fail the run. *(C5, C6, C10, C15)*
12. **Scope every measurement run explicitly.** A run that globs the package root also reads frozen
    copies under `.handoff/`; a tmp-leak check scopes its own TMPDIR. *(D5, C11, C15, D17, D11, D13)*
13. **Every refusal names why, and a parked item names its unpark condition.** *(A1..A15, D13)*

Gate consequence: `npm run verify` = `npm test && npm run alloc && npm run torture && npm run
ascii`, DETERMINISTIC tier only. No single green gate authorises a release.

---

## A. Designs refused

### A1. `getOldest(index)`

- **What happened.** Proposed as an oldest-relative accessor. Rejected on the ROADMAP (the bullet
  carries no date; the Positioning it rests on is SETTLED 2026-10-14, rechecked 2026-11-10).
- **Root cause.** lite-o1 `RingLog.get(i)` is oldest-relative already; here it is
  `get(count - 1 - i)`. The method would inherit `get`'s `number | undefined` box (16 B per call),
  pulling in a `getOldestOrDefault` twin: two methods for one subtraction. The proposed formula also
  had no bounds check (index >= count reads stale slots).
- **Evidence.** ROADMAP.md "Rejected"; commits 1d6e368 / b6a8310 carry it (ROADMAP.md was untracked until 1d6e368). The
  16 B figure is from the e3e1df1 / 0412025 alloc gate (Node 26.8.2 arm64, 2026-10-14).
- **Law.** 7, 8, 13.
- **Gate.** None (absence). Reopen only with a named consumer and a zero-box signature.

### A2. `sum()` / `mean()` / `min()` / `max()` / `stats(out)`

- **What happened.** Proposed as built-in reductions. Rejected on the ROADMAP.
- **Root cause.** O(n) per call duplicates `lite-stats-math` (which already filters NaN and does
  quantiles) and is strictly worse than lite-o1 `WindowFold` / `MonoDeque` (O(1) per push). A
  profiler wanting a running min / max / sum pairs this ring with `WindowFold`.
- **Evidence.** ROADMAP.md "Rejected"; commit b6a8310. No timing refused it.
- **Law.** 8, 13.
- **Gate.** None (absence).

### A3. `RingBuffer.fromBuffer(typedArray)` / SharedArrayBuffer view / worker mode

- **What happened.** Proposed as a "zero-copy worklet <-> main thread" feature. Rejected.
- **Root cause.** The claim does not hold: `head` and `count` are JS fields on the instance, not in
  shared memory, so the other thread cannot tell which samples are live. Making it work needs an
  Atomics header and SPSC publish / consume ordering, a different structure; docs already say
  "Not thread-safe". Accepting Float64Array / Int32Array storage would also make `data`
  polymorphic. If wanted: a separate package (`lite-spsc-ring`). ShellyProject shares only
  fixed-layout summaries across workers, never live rings (rechecked 2026-11-06).
- **Evidence.** ROADMAP.md "Rejected"; commit b6a8310.
- **Law.** 8, 9, 13.
- **Gate.** None (absence).

### A4. Float64 storage mode

- **What happened.** Proposed as an option for exact large counters. Rejected.
- **Root cause.** It makes `data` polymorphic. Float32 is enough for instantaneous telemetry (W, V,
  A, pf: about 7 significant digits); monotonic energy counters above 2^24 belong in the caller's
  Float64 columns.
- **Evidence.** ROADMAP.md "Rejected" and Positioning ("keep `data` a monomorphic `Float32Array`");
  commit b6a8310.
- **Law.** 8, 9, 13.
- **Gate.** None (absence). The `destroy()` entry B3 shows the field-type mechanism.

### A5. Deprecate in favour of lite-o1 `RingLog` / `RingDeque`

- **What happened.** Proposed after lite-o1 appeared; checked against lite-o1 1.11.3 on 2026-11-10;
  SETTLED by the maintainer 2026-10-14, rechecked 2026-11-10: this package stays.
- **Root cause.** Storage: `RingLog` / `RingDeque` use `Float64Array` (twice the memory per window).
  NaN: `push(NaN)` is stored and read back here, so a telemetry gap survives into lite-stats-math;
  `RingLog` / `RingDeque` throw on NaN. Full ring: this ring overwrites the oldest sample;
  `RingDeque` throws when full. Bulk read: `copyTo` and the exposed `data` are how both companions
  read the window; neither lite-o1 class has a bulk copy. Dependents: LiteCanvasGraph,
  LiteStatsMath, LiteProfiler, LiteProfilerScheduler, LiteGPUProfiler (5).
- **Evidence.** ROADMAP.md "Positioning" and "Rejected"; commit b6a8310.
- **Law.** 8, 10, 13.
- **Gate.** None (absence). Reopen only if lite-o1 gains Float32 storage, NaN storage, an overwrite
  mode and a bulk copy at once.

### A6. `get(i)` promoted from REPORTED to a second torture CONTROL

- **What happened.** Unit D2 considered making the torture `get(i)` lane a second CONTROL (the 16 B
  box seen every run). Ruled R-4: it stays REPORTED.
- **Root cause.** 7 minor GCs at 2M ops can fall to 0 if V8 grows new space: a flake in the deterministic tier. The
  torture log of this cycle shows `REPORTED get(i)` 2000000 ops, minor 7, 16.2 B/op
  (`.handoff/archive/1.2.1/D2/qa/q3-torture-batch.txt`, 2026-11-10 07:50Z, Node v26.8.2, quiet-lock free, host
  PRELIMINARY load1 3.63 vs baseline 2.21).
- **Evidence.** b6a8310; `.handoff/archive/1.2.1/D2/PLAN.md` (R-4); `.handoff/archive/1.2.1/D2/qa/q3-torture-batch.txt`;
  `test/torture.mjs` header.
- **Law.** 1, 3, 13.
- **Gate.** `test/alloc.mjs` `CONTROL get(i), one 16 B box` is the deterministic tooth.

### A7. PARKED (not refused): M2, R4; M1 DROPPED 2026-11-15 (two-span forEach)

- **What happened.** Parked 2026-11-10 (maintainer scope trim), each with an unpark condition.
  M1 two-span `forEach` / `copyTo` loop: adopt only on a STATISTICAL win (interleaved A/B at 1024
  and 8192 samples, quiet host, must-fail control); if not run by the release after R3, record a
  null result and drop it. M2 `forEachNewest(fn)`: no consumer needs it (EMA and decay weights can
  be computed oldest-first); unpark when lite-canvas-graph trails asks. R4 `RingBank(rings,
  capacity)` (N rings in one Float32Array): its only driver is the ShellyProject fleet case;
  unpark only when ShellyProject is committed and names RingBank as a dependency, then a research
  burst and a ruled PROPOSAL first.
  Update 2026-11-15: M1's deadline (the release after R3 = 1.5.1) passed unmeasured. RULING Q-M1-DEADLINE =
  "C Measure it next": "Make it a research burst (spike-first ladder, its own session) before B1; nothing is
  dropped now." (maintainer, AskUserQuestion; options were A Drop it, B Keep it parked, C Measure it next).
  M1 stays PARKED until that research burst ends; the adopt rule (STATISTICAL win only) is unchanged. (This M1 is
  the ROADMAP Parked item, not the "M1 unpark unit" of A15 / C17 / D16.)
  Update 2026-11-15 (M1 research burst): M1 DROPPED. The strict A/B on a `store` callback measured a LOSS on the
  wrapped full ring for both two-span candidates (C1, C2) at 1024 and 8192 samples in both strict runs (REPORTED,
  QUIET): row medians candidate / REF C1 1.526-1.553, C2 1.539-1.563; ONE `quiet-lock run --strict` hold, lock exit 0,
  inner exits 0 0, 2026-11-15T16:19:54Z-16:23:32Z, load1 2.42 vs baseline 2.21, Apple M4 Pro, Node v26.8.2 / V8
  14.6.202.34-node.28, HEAD 55b6ea9 / `RingBuffer.js` 90f7ad7c, K 21 x 3 compilations, 2 runs. C2's only WIN is h0
  (0.921-0.926: its second loop never runs); C1 has no WIN row. The PRELIMINARY rung 1b run agreed. Maintainer ruling
  (AskUserQuestion): "Strict re-run, then drop". The `copyTo` loop half (rung 3, "only if rung 1 showed a win") never
  ran and is dropped unmeasured. The sum-callback runs were VOID (D17). Reopen only with a new mechanism that removes
  the wrap-row cost, re-measured by the same strict A/B on a store callback with a must-fail control and a WIN row at
  1024 and 8192 and no loss row. (M1 here is the Parked item, not the "M1 unpark unit".)
- **Root cause.** M2, R4: no consumer. M1: a measured loss (a two-span walk costs more than the masked one on a
  wrapped full ring), not only "no win"; "an engine detail is not a reason to ship code".
- **Evidence.** ROADMAP.md "Parked"; b6a8310; `.handoff/archive/1.5.3/research/m1-twospan/PROGRESS.md`;
  `.handoff/archive/1.5.3/research/m1-twospan/runs/strict/store-1/ab.md`; `.../runs/strict/store-2/ab.md`;
  `.../runs/rung1b/store/ab.md` (PRELIMINARY).
- **Law.** 13.
- **Gate.** None (STATISTICAL, by hand).

### A8. deopt-diff PARKED (unit LU) -> ADOPTED (LU2)

- **What happened.** The LiteUtils tool family offers a deopt-diff (before / after deoptimization
  comparison). Parked in unit LU (2026-11-11).
- **Root cause.** No before / after pair exists before R1, and an A/A run gates no doc claim; R1's open
  question is timing, not deopts.
- **Evidence.** LiteUtils 465881b; `.handoff/archive/1.3.0/LU/PLAN.md` (PLAN.md SPEC, PARK / REFUSE).
- **Law.** 13.
- **Gate.** None. UNPARKED in the R1 build burst (T7, REPORTED tier, decides nothing): the deopt-diff self-test (107 ok)
  and `--fn copyTo` on Float32 and Float64 dst, 1.2.1 vs the R1 candidate (eab8983a), each DIFF = 1.2.1's one Maglev
  deopt (`Math.min`) gone, R1 0 deopts, blind control DIFF (not blind). The drivers (`.handoff/archive/1.3.0/R1/deopt/`)
  were not reviewed; summary `.handoff/archive/1.3.0/R1/evidence/S/t6-t7-summary.md` (HISTORY, R1 build burst 2). A11
  stays closed. ADOPTED in LU2 (C15) as `npm run deopt-diff` (`test/tools/deopt-diff.mjs`, REPORTED, by hand under the
  quiet lock, not in `verify`); the drivers (`test/tools/deopt-driver.mjs`) were reviewed in LU2; the script's self-test
  is 107 ok on lite-utils 1.0.0 (`.handoff/archive/1.4.0/LU2/evidence/deopt-selftest-1.0.0.log`). qa, 1 run
  (deopt-diff.sh --runs 3 per side; tier lines from run 1 of each side), 2026-11-14T16:50:17Z, Node v26.8.2, HEAD
  2f212c8, host PRELIMINARY (load1 4.55 vs baseline 2.21): exit 0, control DIFF; f32 SAME with 1 Maglev deopt-eager
  ("Insufficient type feedback for generic named access", RingBuffer.js:436:17, bytecode offset 91, the `tag ===
  'Float32Array'` test), cycles 1, ends in TurboFan, on both sides; f64 SAME, 0 deopts (REPORTED, decides nothing;
  `.handoff/archive/1.4.0/LU2/evidence/qa-deopt-diff.log`). R1's FC build (eab8983a) read 0 deopts on f32; this build is
  1.3.0 (eaa32ee7), so the builds differ -- not a regression claim (no deopt loop). `pushBatch` had no candidate yet:
  the LU2 driver did not call it, so `--fn pushBatch` reads NO-VERDICT until the before side has pushBatch. The R2 build
  (ff6ee762) extends the driver with a guarded pushBatch phase (`test/tools/deopt-driver.mjs`); `--fn copyTo,pushBatch`
  still reads NO-VERDICT for pushBatch while git HEAD (eef921f) lacks it
  (`.handoff/archive/1.4.0/R2/reported/deopt-diff.log`, exit 2; `--fn copyTo` alone: f32 SAME, f64 SAME, control DIFF,
  `.handoff/archive/1.4.0/R2/reported/deopt-diff-copyTo.log`); a verdict needs the post-commit run (PLAN-G1 A2 FILLER).
  Post-commit run (FILLER R2-5, release 1.4.0 burst), 1 run (deopt-diff.sh --runs 3 per side), 2026-11-14T21:50:17Z,
  Node v26.8.2, HEAD f03561c vs the working tree, both RingBuffer.js ff6ee762 (byte-identical, so an A/A null control,
  not a before / after), host QUIET (load1 2.59 vs baseline 2.21): exit 0, control DIFF; `pushBatch` f32 SAME and f64
  SAME, 0 deopts on both sides, MAGLEV -> TURBOFAN_JS, 0 cycles; `copyTo` f32 SAME (1 deopt each side, as in LU2), f64
  SAME (0 deopts) (REPORTED, decides nothing; `.handoff/archive/1.4.0/release-1.4.0/deopt-diff-copyTo-pushBatch.log`).
  It shows only that the driver drives `pushBatch` to TurboFan without a deopt; the next `RingBuffer.js` change gets the
  first real before / after read.

### A9. allocation-diff REFUSED (unit LU)

- **What happened.** Considered as a second allocation oracle; refused 2026-11-11.
- **Root cause.** It counts young-GC events under a 1 MB semispace, so it resolves only "less than 1 MB
  per window" (law 3), and duplicates torture's GC counts. `test/alloc.mjs` is the per-op byte gate.
- **Evidence.** LiteUtils 465881b; `.handoff/archive/1.3.0/LU/PLAN.md`.
- **Law.** 3, 13.
- **Gate.** None (absence). Unpark: a supported Node without `total_allocated_bytes`, where `alloc.mjs`
  exits 2.

### A10. alloc-per-op.mjs REFUSED (unit LU)

- **What happened.** Considered as a vendored per-op allocation tool; refused 2026-11-11.
- **Root cause.** Same method as `test/alloc.mjs` (`total_allocated_bytes`, minimum over windows), REPORTED
  tier, and untracked in LiteUtils, so there is nothing to pin.
- **Evidence.** LiteUtils 465881b; `.handoff/archive/1.3.0/LU/PLAN.md`.
- **Law.** 1, 13.
- **Gate.** None (absence). Unpark: LiteUtils commits it AND `alloc.mjs` shows a measured cross-lane
  artifact.

### A11. copyTo strategies (a) loop-at-every-size and (b) loop-to-crossover REFUSED (R1 step 1)

- **What happened.** The R1 step 1 research pass (2026-11-11) timed the masked loop, set + subarray and a
  new zero-allocation full-ring candidate (ROT) at 32..16384 samples. Maintainer ruled (c) ROT + loop.
  Refused: (a) the loop at every size -- 4.7x-6.3x of the set path at 1024 / Float32, ~12x at 16384; (b) the
  loop up to the measured crossover (Float32: 64..256) -- both companions (1024) would keep allocating.
  AMENDED by Q-R1B-ROUTER (R1b, 2026-11-11, A12 / D10): Q-R1's "`COPY_LOOP_MAX` goes" was reversed for ONE
  purpose -- a full Float32 ring of <= 32 samples takes the masked loop, ROT only above 32 (the cutoff 32 is
  nominal). This is NOT (b): the loop is not carried up to the crossover, so (b) stays refused.
- **Root cause.** At 1024 / Float32 the masked loop takes ~457 ns per call vs 73-99 ns for set + subarray;
  only a view-free `set` (whole storage) plus `copyWithin` moves the bulk without allocating, and ROT still
  loops over the smaller half (0.71x-3.15x of today's call, PROPOSAL F4).
- **Evidence.** Build under test dc6965f / 43adb369 (frozen); `.handoff/archive/1.5.3/PROPOSAL-r1.md` (RULINGS, section
  2), `.handoff/archive/1.5.3/research/r1/PROGRESS.md`; `.handoff/archive/1.5.3/PROPOSAL-r1b.md` RULINGS (Q-R1B-ROUTER).
  4.7x-6.3x from `runs/v2/rung-1024-v2.md` (2026-11-11T05:38Z, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28,
  load1 1.55 -> 1.56, QUIET non-strict, 3 compilations x 21 rounds); ~12x from `runs/rung-16384-v3.md` (wrap row only,
  host PRELIMINARY, load1 3.07 -> 3.15, run exit 1). All PRELIMINARY (strict hold PENDING).
- **Law.** 5, 7, 13.
- **Gate.** None (refusal). Reopen (a) only if (c) fails its `test/alloc.mjs` copyTo lanes or
  `inlining-budget-diff --fn copyTo` exits 1 on it (deopt-diff is REPORTED and decides nothing); reopen (b)
  only if a strict-hold Float32 crossover reaches >= 1024 samples. The Q-R1B-ROUTER cutoff is the one
  sanctioned loop cutoff; moving it needs a new strict A/B.

### A12. Alias-check buffer cache WITHOUT an identity key REFUSED (R1b)

- **What happened.** V-onebuf cached `this.data`'s buffer at construction to save one ~5 ns getter call.
- **Root cause.** `data` is `readonly` only in the .d.ts; at runtime it is a writable field. A caller that
  assigns `rb.data` would leave the cached buffer stale, so the alias check fails OPEN for that caller.
- **Evidence.** `.handoff/archive/1.5.3/research/r1b/variants/V-onebuf/` (03d1434f);
  `.handoff/archive/1.5.3/PROPOSAL-r1b.md` section 6.
- **Law.** 2.
- **Gate.** None (refusal). Reopen only with a cache that re-reads the intrinsic getter whenever `rb.data` is
  not the cached array (V-split32c's `bufOf` key, written only AFTER the getter returned), with node:test cases
  that reassign `rb.data` to a TypedArray (expects the alias RangeError) and to a non-TypedArray (expects
  TypeError on EVERY call: the review-caught fail-open of 54279dbe, which keyed the cache before the read).
  Held today by `test/copyto-r1b.test.js` A1a / A1b (B7).
- **RULING.** Q-R1B-FIX = "V-split32c" (identity-keyed cache, key written after the read), maintainer,
  2026-11-11, AskUserQuestion (`.handoff/archive/1.5.3/PROPOSAL-r1b.md` RULINGS); V-onebuf was not chosen.

### A13. pushBatch bodies refused by the R2 research pass: one shared loop, Float64 `set`, two spans, inline families

- **What happened.** The R2 research pass (2026-11-12, `.handoff/archive/1.5.3/research/r2/`, build a6d0220 / eaa32ee7)
  compared pushBatch bodies against a caller's `push` loop. Refused: (1) one masked loop shared by every src kind
  (MASK): 0 B monomorphic, but its src LOAD site boxes every sample once it has seen > 4 src classes (2042 B per
  128-sample call), and ONE `pushBatch(BigInt64Array)` call -- which throws TypeError and writes nothing -- leaves it
  boxing every later non-Smi Float32 / Float64 sample (0 -> 1836-1839 B per 128-sample call); (2) `set` from a Float64
  src: slower than the masked loop (0.68-0.91x vs 0.38-0.48x of a push loop, chunks 32..256); (3) two unmasked spans
  (SPAN2): 0.95-1.24x of the masked loop, the R1 LOOP2 null again; (4) per-family loops inline (FULL): 0 B under both
  traps but 658 B of bytecode, over the 460 B inline limit (D9). Kept as the candidate: SPLIT v2 (346 B hot body + 234 B
  batchCheck, per-family loop helpers, BigInt rejected before any store site, `set` for a whole Float32 src only). SPLIT
  v2 is 0 B for Float32 / Float64 src only: its shared "every other kind" site boxes non-Smi samples past 4 kinds
  (review scratch run, 2065 B per 128-sample call).
- **Root cause.** A keyed load / store site has a 4-map polymorphism budget and a megamorphic or generic site
  passes doubles tagged, so it boxes (B8, now on the load side); a store site that once saw a BigInt goes generic
  even though the store threw. `TypedArray.prototype.set` converting float64 -> float32 is slower than TurboFan's
  per-element loop (inferred from timings, not from V8 source).
- **Evidence.** `.handoff/archive/1.5.3/research/r2/PROGRESS.md` rung 0 (`runs/rung0-check.json`, `rung0-check-v2.json`;
  untimed, counter-based, D6 v4 harness), rungs 1-2 (`runs/rung1.md` QUIET non-strict exit 2, `runs/rung2.md`
  PRELIMINARY exit 1 with n = 1024 VOID; 2026-11-12T08:09Z-08:15Z, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28,
  K 21 x 3 compilations; every timing PRELIMINARY); `.handoff/archive/1.5.3/PROPOSAL-r2.md` section 4.
- **Law.** 1, 4, 7 (and zero-box): a doc claim that pushBatch allocates nothing covers the > 4-class and the
  after-a-BigInt-call paths.
- **Gate.** `test/alloc.mjs` pushBatch lanes (7 plain, BIGINT, MEGA F32 / F64) with must-allocate controls `maskBig` and
  `maskMega` (F32 / F64), ~2048 B per call; the torture lane `pushBatch 1024 set+slice+F64+over-cap` (major 0 / minor
  0); `npm run bench:pushbatch` (STATISTICAL, dev-only, not in verify). Strict run of record
  `.handoff/archive/1.4.0/R2/ab/strict-1/` (build ff6ee762, `quiet-lock run --strict` exit 0, QUIET at start, load1 3.17
  -> 3.57, 2026-11-14T21:17:48Z-21:18:41Z, Apple M4 Pro, Node v26.8.2, K 21 x 3 compilations): push loop faster at
  chunks 1 / 8 (all 8 cells SLOWER), pushBatch faster at 32 / 128 (all 12 cells FASTER), every A/A median 0.968-1.024,
  SLOW/CAND >= 2.44. Provenance caveat: a docs helper's `npm test` may have overlapped part of the 52 s window; the A/A
  bands held. Per R2-4, no chunk-1 multiplier is quoted (constant-count folding in the harness). Reopen (1) / (4) only
  with a body that clears those lanes and stays under 460 B; (2) only with a strict A/B where Float64 `set` beats the
  loop; (3) only with a new mechanism (FILLER 2 / A7 rule).
- **RULING.** Q-R2-PARITY = "A Physical parity"; Q-R2-ALIAS = "A RangeError, read every call"; Q-R2-TYPES = "B
  Float32/Float64 only"; Q-R2-BIGINT = "A TypeError up front"; Q-R2-SMALL = "A Document it"; Q-R2-STRICT = "A Rule now,
  strict in build". Maintainer, 2026-11-12, AskUserQuestion, one sitting (`.handoff/archive/1.5.3/PROPOSAL-r2.md`
  section 7).
- **RULING.** Q-R2-FROZEN = "A TypeError, nothing written"; Q-R2-DATA = "A Float32Array only" + "TypeError";
  Q-R2-TAMPER = "A Doc-scope only" (the three lines added to PROPOSAL-r2 section 7 during the build). In effect:
  Q-R2-FROZEN: `head` / `count` are stored before the first data store, so a frozen ring throws TypeError
  with nothing written (differs from `copyTo`, which copies on a frozen ring); Q-R2-DATA = `pushBatch` checks that
  `this.data` is a Float32Array by intrinsic tag on every call, before the cache (B10); Q-R2-TAMPER = only a
  whole-ring `Object.freeze` is covered, per-property tampering is unsupported (as with `push`). Maintainer,
  2026-11-14, AskUserQuestion, in chat.
- **RULING (qa).** Q-R2-DESTROY = "A Document as-is" (after `destroy()`, `pushBatch` returns `count`, stores
  nothing, no throw, like `push`); Q-R2-DETACH = "A Document as-is" (a detached / out-of-bounds `src` reads as
  length 0: `count` omitted -> 0, explicit `count` >= 1 -> bounds RangeError). Maintainer, 2026-11-14,
  AskUserQuestion, in chat; pinned by `test/qa-r2.test.js`; no engine change.

### A14. ic-diff and bytecode-budget PARKED (unit LU2)

- **What happened.** The lite-utils 1.0.0 tool family also offers ic-diff and bytecode-budget; both parked in LU2
  (2026-11-14). allocation-diff and alloc-per-op stay REFUSED (A9, A10; unchanged).
- **Root cause.** ic-diff: no ruled claim is about IC state (bytes are gated by `alloc.mjs`, deopts are reported by
  deopt-diff), and ic-diff has driver mode only, so a wrapper would gate nothing. bytecode-budget: "pushBatch and
  batchCheck each < 460 B" is a threshold; `inline-diff.mjs` has no `--fn`, and inlining-budget-diff gives a delta
  (D9), not a threshold verdict.
- **Evidence.** `.handoff/archive/1.4.0/LU2/PLAN.md`; `.handoff/archive/1.4.0/LU2/FACTS.md`.
- **Law.** 13.
- **Gate.** None (absence). Unpark ic-diff: a ruled IC claim (e.g. R2's MEGA "polymorphic, not megamorphic") or a
  deopt-diff DIFF that needs IC localisation. Unpark bytecode-budget: the R2 build; the tool's GATE mode `--max
  pushBatch=459,batchCheck=459 --node-version <pinned>` plus a padded-fn must-fail control fits;
  deterministic per V8 build only, so by hand / at release, never in `npm test`.
- **UNPARKED (bytecode-budget only) by the R2 build, 2026-11-14.** GATE `--max pushBatch=459,batchCheck=459
  --node-version v26.8.2` exit 0 (pushBatch 322 B, batchCheck 294 B) plus a padded must-fail control (pushBatch
  736 B, exit 1), run by hand, never in `npm test` (`.handoff/archive/1.4.0/R2/b1fix/gate-3-budget-live.log`,
  `gate-3-budget-padded.log`). ic-diff stays parked.

### A15. copyLast bodies refused by the R3 research pass: shared check helper, one shared body, no ROT

- **What happened.** The R3 research pass (2026-11-15, `.handoff/archive/1.5.0/research/r3/`, build e3c1d42 / ff6ee762)
  built `copyLast(dst, dstOffset, n)` four ways as module variants of the frozen file. All four pass a 16,236-case sweep
  against the last k of the frozen `copyTo`, the parity matrix (copyLast(count) === copyTo incl. every error case), the
  n list and the B/op + MEGA lanes (0 B per call). Refused: (1) SHARED (copyCheck takes n; copyTo passes count) and (2)
  DELEG (one copyRange body behind two wrappers): each makes `copyTo` ITSELF 1.15-1.18x slower at head 0 and 1.52-1.62x
  at head 768 on a full Float32 1024 ring (its ROT path), and DELEG makes copyTo and copyLast share one 4-class store
  budget per family; (3) NOROT (the scalar loop for a whole-window copy): 6.79-6.80x / 2.06-2.10x of copyTo at head 0
  / 768. Kept: OWN (copyLast + its own `lastCheck`, copyTo byte-identical). OWN's copyLast(count) is itself 1.15-1.17x /
  1.53-1.76x of copyTo on that path, which FIRED the INTAKE kill rule (> 1.10); the maintainer WAIVED it (Q-R3-PARGAP
  A): the parity gate is an output / throw gate, and ROT is still in use (NOROT above). Mechanism UNKNOWN: two
  frozen-copyTo twins and OWN's own copyTo (identical source) read 0.99-1.02 of the frozen copyTo, every body whose
  inlined check helper carries copyLast's n check and min is slow (no ablation separates the two), feeding rotCopy from
  fields (OWN2) or re-reading `this.count` (SH2) changes nothing, no deopt (`--trace-deopt`), everything inlined (budget
  483 -> 792 / 920); the gap grows with the rotate work (~8 ns with `set` only, ~90-135 ns with `copyWithin` + a
  256-sample loop).
- **Root cause.** Unknown at the time (above); found by R3-M1 (addition below): caller inlining, not either body. The
  refusals rest on the measured copyTo regression, not on a mechanism.
- **Evidence.** `.handoff/archive/1.5.0/research/r3/PROGRESS.md` rungs 0, 1, 2, 2b, 2c; `runs/rung0-check-v2.json`
  (untimed, host QUIET, load1 1.52 -> 1.46), `runs/rung1.md`, `rung2.md`, `rung2b.md`, `rung2c.md` (each `quiet-lock
  run` non-strict exit 2, host PRELIMINARY: another node process at 13-126% CPU, load1 1.79 -> 4.41 at worst;
  2026-11-14T23:16Z-23:26Z, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, K 21 x 3 compilations; every timing
  PRELIMINARY; the strict hold was not run). Variants OWN 2f47eec8, SHARED 3aa1b723, DELEG 9810c2d8, NOROT 49866e6c,
  OWN2 b2473353, SH2 99390108; `.handoff/archive/1.5.0/PROPOSAL-r3.md` sections 3-4 (reviewer APPROVED r3).
- **Law.** 1, 5, 7, 13.
- **Gate.** None yet (refusal + research). The R3 build unit gates OWN: copyTo / copyToFast / copyCheck / rotCopy
  byte-identical to HEAD, the strict A/B on the real method. Reopen (1) / (2) only with a strict A/B showing copyTo at
  <= 1.05x on every T5 row; (3) never while ROT exists; the waived gap reopens as a FILLER mechanism hunt (first
  ablation: OWN with the n check outside lastCheck), adopting a fix only on a strict A/B. Build-unit gates (2026-11-15,
  working tree on 4b471da / 9765c21e, review APPROVED): OWN gated by the identity / golden byte-identical check of
  copyTo / copyToFast / copyCheck / rotCopy, 259 tests, the R3 mutant runs (24 mutants, C14), and the `npm run alloc` /
  `npm run torture` copyLast lanes (`.handoff/archive/1.5.0/R3/gate/b2/verify.log`, run on the round-1 build 6d92ed1f;
  9765c21e differs from it by JSDoc and test assertions only; closing verify on 9765c21e:
  `.handoff/archive/1.5.0/R3/verify-final.log`). Strict A/B (`npm run bench:copylast`): strict A/B
  `.handoff/archive/1.5.0/R3/ab/strict-1/` (quiet-lock --strict exit 0, QUIET, load1 2.06 -> 2.02 vs baseline 2.21,
  2026-11-15, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, K 21 x 3 compilations = 63 paired rounds per row, 63
  rounds, every timed column 0.00 B/op): caller workaround n 120 2.2-2.3x / n 512 1.5x slower than copyLast;
  copyLast(count) / copyTo 1.17x (h0) / 1.52x (h768) Float32, 1.00 Float64 -- the waived gap confirmed on the strict
  host. inlining-budget-diff (REPORTED, `.handoff/archive/1.5.0/R3/inl/main.log`, `ctl.log`): copyTo / copyCheck /
  rotCopy decisions and sizes unchanged (288 / 257 / 192 B); copyLast 295 / lastCheck 304 / copyLastFast 195 B;
  lastCheck + rotCopy inline into copyLast, but copyLast compiled first is NOT inlined into its caller (cumulative
  budget 295 + 496 > 920 / 1.2).
- **RULING.** Q-R3-BODY = "A OWN"; Q-R3-BOUNDS = "A offset + n" (amends ROADMAP R3's `dstOffset + k` bullet);
  Q-R3-ZERO = "A Return 0 early"; Q-R3-PARGAP = "A Waive, ship OWN"; Q-R3-ORDER = "A (dst, off, n)"; Q-R3-FAST =
  "B Add copyLastFast" (new surface: the copyToFast pattern over the newest k, sharing lastCheck; allocates one
  `subarray` view per ring half, not measured this cycle); Q-R3-STRICT = "A Rule now, strict in build". Maintainer,
  2026-11-15, AskUserQuestion, one sitting (`.handoff/archive/1.5.0/PROPOSAL-r3.md` section 7).
- **R3-M1 addition (2026-11-15): the mechanism is the caller's cumulative-inlining budget.** FILLER R3-M1 (research
  ladder, `.handoff/archive/1.5.1/research/r3-m1/`, build b690e9c / 9765c21e, no source edit;
  `test/bench/copylast-ab.mjs` unmodified with `--cand` on research variants, parity rows, Float32; every run
  `quiet-lock run` non-strict exit 2 = host PRELIMINARY only, every A/A / SLOW / B/op / BOX / oracle / TurboFan check in
  band). (1) Rung 1: moving the n check (OUT_N) or the n check + min (OUT_NM) out of lastCheck into copyLast's body:
  1.15 / 1.53 and 1.17 / 1.54 vs LIVE 1.14 / 1.53 (h0 / h768) -- NO EFFECT; lastCheck is inlined into copyLast either
  way (reading, not traced), and both stayed over the reserve (chains 799 / 806 B; D13). (2) Rung 2:
  `--trace-turbo-inlining` in the A/B's own driver: copyTo (288 B + 449 inlined = 737) inlines into its driver; copyLast
  (295 + 496 = 791 > 920 / 1.2 = 767) does not. With `--max-inlined-bytecode-size-cumulative=2400` (both inline)
  copyLast(count) / copyTo = 1.01 / 1.00 (167.0 vs 166.6 ns at h768); at `=300` (neither inlines, and the check helpers
  stop inlining too) 1.01 / 1.00 with copyTo at 263.6 ns -- the gap is copyLast not being inlined into its caller: ~8 ns
  at h0 / ~86-92 ns at h768 (default vs b2400 CAND 59.2 / 51.3 and 259.4 / 167.0 ns; LIVE vs SLIM2 254.7 / 168.4 ns);
  consistent with every R3 row by chain-size arithmetic (not traced: FR copyTo 737 fast; OWN 792, SHARED copyTo 789,
  DELEG 812, OWN2 / SH2 slow). (3) Rung 3a: SLIM2 (lastCheck's type / n / bounds checks share one throw site with a cold
  `lastArgError`, alias / storage one with a cold `lastStateError`) cuts lastCheck 304 -> 278 B, chain 765 B: copyLast
  inlines at default flags and reads 1.01 / 1.00 and 1.00 / 1.00 (two runs, c194837a), 1.00 / 1.01 (final e20476df); the
  near-miss control SLIM (chain 772 B) keeps 1.15 / 1.52. The claim review caught c194837a changing the error for an
  other-realm DataView dst with a bad n (RangeError instead of 1.5.0's native TypeError; pinned by test/copylast.test.js
  "kills X10"); e20476df reads the length in the cold builder first (hot body unchanged, 278 B) and matches 1.5.0 on
  260,580 cases (copyLast + copyLastFast, 10 dst kinds incl. that one; storage, cache-hit and frozen-ring paths not in
  the matrix). Still unknown: why a called ROT path costs more in proportion to the rotate work. Evidence:
  `.handoff/archive/1.5.1/research/r3-m1/PROGRESS.md` rungs 0-3a, `runs/rung1-*`, `runs/rung2-*`, `runs/rung2-trace/`,
  `runs/rung3a-*` (2026-11-15T03:20Z-03:42Z, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, K 21 x 3 compilations
  per row, load1 3.78-6.24 vs baseline 2.21, another package's node process at 100-133% CPU; every timing PRELIMINARY;
  the strict hold of LIVE vs SLIM2 was not run). Law 13: the waiver (Q-R3-PARGAP A) stands until
  `.handoff/archive/1.5.1/PROPOSAL-r3-m1.md` is ruled; adopting SLIM2 needs a strict A/B with copyLast(count) / copyTo
  <= 1.05 at h0 and h768, behaviour parity, and a gate on the chain size (its margin is < 2 B and depends on V8's
  bytecode sizes and budget constants, and on the caller: a caller with no budget left inlines neither method). RULING
  (R3-M1): Q-M1-ADOPT = "A Build SLIM2"; Q-M1-GATE = "A Chain-size gate in npm test"; Q-M1-STRICT = "A In the build
  unit". Maintainer, 2026-11-15, AskUserQuestion, one sitting (`.handoff/archive/1.5.1/PROPOSAL-r3-m1.md` section 6).
  SLIM2 build unit (2026-11-15, `.handoff/archive/1.5.1/M1/`, before build a771a79 / 9765c21e): PARKED after review
  APPROVED. The candidate (0083e04b) took SLIM2's hot body token for token (lastCheck 278 B, chain 765 B, copyTo chain
  737 B unchanged; every other function byte-identical) with one SPEC change: lastStateError compares the same `buf` the
  hot body compared (`data === rb._bufOf ? rb._buf : TA_BUFFER(data)`), because SLIM2's re-read broke the shipped
  poisoned-cache test (D14). Gates built: `test/chainsize.test.js` + `test/tools/chain-size.mjs` (chain <= 766 on the
  pinned Node v26.8.2 / V8 14.6.202.34-node.28; frozen 791 fails, padded 794 fails, 13 of 14 reviewer mutants caught), a
  hasInstance-count test (1 call passing, 2 failing; red on 9765c21e), the unit parity gate
  `.handoff/archive/1.5.1/M1/gate/parity.mjs` (367,806 cases, 0 mismatches, controls SLIM2 + an off-by-one twin caught),
  npm test 288/288; `--trace-turbo-inlining` (REPORTED, PRELIMINARY host): copyLast inlines into the driver on 0083e04b
  (2 lines), not on 9765c21e (0 in 3 repeats; the frozen result depends on tier-up order). The review found that the
  double `dst instanceof DataView` on a failing call is more than "two calls": a user `DataView[Symbol.hasInstance]`
  that answers differently or throws on the second call, or a Proxy getPrototypeOf trap in dst's prototype chain,
  changes WHICH error is thrown vs 1.5.0 (reviewer probe: TypeError or the hook's own error where 1.5.0 throws the n
  RangeError). RULING Q-M1-HOOK = "B Park, research first" (maintainer, 2026-11-15, AskUserQuestion). Parked as
  `.handoff/rejected/M1-slim2/` (restored by the unpark unit; now
  `.handoff/archive/1.5.1/rejected/M1-slim2.restored-1794720601539/`) (park-rejected.mjs, base = HEAD a771a79). Unpark
  (law 13): a cold path that observes `dst`'s DataView-ness at most once per call (reuses the hot result, or tests a
  brand the user cannot hook) with the chain still <= 766 B on the pinned V8, the same parity gate at 0 mismatches incl.
  stateful-hook and Proxy-prototype rows, then the strict A/B (Q-M1-STRICT A). The waiver (Q-R3-PARGAP A) stands. R3-M2
  addition (2026-11-15, research pass `.handoff/archive/1.5.1/research/r3-m2/`, HEAD c2910c0 / 9765c21e, no source edit;
  variants from the parked 0083e04b; every figure DETERMINISTIC unless REPORTED): one DataView observation per call
  FITS. Refused, with the run that killed each: ORD_A (hot order isView, n, dstOffset, instanceof, bounds; the cold
  builder infers the hot answer by brand + bounds; 765 B) mismatches 1.5.0 on 294 stage-H rows -- a TypedArray that
  answers `instanceof DataView` true AND is out of bounds gets the bounds RangeError, not dstTypeError; ORD_B (re-asks
  there) makes 2 observations on such a call (786 rows); BRAND (TA_TAG brand + one getPrototypeOf step, 765 B) cannot
  see the chain `instanceof` walks (4,686 rows: DV subclass, re-prototyped TypedArray, liar hooks); every exact carrier
  without a byte payback is over 766 B (local `var` 769, `let` 771, module `var` 767, module `let` 774); module `var` +
  min payback on SLIM2's order (GLB_S_MIN, 765 B) and on the new order with a late flag read (GLB_O_MIN, 765 B) throw
  the wrong error when a replaced, re-entrant `Number.isInteger` overwrites the flag (7 / 30 and 6 / 30 rows,
  `reentry.mjs`). Kept: candidate C = GLB_O_MIN2 5a2e12e1 -- the new hot order with `(lastDv = dst instanceof DataView)`
  into a module-scope `var` (2 B), the cold builder reading `lastDv` first and asking `instanceof` itself only when the
  hot body did not (bad n / dstOffset), and lastCheck's min rewritten as `let k = rb.count; if (n < k) k = n;` (-2 B;
  the nominal estimate was -4): lastCheck 278 B, chain 765 B. Oracle
  `.handoff/archive/1.5.1/research/r3-m2/parity-m2.mjs` (the M1 gate + stage H: 6 hasInstance hooks x 19 dsts incl.
  Proxy prototypes, event sequence vs 1.5.0): matrix 367,806 / 0, stage H 31,464 / 0 (A/A 0, 23,460 hook rows, max 1
  call per row; parked 0083e04b control 18,306); overlay `npm test` 281/281; reentry O1 0 / 30, O3 0 / 30 outcome
  differences; `--trace-turbo-inlining` (REPORTED, load1 3.81): copyLast inlines into its driver 3 / 3 (frozen 0 / 3).
  Mutants of C: MB / MC / MF / ME caught by stage H, MD equivalent, MA (late flag read) caught only by the O3 re-entry
  rows. Not measured: speed (the hot body now writes a module context slot per call). Evidence:
  `.handoff/archive/1.5.1/research/r3-m2/ PROGRESS.md` rungs 0-4 + claim review, `runs/`, `review/`;
  `.handoff/archive/1.5.1/PROPOSAL-r3-m2.md` (2 claim-review rounds, both LITERAL, fixed). Node v26.8.2 / V8
  14.6.202.34-node.28, Apple M4 Pro, 2026-11-15. RULING (R3-M2): Q-M2-ADOPT = "A Unpark with C"; Q-M2-O3 = "A Out of
  contract, documented" (replaced builtins / `Function.prototype.call` unsupported; docs state the call-time globals and
  the new check order); Q-M2-TEST = "A Port stage H to npm test" (incl. n 0 / -0 rows and the O3 re-entry outcome rows;
  revert checks on 0083e04b, MA, ME). Maintainer, 2026-11-15, AskUserQuestion, one sitting
  (`.handoff/archive/1.5.1/PROPOSAL-r3-m2.md` section 7). Unpark unit (next burst): restore M1-slim2, apply C's delta,
  re-review, then the strict A/B (Q-M1-STRICT A); the waiver (Q-R3-PARGAP A) stands until that A/B passes. Reopen ORD_A
  / BRAND only if exact 1.5.0 parity on hooked or re-prototyped dsts is waived; a carrier with no module state only with
  a hot byte payback that keeps the chain <= 766 B. M1 unpark addition (2026-11-15, `.handoff/archive/1.5.1/M1/unpark/`,
  plan `.handoff/archive/1.5.1/M1/PLAN-delta-unpark.md`; before build c2910c0 / 9765c21e): the unpark condition of the
  SLIM2 build unit is met. M1-slim2 restored, candidate C's 3 hunks applied (5a2e12e1, identical to GLB_O_MIN2), then
  JSDoc only (9e70b525, stripped identity to 5a2e12e1; frozen
  `.handoff/archive/1.5.1/M1/frozen/RingBuffer.unpark-9e70b525.js`). Chain copyLast 295 + lastCheck 278 + rotCopy 192 =
  765 B (<= 766), copyTo chain 737 B unchanged; parity-m2 matrix 367,806 / 0 and stage H 31,464 / 0 (parked 0083e04b
  control 18,306 mismatching rows; SLIM2 and the off-by-one twin caught). Gates: test/chainsize.test.js (+ an M1-N1 row,
  red under mutant m13), test/copylast-hooks.test.js (4, the stage-H port of Q-M2-TEST A; red on 0083e04b, ME and MA;
  replaces the parked build's hasInstance-count test, never committed), test/qa-m1.test.js (4, qa; C17); npm test
  294/294. Review APPROVED (overlay `.handoff/archive/1.5.1/M1/unpark/review/r1/`, 0 blockers, 3 nits). qa PASS: 756
  probe rows equal to 1.5.0 (`.handoff/archive/1.5.1/M1/unpark/qa/probe.mjs`). Strict A/B (`npm run bench:copylast`,
  cand 9e70b525 vs ref 9765c21e, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, K 21 x 3 compilations = 63 paired
  rounds per row, every timed column 0.00 B/op), two runs, each `quiet-lock run --strict` exit 0, host QUIET, baseline
  2.21: strict-1 (`.handoff/archive/1.5.1/M1/ab/strict-1/`, 2026-11-15T05:55Z, load1 1.09 -> 1.66): Float32 1024
  copyLast(count) / copyTo h0 1.016 [0.973..1.043], h768 1.017 [1.009..1.174], h768 compilation medians 1.016 / 1.181 /
  1.007; strict-2 (`.handoff/archive/1.5.1/M1/ab/strict-2/`, 2026-11-15T06:08Z, load1 2.20 -> 1.73): h0 1.009
  [0.964..1.019], h768 1.007 [0.999..1.030], every Float32 compilation median <= 1.046; Float64 h768 one compilation
  1.193 (row median 1.00; D16). 1.5.0 read 1.17 (h0) / 1.52 (h768) on the strict host (above). Caller rows (lower of the
  two runs, minimum over both heads): n 120 2.1x (Float32) / 2.2x (Float64), n 512 1.5x / 1.2x faster than the caller
  workaround. RULING (M1 unpark): Q-M1-STRICT = "A Pass on medians" (maintainer, 2026-11-15, AskUserQuestion in the main
  session, after strict-1 drew "C One more strict run" and strict-2 ran): the waiver Q-R3-PARGAP A is LIFTED; 1.5.1
  ships C (fd7af97); docs cite both runs, each claim the lower of the two, with the one slow compilation per run stated.
  Reopen (law 13): copyLast(count) / copyTo above 1.05 on the median of a strict run at h0 or h768 on the pinned engine,
  or test/chainsize.test.js red on it (the chain margin is 1 B).

---

## B. Defects found and fixed

### B1. `copyTo` bounds check passes with a non-numeric `dst.length`

- **What happened.** `copyTo({})` returned 0 on an empty buffer and threw `TypeError: dst.set is not
  a function` on a non-empty one: `dstOffset + count > undefined` is false, so the bound never
  tripped. Found by the 2026-10-14 external-patch audit. Fix: a non-TypedArray `dst` (`null`, plain
  object, `Array`, `Map`, `DataView`, a DataView from another realm) throws `TypeError:
  LiteRingBuffer: copyTo needs a TypedArray dst`; the bound is `!(dstOffset + count <= length)`
  so NaN never passes; `length` is read through the intrinsic TypedArray getter so a subclass that
  overrides `length` cannot widen the bound. Nothing is written in any case.
- **Root cause.** A `>` compare against a non-number is false (fails open); trusting an instance
  `length`.
- **Evidence.** e3e1df1 / 0412025; `CHANGELOG.md` [1.2.0] Fixed and Tests (17 new cases, 42 -> 59,
  including a `Float32Array` subclass whose `length` getter lies, and a `node:vm` DataView);
  `.handoff/HISTORY.md` 2026-10-14 audit burst (3 of the new tests fail on 1.1.0, by design;
  TA_LENGTH-drop mutant fails a gate).
- **Law.** 1, 2, 10.
- **Gate.** `test/RingBuffer.test.js` copyTo cases (59 of count.mjs's 90).

### B2. `getOrDefault` boxed every non-integer sample

- **What happened.** `getOrDefault` delegated to `get`; inlined into a hot loop, `get`'s `number |
  undefined` result boxed every non-integer sample, 16 B per call even with a numeric default. Now
  it bounds-checks itself: with a numeric default every path returns a number, 16 B -> 0 B per call.
  `getOrDefault(i)` with no default still returns `undefined` out of range and still boxes 16 B.
- **Root cause.** A union-typed return across an inlined call boundary; the 1.1.0 zero-allocation
  claim covered the entry, not the path.
- **Evidence.** e3e1df1 / 0412025; `CHANGELOG.md` [1.2.0] Fixed (figures: Node 26.8.2 arm64,
  2026-10-14, `npm run alloc`, 1M calls per window, min over 5 steady-state windows, empty-loop
  baseline subtracted); `.handoff/HISTORY.md`: against 1.1.0 the gate exits 1 on `getOrDefault(i,
  0)`.
- **Law.** 4, 7.
- **Gate.** `test/alloc.mjs` getOrDefault lanes; the docs state every figure assumes V8 inlines
  the call (`--no-turbo-inlining` shows the box).

### B3. `destroy()` widened the `data` field to `Any`

- **What happened.** `destroy()` wrote `null` into `data`, which widened the field's tracked type on
  the shared hidden class from `Float32Array` to `Any` for the rest of the process
  (`--trace-generalization`: `Class;const -> Any;mutable`). It now sets `data` to a shared empty
  `Float32Array` (`const -> mutable` only). **Behavior change:** `push`, `tryPush` and `reset` after
  `destroy()` used to throw `TypeError` on `null`; now they do nothing, and `tryPush(v)` returns
  `true` without storing. SETTLED by the maintainer 2026-10-14: use after `destroy()` is
  cleanup-time misuse; do not reopen.
- **Root cause.** A field store of a different type generalizes the field for every instance of the
  shape.
- **Evidence.** e3e1df1 / 0412025; `CHANGELOG.md` [1.2.0] Fixed; ROADMAP.md "Settled"; `.d.ts`
  `data: Float32Array` is now accurate.
- **Law.** 9.
- **Gate.** `test/RingBuffer.test.js` destroy test (one shared empty `Float32Array`); `test/torture.mjs`
  held-data lane (256 live instances' `data` reclaimed after `destroy()`).

### B4. `copyTo` above 32 samples allocated 104 / 208 B (R1, CLOSED)

- **What happened.** In 1.2.1 `set` + `subarray` allocated one 104 B view per ring half above 32 samples: 104 B
  contiguous, 208 B wrapped; both companions (1024-sample scratch) allocated every frame. R1 (99e8749,
  2026-11-11) made `copyTo` allocate 0 B at every size: full Float32 ring above 32 samples -> ROT (`set` +
  `copyWithin` + a loop over the smaller half), everything else -> the masked scalar loop; `copyToFast` keeps the
  allocating memcpy path. R1b (working tree) added the <= 32 loop router back (Q-R1B-ROUTER, A11 / A12 / D10).
  The cutoff 32 (`COPY_LOOP_MAX`) is nominal. Closed on allocation; the speed trade-off is REPORTED, see Evidence.
- **Root cause.** `TypedArray.set` takes no source offset / length; the only allocation-free bulk copy over a
  ring half is a JS loop, or a view-free `set` of the whole storage plus `copyWithin` (ROT).
- **Evidence.** Before: e3e1df1 / 0412025; `CHANGELOG.md` [1.2.0] Changed; `.handoff/HISTORY.md` 2026-10-14 release
  burst: `copyTo 33 contig 103.8 B/op`, `copyTo 64 wrapped 207.9 B/op` (Node 26.8.2 arm64, load average 4.11, one run).
  The loop-vs-`set` research (2026-11-11, `.handoff/archive/1.5.3/research/r1/`, PRELIMINARY): at 32 samples the loop is
  1.7x-3.9x faster than set + subarray, the Float32 crossover is 64..256 and at 1024 / Float32 the loop costs 4.7x-6.3x
  of set + subarray (QUIET non-strict, 3 compilations x 21 rounds, Apple M4 Pro, Node v26.8.2, load1 1.54..1.73). After:
  99e8749 (R1 build), 5ae2266 (`npm run bench:copyto`), R1b fix in the working tree. Alloc:
  `.handoff/archive/1.3.0/r1b-fix/evidence/burst-verify.log` (`npm run verify`, 2026-11-12, Node v26.8.2, host
  PRELIMINARY load1 4.72 vs baseline 2.21): `copyTo 32 wrapped` 0.2, `copyTo 33 contiguous` 0.0, `copyTo 1024 F32 full
  head 0` 0.1, `start 512` 0.0, `start 768` 0.1, `1023 non-full` 0.0, `1024 -> Float64 contiguous / wrapped` 0.2 / 0.2
  steady-state B/op; `copyToFast 1024` 104.0 / 208.1 B/op (REPORTED); verify exit 0, 130 / 130 tests. Speed
  (STATISTICAL, ONE `quiet-lock run --strict`, exit 0, 2026-11-12T03:00:01Z .. 03:08:19Z, host QUIET load1 2.10 -> 1.36
  vs baseline 2.21, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, K 21 x 3 compilations = 63 paired ratios,
  median [Q1..Q3]; `.handoff/archive/1.3.0/r1b-fix/T5-SUMMARY.md`): R1b / 1.2.1 at 32 samples 1.33-1.38x (10.8 -> 14.8
  ns f32); at 64 0.24-0.67x; at 1024 / f32 contiguous 0.75x, but wrapped 3.10 [2.80..3.16]x (84.0 -> 257.0 ns) and
  partial 3.75 [3.52..3.81]x (83.1 -> 310.1 ns) -- the WORST cells; f64 dst at 1024 0.41-0.61x. Also 256 / f32 wrap
  1.30x, part 1.26x. R1 (99e8749) alone was 2.3-4.0x (R1 B-S2 T5, `.handoff/archive/1.3.0/R1/evidence/S/t5-summary.md`,
  strict, 2026-11-11T07:34Z, QUIET, 2.28-3.98) slower than 1.2.1 at 32 (24.6-43.0 ns in the T5-SUMMARY FC column), which
  R1b cut to ~1.35x.
- **Law.** 5, 7.
- **Gate.** `test/alloc.mjs` copyTo lanes (32 contiguous / wrapped, 32 -> Float64 wrapped, 33, 64, 1024 F32 full
  at three heads, 1023 non-full, 1024 -> Float64 contiguous / wrapped, 8 full wrapped on-heap; < 1 B/op gated);
  `copyToFast` lanes and `copyTo 33 / 64` are REPORTED; `test/torture.mjs` lanes `copyTo 32 ...` and `copyTo 1024
  F32, start walks 0..1023`. Speed: `npm run bench:copyto` by hand, strict (C13 / D8).

### B5. README: "Each stage holds zero allocation in steady state" was false (CLOSED by R1)

- **What happened.** The README Companion libraries / Ecosystem diagram said the pipeline stages hold zero
  allocation in steady state. `lite-stats-math` (`compute`, `quantile`) and `lite-canvas-graph` (`render`) call
  `copyTo` with a capacity-sized scratch, so once the ring held more than 32 samples each call allocated 104 B
  contiguous or 208 B wrapped. Found 2026-10-14 (the audit left it "unchecked", then the ROADMAP R1 finding
  checked the callers); 1.2.0 made the README say so. R1 (99e8749) removed the allocation: 1024-sample
  `copyTo` reads 0.0-0.2 B/op in the closing verify (B4 Evidence), so the stage claim is true for the
  `copyTo` call path again; the README states it (docs batch B4).
- **Root cause.** A claim written about the ring's entry points, not about how the callers use it.
- **Evidence.** 0412025; `CHANGELOG.md` [1.2.0] Docs; ROADMAP.md R1 (callers at
  `LiteStatsMath/StatsMath.js:59,103`, `LiteCanvasGraph/CanvasGraph.js:157`); 99e8749; B4 Evidence.
- **Law.** 7.
- **Gate.** `test/alloc.mjs` copyTo 1024 lanes (B4); the README line is a reviewer doc-truth check.

### B6. Docs: `get(i)` listed as allocation-free; `ceilPow2` domain undocumented

- **What happened.** README, llms.txt and `.d.ts` listed `get(i)` among the zero-allocation methods;
  it allocates 16 B per call on non-integer samples. They now point hot loops at `getOrDefault(i,
  0)`, and state that every figure assumes V8 inlines the call. `ceilPow2` documents its behavior
  outside `[1, 2^32]` (not validated: `ceilPow2(1.5) === 1`; `0 < n < 1`, `NaN`, `+/-Infinity` give
  1; finite `n <= 0` gives 2^32; `n > 2^32` wraps, `ceilPow2(2 ** 32 + 1) === 1`).
- **Root cause.** Claims not checked against a per-method allocation gate.
- **Evidence.** 0412025; `CHANGELOG.md` [1.2.0] Docs and Tests (a `ceilPow2` outside-domain case).
- **Law.** 7.
- **Gate.** `test/alloc.mjs` `CONTROL get(i)` (reads 16 B, must); `ceilPow2` case in
  `test/RingBuffer.test.js`.

### B7. `copyTo` into a dst sharing the ring's buffer silently corrupted a wrapped ring (R1 / R1b)

- **What happened.** In 1.2.1 a `dst` viewing `rb.data.buffer` was accepted: each `set` is overlap-safe alone,
  but the second half reads storage the first half overwrote, and the <= 32 loop corrupts too. Probe on the
  frozen build (dst = `new Float32Array(rb.data.buffer)`, capacity 64 full): head 32 -> 32 of 64 slots wrong,
  head 16 -> 16 wrong, contiguous -> 0 wrong. R1 (99e8749): `copyTo` and `copyToFast` read `dst`'s buffer through
  the intrinsic `%TypedArray%.prototype.buffer` getter and throw `RangeError` before the first store when it is
  the ring's buffer. It stays closed after `rb.data` is reassigned: R1b's identity-keyed buffer cache re-reads the
  getter whenever `rb.data` is not the cached array (A1a: `data` replaced by a view of `dst` -> RangeError on 3
  calls in a row, `dst` unchanged; A1b: `data` replaced by an Array -> TypeError on each of 3 calls, `dst`
  untouched). The research-timed build 54279dbe wrote the cache key BEFORE the getter read, so after a failed
  read the next call skipped the check: a fail-open caught in the R1b research review (fixed in b93aab2c).
- **Root cause.** A bulk copy over two halves of one storage with no overlap check; then a cache keyed before it
  was validated (law 2).
- **Evidence.** `.handoff/archive/1.5.3/PROPOSAL-r1.md` Q-R1-ALIAS (`research/r1/runs/controls/review/alias-check.mjs` +
  `.log`); 99e8749; `.handoff/HISTORY.md` R1b research pass (54279dbe archived in
  `.handoff/archive/1.5.3/research/r1b/variants/archive/`); `test/copyto-r1b.test.js` (A1a / A1b are regression pins on
  the frozen before build; the 54279dbe build fails A1b, `tap-FAILOPEN.tap`);
  `.handoff/archive/1.3.0/r1b-fix/evidence/tap-FAILOPEN.tap`.
- **Law.** 1, 2.
- **Gate.** `test/copyto-r1b.test.js` A1a / A1b; the R1 alias cases in `test/copyto.test.js`; Q-R1-ALIAS ruling
  (RangeError, Q-F1: `copyToFast` too). Cost: an aliasing call that was correct in 1.2.1 (a contiguous ring,
  non-overlapping view) now throws.

### B8. `copyTo` boxed every sample once the process had copied into more than 4 dst kinds (O6 = F1, audit 2026-11-12)

- **What happened.** The dual blind audit (2026-11-12) found that `copyTo`'s one masked-loop store site went
  megamorphic once the process had copied into more than 4 distinct dst hidden classes, and then boxed every
  non-integer sample: one 16 B HeapNumber each, about 16 KB per 1000-sample call (R1b build 63eb5bc1, which
  documented "0 B at every size"). The alloc gate saw only 1-2 dst kinds. Fix (unit 1, ruling Q-AUD-1,
  commit f66972c, build c450e686): one store site per dst family (Float32Array: `rotCopy` for a full ring above
  32 samples, else its own loop; Float64Array; every other kind); bytecode copyTo 189 -> 288 B, copyCheck 191 ->
  257 B, rotCopy 192 B, all under the 460 B inline limit (D9 / D10). Residual, documented as such: 5 or more
  classes of ONE element type (e.g. Float32Array subclasses) still box; `copyToFast` is unaffected. Docs now
  scope every "allocates nothing" for `copyTo` to "at most 4 dst hidden classes per store site, Node 26.8.2 arm64".
- **Root cause.** One keyed-store site shared by every dst kind; an IC site has a polymorphism budget of 4 maps and
  a megamorphic keyed store boxes a double (zero-box law; law 7: a doc claim about allocation is a claim about
  every caller path). The gate exercised too few dst kinds to see it (law 1).
- **Evidence.** `audit/2026-11-12/TRIAGE.md` (O6 = F1, Q-AUD-1), `audit/2026-11-12/fable-5.2_FINDINGS.md` F1,
  `audit/2026-11-12/opus-5.5_FINDINGS.md` O6; frozen before 63eb5bc1 (`.handoff/archive/1.3.0/audit-fix/frozen/`), after
  c450e686 (commit f66972c). `npm run alloc` MEGA lanes, B/op (net of baseline;
  `.handoff/archive/1.3.0/audit-fix/evidence/r2-alloc-new.log` / `r2-alloc-frozen.log`, 2026-11-12, Node v26.8.2 arm64,
  load1 2.79 per `r2-alloc-provenance.log`, one run each): new -0.1..0.2 on the gated lanes vs 511.9 / 16368.1 / 16384.1
  on 63eb5bc1; the Int16 'mega' control 512.0; the Float32-subclass residual 512.0 (REPORTED, not gated).
  `.handoff/archive/1.3.0/audit-fix/U3-SUMMARY.md` (2026-11-12, Node v26.8.2, Apple M4 Pro, QUIET, `--strict`): torture
  exit 0; inline-diff 63eb5bc1 vs c450e686 SAME with 3/3 controls DIFF; T5 fix cost vs 63eb5bc1 a TIE in 30/30 configs,
  medians 0.99-1.11x (K=21 rounds x 3 compilations; STATISTICAL, local).
  `.handoff/archive/1.3.0/audit-fix/review-u1-r1.md`: round 1 REJECTED (4 LITERAL), two of them teeth gaps: the Float32
  / Float64 split was ungated (surviving mutant M5: one loop shared by both) and the pollution was not proven in-run
  (reordered pollution; no proof the site went megamorphic). Fixed: 3 Float64Array subclasses in the pollution,
  pollution at the first MEGA lane inside the run loop, and the Int16 lane became a must-allocate 'mega' control (>= 256
  B/op). Review r1 mutants caught: M1 M2 M3 M4 M6 M8 M10 M12; M13 equivalent.
- **Law.** 1, 3, 4, 7 (and zero-box).
- **Gate.** `test/alloc.mjs` MEGA lanes (`MEGA 32 F32, wrapped`, `MEGA 1023 F32, non-full`, `MEGA 1024 ->
  Float64Array, wrapped`, `MEGA 1024 F32, full, start 768`, and the `MEGA 32 -> Int16Array, wrapped` 'mega'
  must-allocate control; the self-check orders them last). Re-opens if a fourth store site is needed, if
  copyTo / copyCheck bytecode passes 460 B, or if a fix for the 5+ same-element-type residual is proposed: it
  must clear every MEGA lane, `inline-diff` and T5.

### B9. `copyTo` trusted `data.length === capacity`; a frozen ring threw (O1 + F5 + O2, audit 2026-11-12)

- **What happened.** O1: ring storage detached (e.g. `rb.data.buffer` transferred to a Worker) made `copyTo` write
  NaN for every sample and return `count` (1.2.1 threw a TypeError above 32 samples). F5: a longer replaced
  `data` made the rotate write past `count`. O2: a frozen / sealed ring made `copyTo` / `copyToFast` throw
  "Cannot assign to read only property '_buf'" because the buffer cache write was unconditional (1.2.1 copied).
  Fix (unit 1, ruling Q-AUD-2, f66972c): `copyCheck` throws a RangeError ("storage holds N slots, capacity ...")
  when count > 0 and `data` does not hold exactly `capacity` slots (read through the intrinsic `length`);
  `copyToFast` on detached storage is that RangeError, not a V8 TypeError; the cache is not stored on a
  non-extensible ring (the array cached before the lock stays referenced until `destroy()`, or for the ring's
  lifetime when frozen). Check order: TypeError, bounds RangeError, return 0 on empty, alias RangeError, storage
  RangeError, first store. Review nit M7 (`data.length` instead of the intrinsic) was pinned in unit 2.
- **Root cause.** A fail-open: the loop trusted an invariant (`data.length === capacity`) nothing re-verified
  (law 2); a cache write placed before the guard that could refuse it.
- **Evidence.** `audit/2026-11-12/TRIAGE.md` (O1 + F5, O2, Q-AUD-2); both FINDINGS files; build 63eb5bc1 ->
  c450e686 (commit f66972c); `.handoff/archive/1.3.0/audit-fix/review-u1-r1.md`.
- **Law.** 1, 2.
- **Gate.** `test/audit-fix.test.js` (storage RangeError, detached `copyToFast`, frozen / sealed ring cases) and
  `test/mutant-kills.test.js` (M7 pin). Re-opens if `data` is allowed to be anything other than a Float32Array of
  exactly `capacity` slots, or if the cache write moves before the checks.
- **R2 note.** `pushBatch` shares the storage rule (RangeError when `data` is not `capacity` slots) and adds the
  element-type check (B10). A frozen ring differs from `copyTo`: `pushBatch` is head-first and throws TypeError with
  nothing written; `copyTo` copies.

### B10. `pushBatch` threw after its head write on a capacity-length non-Float32 `data` (R2 build B1 review)

- **What happened.** In build d4445574 a `data` replaced by `BigInt64Array(capacity)` passed `batchCheck`; `head`
  went 2 -> 7 and `count` 3 -> 8, then the first store threw: a torn state (set path, `loopF32` and `loopF64` alike).
  The fix's own review (r1) then found the oracle did not pin the INTRINSIC tag: `instanceof`, prototype-tag and
  `constructor` mutants of the check all passed; +3 tests.
- **Root cause.** The storage check verified length only, not element type; the head-first order of Q-R2-FROZEN
  turned any later store throw into a torn state (law 2). The first oracle did not distinguish the intrinsic tag
  from spoofable ones (law 1).
- **Fix.** Q-R2-DATA: an intrinsic `Symbol.toStringTag` check of `data` on every call (count > 0), before the alias
  cache is read or written (ff6ee762). Residual per Q-R2-TAMPER: per-property tampering (a non-writable `count`
  alone, accessors on `head` / `count` / `data`) is unsupported and may leave `head` written, as with `push`.
- **Evidence.** d4445574 (rejected build), ff6ee762 (fixed build); `.handoff/archive/1.4.0/R2/frozen-b1/`,
  `.handoff/archive/1.4.0/R2/b1fix/`, `.handoff/archive/1.4.0/R2/review-b1fix/`.
- **Law.** 1, 2.
- **Gate.** `test/pushbatch.test.js`, describe "replaced storage element type (Q-R2-DATA)" (28 tests). Re-opens if
  `data` may be anything but a Float32Array of `capacity` slots.

### B11. copyLast's own-store-site budget claim was false for the whole-window Float32 path (rotCopy shared with copyTo)

- **What happened.** The R3 proposal (section 2) and the first build's JSDoc said copyLast's three store sites are its
  own, so copyLast and copyTo each have their own 4-class budget. Caught by the R3 build review, round 1: the
  whole-window Float32 path (full ring copied whole, capacity > 32) calls `copyTo`'s `rotCopy`, whose scalar loop is one
  store site shared with `copyTo`. A reviewer probe (unlogged, so no figure is quoted here: law 5) saw that path
  allocate after `copyTo` ROT with 4 Float32Array subclasses.
- **Root cause.** The claim was written from the design (copyLast has its own bodies) without checking which store
  sites its ROT branch reaches (law 7: a doc claim about allocation is a claim about every caller path).
- **Fix.** Docs carry the exception: `RingBuffer.js` JSDoc, `RingBuffer.d.ts`, README (Bulk copy allocation paragraph,
  API row, hot-path bullet), `llms.txt`, CHANGELOG: every Float32 `dst` class either method passes through `rotCopy`
  counts against one 4-class budget. A `rotCopy` clone for copyLast would be a DESIGN change, not proposed; unpark
  only on a measured MEGA ROT need (a caller whose Float32 `dst` classes exceed the shared budget on a whole-window
  path).
- **Evidence.** `.handoff/archive/1.5.0/R3/PLAN-G1.md` addendum A6 (review r1 REJECTED, 3 LITERAL); build 9765c21e
  (working tree on 4b471da) carries the doc fix; the probe has no run log, so this entry quotes no measurement.
- **Law.** 7.
- **Gate.** None for the shared budget itself (documented, not gated: the `npm run alloc` MEGA lanes gate the per-family
  split of copyLast's own sites). Reopen the design only with a measured MEGA ROT need that clears copyTo's
  byte-identical gates.

### B12. README claimed `& mask` is roughly 3-5x cheaper than `%` with no source

- **What happened.** The README said the `& mask` wrap-around "on V8 is roughly 3-5x cheaper in tight loops" with no run
  log (law 5). B1 measured it (`wrap-step n1024`, `wrap-push n1024`; REPORTED): `% capacity` costs 1.784x [1.759..1.829]
  the `& mask` step at the same power-of-two capacity (1024) and 5.630x [5.583..5.799] at a non-power-of-two capacity
  (1023); inside a hand-rolled Float32Array push 1.057x [1.042..1.203] and 3.204x [3.186..3.249]. Only against a
  non-power-of-two `%` does the measured gap reach the claimed band (3.204x inside a push, 5.630x per step); at the same
  power-of-two capacity it is 1.784x per step and 1.057x inside a push.
- **Root cause.** An estimate written as a measurement.
- **Evidence.** `.handoff/archive/1.5.3/B1/strict-1/compare.md` (one strict QUIET run, 2026-11-15T17:21Z, Apple M4 Pro,
  Node v26.8.2, load1 2.62 at start / 1.68 at end, K 21 x 3 compilations, HEAD 6431ec9, RingBuffer.js 90f7ad7c); README
  before the fix: `.handoff/archive/1.5.3/B1/frozen/README.md` 829475e5 (= `git show 6431ec9:README.md`).
- **Law.** 5.
- **Gate.** None (REPORTED). `npm run bench:compare` prints the QUOTE-OP / QUOTE-PUSH lines.

### B13. The "checks use ..." out-of-contract lists named only some call-time lookups

- **What happened.** The post-1.5.3 fillers unit-2 review found that the out-of-contract lists for `copyLast` (README
  copyLast row, llms.txt copyLast bullet, `RingBuffer.d.ts`) named only `ArrayBuffer.isView`, `Number.isInteger`,
  `DataView` and the length getter's `call`. The check helpers also resolve, at call time, the `buffer` getter's
  `call`, the global `Object.isExtensible` (alias-cache miss) and, in `copyTo` / `copyLast` / `pushBatch`, the
  `Symbol.toStringTag` getter's `call`; the Fast methods also look up `Math.min` and `data.subarray`. The reviewer's
  probes ran user code in `copyLast`, `copyLastFast` and `copyTo` outside the `DataView` window with the error
  unchanged. `copyTo`, `copyToFast` and `pushBatch` had no such note at all.
- **Root cause.** A list written from the first intrinsics found read as exhaustive; no one swept the helpers
  (`copyCheck`, `batchCheck`, `lastCheck`, the cold error builders) for every call-time lookup.
- **Fix.** One package-wide note (README Edge cases "Call-time lookups", llms.txt, the `RingBuffer.d.ts` class JSDoc,
  matching `RingBuffer.js` comments) covering all five bulk methods: what is captured at load (a guarantee) and what
  resolves at call time (out of contract if replaced); the three existing lists now name every builtin the checks
  consult and point to the note for the full set.
- **Evidence.** `.handoff/HISTORY.md` (post-1.5.3 FILLERS NEXT, DESIGN follow-up); frozen source
  `.handoff/archive/1.5.5/frozen/f0c691a/RingBuffer.js`; build 414bba0d (working tree on f0c691a).
  The probes have no committed log, so this entry quotes no measurement.
- **Law.** 7 (generalized by this entry, maintainer ruling 2026-11-15: generalize law 7).
- **Gate.** None (doc text; reviewer).

---

## C. Gate evolution (gates that had to be given teeth)

### C1. `node --test test/*.test.js` failed OPEN

- **What happened.** On Node >= 22 a zero-match glob prints `tests 0` and exits 0; an explicit
  missing path exits 1. A reviewer (unit D, batch B1) returned a DESIGN REJECT; the planner delta
  D-A2 names the file: `node --expose-gc --test test/RingBuffer.test.js`.
- **Root cause.** The harness, not the code, failed open on "nothing ran".
- **Evidence.** 1d6e368; `.handoff/archive/1.2.1/D/PLAN.md` addendum D-A2; `.handoff/archive/1.2.1/D/b1/ctl-missing`
  (missing path exits non-zero, "Could not find") and `.handoff/archive/1.2.1/D/b1/ctl-oldglob` (empty dir + glob exits
  0, tests 0); exit codes also in `.handoff/archive/1.2.1/D/b1/evidence.txt`.
- **Law.** 1, 2.
- **Gate.** Superseded by C5 / C6 (`test/count.mjs`).

### C2. The vitest heap smoke test returned silently without `global.gc`

- **What happened.** The 1M-push heap smoke test returned early when `global.gc` was missing, so a
  run without `--expose-gc` passed. It now asserts `typeof globalThis.gc === 'function'` (fails,
  not skips); `npm test` passes `--expose-gc`.
- **Root cause.** A skip path that reads as a pass.
- **Evidence.** 1d6e368; `.handoff/archive/1.2.1/D/b2/no-expose-gc-control.txt`; `.handoff/archive/1.2.1/D/PLAN.md`
  addendum D-A1 (141 assertion sites = 140 one-for-one + 1 fail-closed gc assert).
- **Law.** 1, 2.
- **Gate.** `test/RingBuffer.test.js` heap smoke test.

### C3. `test/ascii.mjs` v1 skipped missing paths and could not see U+0080..U+00FF

- **What happened.** v1 skipped missing `files[]` paths, glob entries and a missing `files[]`
  (reported clean), threw exit 1 instead of 2 on an unreadable file, and its self-control could not
  see U+0080..U+00FF: a mutant `cp > 0xFF` passed the live tree and dropped the frozen findings 45
  -> 37. Fixed in the B4 fix round: exit 2 on each of those cases; the self-control probes U+2014,
  U+00A9, U+0080, U+1F600 as 4 code points and must pass U+00D7 and U+00B5; it also catches a
  UTF-16-unit iterator.
- **Root cause.** A scanner whose own check had a blind range.
- **Evidence.** 1d6e368; `.handoff/archive/1.2.1/D/b4/proofs.log` (exit 2 cases, "self-control FAILED (must flag
  U+2014, U+00A9, U+0080, U+1F600 as 4 code points ...)"); `.handoff/HISTORY.md` ("ascii: live 0,
  frozen 45"). b6a8310 flattened the self-control to flat module code (output unchanged).
- **Law.** 1, 2.
- **Gate.** `test/ascii.mjs` self-control; `npm run ascii`.

### C4. GC-count gates have a resolution

- **What happened.** The reviewer's mutant M-rare (about 0.8 B/op net) passed torture (reviewer / coder report recorded
  in `.handoff/archive/1.5.3/reviews/2026-11-10-findings.md`; no run log on disk; no host / load stated);
  `test/alloc.mjs` caught it (`copyTo` 32 contiguous at 15.8 B/op). So torture `minor 0` proves "less than res B/op",
  not "0 B/op". Torture prints `res=` (CONTROL lane B/op divided by its minor-GC count); docs state no value, only that
  it is nominal and depends on V8 new-space size.
- **Root cause.** A GC count is a threshold on bytes, and the threshold is the new-space size.
- **Evidence.** 1d6e368 / b6a8310; `test/torture.mjs` header (res= definition); `CHANGELOG.md` [Unreleased] Tests;
  M-rare run: `.handoff/archive/1.5.3/reviews/2026-11-10-findings.md` (D B2+B3 reviewer: a box on copyTo's start===0
  branch printed GATE ok in torture; alloc.mjs exit 1; reviewer scratch mutant not kept).
- **Law.** 3.
- **Gate.** `test/alloc.mjs` is the per-op byte gate; torture `res=` is printed, never gated.

### C5. An emptied or skipped test file still passed `npm test`

- **What happened.** After C1, an emptied test file still passed: plain `node --test` counted the file itself as one
  passing test (`tests 1`, `pass 1`, exit 0); it also passed a skip file. Ruling R-2 (unit D2): `npm test` = `node
  test/count.mjs` (node:test `run()` over the explicit `FILES`, `--expose-gc`), exact `EXPECTED = 59`, 0 fail, 0 skip /
  todo, no failed suite, no empty file. Lost: `--test-name-pattern` passthrough.
- **Root cause.** The count was held by hand in qa, not by the gate.
- **Evidence.** b6a8310; `.handoff/archive/1.2.1/D2/PLAN.md` R-2;
  `.handoff/archive/1.2.1/D2/evidence/a2-old-plain-empty.txt`, `a2-old-plain-skip.txt`, `a2-mut-*.txt`;
  `.handoff/archive/1.2.1/D2/qa/q2-mut-*.txt` (qa re-run).
- **Law.** 1, 11.
- **Gate.** `test/count.mjs`. Open FILLER: it passes no `run()` timeout, so a never-settling test
  hangs the gate (ROADMAP D2 FILLER).

### C6. `count.mjs` v1 dropped per-file summary events

- **What happened.** A 60th test calling `process.exit(0)` after 400 ms gave `pass 59/59`, exit 0 (4 of 4 runs on the v1
  gate (reviewer / coder report recorded in `.handoff/archive/1.5.3/reviews/2026-11-10-findings.md`; no run log on disk;
  no host / load stated)). Fix: count file summaries and require them to equal `files.length`. With the fix the same
  mutant exits 1 (3 of 3 runs); without it exit 0 (3 of 3).
- **Root cause.** The gate tallied `test:pass` events and ignored that a file can die before its
  summary.
- **Evidence.** b6a8310; `.handoff/archive/1.2.1/D2/evidence/fix1-dexit-fixed-run1..3.txt` ("count: file summary events:
  0 (want 1)", `exit=1`) and `fix1-dexit-prefix1-run1..3.txt` (`pass 59/59`, `exit=0`); the v1 "4 of 4 runs" figure (a
  60th test exiting after 400 ms, 1 summary event instead of 2): `.handoff/archive/1.5.3/reviews/2026-11-10-findings.md`
  (D2 B1 reviewer round 1).
- **Law.** 1, 2, 11.
- **Gate.** `test/count.mjs` file-summary count. Its must-fail controls are scratch only, not committed:
  `.handoff/archive/1.2.1/D2/mut/*.test.js`, logs `.handoff/archive/1.2.1/D2/evidence/fix1-mut-*.txt` (gitignored).

### C7. Torture retention `trackedMid >= 1` had no teeth

- **What happened.** A half-tracking mutant (2048 of 4096 instances) passed the 1d6e368 harness. Now
  `trackedMid === CYCLES`; message `retention: tracked N of 4096 mid-run (want exact)`.
- **Root cause.** A lower bound of 1 lets a tracker miss almost everything while `live=0` still
  reads clean.
- **Evidence.** b6a8310; `.handoff/archive/1.2.1/D2/evidence/a4-torture-halftrack.txt` (`trackedMid=2048`,
  `exit=1`) and `a4-torture-frozen-halftrack.txt` (old harness); `.handoff/archive/1.2.1/D2/qa/
  q3-torture-batch.txt`.
- **Law.** 1.
- **Gate.** `test/torture.mjs` retention check.

### C8. The alloc gate (e3e1df1) needed NaN-safety and known-size controls

- **What happened.** The external audit patch shipped a `heapUsed`-delta allocation test; the old
  allocating `copyTo` (19 MB over 100k calls) read 0.96 MB, under its 1 MB bound. The replacement
  `test/alloc.mjs` uses V8 `total_allocated_bytes`, two control lanes of known size (`get(i)` one
  bare 16 B box, a 104 B `subarray` view) that must read their size, an empty-loop baseline bounded
  to +/-1 B, and every comparison fails on NaN. A reviewer found a NaN counter passed the first
  gate. A NaN-counter mutant, a TA_LENGTH-drop mutant and a mistyped lane label each fail a gate.
  Against 1.1.0 it exits 1 (4 FAIL lanes at the 1.2.0 release run).
- **Root cause.** A bound compared with `<` passes on NaN; a gate with no known-size control cannot
  show it can see allocation.
- **Evidence.** e3e1df1 / 0412025; `test/alloc.mjs` header; memory note
  `alloc-gate-total-allocated-bytes` (noise under 0.3 B/op; original note 2026-10-14);
  `.handoff/HISTORY.md` 2026-10-14 bursts (Node 26.8.2 arm64, load average 4.11, one revert-check
  run).
- **Law.** 1, 2, 4.
- **Gate.** `test/alloc.mjs` (17 lanes at the unit D closing run (`.handoff/archive/1.2.1/D/verify/verify.log`,
  2026-11-10 07:17Z, host PRELIMINARY load1 5.14 vs baseline 2.21, Node v26.8.2)).

### C9. A docs status line claimed a verify that did not exist on the final tree

- **What happened.** A unit D2 docs draft said "closing verify PRELIMINARY" for a verify that had
  hit a BUSY lock, ran unlocked and predated the final code; the reviewer REJECTED it (doc truth).
  The final ROADMAP line names the run: closing `npm run verify` under the quiet lock 2026-11-10
  07:50Z exit 0, host PRELIMINARY (load1 3.63 vs baseline 2.21), Node v26.8.2.
- **Root cause.** A status line written from the plan, not from a log.
- **Evidence.** b6a8310; ROADMAP.md D2 STATUS; `.handoff/archive/1.2.1/D2/qa/q7-verify.txt` (`verify_lock_run_exit=0`,
  "host PRELIMINARY (load1 3.63, baseline 2.21, 12 cores ...)"). The REJECT:
  `.handoff/archive/1.5.3/reviews/2026-11-10-findings.md` (D2 B2 reviewer: the only D2 verify, 07:24Z, hit a BUSY lock,
  ran unlocked at load1 31.53 and predated the count.mjs fix; line set to PENDING until qa's 07:50Z locked run).
- **Law.** 5, 6.
- **Gate.** Reviewer doc-truth check; no automation.

### C10. The inlining by-hand release check: `npm run inline-diff` and its tool tests (unit LU)

- **What happened.** The zero-allocation numbers need V8 to inline the call (B2), but nothing checked that a change to
  `RingBuffer.js` kept it inlinable. Unit LU vendored `test/tools/inlining-budget-diff.sh` (byte-identical to
  unpublished `@zakkster/lite-utils` commit 465881b, sha256 f13f33c2..., 1530 lines; pinned by sha in
  `test/InliningTool.test.js`; never edited here) and wrote `test/tools/inline-diff.mjs`. It stages before = `git show
  HEAD:RingBuffer.js`, after = the working-tree file, and three must-fail controls (copies of after whose
  `getOrDefault`, `peekNewest` or `peekOldest` is padded with a never-taken branch past V8's default 460-byte
  max-inlined-bytecode-size; bytecode 66 -> 724, 39 -> 697, 44 -> 702 on Node v26.8.2
  (`.handoff/archive/1.3.0/LU/evidence/bytecode.log`)), then runs the script with `--fn
  getOrDefault,peekNewest,peekOldest` on turbo and maglev. Exit 0 = A/A SAME and every control DIFF naming only its own
  function in every tier; 1 = A/A DIFF or a blind control; 2 = NO-VERDICT.
- **Root cause.** An inlining regression is invisible to the correctness suite, and a diff tool that has never
  been shown a DIFF cannot be trusted to report one.
- **Evidence.** `.handoff/archive/1.3.0/LU/evidence/census.log` (2026-11-11 ~01:02Z, Node v26.8.2 arm64, HEAD 27a8326,
  host QUIET at start, load1 2.72 vs baseline 2.21, tool e1e63ad8: 5 full runs exit 0, A/A SAME 5/5, each control DIFF
  5/5 on its own fn, ~7 s per run; REPORTED; and 1 run of the shipped tool 3fae616d, exit 0, host PRELIMINARY load1
  3.78, `.handoff/archive/1.3.0/LU/evidence/fix-run.log`; REPORTED). Cross-oracle: on the getOrDefault control `node
  --expose-gc test/alloc.mjs <control>` reads `getOrDefault(i, 0)` 16.0 B/op and exits 1.
  `.handoff/archive/1.3.0/LU/PLAN.md` OQ-1..4 rulings.
- **Law.** 1, 2, 11.
- **Gate.** Tier (ruling OQ-1): REPORTED, by hand under the quiet lock before each /release and in every unit touching
  `RingBuffer.js`; not in `verify`. Deterministic part, in `npm test` (90 = 59 + 31): the sha pin and its teeth, the
  script's `--self-test` (89 checks), five script mutants red (sort -u, elif false, guard off, kConcurrent c=0, always
  SAME), and 14 MUST-COVER `inline-diff.mjs` rows (1-13 plus 8b; the run rows against a stub script, 6 and 12 by
  `--stage-only` on the real tree); a missing bash / git / node fails red (OQ-4), no skip, no real A/A verdict there
  (OQ-1). Open FILLER (LiteUtils): script mutant m4 (null-control cmp off) survives every deterministic row. Since LU2
  (C15): the script comes from the pinned devDependency `@zakkster/lite-utils` 1.0.0 (the vendored copy is deleted),
  `--self-test` is 92 checks, six script mutants are red (m4 `if false && ! cmp -s` added), and the m4 FILLER is CLOSED
  (lite-utils 1.0.0 null-control rows kill it).

### C11. Review-caught teeth defects in the inlining gate (unit LU)

- **What happened.** (1) B1 review: a padded control that DIFFed on only one tier passed (`found.some`);
  fixed to require every tier. A missing tier diff file read exit 1 instead of 2; now NO-VERDICT.
  (2) B2: a full real-V8 verdict row had been put inside `npm test` against ruling OQ-1 (brief error,
  removed before review); the tmp-leak row compared a whole-host tmpdir listing (a law 12 instance: now
  a scoped TMPDIR); the hang row depended on host speed (now a first-call hang plus a 3 s cap). (3) B2
  review: the driver-exit row's regex also matched the echo mutant m6 (die -> echo); anchored to die()'s
  prefix, so m6 is caught by the real-V8 driver-exit row.
- **Root cause.** An any-of check where the contract was all-of; a missing output mapped to the wrong exit;
  a whole-host listing as a scope; a timing-dependent row; a regex looser than the failure it names.
- **Evidence.** `.handoff/archive/1.3.0/LU/review-b1.md`, `.handoff/archive/1.3.0/LU/review-b2.md`,
  `.handoff/archive/1.3.0/LU/evidence/b2-m6-bothways.log`, `.handoff/archive/1.3.0/LU/evidence/failclosed.log`.
- **Law.** 1, 2, 12.
- **Gate.** `test/InliningTool.test.js` (every-tier control row, missing-tier-file row, scoped-TMPDIR
  row, first-call hang row, anchored driver-exit row).

### C12. Torture `n/a` rows failed open (review-caught, R1 build unit B2)

- **What happened.** B2 added the `copyToFast` lane to `test/torture.mjs` and made a lane `n/a` when the method
  is missing on an explicit (older) build. Review round 1 (REJECTED, 2 LITERAL) found that an unmeasured gated
  row printed `n/a` in its verdict column while the GATE line still read `ok`, and that the GC-count resolution
  (`res=`) was stated without the per-lane B/op it resolves. Round 2 REJECTED once more (1 line: a null-report
  guard hid the blind-control message); a literal-only fix followed and round 3 APPROVED. Now an unmeasured
  gated lane is reported on stderr (`lane "<name>" not measured (method missing on this build)`) and fails the
  GATE; `res=` prints `n/a` only when minor is 0 or NaN, with every lane's alloc B/op in its own column.
- **Root cause.** A gate that renders "not measured" as a printable value instead of a failure (law 2). Residual
  nit (FILLER): an unmeasured gated row's verdict column still prints `n/a`, not `FAIL`; the GATE line is the
  fail.
- **Evidence.** 99e8749; `.handoff/HISTORY.md` R1 build burst 1 (engine unit, B2 rounds);
  `.handoff/archive/1.3.0/R1/evidence/E/ b2-failclosed.log`, `b2-fix-checks.log`. The reviewer text is not on disk as a
  file (reviewer text not on disk; HISTORY.md:164-166).
- **Law.** 1, 2, 3.
- **Gate.** `test/torture.mjs` (`not measured` branch and the `res=` line);
  `.handoff/archive/1.3.0/R1/evidence/E/b2-revert-torture.log`.

### C13. Bench: a NaN BEFORE / FAST round failed open (review-caught, B-S1)

- **What happened.** `test/bench/copyto-ab.mjs` review round 1 (REJECTED, 2 LITERAL + 1 DESIGN): a NaN BEFORE (or
  FAST, with `--fast`) timing made the CAND_BEFORE / FAST_BEFORE / CAND_FAST statistics NaN; the row printed
  `n/a` but the run exited 0 "STATISTICAL (QUIET host, all checks ok)". The `q()` NaN guard also had no teeth.
  Fix: `if (!(st[k].q1 <= st[k].q3)) v.push(k + ' not measured (NaN)')` for those keys, with the self-test rows
  `BEFORE NaN round -> 1` and `FAST NaN round -> 1` (AA and SLOW NaN rounds -> 2 already). Round 2 APPROVED
  (copyto-ab.mjs 483fa10e, self-test 52 / 52). The DESIGN item (retain on signal) was ruled "Known limit,
  FILLER" by the maintainer (PLAN-S ADDENDUM A2).
- **Root cause.** A comparison written positively (`x <= y` pushes nothing on NaN) on a statistic the judge must
  fail closed on (law 1).
- **Evidence.** B-S1 commit 5ae2266; `.handoff/archive/1.3.0/R1/evidence/S/review-bs1-r1.md`; `.handoff/HISTORY.md` R1
  build burst 2.
- **Law.** 1, 2.
- **Gate.** `test/bench/copyto-ab.mjs --self-test` (the two NaN-round rows; run by hand, 52 / 52 at approval).

### C14. 13 engine mutants (F4's 12, O4 among them, + review M7) survived every test (F4 / O4, audit 2026-11-12)

- **What happened.** Fable's F4 hand-built 12 engine mutants (e.g. `isEmpty`, `isFull`, peek-on-empty NaN,
  `tryPush({})`, `copyToFast` default offset, capacity 0.5, the rotate branch choice) that passed all 99 engine
  tests; Opus's O4 (`!options.overwrite`, which makes `tryPush(v, {})` refuse) is one of them, and review nit M7
  (`data.length` instead of the intrinsic length) survived too. Unit 2 (ruling Q-AUD-4, commit 114af66) added
  `test/mutant-kills.test.js` (8 tests); 13 of 13 mutants are killed, each by a test that fails on the mutated
  engine.
- **Root cause.** Tests asserted the behavior the author had in mind, not every observable contract of the
  small methods; no mutation pass had ever been run over the engine (law 1).
- **Evidence.** `audit/2026-11-12/TRIAGE.md` (O4 + F4, Q-AUD-4); `audit/2026-11-12/fable-5.2_FINDINGS.md` F4 and
  `fable-5.2_reproductions.mjs`; `audit/2026-11-12/opus-5.5_FINDINGS.md` O4. The audit itself: dual blind audit,
  2026-11-12, Opus 5.5 (high) and Fable 5.2 (xhigh), TRIAGE and rulings Q-AUD-1..4 in
  `audit/2026-11-12/TRIAGE.md`; audited build 63eb5bc1, fixed build c450e686.
- **Law.** 1.
- **Gate.** `test/mutant-kills.test.js` (13 mutants, 8 tests; counted by `test/count.mjs`). Re-opens if any
  engine method gains a branch with no test that fails when that branch is mutated.
- **R3 addition (2026-11-15).** The R3 mutant set (24 mutants, `.handoff/archive/1.5.0/R3/mutants/`, `run.log`: every
  one fails at least one test, or the alloc / torture lane for the two lane mutants) all die, M7 included: M7 is NOT
  equivalent under the literal-0 return (on a non-empty ring n = -0 gives k = -0; without `if (k === 0) return 0;`
  copyLast returns -0, killed by `test/copylast.test.js`). `test/mutant-kills.test.js` is now 10 tests.

### C15. Unit LU2: the inlining / deopt tooling moves to the pinned @zakkster/lite-utils 1.0.0

- **What happened.** `@zakkster/lite-utils` is now a devDependency pinned EXACTLY "1.0.0" (`dependencies` stays empty)
  and the vendored `test/tools/inlining-budget-diff.sh` (LiteUtils 465881b, 1530 lines, sha256 f13f33c2) is deleted.
  `test/tools/lite-utils.mjs` resolves scripts only from `<root>/node_modules/@zakkster/lite-utils` (no module
  resolution, no walk-up) and checks package name, version === 1.0.0 and script presence; else the tools exit 2 with a
  named reason. `test/InliningTool.test.js` pins inlining-budget-diff.sh (7a5cf99b..., 1658 lines) and
  `test/DeoptTool.test.js` T1 pins deopt-diff.sh (95e12a28..., 1857 lines); InliningTool also has a version row
  (installed 1.0.0, root devDependency exactly "1.0.0", empty dependencies, vendored path absent), so a dependency bump
  goes red. InliningTool 31 -> 35 tests; the script's `--self-test` 89 -> 92 checks; SIX script mutants are red (sort
  -u, elif false, guard off, kConcurrent c=0, always SAME, and m4 `if false && ! cmp -s`). m4, the open FILLER of C10,
  is CLOSED: lite-utils 1.0.0's null-control self-test rows kill it. m6 (die -> echo) still survives `--self-test` and
  is still caught by the real-V8 driver-exit row. New `npm run deopt-diff` (A8) and `test/DeoptTool.test.js` (7 rows:
  sha pin + teeth, `--stage-only` layout on the real tree, missing / wrong-version package -> 2, bad args, exit contract
  on a stub script incl. precedence 2 > 1, group kill on hang, SIGTERM, temp cleanup). `npm test` 163 -> 174 (60 + 35 +
  30 + 9 + 10 + 8 + 15 + 7). RingBuffer.js unchanged.
- **Root cause.** A vendored copy of an unpublished script drifts and cannot be bumped; the exact pin plus a sha
  pin makes the tool bytes a reviewed, versioned input. Review caught gate-teeth defects in both batches. B1
  (REJECTED round 1): helper fail-open mutants survived, and the root was coerced / could throw instead of failing
  closed. B2 (REJECTED round 1): exit precedence 2 > 1 was untested; the hang row could not tell a process-group
  kill from a pid kill; an uncaught throw exited 1, which reads as "blind" instead of NO-VERDICT; a signal orphaned
  the detached group and the temp dir. All fixed, then APPROVED.
- **Evidence.** `.handoff/archive/1.4.0/LU2/PLAN.md`, `.handoff/archive/1.4.0/LU2/evidence/` (`mutants-1.0.0.log`,
  `deopt-selftest-1.0.0.log` 107 ok, `revert-b1.log`, `revert-b2.log`, `npmtest-b2-fr1.log` count 174/174,
  `qa-inline-diff.log`, `qa-deopt-diff.log`). qa 2026-11-14T16:50:09Z, Node v26.8.2, HEAD 2f212c8, RingBuffer.js
  eaa32ee7, host PRELIMINARY (load1 4.74 vs baseline 2.21), quiet-lock run non-strict, 1 run: `npm run inline-diff` exit
  0, A/A SAME, 3/3 controls DIFF on their own fn in turbo + maglev (REPORTED). Working tree, not yet committed.
- **Law.** 1, 2, 11, 12.
- **Gate.** `test/InliningTool.test.js` (version / pinned-exactly row, sha pin, `--self-test` 92 checks, six
  script mutants, MUST-COVER rows) and `test/DeoptTool.test.js`; both in `npm test` (count.mjs `EXPECTED` 174).
  The real-V8 verdicts stay REPORTED, by hand under the quiet lock.

### C16. copyLast's documented check order had no pin (alias vs storage, TypeError vs n for an other-realm DataView)

- **What happened.** In the R3 build review round 1, reviewer mutants X2 (alias check swapped with the storage check)
  and X10 (the DataView TypeError moved after the `n` check, reachable with an other-realm DataView) survived every
  test: the documented check order of `copyLast` / `copyLastFast` was pinned only in part.
- **Root cause.** The check-order test pinned n before bounds before alias / storage, but not alias before storage
  and not the dst TypeError before the `n` RangeError for a DataView from another realm (law 1).
- **Fix.** Two cases added to the check-order test in `test/copylast.test.js`.
- **Evidence.** `.handoff/archive/1.5.0/R3/PLAN-G1.md` addendum A6 (2); build 9765c21e, `test/copylast.test.js`
  check-order test (the `kills X2` / `kills X10` cases); no run log of X2 / X10 is kept
  (`.handoff/archive/1.5.0/R3/mutants/run.log` is the 24-mutant R3 set, run on round-1 build 6d92ed1f before these
  pins).
- **Law.** 1.
- **Gate.** `test/copylast.test.js`, the check-order test (message order). Reopens if a check is added to
  `lastCheck` with no test that fails when its position is mutated.

### C17. The shipped suite passed a same-size reorder that reads the ring's count before the checks (M1 unpark qa)

- **What happened.** In the M1 unpark qa pass, mutant MK_countEarly (9e70b525 with `let k = rb.count;` moved above the
  type / n / bounds check; chain still 765 B, so test/chainsize.test.js cannot see it) passed every other shipped test
  file (`.handoff/archive/1.5.1/M1/unpark/qa/logs/suite-MK_countEarly.log`, 285 pass / 0 fail;
  `test/tools/chain-size.mjs` on MK: 765, ok). 1.5.0 reads `rb.count` after `dst instanceof DataView`, so a user
  `DataView[Symbol.hasInstance]` hook that resets, destroys or pushes into the ring during the check changes what the
  call copies; MK copies the stale count. Mutant MM_lenBeforeHook (dst's length read before the hook runs) is the same
  class for a resizable / transferred `dst` buffer.
- **Root cause.** The stage-H port (test/copylast-hooks.test.js) compares which error is thrown and the hook event
  sequence; no row lets the hook mutate the ring or `dst`'s buffer, so read-order changes that keep the error
  identical were unpinned (law 1).
- **Fix.** test/qa-m1.test.js (4, expectations are literals from the frozen 1.5.0 build a771a79): Q1-Q3 hook resets /
  destroys / pushes into the ring mid-check, Q4 hook resizes / transfers a resizable dst buffer mid-check.
- **Evidence.** `.handoff/archive/1.5.1/M1/unpark/qa/` (`mut/MK_countEarly.js`, `mut/MM_lenBeforeHook.js`,
  `ov-MK_countEarly/`, `ov-MM_lenBeforeHook/`, `logs/`), 2026-11-15, Node v26.8.2; header of `test/qa-m1.test.js`;
  fd7af97.
- **Law.** 1.
- **Gate.** `test/qa-m1.test.js` Q1-Q4 (revert checks: Q1-Q3 red on MK_countEarly, Q4 red on MM_lenBeforeHook). Reopens
  if copyLast / copyLastFast gain a read of ring or dst state with no row whose hook mutates that state.

### C18. The B1 bench judge failed open on a missing or short `rounds` field and printed a PRELIMINARY host's ratio as quotable

- **What happened.** Caught by review round 1 (compare.mjs 2eea7409 -> 21a15822): a compilation with no `rounds` pooled
  nothing and the row stayed VALID; a probe with a different K was accepted; the QUOTE lines tagged smoke but not a
  non-quiet host; MOD_NP2's capacity was unlabelled.
- **Root cause.** The judge trusted the probe's output shape instead of checking it (laws 1, 2).
- **Fix.** `rounds` length == K >= 5 per compilation, the probe's K is checked, a host tag is on the QUOTE lines, every
  per-round ratio is finite and > 0, VOID rows mask their ns cells, and the MOD / MOD_NP2 capacities are named on the
  QUOTE lines (COL_NOTE label).
- **Evidence.** compare.mjs 2eea7409 -> 21a15822; `.handoff/archive/1.5.3/B1/reviews/code-review.md`; fix-revert runs
  `.handoff/archive/1.5.3/B1/coder/mut/fix.{rounds,perround,hosttag,nsmask}.out`.
- **Law.** 1, 2.
- **Gate.** `node test/bench/compare.mjs --self-test` (125 checks; reverting the rounds, per-round-ratio, host-tag,
  ns-mask or COL_NOTE-label fix turns it red; the probe-output accept check acceptProbe, compare.mjs:226, called at
  :547, has one reject case per clause and dropping any clause turns it red).

### C19. The Q2 CHK argument oracle never exercised the guard's cache statements (Q2 review r1)

- **What happened.** Review r1 (group A, 2026-11-16) found that `chkArgs`, the oracle for the CHK column's copied
  argument checks, compared RingBuffer and CHK by outcome and error class only. Two mutants of the copied alias-cache
  guard (`if (data !== ring._bufOf)` -> `if (ring._bufOf === null)`, and dropping `ring._bufOf = data;`) kept every
  outcome identical, so a CHK that silently skipped or lost the cache statements would have been timed and reported as
  "RingBuffer's argument checks". Maintainer ruled "Fix once, re-review" (SPEC A11).
- **Root cause.** The oracle observed results, not the state the checks exist to maintain (laws 1, 2): the cache is
  the cost being measured and nothing compared it.
- **Fix.** New ARG_STATE `swapData` (warm both caches, replace `data` with a new full-length array of the same values,
  copy into the OLD data) and, after every ok outcome, a cache-parity assert `(rb._bufOf === rb.data) ===
  (ck._bufOf === ck.data)`; mutants MUT_CHK_STALE and MUT_CHK_NOCACHE on both copy rows.
- **Evidence.** HEAD 82cd5dc + the Q2 working tree; `.handoff/archive/1.5.6/q2/SPEC.md` A11;
  `.handoff/archive/1.5.6/q2/review-r1/` (gitignored paths, maintainer checkout only); round 2 APPROVED.
- **Law.** 1, 2.
- **Gate.** `node test/bench/compare.mjs --self-test` (307 checks in the strict-1 run): rows `copyto32 MUT_CHK_STALE
  missed -> 1`, `copyto1024 MUT_CHK_STALE missed -> 1`, `copyto32 MUT_CHK_NOCACHE missed -> 1`, `copyto1024
  MUT_CHK_NOCACHE missed -> 1` (and their `null` / `missing` rows). Reverting `swapData` or the parity assert lets a
  mutant through.

### C20. Q2 bench self-tests and the Q1 core lane had untested holes (post-1.5.6 fillers)

- **What happened.** Mutation review of the post-1.5.6 dev tooling found holes its own gates did not see. Bench:
  mutant MUT_CHK_NOBUF survived; the gc-lane child was orphaned on SIGINT / SIGTERM; `compare.mjs --self-test --K 4`
  exited 0 and `--K 0021` was accepted; a NaN-open floor in compare-gc survived. Core lane: `test/core.mjs` had no
  self-test, an emptied file (term 1, `tests 1 pass 1` on Node 18..26) passed, and nothing checked the `ci.yml`
  legs. Review r1 then found the new `test/ci-legs.mjs` open on `defaults.run.shell: true {0}` (every run step a
  no-op) and on a non-push `on:`.
- **Root cause.** Each gate was tested on the paths its author thought of, not by a mutant of its own judge
  (laws 1, 2); the CI matrix was an unchecked text file.
- **Fix.** Bench: MUT_CHK_NOBUF mutant and a `warm` ARG-oracle state, signal forwarding to the probe / gc lane
  (signalPlan), canonical-integer parseOpts and a `--self-test` that takes no other argument, a pure floor predicate
  rbFloorOk with direct rows. Core: a 24-case self-test on fixture copies, `test/ci-legs.mjs`, the tier split in
  `test/core-tiers.json`, every count term >= 2, new exit 2 causes; ci-legs r2 pins `defaults` and `on`.
- **Evidence.** Base 1d91441 + the working tree; `.handoff/archive/1.5.7/fillers/u1/evidence/`,
  `.handoff/archive/1.5.7/fillers/u3/evidence/`, `.handoff/archive/1.5.7/fillers/u3/review/` (gitignored, maintainer
  checkout only); frozen before `.handoff/archive/1.5.7/fillers/frozen-8965b17/`. First hosted run 43794508993 (push of
  c651488, 2026-11-16T02:49Z UTC) passed all 12 legs: self-test 24/24 on Node 22 / 24 / 26 (23/23 + 1 n/a on 18 / 20),
  ci-legs ok on every leg.
- **Law.** 1, 2.
- **Gate.** `node test/bench/compare.mjs --self-test` (372 checks), `node test/bench/compare-gc.mjs --self-test`
  (212), `node test/core.mjs` (self-test 24/24 + the ci-legs check). Earlier 307 / 197 counts (C19, Q2) stay as
  history.

### C21. Timeout orphaned the gc child; ci.yml SKIP / block lines were only loosely checked (post-1.5.7 fillers)

- **What happened.** The post-1.5.7 fillers burst (commits bdea88a, 0eb8dd6 on 51b0e74) found three more holes.
  Unit A: the `PROBE_TIMEOUT_MS` timer in `test/bench/compare.mjs` used a bare SIGKILL, which left the gc lane's own
  child orphaned (a timed-out `compare-gc.mjs` could not forward the signal); at 51b0e74 `compare.mjs` parseOpts
  was already canonical for `--K` while `compare-probe.mjs` and echoOf took `/^[0-9]+$/`. Unit B: `test/ci-legs.mjs`
  let a SKIP line carry text after its echo that the old deny-list missed, and a non-SKIP `|` block run step carry
  any line its deny-list missed (`nvm use 18` passed). Unit W: a rewrap of `test/ci-legs.mjs` and
  `test/core.mjs` to 120 cols. Review round 1 then found the new oracles open on their own mutants: the runProbe
  SOURCE row accepted a regression that sends SIGKILL first (its predicate did not pin the kill order); no row
  isolated the `\` clause of the SKIP rule; nothing proved every SKIP line is checked (an unpinned per-line loop); the
  `ci.yml` header comment was stale.
- **Root cause.** A source / string oracle written to the author's paths, not to a mutant of its own judge: a
  predicate that pinned what the fix contained but not the order that made it a fix, and per-line loops and clauses
  with no row that fails when only they are removed (laws 1, 2).
- **Fix.** Unit A: a pure `timeoutPlan()` derived from `signalPlan('SIGTERM')` forwards SIGTERM and sends SIGKILL
  only after `SIGNAL_GRACE_MS` if the child has not exited, both timers cleared in `fin`; one `CANON_INT`
  (`/^(?:0|[1-9][0-9]*)$/`) for `--K` on both sides (`compare.mjs` parseOpts + echoOf, `compare-probe.mjs`), one
  source text, a source row fails a one-sided change. The round-1 predicate (grace timer armed before
  `ch.kill(tp.forward)`, exactly 2 `ch.kill(` sites, no SIGKILL literal) replaced the weak one; the header line
  "counts as crashed / VOID" was softened because nothing on the accept path read `timedOut`. Unit B: a SKIP line
  is exactly one `echo "..."` with no `"`, backtick, `\` or `$` inside except the 2 whole substitutions in
  `SKIP_SUBST`; every line of a non-SKIP `|` block run step is one of the exact 10 trimmed lines in `BLOCK_LINES`
  (the provenance block) or blank;
  the in-file `ciLegsSelfTest` (35 rows with a live `ci.yml`, 32 without, count-pinned) runs inside `ciLegsAt`, so
  in `test:core` and the CLI; `ci.yml` comment lines 22-24 updated.
- **Evidence.** Base 51b0e74 + commits bdea88a, 0eb8dd6; `.handoff/fp157/A/evidence/`, `.handoff/fp157/B/evidence/`,
  reviews `.handoff/fp157/review-{A,B,W}/`, frozen before `.handoff/fp157/frozen-51b0e74/`, verify log
  `.handoff/fp157/evidence/verify.log` (gitignored, maintainer checkout only). Unit A trial (timer patched to 4 s
  for the gc lane, 1 run per copy, PRELIMINARY host; 2026-11-16T05:09:12Z, load1 5.32, Node v26.8.2; pass/fail,
  not a timing; `.handoff/fp157/A/evidence/T1-timeout.txt`): 51b0e74 left a ppid-1 `compare-gc-child`; head left
  none (gc lane exit 143 -> VOID, exit 1). Unit B frozen-vs-live: 51b0e74 passed both holes, head names both. Unit W:
  acorn token and comment streams identical, 0 lines over 120. Hosted run 43811202859 (push of 0eb8dd6,
  2026-11-16T05:35:14Z..05:39:52Z UTC) passed all 12 legs: core self-test 24/24 on Node 22 / 24 / 26 / 26.8.2 (23/23
  + n/a feature guard on 18 / 20), core ci-legs "12 legs ... ok" on every leg, the first hosted run of the exact
  SKIP / block rules and the ci-legs self-test. Closing local verify: exit 0, PRELIMINARY host (load1 5.31 vs
  baseline 2.21; 1 run, 2026-11-16T05:26:21Z..05:28:07Z UTC), npm test 294/294, torture leak 0/0 gc 0/0 alloc 0.0
  B/op, Node v26.8.2 arm64.
- **Left open at 0eb8dd6.** (1) `compare.mjs` accepts a probe / gc lane that exited 0 with valid output after the
  timeout fired (nothing on the accept path reads `timedOut`; the old SIGKILL code had the same race). (2) The
  sibling bench probes `copyto-probe.mjs`, `pushbatch-probe.mjs`, `copylast-probe.mjs` (and their `*-ab.mjs`
  drivers) still take `--K` with `/^[0-9]+$/`. (3) ci-legs has no row for the empty-SKIP-body branch (mutant M11
  survives) and `SKIP_SUBST` is not count-pinned like `BLOCK_LINES`.
- **Law.** 1, 2.
- **Gate.** `node test/bench/compare.mjs --self-test` (383 checks), `node test/bench/compare-gc.mjs --self-test`
  (212), `node test/core.mjs` (self-test 24/24 + ci-legs, whose in-file self-test is 35 rows with `ci.yml`). C20's
  372 stays as history.

### C22. C21's three leftovers closed; the timeout accept fix first pinned only its consumer (post-commit fillers)

- **What happened.** The burst after 0eb8dd6 (working tree on 0eb8dd6, not yet committed) closed the three items C21
  left open. (1) `test/bench/compare.mjs` accepted a probe or gc lane that exited 0 with valid output after the
  timeout fired. Now a pure `ranClean(r)` (status 0, signal null, `timedOut === false`, error null) gates both
  lanes: the probe accept is a pure `acceptRun(r, want)` (ranClean, then string stdout, JSON.parse, `acceptProbe`),
  the gc lane accept is `acceptGc(run, mdExists)` = `ranClean(run) && mdExists === true`. The usage-error guards
  became `r.status === 2 && r.timedOut === false` (probe) and `g.status === 2 && g.timedOut === false` (gc), so a
  timed-out run is crashed / VOID even on exit 0 with valid output, or on exit 2. The header says "counts as
  crashed / VOID" again. Self-test 383 -> 446 (+63 rows: ranClean / acceptGc / acceptRun tables, a `String(acceptRun)`
  order row, a main-loop source row). (2) `test/bench/{copyto,pushbatch,copylast}-{ab,probe}.mjs` now carry the same
  `const CANON_INT = /^(?:0|[1-9][0-9]*)$/;` line as `compare.mjs` on both sides; 0eb8dd6 accepted `--K 021`, head
  exits 2. (3) `test/ci-legs.mjs` got a 4th end-to-end row: a live torture SKIP run with a blank scalar must give
  the exact finding "a SKIP step with an empty run body" (mutant M11 passed 0eb8dd6 at 35/35, now red; it is
  reachable only end to end: with no `ci.yml`, M11 survives because `checkCiLegs` does not run on that path), one
  row per `SKIP_SUBST` entry, counted like `BLOCK_LINES`. Review round 1 then found the item-(1) fix pinned only the
  consumer of `timedOut` / `error`: mutants in the producer (`runProbe`) survived at 446/446 and silently reopened
  the hole: R2 `res({..., timedOut: false})`, R3 the `timedOut = true;` line dropped, R8 'error' resolved as
  `fin(0, null, null)`; also R1 `combineExit(J.exit, 0)`.
- **Root cause.** A fix that makes a field load-bearing must pin the field's producer, not only its consumer: the
  accept predicate read `timedOut`, but nothing failed when the code that sets it stopped setting it (laws 1, 2).
- **Fix.** The `runProbe` source row in `compare.mjs` now pins `timedOut = true;` (exactly once, before
  `ch.kill(tp.forward)`), the `res(...)` line and both `ch.on` handlers; also pinned are
  `const exitAll = combineExit(J.exit, gcExit);` and the two exit-2 guards. Each of the three bench drivers got +3
  self-test rows (own source, probe source, pure table): copyto-ab 52 -> 55, pushbatch-ab 68 -> 71, copylast-ab
  84 -> 87; reverting either side alone is red. ci-legs self-test 35 / 32 -> 38 / 34 (with / without `ci.yml`).
- **Evidence.** Working tree on 0eb8dd6; `.handoff/fx0eb/U2/evidence/`, `.handoff/fx0eb/U3/evidence/` (and
  `U3/evidence/fix1/`), `.handoff/fx0eb/U4/evidence/`, reviews `.handoff/fx0eb/review-{U2,U3,U4}/`, frozen before
  `.handoff/fx0eb/frozen-0eb8dd6/` (gitignored, maintainer checkout only). Timed-out stub trial (stub probes trap
  SIGTERM, exit 0 with valid output; `PROBE_TIMEOUT_MS` patched to 400 ms on scratch copies, `--smoke`, untimed,
  1 run per copy, Node v26.8.2 / V8 14.6.202.34-node.28, Darwin 27.2.0 arm64 Apple M4 Pro x 12 cores; frozen run
  2026-11-16T05:53:28.006Z .. 05:53:30.938Z, load1 2.48 at start / 2.45 at end (`e2e-frozen.log`); live run
  05:53:30.999Z .. 05:53:33.936Z, load1 2.45 at start / 2.41 at end (`e2e-live.log`); pass/fail, not a timing;
  `U3/evidence/fix1/e2e.log`): frozen 0eb8dd6 accepted 6/6 timed-out probes and the timed-out gc lane; head counts
  6/6 crashed and the gc lane VOID.
- **Left open.** Review nits, recorded and not fixed. (a) The `CANON_INT` source rows are text checks, so deliberate
  sabotage (`CANON_INT.test(K) || true`, a decoy call, a shadowing block) survives; a probe spawn row per driver
  would catch the probe side. (b) A truncated `SKIP_SUBST` entry (`'$(node --version'` without `)`) survives and
  would admit `echo "SKIP $(node --version; npm run torture)"`; an `ST_BAD` row with that line would kill it.
- **Law.** 1, 2.
- **Gate.** `node test/bench/compare.mjs --self-test` (446 checks), `node test/bench/copyto-ab.mjs --self-test` (55),
  `node test/bench/pushbatch-ab.mjs --self-test` (71), `node test/bench/copylast-ab.mjs --self-test` (87),
  `node test/core.mjs` (ci-legs in-file self-test 38 rows with `ci.yml`). C21's 383 / 35 stay as history.

---

## D. Measurement traps

### D1. `heapUsed` deltas miss transient boxes

- **What happened.** See C8: 19 MB of real allocation read as 0.96 MB. Use `total_allocated_bytes` (present on Node
  v26.8.2, absent on v18.20.8 / v20.20.2 / v22.23.5 / v24.22.3, see D18): B/op over 1M calls, minimum over windows
  1..W-1, empty-loop baseline subtracted; noise under 0.3 B/op.
- **Root cause.** Scavenges absorb short-lived allocation before the delta is read.
- **Evidence.** e3e1df1; `test/alloc.mjs` header; memory note `alloc-gate-total-allocated-bytes`.
- **Law.** 4.
- **Gate.** `test/alloc.mjs`.

### D2. Window 0 runs pre-TurboFan code

- **What happened.** In `test/alloc.mjs` the first window runs unoptimized code that does not inline
  and boxes, so steady state is the MINIMUM over windows 1..W-1 (W = 6, N = 1,000,000 calls). The
  harness accumulator lives in a `Float64Array` slot so the harness itself does not box.
- **Root cause.** A tier-up transient counted as steady state.
- **Evidence.** e3e1df1; `test/alloc.mjs` header and constants (`N`, `WINDOWS`).
- **Law.** 4.
- **Gate.** `test/alloc.mjs`.

### D3. Torture first draft: lanes ran in lower compiler tiers

- **What happened.** One 2M-op call per lane entered in a low tier and reached TurboFan only by OSR part-way through; an
  empty `SINK[k] += x` loop measured 32-48 B/op (`--trace-opt`, Node 26.8.2), so the minor count hung on when the
  background compile landed. Fix: 1000-op calls (`CHUNK`) and 300k warmup (`WARM`) outside the window; no budget
  widened. The same loop read 15-23 minor GCs (`.handoff/archive/1.5.3/reviews/2026-11-10-findings.md`, D B3 coder
  report, `--trace-opt`).
- **Root cause.** A long single call defeats optimized entry; low tiers box doubles.
- **Evidence.** 1d6e368; `test/torture.mjs` header and lines about `CHUNK` / `WARM` (comment "an empty
  `SINK[k] += x` loop measured 32-48 B/op that way, --trace-opt Node 26.8.2"); `.handoff/archive/1.2.1/D/b3/`
  (provenance: node v26.8.2, torture-live-1..3 unlocked at load1 10.19 / 10.19 / 9.77, baseline
  2.21, PRELIMINARY; GC counts deterministic, maxPauseMs PENDING a quiet window).
- **Law.** 3, 4.
- **Gate.** `test/torture.mjs` (HOT = 2,000,000 ops per lane, 6 gated lanes, control lane minor 49 at the unit D closing
  run (`.handoff/archive/1.2.1/D/verify/verify.log`, 2026-11-10 07:17Z, host PRELIMINARY load1 5.14 vs baseline 2.21,
  Node v26.8.2)).

### D4. `res=` drifts, and a derived number is not a measurement

- **What happened.** `res=` read 2.13 B/op (`.handoff/archive/1.2.1/D2/qa/q3-torture-batch.txt`, 2026-11-10 07:50Z, Node
  v26.8.2, quiet-lock free, host PRELIMINARY load1 3.63 vs baseline 2.21); a second run read 0.53 B/op (half-track run,
  load1 13-76, unlocked, PRELIMINARY; `.handoff/archive/1.5.3/reviews/2026-11-10-findings.md`, D2 B1 reviewer). The docs
  therefore state no value and label it nominal. Unit D's committed docs (1d6e368: README Testing, llms.txt, CHANGELOG
  [Unreleased]) said "about 2 B/op", a derivation (104.2 B/op x 2,000,000 / 49 minors); unit D qa flagged it as derived,
  not measured; b6a8310 removed the value.
- **Root cause.** `res` scales with V8 new-space size, which grows; and a ratio of two measurements
  is an estimate.
- **Evidence.** 1d6e368 / b6a8310; `.handoff/HISTORY.md` "Next burst -- unit D2" item 2 (the derivation);
  `CHANGELOG.md` [Unreleased] ("nominal ... depends on the V8 new-space size").
- **Law.** 3, 5.
- **Gate.** Reviewer doc-truth check; torture prints `res=` and gates nothing on it.

### D5. A vitest run also picked up the frozen copy under `.handoff/`

- **What happened.** A baseline vitest run also collected the frozen copy of the test file under `.handoff/` (a bare
  `vitest run` reported 118 tests (reviewer / coder report recorded in
  `.handoff/archive/1.5.3/reviews/2026-11-10-findings.md`; no run log on disk; no host / load stated)). The baseline
  command now excludes it: `npx vitest run RingBuffer.test.js --exclude .handoff/** --reporter=json` -> 59 tests, 59
  passed (vitest 4.1.11, node v26.8.2, darwin-arm64, HEAD 0412025).
- **Root cause.** An unscoped run globs the package tree, frozen builds included.
- **Evidence.** 1d6e368; `.handoff/archive/1.2.1/D/vitest-baseline.json` (`cmd`, `numTotalTests`).
- **Law.** 12.
- **Gate.** `npm test` names its files explicitly (`test/count.mjs` `FILES`).

### D6. A short-window B/op lane read noise as allocation (R1 step 1 probe, four harness revisions)

- **What happened.** The R1 step 1 research probe (2026-11-11) measured B/op per copyTo-shaped call at 32..16384 samples
  with `total_allocated_bytes`. At large n a window holds few calls, and four successive traps each read counter noise
  as allocation or hid real allocation: v1 took the minimum of per-window DIFFERENCES over as few as 2,640 calls
  (`runs/v1/rung-16384.json` nb) -> SET's known 104 B read 93 B (rungs 4096 / 16384 VOID); v2 ran each lane's 6 windows
  back to back (~200 ms) -> LOOP2 read 12.49 B/op in one of 3 compilations (not reproduced in 8 untimed re-runs;
  inferred cause: one background allocation event spanning all six windows); a v3 draft without gc() accounted SET's GC
  work in the NEXT lane's window (+1.23 B/op) and, with gc() only at window start, missed the bytes in the open
  allocation area (SET 196.6 of 208 B); v3 on a contended host read four loop lanes at ~9 B/op, consistent with a
  background allocation rate (~1.2 MB/s, inferred, not measured directly) that scales with window wall time while the
  empty-driver window lasted microseconds. v4: min of each lane separately, gc() around every window, windows
  interleaved across lanes, the empty window time-matched to its lane.
- **Root cause.** Absolute counter noise (tens to hundreds of KB per window) divided by a small call
  count; an empty baseline that is not matched to the lane in time or in GC state.
- **Evidence.** Build under test dc6965f / 43adb369 (frozen); `.handoff/archive/1.5.3/research/r1/PROGRESS.md` (v1..v4
  sections), `runs/v1/`, `runs/v2/`, `runs/rung-*-v3.*`, harness copies per version (none for v3); Node v26.8.2 / V8
  14.6.202.34-node.28, Apple M4 Pro, 2026-11-11 05:33Z-05:48Z, hosts as each run states (QUIET to PRELIMINARY).
- **Law.** 3, 4. A probe's B/op lane at >= 20,000 calls per window classifies objects per call (loops < 8 B = no 16 B
  box; SET >= 52 / >= 156 B = one / two 104 B views); "< 1 B/op" is proven only by `test/alloc.mjs` at N = 1,000,000;
  the < 8 B boundary is not yet trusted -- its error at 20,000 calls (SET 91.7 of 104 B) exceeds the 8 B margin and it
  has no one-16-B-box must-fail column yet (PROPOSAL-r1 Q-STATHOST).
- **Gate.** None in the repo (research harness). `test/alloc.mjs` copyTo 1024 lanes (R1 build,
  99e8749) now hold the < 1 B/op claim.

### D7. A single-layout oracle missed a whole branch (R1 step 1 probe)

- **What happened.** The probe's oracle compared each candidate with HEAD `copyTo` on the timed
  layouts only (head 0 and head n/2). A mutant in the ROT candidate's `start > capacity / 2` branch
  passed it; a sweep (every head x counts {cap, cap-1, cap/2+1, 33, 1} x capacities 8 /
  64 / min(n, 1024)) fails it.
- **Root cause.** The timed layouts are chosen for speed questions; head n/2 is the tie point between
  ROT's two branches and never enters the second.
- **Evidence.** Build under test dc6965f / 43adb369 (frozen);
  `.handoff/archive/1.5.3/research/r1/runs/controls/mut-rot-else.txt` (oracle true, sweep false).
- **Law.** 1.
- **Gate.** None yet (research harness). The R1 build unit's oracle will be the sweep extended with dstOffset > 0 and
  guards on both sides, as node:test (PROPOSAL-r1 section 6).

### D8. An A/A on an allocating before-build is not an A/A (R1 build, B-S1)

- **What happened.** B-S1's first A/A design ran the frozen 1.2.1 build (FR) against itself. FR's `copyTo`
  allocates 104 / 208 B above 32 samples, so the bench judge's B/op lane read VOID (exit 1) on 24 of 30 rows.
  PLAN-S ADDENDUM A1 (2026-11-11) moved the A/A dry run and both B/op must-fail controls (`ctl-box`, `ctl-view`)
  to FC vs FC (the approved R1 candidate eab8983a, 0 B/op at every size). The T5 run of record uses 1.2.1 only as
  the BEFORE side of the contrast; its A/A twins are separate runs (T5-SUMMARY: A/A medians 0.973..1.066).
- **Root cause.** An A/A needs a twin that passes the same gates the contrast must pass; an allocating build
  cannot pass the zero-allocation lane (law 2).
- **Evidence.** 5ae2266 (FC eab8983a); `.handoff/archive/1.3.0/R1/PLAN-S.md` ADDENDUM A1; `.handoff/HISTORY.md` R1 build
  burst 2 (B-S1 review finding 1; T4: `ctl-box` exit 1 CAND B/op 15.4-15.6, `ctl-view` exit 1 VIEW B/op 0.0, `aa-dry` FC
  vs FC exit 0 QUIET).
- **Law.** 1, 3.
- **Gate.** `npm run bench:copyto` (A/A twin on a 0 B/op build; STATISTICAL, by hand, strict).

### D9. `npm run inline-diff`'s anchors miss `copyTo`

- **What happened.** T6 ran `npm run inline-diff -- --after FC`: exit 0 on both runs, yet its function list is
  `getOrDefault`, `peekNewest`, `peekOldest` (C10), so it never looked at `copyTo`. The package's own
  `inlining-budget-diff` with `--fn copyTo` (1.2.1 vs the R1 candidate FC) reported DIFF: `copyTo` bytecode
  385 -> 489 B, over TurboFan's default 460 B single-inline limit, so TurboFan stopped inlining it into callers.
  After R1b, `--fn copyTo` FC vs the R1b file reports `copyTo: 489 -> 189 bytes (-300)` (REPORTED;
  `.handoff/archive/1.3.0/r1b-fix/evidence/inl-FC-vs-new.log`; `copyCheck` and `rotCopy` are now separate functions that
  TurboFan inlines into `copyTo`).
- **Root cause.** An exit-0 gate proves only the functions it names; a function added to the contract needs a
  new anchor.
- **Evidence.** 99e8749 (FC eab8983a), R1b 63eb5bc1 (working tree); `.handoff/HISTORY.md` R1 build burst 2 (T6;
  `inline-diff-copyto.log`); `.handoff/archive/1.3.0/r1b-fix/evidence/ inl-FC-vs-new.log` (Node v26.8.2).
- **Law.** 1, 5.
- **Gate.** REPORTED, by hand under the quiet lock: `bash node_modules/@zakkster/lite-utils/inlining-budget-diff.sh --fn
  copyTo ...`. `inline-diff.mjs` is not changed (its function list is a FILLER candidate).

### D10. The intrinsic `buffer` getter and the 460 B inline limit cost R1 copyTo ~21 ns at 32 samples (R1b)

- **What happened.** R1 copyTo (99e8749) ran 2.3-4.0x (R1 B-S2 T5, `.handoff/archive/1.3.0/R1/evidence/S/t5-summary.md`,
  strict, 2026-11-11T07:34Z, QUIET, 2.28-3.98) slower than 1.2.1 at 32 samples (T5 strict A/B, 11 -> 25-44 ns) although
  both validate the same way. The R1b research pass (2026-11-11) ablated one capability per frozen variant: lost caller
  inlining ~11-12 ns (copyTo bytecode 385 -> 489 B, over TurboFan's 460 B single-inline limit, D9), ~4-5 ns per
  intrinsic `%TypedArray%.prototype.buffer` getter call (two per call for the alias check), and wrapped ROT at 32
  samples ~13 ns over the loop.
- **Root cause.** The alias check and the ROT router added ~104 B of bytecode to one method, so callers stopped
  inlining it; the `buffer` getter apparently is not reduced by TurboFan as `length` / `toStringTag` are (all
  inferred from timings: ~4-5 ns per `buffer` read vs <= ~1 ns; not confirmed from V8 source or a trace).
- **Evidence.** Build under test 5ae2266 (FC eab8983a), FR 132d003 / 43adb369; frozen variants
  `.handoff/archive/1.5.3/research/r1b/variants/` -- V-noalias bab60068, V-onebuf 03d1434f, V-loop32 1360bb5c, V-split
  46c95d02, V-split32 4bb914b8, V-split32c 54279dbe (timed) / b93aab2c (review-fixed; differs only in the cache-miss
  branch); `.handoff/archive/1.5.3/research/r1b/PROGRESS.md` (rungs 0-2), `runs/timed/analysis-rung0-1.md`,
  `analysis-rung2.md`, `runs/untimed/inl-*.log`. Rung 0 / 1: `quiet-lock run` non-strict, 2026-11-11T08:21:59Z-
  08:26:56Z, load1 2.98 at start, 2.75-4.03 over the five runs (rung0-FC and V-onebuf QUIET exit 0; V-noalias / V-loop32
  / V-split exit 2 PRELIMINARY); rung 2: `run --strict`, 08:35:44Z-08:37:27Z, load1 2.30 -> 3.70, QUIET, exit 0 both.
  Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, K 21 x 3 compilations, one run each. Strict rung 2: V-split32c
  (shared copyCheck, rotCopy helper, loop at <= 32, identity-keyed buffer cache) 1.32-1.35x of 1.2.1 at 32, V-split32
  (no cache) 1.69-1.80x; both 0 B/op, faster than 1.2.1 at 64. The shipped fix (63eb5bc1) in the T5 run of record (B4
  Evidence): 1.33-1.38x of 1.2.1 at 32. Bytecode 489 -> 189 B: `inl-FC-vs-new.log` (D9).
- **Law.** 5 (numbers from this cycle's logs only), 1 (V-noalias was the alias suite's must-fail column).
- **Gate.** None (REPORTED). The T5 strict A/B on the final candidate is the run of record
  (`.handoff/archive/1.3.0/r1b-fix/T5-SUMMARY.md`); `inlining-budget-diff --fn copyTo` reports copyTo's bytecode against
  460 B (REPORTED).
- **RULING.** Q-R1B-FIX = "V-split32c"; Q-R1B-ROUTER = "Loop at <= 32" (amends Q-R1 "`COPY_LOOP_MAX` goes",
  A11); maintainer, 2026-11-11, AskUserQuestion, one sitting (`.handoff/archive/1.5.3/PROPOSAL-r1b.md` RULINGS).

### D11. Identical-source `new Function` probe columns share one feedback vector (R2 research)

- **What happened.** The R2 probe builds each column from source text with `new Function`. Its rung-0 sweep fed the
  MASK column a BigInt src; the later "fresh" B/op lane built a new MASK closure from the same text and read 1839 B
  per call on Float32 src -- the sweep's pollution, not the lane's own behaviour. A per-column nonce comment in the
  source (different text -> different cache entry) gave every lane fresh feedback and 0 B.
- **Root cause.** V8's compilation (eval) cache returns the same SharedFunctionInfo and, with it, shared feedback for
  identical source text, so separately built closures are one IC history. R1's probe relied on this for its A/A
  twin (a timing-position A/A, not a second compilation) -- the same mechanism, harmless there.
- **Evidence.** `.handoff/archive/1.5.3/research/r2/probe-pushbatch.mjs` (`mkCol(..., fresh)`, `NONCE`); first-run vs
  fixed `runs/rung0-check.json` described in `PROGRESS.md` rung 0 (2026-11-12, Node v26.8.2).
- **Law.** 4 (a lane must run in the state it claims), 12 (scope every measurement).
- **Gate.** None (research harness). A probe lane that claims fresh / monomorphic feedback builds its columns from
  unique source text (or separate modules); a lane that wants shared feedback says so.

### D12. Probe harness traps in the R3 research: a per-call closure in a column, reps sized from cold code, a column assumed privileged

- **What happened.** Three traps in `.handoff/archive/1.5.0/research/r3/probe-copylast.mjs` (2026-11-15), each caught
  before a number was used: (1) the CALLER column was written as a per-call IIFE, which allocated ~58-64 B per call of
  harness (rung 0 v1, `runs/rung0-check-v1.json`); and v1's BOX must-allocate control read 11.74 B at 20,000 calls per
  window, under the INTAKE's 12 B, so v2 moved to a named function and >= 100,000 calls per window; (2) `reps` was sized
  from the first 2,000 (cold) calls, ~1,500 reps = ~40 us timing samples, and a 30,000-call B/op lane read +-3-6 B per
  call (smoke run, another node at 121% CPU); v3 sizes reps from warmed code and uses >= 100,000 calls per window; (3)
  when copyLast(count) read 1.16-1.59x of the frozen copyTo (rung 2), the frozen column was suspected of being
  privileged (shared module, buffer placement); rung 2b's twins (a second frozen ring, the frozen file as a second
  module) and OWN's identical copyTo read 0.99-1.02 of it: the suspicion was wrong and the gap real (A15).
- **Root cause.** (1) A closure literal in a hot expression allocates a JSFunction per call; a control's threshold
  must be met at the window size used. (2) Cold-code timing is 10x+ slower, so derived sample sizes come out short.
  (3) A ratio against one column cannot tell "this column is fast" from "the others are slow" without a twin of it.
- **Evidence.** `.handoff/archive/1.5.0/research/r3/PROGRESS.md` rung 0 (harness v1 -> v2), "Timed harness prepared",
  rung 2b; `runs/rung0-check-v1.json`, `rung0-check-v2.json`, `runs/smoke.*`, `runs/rung2b.md` (Node v26.8.2, hosts as
  stated there).
- **Law.** 1 (a control must fire at the size used), 4 (a lane must measure the code it claims, not the harness).
- **Gate.** None (research harness). A probe column calls named functions only; reps are sized after warm-up; a
  reference column that decides a kill rule gets a twin (A/A of the reference, not only of the candidate).

### D13. A method-vs-method ratio measured the caller's inlining budget, not the bodies (R3-M1)

- **What happened.** The R3 research and the R3 strict A/B read copyLast(count) at 1.15-1.17x / 1.52-1.76x of copyTo
  (Float32 1024, h0 / h768) and attributed the gap to copyLast's body ("every body whose inlined check helper carries
  copyLast's n check and min is slow"). R3-M1 rung 1 then moved those checks out of the helper and saw no change -- an
  ablation that left the graph roughly the same (reading: the helper is inlined into the body either way) and the chain
  on the same side of the reserve (791 -> 799 / 806 B). Rung 2 found the real variable: whether the method is inlined
  into the benchmark's driver (A15 R3-M1 addition).
- **Root cause.** Both columns time "driver -> method", and V8 inlines the method into the driver only while its inlined
  chain fits the cumulative reserve (920 / 1.2). Two bodies on either side of that line differ by the cost of the
  non-inlined compile (cause not isolated; rung 3b not run), which here scales with the work inside (~8 ns to ~86-92
  ns), so a byte-level change anywhere in the chain can move the ratio by 1.5x. Relocating code into an inlined callee
  leaves the graph roughly the same (reading) but changes the chain's bytecode size, which decides caller inlining.
- **Evidence.** `.handoff/archive/1.5.1/research/r3-m1/PROGRESS.md` rungs 1, 2, 3a; `runs/rung2-trace/` (default / 2400
  / 300 / slim2 / slim traces); `runs/rung1-*`, `runs/rung2-*`, `runs/rung3a-*` (2026-11-15, hosts as stated there,
  PRELIMINARY).
- **Law.** 12 (scope a measurement: name what the driver inlines), 13.
- **Gate.** None (research). A speed comparison between two methods records `--trace-turbo-inlining` for each driver
  and reports the cumulative chain size of each side first; an ablation tests code cost only if both sides stay on the
  same side of the reserve.

### D14. A research variant was called behaviour-equal on a matrix that never ran the shipped suite (R3-M1 -> M1)

- **What happened.** R3-M1 rung 3a reported SLIM2 (e20476df) as matching 1.5.0 on 260,580 cases (`check.mjs`), with the
  storage, cache-hit and frozen-ring paths listed as not covered. The M1 planner read the shipped tests against SLIM2's
  `lastStateError` and found that it re-reads `data`'s buffer instead of using the `buf` the hot body compared, so on a
  cache hit with a poisoned `_buf` it throws the storage RangeError where 1.5.0 throws the alias RangeError. Running
  test/copylast.test.js on SLIM2 in an overlay confirmed it: 18 / 19 pass, the poisoned-cache test (lines 419-431)
  fails.
- **Root cause.** A research behaviour matrix covers only the rows it generates; the shipped suite already pinned the
  uncovered path, and nobody ran it on the variant. The claim review checked the matrix, not the suite.
- **Evidence.** `.handoff/archive/1.5.1/M1/evidence/t0/c-overlay-copylast.log` (overlay of SLIM2 e20476df, 2026-11-15,
  Node v26.8.2); `.handoff/archive/1.5.1/M1/PLAN.md` SPEC; `.handoff/archive/1.5.1/research/r3-m1/PROGRESS.md` rung 3a
  (the uncovered-path note).
- **Law.** 1, 2 (an unverified path is not "equal").
- **Gate.** `.handoff/archive/1.5.1/M1/gate/parity.mjs` (unit gate; parked with M1) has poisoned-cache, storage and
  frozen-ring rows and uses SLIM2 as a must-fail control. A research variant that claims behaviour parity also runs the
  full shipped suite in an overlay before the claim is made.

### D15. A stage-H oracle missed the candidate's own decision boundary, and a stateless oracle missed shared state (R3-M2)

- **What happened.** (1) The first stage H (19,836 rows) had n {2, -1, 1.5, NaN, '1', 100, undefined} and dstOffset
  {0, -1, NaN, 5}: no n 0 / -0 and no dstOffset -0, exactly where candidate C's cold builder decides whether the hot
  body asked `instanceof` (`n >= 0`). The claim review's mutant ME (`n > 0`) passed the full oracle while calling the
  hook twice on `copyLast(f32 of 3, 5, 0)` (and throwing dstTypeError under a flip hook). (2) GLB_S_MIN and GLB_O_MIN
  passed stage H at 0 mismatches although they keep the hot `instanceof` answer in module state: only the separate
  `reentry.mjs` probe, where a replaced `Number.isInteger` re-enters copyLast, showed them throwing the wrong error.
- **Root cause.** (1) The row lists were copied from the shapes 1.5.0's checks care about, not from the variant's own
  new branch conditions. (2) Each stage-H row is one call with fresh state; a design with cross-call state needs rows
  that interleave calls inside the window where that state is live.
- **Evidence.** `.handoff/archive/1.5.1/research/r3-m2/review/` (mutants, `parity-m2-n0.mjs`, `probe-n0.mjs`),
  `runs/h-only-ME-n0.json` (1,224 mismatches after the fix), `runs/reentry.json`; PROPOSAL-r3-m2 section 7 (2026-11-15,
  Node v26.8.2).
- **Law.** 1 (a control must fire on the variant's own boundary), 2.
- **Gate.** `parity-m2.mjs` NS_H / OFFS_H include 0, -0 (and -0 offset); Q-M2-TEST A ports those rows and the O3
  re-entry outcome rows into `npm test` with revert checks on mutants ME and MA. A research oracle for a variant adds
  rows at each new branch condition the variant introduces, and re-entrancy rows for any state that outlives a call.

### D16. One of three compilations can read ~1.18-1.19 on a row with no gap (M1 unpark strict A/B)

- **What happened.** Both strict runs of the M1 unpark A/B (cand 9e70b525 vs ref 9765c21e, each `quiet-lock run
  --strict` exit 0, host QUIET) had exactly one slow compilation, on a different row each time: strict-1 Float32 1024
  h768 compilation medians 1.016 / 1.181 / 1.007 (row median 1.017, Q3 1.174); strict-2 Float64 1024 h768 1.193 / 1.001
  / 1.001 (row median 1.00, Q3 1.19), a row that showed no gap in 1.5.0 either. strict-2's Float32 h768 row read 1.046 /
  1.010 / 0.998. A rule on "every compilation median <= 1.05" of one run would have failed strict-1 on the row the fix
  targets and strict-2 on a row it does not target (Float64, no gap in 1.5.0; the trimmed lastCheck runs on it too);
  those two rows' medians are <= 1.017 in both runs (every row median of both runs <= 1.02).
- **Root cause.** A compilation is one process with its own tier-up order and inlining decisions (A15: the frozen
  build's inlining result depends on tier-up order); 21 rounds share that one outcome, so a per-compilation median is a
  sample of size 1 of the compilation outcome, not of the timing. Not traced which decision differed in the slow
  compilation.
- **Evidence.** `.handoff/archive/1.5.1/M1/ab/strict-1/ab.json`, `.handoff/archive/1.5.1/M1/ab/strict-2/ab.json`
  (2026-11-15T05:55Z / 06:08Z, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, load1 1.09 -> 1.66 / 2.20 -> 1.73 vs
  baseline 2.21, K 21 x 3 compilations); RULING Q-M1-STRICT A (A15).
- **Law.** 5 (a measured number enters docs from this cycle's run logs: here, both runs).
- **Gate.** None (STATISTICAL, by hand). A strict A/B verdict is ruled on row medians; every run is recorded, and docs
  cite each run with any slow compilation stated, each claim the lower of the runs. Reopen if a later strict run shows a
  slow compilation on the same row in two runs in a row (then it is a mode, not noise: trace it).

### D17. A trivial accumulating callback measured per-compilation modes, not the walk (M1 research)

- **What happened.** The M1 research burst (ROADMAP Parked M1, A7; not the "M1 unpark unit") timed `forEach` with a sum
  callback (`ACC[0] += v`). The masked body ran in two per-compilation modes, ~1.79 vs ~0.68 ns per element
  (`.handoff/archive/1.5.3/research/m1-twospan/PROGRESS.md`, rung 1; all PRELIMINARY: host noisy, a LiteSignal
  `--jitless` node at 100-127% CPU). Identical bodies in one process read 0.38 or 2.6 of each other at 8192: rung 1 A/A
  (REF_AA / REF) 0.456 [0.382..2.566] h0 (`runs/rung1/ab.md`, K 21 x 3, exit 3 VOID); sum6 A/A 0.393 [0.382..1.001] h0
  and 2.580 [1.004..2.641] wrap (`runs/rung1b/sum6/ab.md`, K 21 x 6, exit 3 VOID). At 1024 the candidates read C1/REF
  0.379 h0 / 0.428 wrap (rung 1) and 0.380 / 0.430 (sum6): those "wins" were C1 reaching the fast mode where REF did not
  (REF in the slow mode in 12 / 12 sum6 compilations at 1024). On a fast-vs-fast pairing C1/REF read 0.983
  [0.975..0.994] (8192 wrap, 4 of 6 compilations). The same walks on a `store` callback (`OUT[i] = v`) showed NO modes
  (REF / REF_AA 0.326-0.346 ns per element in all 12 compilations of `runs/rung1b/store/ab.md`, PRELIMINARY) and gave
  the strict verdict recorded in A7.
- **Root cause.** NOT found. Ruled out with evidence (`diag-sum/diag.md`, 6 compilations x 4 rows, optimized code of
  all 120 driver compilations printed): accumulator in a register (ACC loaded, added and stored per element in BOTH
  modes; the rung 1 hypothesis is refuted), OSR (no driver OSR-compiled), callback not inlined (no call in any inner
  loop), deopt cycles (no driver bailout; forEach bailouts 0-36 do not track the mode), data address (`exp-align.mjs`,
  `align-v2 --same-ring 1`: 1-2 of 16 identical drivers on the SAME data still run slow; 17 / 192 driver runs slow;
  `align-gc` 6 / 96). 36 / 36 masked-body (REF / REF_AA / SLOW) compilations ran fast under
  `--no-turboshaft-loop-unrolling` (`diag-sum-nounroll`) but one `exp-align` driver read 3.10 ns without unrolling
  (`align-v1`): suggestive, not a clean condition. Open: REF at 1024 is slow in 6 / 6 (rung 1), 12 / 12 (sum6), 12 /
  12 (diag-sum) compilations but 6-12% at 1024 in `exp-align`; untested differences: one module per column, BOX in the
  interleaved warm-up, the B/op lane. A per-code-address CPU effect is an untested hypothesis. Separately, a property
  of the harness (not tested against the modes): the drivers hold the ring as a closure constant, so TurboFan folds
  the mask (`#0x3ff`) and bound
  (`#0x400`), which is more specialised than a production caller.
  - **Evidence.** `.handoff/archive/1.5.3/research/m1-twospan/PROGRESS.md`; `runs/rung1/ab.md`
    (2026-11-15T07:47:03Z-07:50:29Z); `runs/rung1b/sum6/ab.md` and `modes.md`; `runs/rung1b/diag-sum/diag.md`;
    `runs/rung1b/store/ab.md` (2026-11-15T08:12:12Z-08:14:06Z); strict `runs/strict/store-1/ab.md`
    (2026-11-15T16:19:54Z-16:21:42Z) and `runs/strict/store-2/ab.md` (2026-11-15T16:21:42Z-16:23:32Z). All sum-callback
    runs are PRELIMINARY. All: HEAD 55b6ea9 / RingBuffer.js sha256/8 90f7ad7c, Apple M4 Pro (12 cores), Node v26.8.2 /
    V8 14.6.202.34-node.28, one run each; load1 1.80 -> 2.63 (rung 1), 2.24 -> 2.63 (diag-sum, 08:02:45Z-08:09:40Z),
    2.33 -> 2.62 (sum6, 08:14:06Z-08:20:59Z), 2.43 -> 2.33 (store), baseline 2.21.
- **Law.** 5 and 12. Lesson: a workload whose per-element cost can shift between two modes per compilation cannot
  carry an A/B verdict; per-compilation medians plus an A/A twin catch it; use a store callback.
- **Gate.** None (STATISTICAL harness self-check: the A/A twin and the per-compilation mode report in `ab-foreach.mjs`,
  a research harness under `.handoff/archive/1.5.3/research/m1-twospan/`, not in `npm test`). Reopen only with a
  mechanism found for the modes and shown by a clean condition (a run where the mode flips with the condition and with
  nothing else).

### D18. count.mjs's node:test run() event model is absent on Node 18 / 20, and "Node >= 24 has total_allocated_bytes" was false (Track Q1)

- **What happened.** Two portability claims failed when the Q1 CI lane was probed on other engines (local runs
  2026-11-16, untimed, arm64, npm `node@N` binaries). (1) `test/count.mjs` counts through `node:test` `run()` events
  (`details.type`, `test:summary`); on Node 18 / 20 that model is missing and a run reads pass 0, so `test:core`
  (`test/core.mjs`) counts the TAP summary of each file's own child instead (v18.20.8 206 / 206, v20.20.2 206 / 206,
  v22.23.5 / v24.22.3 / v26.8.2 247 / 247). (2) README.md and llms.txt said the other dev scripts need Node >= 24 for
  V8's `total_allocated_bytes`; the counter was seen on v26.8.2 only (absent on v18.20.8 / v20.20.2 / v22.23.5 /
  v24.22.3), so `npm run alloc` needs the counter. Corrected in the docs (CHANGELOG
  [Unreleased]); D1 carries the same correction.
- **Root cause.** The suite's gate was only ever run on the pinned engine (Node v26.8.2); a claim about other engines
  was written from the version a feature was expected in, not from a run (law 5).
- **Evidence.** HEAD 834dab9 + the Q1 working tree; logs `.handoff/archive/1.5.6/q1/evidence/` (core-v<version>.log per
  engine, 0c-n{20,22,24}-{1,2,3}.log, fix-torture-n18.log, ev-types-n18.log / ev-types-26.log, teeth.log,
  engine-features.log, review mutants review/*.out) of the 2026-11-16 local runs (test:core exit 0 on v18.20.8 /
  v20.20.2 / v22.23.5 / v24.22.3 / v26.8.2; test:types exit 0 on v18.20.8 and v26.8.2; torture 3 runs each exit 0 on
  v20.20.2 / v22.23.5 / v24.22.3, exit 1 on v18.20.8, CONTROL lane profiler blind). The CI workflow had not run
  on GitHub then; first hosted run 43773037509 (push of 82cd5dc) passed all 12 legs (CHANGELOG 1.5.6).
- **Law.** 1, 2, 5.
- **Gate.** `test/core.mjs` (header; teeth by mutants in temp copies, all non-zero exits: deleted file, +1 test,
  `it.skip`, top-level throw, unclassified FILES entry, unparseable EXPECTED (exit 2), feature guard on Node 22 with
  `transfer` deleted, timeout, maxBuffer, spawn ENOENT); `.github/workflows/ci.yml` named SKIP steps (alloc on
  18 / 20 / 22 / 24 prints whether the engine has the counter, printed not gated). Reopens if the CI matrix changes an
  engine or a claim about another engine is made without a run on it.

### D19. `total_allocated_bytes` counts V8 heap only; off-heap typed-array stores are invisible (Q2 B0 F1)

- **What happened.** The B0 scratch probe of the Q2 bench read `new Float32Array(n)` at ~215-285 B/op for n 8..1024 (B0
  scratch, SPEC A7; nominal, no run log): expected to be the object headers only, not the n * 4 byte store (UNVERIFIED:
  V8 may keep a store of <= 64 B, i.e. n 8 / 16, on-heap, in which case those copies would count in full). A B/op or
  B/frame figure therefore cannot say "total bytes", and an allocating `toArray` into a typed array looks small in it
  (SPEC A7).
- **Root cause.** The counter (V8 `total_allocated_bytes`, D1 / law 4) is a heap counter; ArrayBuffer backing stores
  live off-heap.
- **Evidence.** HEAD 82cd5dc + the Q2 working tree; `.handoff/archive/1.5.6/q2/SPEC.md` A7; REPORTED run
  `.handoff/archive/1.5.6/q2/strict-1/compare-gc.md` (2026-11-16T01:16Z, Node v26.8.2 / V8 14.6.202.34-node.28, QUIET,
  load1 2.81 at the lock): MN_ARR 200.87 B/frame (n 64; 8 minor, 0 major) and 203.37 (n 1024; 7 minor, 9 major), CTL
  201.29 (8 minor, 0 major) and 203.14 (7 minor, 7 major). gitignored paths.
- **Law.** 3, 4 (a B/op claim names its resolution and its scope: heap bytes).
- **Gate.** `test/bench/compare-gc.mjs --self-test` (197 checks): CTL teeth are minor >= 1 AND raw B/frame >= 128 at
  every n (rows `CTL n64 / n1024 B/frame 127.99 -> 1`, `B/frame 128 -> 0`, `minor 0 -> 1`); the memory lane keeps the
  `arrayBuffers` term (`control mem: F32H n1024 perInstB 300 -> 1`). Docs say "V8 heap bytes only" once per table and
  use the GC counts as the off-heap witness; `abDelta` is a retained gauge, never an allocation witness.

### D20. The counter read has a floor (0.18-5.77 B/frame in strict-1); a raw B/frame bound failed on an empty driver

- **What happened.** Two back-to-back `getHeapStatistics` reads differed by ~205-230 KB in the B-child scratch
  (SPEC A10; nominal, no run log), ~5.1-5.9 B/frame at 40,000
  frames; an empty driver read nonzero and a raw `< 8` bound on RingBuffer sat next to its own noise floor (SPEC A10).
  Review r1 (group B) then found the netted calibration term itself was unbounded: a floor of 99 would have let an
  allocating RingBuffer pass as "net < 8" (SPEC A12).
- **Root cause.** The measurement instrument has a nonzero, per-window-varying cost (law 5: the floor is measured, not
  assumed fixed); a subtraction with an unbounded subtrahend gates nothing (law 1).
- **Evidence.** HEAD 82cd5dc + the Q2 working tree; `.handoff/archive/1.5.6/q2/SPEC.md` A10 / A12;
  `.handoff/archive/1.5.6/q2/review-r1/`; `.handoff/archive/1.5.6/q2/strict-1/compare-gc.md` (RB floor 5.72 / 5.76, net
  -0.07 / -0.07 B/frame; other cells 0.18-5.77). gitignored paths.
- **Law.** 1, 4, 5.
- **Gate.** `test/bench/compare-gc.mjs --self-test`: the RB cell is VOID unless 0 <= floor < 8 AND net < 8; rows
  `RB n64 / n1024 floor 99 (bpf 50) -> 1`, `floor 8 (bpf 8) -> 1`, `floor -0.5 (bpf 0) -> 1`,
  `bpf 20 floor 14 (net 6) -> 1`, `net 8 (14 - 6) -> 1`, and the in-bound `floor 7.99` rows -> 0.
  md shows raw, floor and net.

### D21. mnemonist `CircularBuffer.forEach` boxes 16 B per element per call (Q2, REPORTED)

- **What happened.** The mnemonist column's copy rows read 511.96 B/op at n 32 and 16383.12 B/op at n 1024 for `forEach`
  with a hoisted store callback. Review proved the cause: its loop calls `callback.call(scope, item, i, this)` and that
  call boxes the float; a direct loop over its items with the same callback read 0 B (review r1 scratch,
  `.handoff/archive/1.5.6/q2/review-r1/VERDICTS.md`; not a strict-1 figure); the GC lane's MN_EACH cells read 1025.42
  B/frame at n 64, 16385.00 at n 1024 (40 / 625 minor GCs). `toArray()` allocates a new array per call (MN_ARR / MN_TA).
- **Root cause.** A non-inlined call boundary on a fractional value (the zero-box rule), in the competitor, not here.
- **Evidence.** `.handoff/archive/1.5.6/q2/strict-1/compare.md` (copyto32 / copyto1024 MN rows) and `compare-gc.md`
  (MN_EACH, MN_ARR rows); one strict QUIET run, 2026-11-16T01:13Z..01:16Z, Apple M4 Pro, Node v26.8.2 / V8
  14.6.202.34-node.28, load1 2.81 at start / 3.75 at end, K 21 x 3 compilations; mnemonist 0.40.8 (sha256/8 029daecd).
  gitignored paths.
- **Law.** 5 (a REPORTED figure of a competitor, with provenance, worded as a measurement).
- **Gate.** None (REPORTED, no bound; MN_EACH / MN_ARR are ungated in the judge). What is gated is the pin:
  `test/bench/mn-pin.mjs` (exact version 0.40.8 + sha256 over the 7 loaded files; a drift makes the lane VOID) and the
  child's sha8 checks in the `accept` self-test rows.
