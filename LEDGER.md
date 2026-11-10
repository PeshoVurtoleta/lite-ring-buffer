# lite-ring-buffer -- the consolidated ledger

*Every design refused, every defect found and fixed, every gate that had to be given teeth,
every measurement trap, and the laws each one produced. This is the evidence base the package
roadmap builds on. Nothing here is re-litigated without a **new mechanism** clearing **every**
gate the entry names.*

Scope: `@zakkster/lite-ring-buffer` (RingBuffer, ceilPow2). Sources: `git log`, `CHANGELOG.md`,
`ROADMAP.md`, `.handoff/HISTORY.md`, `.handoff/D/PLAN.md`, `.handoff/D2/PLAN.md` and the evidence
dirs under them (all `.handoff/` is gitignored), the headers of `test/alloc.mjs`,
`test/torture.mjs`, `test/count.mjs`, and the auto-memory note `alloc-gate-total-allocated-bytes`.
Numbers are copied from those sources as they state them; a number with no date / host / run
count there carries none here either, and says so.

Commits cited: 4dd231b (initial, 2026-06-30), 1a5a294 (1.1.0, 2026-10-08), e3e1df1 (audit fixes +
alloc gate, 2026-10-14), 0412025 (1.2.0, 2026-10-14), 1d6e368 (unit D, 2026-11-10), b6a8310
(unit D2, 2026-11-10). Unit D was first committed as c2c28e0 (still named in `.handoff/HISTORY.md`); the maintainer amended it to
1d6e368 only to drop a trailer (trees identical, `git diff c2c28e0 1d6e368` empty). Not a conflict.

## How to read this file

- Section 0 (the laws) first. Each law cites the entries that prove it.
- Entries are IDs, not a single running number: `A<n>` refused / parked designs, `B<n>` defects
  found and fixed, `C<n>` gate evolution (gates that had to be given teeth), `D<n>` measurement
  traps. Within a section, entries are in rough chronological order. "Unit D" and "unit D2" mean
  the ROADMAP units of those names; `D1`..`D5` are entries in section D of this file.
- Every entry has: what happened, root cause, evidence (commit sha from `git log` plus a file or
  `.handoff` path), the law it produced, and the gate that now holds it (file name + test / lane
  name). A claim with no findable sha or path says `evidence: NOT FOUND` (none remain).
- `.handoff/` is gitignored: those paths exist only in the maintainer's main checkout.
- Tiers: DETERMINISTIC gates run in `npm test` / `npm run verify` every time; STATISTICAL gates run
  once per release on a quiet host; REPORTED numbers gate nothing. This package has no STATISTICAL
  gate yet (the R1 timed A/B is PENDING).

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

1. **A gate that cannot fail is not a gate.** Every gate needs a must-fail control that fails for
   its own reason (test/count.mjs has none committed yet; its controls are scratch under
   `.handoff/D2/mut/`), and every comparison is written so NaN fails it. *(A6, B1, C1, C2, C3, C5, C6, C7,
   C8)*
2. **Fail closed on every unverified state, including the harness.** A zero-match glob, a missing
   path, a missing `files[]`, a missing summary event, a missing `global.gc` and a NaN counter each
   passed silently once. *(B1, C1, C2, C3, C6, C8)*
3. **A zero-GC claim names its resolution.** GC counts prove "less than res B/op", not 0 B/op;
   the per-op byte gate is `test/alloc.mjs`. *(A6, C4, D3, D4)*
4. **Measure allocation with the counter that sees transient boxes.** V8 `total_allocated_bytes`,
   not a `heapUsed` delta; steady state is the minimum over windows 1..W-1, never window 0, and a
   lane must run in optimized code. *(B2, C8, D1, D2, D3)*
5. **Measured numbers enter docs from a run log of this cycle; an estimate is "nominal".** A figure
   derived from another measurement is not a measurement. *(B4, C9, D4)*
6. **A status line names a run that exists on the final tree.** A verify that hit a BUSY lock, ran
   unlocked and predated the final code is not "closing verify PRELIMINARY". *(C9)*
7. **A doc claim about allocation is a claim about every caller path.** "Zero allocation" holds only
   for the paths the gate lanes cover; `copyTo` above 32 samples and `get(i)` allocate and the docs
   say so. *(A1, B2, B4, B5, B6)*
8. **General O(1) structures belong to lite-o1; this package is the Float32 telemetry ring** that
   feeds lite-canvas-graph and lite-stats-math. A feature that does not serve that pipeline is
   refused. *(A1, A2, A3, A4, A5)*
9. **Float32 `data` stays monomorphic and a field never widens to `Any`.** No Float64 or shared
   storage mode; `destroy()` keeps a typed (shared empty) array, never `null`. *(A3, A4, B3)*
10. **NaN is data here; null is not zero.** `push(NaN)` is stored and read back so a telemetry gap
    reaches lite-stats-math; a bad `dst` throws, a NaN bound never passes. *(A5, B1)*
11. **A test-count floor is part of `npm test`.** An emptied, skipped, crashed or early-exiting test
    file must fail the run. *(C5, C6)*
12. **Scope every measurement run explicitly.** A run that globs the package root also reads frozen
    copies under `.handoff/`. *(D5)*
13. **Every refusal names why, and a parked item names its unpark condition.** *(A1..A7)*

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
- **Evidence.** ROADMAP.md "Rejected"; commits 1d6e368 / b6a8310 carry it (ROADMAP.md was untracked until 1d6e368). The 16 B figure is from
  the e3e1df1 / 0412025 alloc gate (Node 26.8.2 arm64, 2026-10-14).
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
- **Root cause.** 7 minor GCs at 2M ops can fall to 0 if V8 grows new space: a flake in the
  deterministic tier. The torture log of this cycle shows `REPORTED get(i)` 2000000 ops, minor 7,
  16.2 B/op (`.handoff/D2/qa/q3-torture-batch.txt`, 2026-11-10 07:50Z, Node v26.8.2, quiet-lock free, host PRELIMINARY load1 3.63 vs baseline 2.21).
- **Evidence.** b6a8310; `.handoff/D2/PLAN.md` (R-4); `.handoff/D2/qa/q3-torture-batch.txt`;
  `test/torture.mjs` header.
- **Law.** 1, 3, 13.
- **Gate.** `test/alloc.mjs` `CONTROL get(i), one 16 B box` is the deterministic tooth.

### A7. PARKED (not refused): M1, M2, R4

- **What happened.** Parked 2026-11-10 (maintainer scope trim), each with an unpark condition.
  M1 two-span `forEach` / `copyTo` loop: adopt only on a STATISTICAL win (interleaved A/B at 1024
  and 8192 samples, quiet host, must-fail control); if not run by the release after R3, record a
  null result and drop it. M2 `forEachNewest(fn)`: no consumer needs it (EMA and decay weights can
  be computed oldest-first); unpark when lite-canvas-graph trails asks. R4 `RingBank(rings,
  capacity)` (N rings in one Float32Array): its only driver is the ShellyProject fleet case;
  unpark only when ShellyProject is committed and names RingBank as a dependency, then a research
  burst and a ruled PROPOSAL first.
- **Root cause.** No consumer or no measured win; "an engine detail is not a reason to ship code".
- **Evidence.** ROADMAP.md "Parked"; b6a8310.
- **Law.** 13.
- **Gate.** None.

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
- **Gate.** `test/RingBuffer.test.js` copyTo cases (counted by `test/count.mjs`, 59).

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

### B4. `copyTo` above 32 samples allocated 104 / 208 B (R1, partly fixed)

- **What happened.** `set` + `subarray` allocated one 104 B view per ring half: 104 B contiguous,
  208 B wrapped. At <= 32 samples `copyTo` now uses a scalar loop: 0 B. Larger copies keep the
  memcpy path and its views; the JSDoc, `.d.ts` and README state the allocation. The cutoff of 32
  (`COPY_LOOP_MAX`) is nominal: the loop's speed against memcpy at that size has not been measured.
  The companions copy capacity-sized scratch (typically 1024), so they still allocate: ROADMAP R1
  is open.
- **Root cause.** `TypedArray.set` takes no source offset / length; the only allocation-free bulk
  copy over a ring half is a JS loop.
- **Evidence.** e3e1df1 / 0412025; `CHANGELOG.md` [1.2.0] Changed; `.handoff/HISTORY.md` 2026-10-14
  release burst: `copyTo 33 contig 103.8 B/op`, `copyTo 64 wrapped 207.9 B/op` (Node 26.8.2 arm64,
  load average 4.11, one run); ROADMAP.md R1 (the "10-20 MB/s at fleet scale" line there is NOMINAL
  arithmetic, not a measurement). The scalar-loop-vs-`set` timing is PENDING (no quiet window ran).
- **Law.** 5, 7.
- **Gate.** `test/alloc.mjs` lanes `copyTo 32, contiguous`, `copyTo 32, wrapped` and
  `copyTo 32 -> Float64Array, wrapped` (gated, < 1 B/op). The `copyTo 33` / `copyTo 64` set-path
  lanes are REPORTED (`'report'`) and never gated. R1 adds 1024 lanes when it lands.

### B5. README: "Each stage holds zero allocation in steady state" was false

- **What happened.** The README Companion libraries / Ecosystem diagram said the pipeline stages
  hold zero allocation in steady state. `lite-stats-math` (`compute`, `quantile`) and
  `lite-canvas-graph` (`render`) call `copyTo` with a capacity-sized scratch, so once the ring holds
  more than 32 samples each call allocates 104 B contiguous or 208 B wrapped. Found 2026-10-14 (the
  audit left it "unchecked", then the ROADMAP R1 finding checked the callers); the README now says
  so.
- **Root cause.** A claim written about the ring's entry points, not about how the callers use it.
- **Evidence.** 0412025; `CHANGELOG.md` [1.2.0] Docs; ROADMAP.md R1 (callers at
  `LiteStatsMath/StatsMath.js:59,103`, `LiteCanvasGraph/CanvasGraph.js:157`).
- **Law.** 7.
- **Gate.** None automated. The README line as it stands (states 104 / 208 B) plus the R1 alloc lanes (1024 contiguous / wrapped) when R1 lands.

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

---

## C. Gate evolution (gates that had to be given teeth)

### C1. `node --test test/*.test.js` failed OPEN

- **What happened.** On Node >= 22 a zero-match glob prints `tests 0` and exits 0; an explicit
  missing path exits 1. A reviewer (unit D, batch B1) returned a DESIGN REJECT; the planner delta
  D-A2 names the file: `node --expose-gc --test test/RingBuffer.test.js`.
- **Root cause.** The harness, not the code, failed open on "nothing ran".
- **Evidence.** 1d6e368; `.handoff/D/PLAN.md` addendum D-A2; `.handoff/D/b1/ctl-missing` (missing
  path exits non-zero, "Could not find") and `.handoff/D/b1/ctl-oldglob` (empty dir + glob exits 0,
  tests 0); exit codes also in `.handoff/D/b1/evidence.txt`.
- **Law.** 1, 2.
- **Gate.** Superseded by C5 / C6 (`test/count.mjs`).

### C2. The vitest heap smoke test returned silently without `global.gc`

- **What happened.** The 1M-push heap smoke test returned early when `global.gc` was missing, so a
  run without `--expose-gc` passed. It now asserts `typeof globalThis.gc === 'function'` (fails,
  not skips); `npm test` passes `--expose-gc`.
- **Root cause.** A skip path that reads as a pass.
- **Evidence.** 1d6e368; `.handoff/D/b2/no-expose-gc-control.txt`; `.handoff/D/PLAN.md` addendum
  D-A1 (141 assertion sites = 140 one-for-one + 1 fail-closed gc assert).
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
- **Evidence.** 1d6e368; `.handoff/D/b4/proofs.log` (exit 2 cases, "self-control FAILED (must flag
  U+2014, U+00A9, U+0080, U+1F600 as 4 code points ...)"); `.handoff/HISTORY.md` ("ascii: live 0,
  frozen 45"). b6a8310 flattened the self-control to flat module code (output unchanged).
- **Law.** 1, 2.
- **Gate.** `test/ascii.mjs` self-control; `npm run ascii`.

### C4. GC-count gates have a resolution

- **What happened.** The reviewer's mutant M-rare (about 0.8 B/op net) passed torture (reviewer / coder report recorded in `.handoff/reviews/2026-11-10-findings.md`; no run log on disk; no host / load stated); `test/alloc.mjs`
  caught it (`copyTo` 32 contiguous at 15.8 B/op). So torture `minor 0` proves "less than res B/op",
  not "0 B/op". Torture prints `res=` (CONTROL lane B/op divided by its minor-GC count); docs state
  no value, only that it is nominal and depends on V8 new-space size.
- **Root cause.** A GC count is a threshold on bytes, and the threshold is the new-space size.
- **Evidence.** 1d6e368 / b6a8310; `test/torture.mjs` header (res= definition); `CHANGELOG.md`
  [Unreleased] Tests; M-rare run: `.handoff/reviews/2026-11-10-findings.md` (D B2+B3 reviewer: a box on copyTo's start===0 branch printed GATE ok in torture; alloc.mjs exit 1; reviewer scratch mutant not kept).
- **Law.** 3.
- **Gate.** `test/alloc.mjs` is the per-op byte gate; torture `res=` is printed, never gated.

### C5. An emptied or skipped test file still passed `npm test`

- **What happened.** After C1, an emptied test file still passed: plain `node --test` counted the file
  itself as one passing test (`tests 1`, `pass 1`, exit 0); it also passed a skip file. Ruling R-2 (unit D2): `npm test` = `node test/count.mjs`
  (node:test `run()` over the explicit `FILES`, `--expose-gc`), exact `EXPECTED = 59`, 0 fail, 0
  skip / todo, no failed suite, no empty file. Lost: `--test-name-pattern` passthrough.
- **Root cause.** The count was held by hand in qa, not by the gate.
- **Evidence.** b6a8310; `.handoff/D2/PLAN.md` R-2; `.handoff/D2/evidence/a2-old-plain-empty.txt`,
  `a2-old-plain-skip.txt`, `a2-mut-*.txt`; `.handoff/D2/qa/q2-mut-*.txt` (qa re-run).
- **Law.** 1, 11.
- **Gate.** `test/count.mjs`. Open FILLER: it passes no `run()` timeout, so a never-settling test
  hangs the gate (ROADMAP D2 FILLER).

### C6. `count.mjs` v1 dropped per-file summary events

- **What happened.** A 60th test calling `process.exit(0)` after 400 ms gave `pass 59/59`, exit 0
  (4 of 4 runs on the v1 gate (reviewer / coder report recorded in `.handoff/reviews/2026-11-10-findings.md`; no run log on disk; no host / load stated)). Fix: count file summaries and require them to equal `files.length`.
  With the fix the same mutant exits 1 (3 of 3 runs); without it exit 0 (3 of 3).
- **Root cause.** The gate tallied `test:pass` events and ignored that a file can die before its
  summary.
- **Evidence.** b6a8310; `.handoff/D2/evidence/fix1-dexit-fixed-run1..3.txt` ("count: file summary
  events: 0 (want 1)", `exit=1`) and `fix1-dexit-prefix1-run1..3.txt` (`pass 59/59`, `exit=0`);
  the v1 "4 of 4 runs" figure (a 60th test exiting after 400 ms, 1 summary event instead of 2): `.handoff/reviews/2026-11-10-findings.md` (D2 B1 reviewer round 1).
- **Law.** 1, 2, 11.
- **Gate.** `test/count.mjs` file-summary count. Its must-fail controls are scratch only, not committed:
  `.handoff/D2/mut/*.test.js`, logs `.handoff/D2/evidence/fix1-mut-*.txt` (gitignored).

### C7. Torture retention `trackedMid >= 1` had no teeth

- **What happened.** A half-tracking mutant (2048 of 4096 instances) passed the 1d6e368 harness. Now
  `trackedMid === CYCLES`; message `retention: tracked N of 4096 mid-run (want exact)`.
- **Root cause.** A lower bound of 1 lets a tracker miss almost everything while `live=0` still
  reads clean.
- **Evidence.** b6a8310; `.handoff/D2/evidence/a4-torture-halftrack.txt` (`trackedMid=2048`,
  `exit=1`) and `a4-torture-frozen-halftrack.txt` (old harness); `.handoff/D2/qa/
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
- **Gate.** `test/alloc.mjs` (17 lanes at the unit D closing run (`.handoff/D/verify/verify.log`, 2026-11-10 07:17Z, host PRELIMINARY load1 5.14 vs baseline 2.21, Node v26.8.2)).

### C9. A docs status line claimed a verify that did not exist on the final tree

- **What happened.** A unit D2 docs draft said "closing verify PRELIMINARY" for a verify that had
  hit a BUSY lock, ran unlocked and predated the final code; the reviewer REJECTED it (doc truth).
  The final ROADMAP line names the run: closing `npm run verify` under the quiet lock 2026-11-10
  07:50Z exit 0, host PRELIMINARY (load1 3.63 vs baseline 2.21), Node v26.8.2.
- **Root cause.** A status line written from the plan, not from a log.
- **Evidence.** b6a8310; ROADMAP.md D2 STATUS; `.handoff/D2/qa/q7-verify.txt` (`verify_lock_run_exit=0`,
  "host PRELIMINARY (load1 3.63, baseline 2.21, 12 cores ...)"). The REJECT: `.handoff/reviews/2026-11-10-findings.md` (D2 B2 reviewer: the only D2 verify, 07:24Z, hit a BUSY lock, ran unlocked at load1 31.53 and predated the count.mjs fix; line set to PENDING until qa's 07:50Z locked run).
- **Law.** 5, 6.
- **Gate.** Reviewer doc-truth check; no automation.

---

## D. Measurement traps

### D1. `heapUsed` deltas miss transient boxes

- **What happened.** See C8: 19 MB of real allocation read as 0.96 MB. Use `total_allocated_bytes`
  (Node >= 24): B/op over 1M calls, minimum over windows 1..W-1, empty-loop baseline subtracted;
  noise under 0.3 B/op.
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

- **What happened.** One 2M-op call per lane entered in a low tier and reached TurboFan only by
  OSR part-way through; an empty `SINK[k] += x` loop measured 32-48 B/op (`--trace-opt`, Node
  26.8.2), so the minor count hung on when the background compile landed. Fix: 1000-op calls
  (`CHUNK`) and 300k warmup (`WARM`) outside the window; no budget widened. The same loop read 15-23 minor GCs (`.handoff/reviews/2026-11-10-findings.md`, D B3 coder report, `--trace-opt`).
- **Root cause.** A long single call defeats optimized entry; low tiers box doubles.
- **Evidence.** 1d6e368; `test/torture.mjs` header and lines about `CHUNK` / `WARM` (comment "an empty
  `SINK[k] += x` loop measured 32-48 B/op that way, --trace-opt Node 26.8.2"); `.handoff/D/b3/`
  (provenance: node v26.8.2, torture-live-1..3 unlocked at load1 10.19 / 10.19 / 9.77, baseline
  2.21, PRELIMINARY; GC counts deterministic, maxPauseMs PENDING a quiet window).
- **Law.** 3, 4.
- **Gate.** `test/torture.mjs` (HOT = 2,000,000 ops per lane, 6 gated lanes, control lane minor 49
  at the unit D closing run (`.handoff/D/verify/verify.log`, 2026-11-10 07:17Z, host PRELIMINARY load1 5.14 vs baseline 2.21, Node v26.8.2)).

### D4. `res=` drifts, and a derived number is not a measurement

- **What happened.** `res=` read 2.13 B/op (`.handoff/D2/qa/q3-torture-batch.txt`, 2026-11-10 07:50Z, Node v26.8.2, quiet-lock free, host PRELIMINARY load1 3.63 vs baseline 2.21);
  a second run read 0.53 B/op (half-track run, load1 13-76, unlocked, PRELIMINARY; `.handoff/reviews/2026-11-10-findings.md`, D2 B1 reviewer). The docs therefore state no value and label it nominal. Unit D's committed
  docs (1d6e368: README Testing, llms.txt, CHANGELOG [Unreleased]) said "about 2 B/op", a derivation
  (104.2 B/op x 2,000,000 / 49 minors); unit D qa flagged it as derived, not measured; b6a8310 removed
  the value.
- **Root cause.** `res` scales with V8 new-space size, which grows; and a ratio of two measurements
  is an estimate.
- **Evidence.** 1d6e368 / b6a8310; `.handoff/HISTORY.md` "Next burst -- unit D2" item 2 (the derivation);
  `CHANGELOG.md` [Unreleased] ("nominal ... depends on the V8 new-space size").
- **Law.** 3, 5.
- **Gate.** Reviewer doc-truth check; torture prints `res=` and gates nothing on it.

### D5. A vitest run also picked up the frozen copy under `.handoff/`

- **What happened.** A baseline vitest run also collected the frozen copy of the test file under
  `.handoff/` (a bare `vitest run` reported 118 tests (reviewer / coder report recorded in `.handoff/reviews/2026-11-10-findings.md`; no run log on disk; no host / load stated)). The baseline command now excludes it: `npx vitest run RingBuffer.test.js --exclude
  .handoff/** --reporter=json` -> 59 tests, 59 passed (vitest 4.1.11, node v26.8.2, darwin-arm64,
  HEAD 0412025).
- **Root cause.** An unscoped run globs the package tree, frozen builds included.
- **Evidence.** 1d6e368; `.handoff/D/vitest-baseline.json` (`cmd`, `numTotalTests`).
- **Law.** 12.
- **Gate.** `npm test` names its files explicitly (`test/count.mjs` `FILES`).
