# @zakkster/lite-ring-buffer

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-ring-buffer.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-ring-buffer)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-ring-buffer?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-ring-buffer)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-ring-buffer?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-ring-buffer)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-ring-buffer?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-ring-buffer)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**Pre-allocated, zero-GC circular buffer over a `Float32Array`. Power-of-two capacity. Mask-based wrap. Oldest-first bulk copy.**

One allocation for the lifetime of the buffer. No `Array.shift`, no slicing, no per-frame `new Float32Array`. The `push` hot path is one indexed store, a masked increment and a compare.

```js
import { RingBuffer } from '@zakkster/lite-ring-buffer';

const fps = new RingBuffer(1024);                  // -> capacity = 1024 (already a pow2)

// Hot path -- drop a sample every frame.
function onFrame(dt) {
  fps.push(1000 / dt);
}

// Read out the most recent sample.
fps.peekNewest();           // -> 60.0

// Bulk-copy the entire window into your renderer / stats engine.
const window = new Float32Array(fps.count);
fps.copyTo(window, 0);      // window[0] is oldest, window[count-1] is newest
```

---

## Contents

- [Why](#why) | [Install](#install) | [Quick start](#quick-start)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Edge cases & guarantees](#edge-cases--guarantees)
- [Testing](#testing)
- [Companion libraries](#companion-libraries)
- [FAQ](#faq) | [License](#license)

---

## Why

You're sampling something -- frame times, audio levels, mouse velocity, network RTT -- and you want a sliding window of the last N values to render, average, or quantile.

The code you write first looks like this:

```js
// The first draft, and the version that bites you in production
const samples = [];
function pushSample(v) {
  samples.push(v);
  if (samples.length > 1024) samples.shift();   // O(n), per frame
}
```

Two problems compound at 60 fps:

1. `Array.shift()` is **O(n)** -- every frame you re-index 1023 elements just to drop the front one.
2. The array is a *generic* JS array, here the naive `push` / `shift` one above (not a preallocated Array ring; see [Comparison (REPORTED)](#comparison-reported) for how that differs). Growth and shrink can trigger fresh allocations, elements-kind and shape transitions, and boxing when values leave the packed-double path; the GC sees a moving target.

`@zakkster/lite-ring-buffer` collapses both costs:

```mermaid
flowchart LR
    subgraph N["Naive Array"]
        direction TB
        N1["push: amortized O 1<br/>but resizes; can box"]
        N2["shift: O(n)<br/>re-indexes all elements"]
        N3["read: by value<br/>property access on objects"]
        N1 --> N2 --> N3
    end
    subgraph R["RingBuffer (this library)"]
        direction TB
        R1["push: 1 store + 1 AND<br/>zero alloc"]
        R2["wrap: head & mask<br/>O(1)"]
        R3["copyTo: masked loop, or set + rotate<br/>for full Float32 rings > 32; 0 B (<= 4 dst classes)"]
        R1 --> R2 --> R3
    end
```

The buffer is a `Float32Array` so reads and writes are unboxed `number -> IEEE-754 float32` round trips -- the same memory representation a GPU vertex buffer or a `<canvas>` waveform expects.

---

## Install

```bash
npm i @zakkster/lite-ring-buffer
```

ESM-only. No dependencies. Ships TypeScript definitions alongside the source.

```js
import { RingBuffer } from '@zakkster/lite-ring-buffer';
```

You can also drop `RingBuffer.js` into your project directly -- it's one file with no imports.

---

## Quick start

### Telemetry window

```js
const frameTimes = new RingBuffer(512);

function tick(dt) {
  frameTimes.push(dt);
}

// Display the recent window in some UI.
function render() {
  const newest = frameTimes.peekNewest();
  const oldest = frameTimes.peekOldest();
  // ...
}
```

### Streaming into a stats engine

```js
import { RingBuffer } from '@zakkster/lite-ring-buffer';
import { StatsMath }   from '@zakkster/lite-stats-math';

const rb    = new RingBuffer(1024);
const stats = new StatsMath(rb.capacity);
const out   = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };  // hoisted, reused

function onSample(v) {
  rb.push(v);
}

function readout() {
  stats.compute(rb, out);
  return out;   // mutated in-place, no allocation per call
}
```

### Batch ingest

`pushBatch` takes a whole chunk (an audio block, a socket frame) in one call. The result is the state of the same samples pushed one by one (values round through float32; NaN payload bits unspecified).

For a few samples per call a loop of `push` is faster. Timing is STATISTICAL and REPORTED, not gated: in one strict interleaved A/B run (`npm run bench:pushbatch`, 2026-11-14T21:17Z, Apple M4 Pro, Node v26.8.2, host QUIET at start, load1 3.17 -> 3.57, baseline 2.21, 21 rounds x 3 compilations = 63 paired rounds per config) a `push` loop won at 1 and 8 samples per call and `pushBatch` won at 32 and 128, for Float32Array and Float64Array `src` alike; the crossover between 8 and 32 was not measured.

```js
import { RingBuffer } from '@zakkster/lite-ring-buffer';

const rb    = new RingBuffer(1024);
const chunk = new Float32Array(128);     // allocated once, refilled by the producer

function onBlock() {
  // ... fill chunk ...
  rb.pushBatch(chunk);                   // -> 128; srcOffset 0, count chunk.length
  rb.pushBatch(chunk, 32, 64);           // samples 32..95 only -> 64
}
```

### Streaming into a `<canvas>` waveform

```js
import { RingBuffer } from '@zakkster/lite-ring-buffer';
import { CanvasGraph } from '@zakkster/lite-canvas-graph';

const rb = new RingBuffer(2048);
const graph = new CanvasGraph(canvas, 600, 200);

function frame(dtMs) {
  rb.push(dtMs);
  graph.render(rb, 33.34);   // expected max ~= 30 fps budget
  requestAnimationFrame(frame);
}
```

Only the last N samples (a sparkline or oscilloscope trace of the newest 120 of a 1024 ring) without copying the whole window:

```js
const out = new Float32Array(120);          // allocate once, reuse every frame
const k = rb.copyLast(out, 0, 120);         // newest min(120, count), oldest-first; returns k
```

---

## How it works

### Power-of-two capacity -> bitmask wrap

The constructor rounds the requested capacity up to the next power of two:

| `requested` | `capacity` | `mask` |
|---:|---:|---:|
| 1 | 1 | 0 |
| 100 | 128 | 127 |
| 1024 | 1024 | 1023 |
| 1025 | 2048 | 2047 |

Wrap-around becomes `head = (head + 1) & mask` -- a single AND instead of a `%` modulo. Measured per wrap step (`wrap-step n1024`), `% capacity` costs 1.784x [1.759..1.829] the `& mask` step at the same power-of-two capacity (1024) and 5.630x [5.583..5.799] at a non-power-of-two capacity (1023); inside a whole hand-rolled Float32Array push (`wrap-push`) the gaps are 1.057x [1.042..1.203] and 3.204x [3.186..3.249]. Provenance: see [Comparison (REPORTED)](#comparison-reported) below.

### Layout

```mermaid
flowchart LR
    subgraph S["data : Float32Array (capacity = 8)"]
        direction LR
        A0["0"] --- A1["1"] --- A2["2"] --- A3["3"] --- A4["4"] --- A5["5"] --- A6["6"] --- A7["7"]
    end
    H[head = 5] -.->|next push lands here| A5
    O[oldest sample] -.-> A5
    N[newest sample] -.-> A4
```

Once the buffer is full (`count === capacity`), `head` chases the oldest sample around the ring. There is no "front pointer" -- the oldest is always at offset `(head - count + capacity) & mask`.

### Oldest-first bulk copy

`copyTo(dst, dstOffset)` writes oldest-first and allocates nothing at any size while its store sites stay within V8's 4-class feedback limit (see the allocation paragraph below). A full Float32 ring of more than 32 samples takes one `set` + `copyWithin` rotation plus a loop over the smaller ring half; every other copy (up to 32 samples, a partly filled ring, any Float64 `dst`) is a masked scalar loop. The diagram shows the two ring halves a copy has to place:

```mermaid
flowchart TB
    subgraph R["Ring (head=5, count=8, capacity=8)"]
        direction LR
        R5["5"]:::oldest --- R6["6"] --- R7["7"] --- R0["0"] --- R1["1"] --- R2["2"] --- R3["3"] --- R4["4"]:::newest
    end
    subgraph D["dst : Float32Array -- oldest-first"]
        direction LR
        D0["[0] = data[5]"] --- D1["[1] = data[6]"] --- D2["[2] = data[7]"] --- D3["[3] = data[0]"] --- D4["[4] = data[1]"] --- D5["[5] = data[2]"] --- D6["[6] = data[3]"] --- D7["[7] = data[4]"]
    end
    R5 -. "half 1: data[5..8] -> dst[0..3]" .-> D0
    R0 -. "half 2: data[0..5] -> dst[3..8]" .-> D3
    classDef oldest fill:#882,color:#fff
    classDef newest fill:#288,color:#fff
```

Allocation is DETERMINISTIC and gated: `npm run alloc` (inside `npm run verify`, 2026-11-12, Node v26.8.2 arm64) measures every gated `copyTo` lane, MEGA lanes included, at <= 0.2 B per call against a < 1 B per call gate. Each of `copyTo`'s three store sites (Float32Array `dst`, Float64Array `dst`, every other element type) allocates nothing until it has seen more than 4 distinct `dst` hidden classes in the process (each subclass, realm and resizable-buffer variant counts as one); past that the site boxes every non-integer sample (one HeapNumber per sample, 16 B on Node 26.8.2 arm64). `copyToFast` is unaffected. `npm run alloc` gates the family split (plus an Int16 must-allocate control) and REPORTS the 5-class Float32 residual. The alias check reads the `dst` buffer once per call; a small (<= 64 B) on-heap `dst` has its ArrayBuffer materialized by that read once (about 32-61 B off-heap per fresh small `dst`, REPORTED from the 2026-11-12 audit), so allocate and reuse `dst` rather than creating one per call. The cutoff of 32 (`COPY_LOOP_MAX`) is nominal. A `dst` that shares the ring's ArrayBuffer throws `RangeError` and writes nothing (1.2.1 silently corrupted a wrapped ring); `set` and `copyWithin` are the %TypedArray%.prototype intrinsics, so a `dst` subclass that overrides them cannot change the result. The scalar loop may quiet a signalling-NaN payload.

`copyToFast(dst, dstOffset)` keeps the 1.2.1 copy (at most two `set` calls over `subarray` views, a memcpy each) with identical validation and errors. It allocates 104 B per contiguous call and 208 B per wrapped call (REPORTED: `npm run alloc` lanes `copyToFast 1024, contiguous` / `wrapped`: 104.0 and 208.1 B/op, same run).

`copyLast(dst, dstOffset, n)` copies the newest `min(n, count)` samples, oldest-first, and allocates 0 B under `copyTo`'s rule: each of its three store sites (Float32Array `dst`, Float64Array `dst`, every other element type) stays typed while it has seen at most 4 distinct `dst` hidden classes in the process. The sites are `copyLast`'s own, not `copyTo`'s, with ONE exception: a full ring copied whole (`n >= count === capacity > 32`) into a Float32Array runs `copyTo`'s `rotCopy`, whose scalar loop is a single store site shared with `copyTo`, so every Float32 `dst` class either method has passed through `rotCopy` counts against that one 4-class budget. `copyLastFast(dst, dstOffset, n)` is the `copyToFast` pattern over the newest `k` (at most two `set` calls over `subarray` views): it allocates one view per ring half it spans and never boxes a sample, whatever the number of `dst` classes. For a whole-window copy `copyTo` is the safe choice (see the timing paragraph below). REPORTED, `npm run alloc` (2026-11-15, Node v26.8.2 arm64): `copyLastFast 120, cap 1024` allocates 104.0 B contiguous and 208.0 B straddling; every gated `copyLast` lane, MEGA lanes included, reads <= 0.2 B per call against the < 1 B gate.

Timing is STATISTICAL and REPORTED, not gated (`npm run bench:copylast`, dev-only, strict quiet lock, not in `verify`, not shipped). Two strict runs (`quiet-lock run --strict`, exit 0 both): strict-1 2026-11-15T05:55:32Z..05:56:50Z (load1 1.09 at start, 1.66 at end) and strict-2 2026-11-15T06:08:14Z..06:09:32Z (load1 2.20 at start, 1.73 at end), baseline 2.21, host QUIET both; Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, K 21 rounds x 3 compilations = 63 paired rounds per row, every timed column 0.00 B/op, candidate 9e70b525 vs reference 9765c21e. Against the caller workaround (`copyTo` the whole window into a capacity-sized scratch, then copy its last n), on a full 1024 ring, `copyLast` is 2.1x faster (Float32) / 2.2x (Float64) at n 120 and 1.5x (Float32) / 1.2x (Float64) at n 512 (each claim is the minimum over both head layouts and the lower of the two strict runs). Parity, `copyLast(dst, off, count)` / `copyTo`, median [Q1..Q3], strict-1 ; strict-2: Float32 1024 is 1.02 [0.97..1.04] ; 1.01 [0.96..1.02] at head 0 and 1.02 [1.01..1.17] ; 1.01 [1.00..1.03] at head 768; Float64 1024 is 1.00 [1.00..1.01] ; 0.99 [0.91..1.00] at head 0 and 1.00 [0.99..1.00] ; 1.00 [1.00..1.19] at head 768; a 32-sample ring is 1.02 ; 1.02 (Float32) and 1.02 ; 1.01 (Float64). One compilation was slow in each run: in strict-1 Float32 head 768 one of three compilation medians read 1.18 (the others 1.02 / 1.01); in strict-2 Float64 head 768 one read 1.19 (the others 1.00 / 1.00), on a row that showed no gap in 1.5.0; every strict-2 Float32 compilation median is <= 1.05 (head 768: 1.05 / 1.01 / 1.00). For a whole-window copy `copyTo` is the safe choice: the medians are 0.99-1.02, but a one-off compilation at 1.18-1.19 was seen at head 768 (Float32 in strict-1, Float64 in strict-2), and parity is not guaranteed (it depends on the caller's inlining budget, so a caller with no budget left inlines neither method). `copyLast` is kept inlinable into its caller: the inlined chain copyLast + `lastCheck` + `rotCopy` is 765 B of bytecode, within V8's 766 B cumulative-inlining reserve on Node v26.8.2 / V8 14.6.202.34-node.28 (1.5.0: 791 B), gated by `test/chainsize.test.js` (DETERMINISTIC, pinned engine).

Timing is STATISTICAL and REPORTED, not gated (`npm run bench:copyto`, dev-only, strict quiet lock, not in `verify`, not shipped). One strict run 2026-11-12T06:10Z..06:14Z, Apple M4 Pro, Node v26.8.2 / V8 14.6.202.34-node.28, host QUIET (load1 2.74 at start, 1.54 at end, baseline 2.21), K 21 rounds x 3 compilations = 63 paired ratios per config, median per call vs 1.2.1 (43adb369) of the audit-fix build (c450e686): at n = 32 every layout is 1.47-1.52x slower (about 11 ns -> 16 ns); at n = 64 and 128 it is faster in every layout (0.26-0.89x); for a Float64 `dst` it is faster at every n >= 64 (0.26-0.62x at the medians); for a Float32 ring it is 1.29x (wrapped) / 1.34x (count n-1) slower at 256 and 3.03x (full, wrapped) / 3.85x (count n-1) slower at 1024. Use `copyToFast` when large wrapped or partly filled Float32 copies are hot and 104 / 208 B per call is acceptable.

| n | dst | layout | 1.2.1 ns | now ns | now / 1.2.1 (median) |
|---|---|---|---|---|---|
| 32 | f32 | contig / wrap / part | 10.8 / 10.8 / 10.5 | 16.3 / 16.3 / 16.0 | 1.51 / 1.51 / 1.52 |
| 32 | f64 | contig / wrap / part | 11.6 / 11.6 / 11.3 | 17.3 / 17.1 / 16.8 | 1.49 / 1.47 / 1.49 |
| 64 | f32 | contig / wrap / part | 29.3 / 54.6 / 54.9 | 15.0 / 37.9 / 25.6 | 0.51 / 0.69 / 0.47 |
| 64 | f64 | contig / wrap / part | 65.8 / 107.3 / 94.8 | 27.4 / 27.4 / 27.1 | 0.42 / 0.26 / 0.29 |
| 128 | f32 | contig / wrap / part | 31.6 / 59.1 / 58.4 | 17.5 / 52.2 / 44.6 | 0.56 / 0.89 / 0.77 |
| 128 | f64 | contig / wrap / part | 99.8 / 126.1 / 159.9 | 48.2 / 48.0 / 47.7 | 0.50 / 0.38 / 0.30 |
| 256 | f32 | contig / wrap / part | 36.0 / 62.0 / 62.1 | 21.2 / 79.6 / 83.0 | 0.59 / 1.29 / 1.34 |
| 256 | f64 | contig / wrap / part | 166.1 / 257.4 / 198.8 | 89.3 / 88.7 / 88.9 | 0.54 / 0.35 / 0.45 |
| 1024 | f32 | contig / wrap / part | 66.1 / 86.7 / 85.0 | 49.9 / 257.4 / 319.4 | 0.76 / 3.03 / 3.85 |
| 1024 | f64 | contig / wrap / part | 543.9 / 576.1 / 573.4 | 338.8 / 337.6 / 337.8 | 0.62 / 0.58 / 0.59 |

Layouts: contig = full ring, head 0; wrap = full ring, head n/2; part = count n-1, head n/2. Medians of 63 paired ratios per config; ns are medians per call. The per-config [Q1..Q3] ranges come from `npm run bench:copyto` (run under a strict quiet lock), which prints them. A/A medians in this run were 0.987..1.014 (the noise floor to read the ratios against). The audit-fix build against the previous build (63eb5bc1), same day, K 21 x 3, one quiet-lock hold, QUIET at hold start (load1 1.64; 4.40 at this run's start after the hold's earlier steps, 3.99 at end): TIE in 30 of 30 configs, medians 0.99-1.11x (n = 32: 1.09-1.11x; n >= 64: 0.99-1.07x).

Two consequences of the alias-check cache: the ring carries two enumerable own keys, `_bufOf` and `_buf` (they show in `Object.keys`, and `JSON.stringify` of a ring that has copied serializes its storage twice), and a replaced `data` (and its buffer) stays referenced until the next non-empty copy, non-empty `pushBatch` or `destroy()`; `reset()` does not release it. On a frozen, sealed or non-extensible ring the keys are never updated: the array cached before the lock stays referenced until `destroy()`, or for the ring's lifetime when frozen (`destroy()` throws a TypeError on a frozen ring, it cannot write it). `this.data` is read once per call, before the checks. Validation lives in a shared helper, so an error's stack has two extra frames vs 1.2.1 (the error builder and `copyCheck`); messages are unchanged.

### Comparison (REPORTED)

RingBuffer against what a user would write instead: a hand-rolled `Float32Array` ring, a hand-rolled `Array` ring, and the `lite-o1` `RingDeque`. Ring of 1024 samples (32 for the copyTo n 32 row). Each cell is ns/op (median) and, in parentheses, the ratio against the RingBuffer method (median of per-round ratios; below 1 = faster than RingBuffer, above 1 = slower).

| Operation | RingBuffer method | Hand-rolled Float32Array ring | Hand-rolled Array ring | lite-o1 RingDeque (emulated) |
|---|---|---|---|---|
| push | 1.01 | 1.01 (0.998x) | 1.04 (1.035x) | 2.13 (2.116x) |
| get / getOrDefault (RingBuffer: `getOrDefault(i, 0)`) | 0.92 | 0.54 (0.595x) | 0.44 (0.481x) | N/A (no indexed read) |
| copyTo n 32 (full ring, head n/2, Float32 dst) | 24.62 | 12.74 (0.517x) | 13.56 (0.550x) | 12.68 (0.514x) |
| copyTo n 1024 (full ring, head n/2, Float32 dst) | 277.01 | 390.40 (1.411x) | 411.70 (1.484x) | 386.05 (1.393x) |

- RingBuffer is slower than the hand-rolled loops on `get` / `getOrDefault` and on `copyTo` n 32, and faster on `copyTo` n 1024. No cause was measured here.
- `get(i)` is 1.896x [1.880..1.908] `getOrDefault(i, 0)` (1.73 ns vs 0.92 ns) and allocates 15.99 B/op, matching the documented 16 B box; `getOrDefault` and the other timed columns read 0.00 B/op (the resolution of this bench is 8 B; `npm run alloc` is the 0 B gate).
- RingDeque cells are emulations: push is `if (size === capacity) popFront(); pushBack(v)`; copy is `forEach` with a hoisted store callback. RingDeque is a Float64 double-ended queue that throws when full or on NaN, a structure for a different purpose (lite-o1), not a worse ring.
- Ratios against hand-rolled loops include driver-inlining effects: how well V8 inlines each column into the measuring loop is part of the number.
- Provenance: one strict QUIET run under `quiet-lock run --strict`, 2026-11-15T17:21Z, Apple M4 Pro (12 cores), Darwin 27.2.0 arm64, Node v26.8.2 / V8 14.6.202.34-node.28, load1 2.62 at start / 1.68 at end, K 21 rounds x 3 compilations, every row VALID, judge exit 0; RingBuffer.js 90f7ad7c at HEAD 6431ec9; lite-o1 1.11.3; another node process read 11.5% CPU at the start sample (recorded, not judged). A/A twin and SLOW / BOX controls ran per row. The wrap-cost figures in "Why power-of-two capacity" above come from the same run.
- Reproduce: `npm run bench:compare` (dev-only, not in `verify`, not shipped).

---

## API reference

### `new RingBuffer(requestedCapacity = 1024)`

| Arg | Type | Description |
|---|---|---|
| `requestedCapacity` | `number` | Minimum capacity. Rounded up to the next power of two. |

Throws `RangeError` if `requestedCapacity` is not a number in `[1, 2^31]`. 2^31 is the ceiling because the wrap mask must fit in an int32. An argument that cannot be converted to text (a null-prototype object, an object whose `toString` throws) throws `TypeError` or the user's own error instead, before any state is written; a Symbol, BigInt or plain object still gets the `RangeError`. The same holds for a `dstOffset` passed to `copyTo` / `copyToFast`.

### Instance members

| Member | Type | Description |
|---|---|---|
| `requestedCapacity` | `number` (readonly) | What the caller asked for, before pow2 rounding. |
| `capacity` | `number` (readonly) | Actual storage size. Always a power of two. |
| `count` | `number` | Live samples, `0..capacity`. |
| `head` | `number` | Write cursor. Internal -- exposed for inspection only. |
| `mask` | `number` | `capacity - 1`. Used in the wrap math. |
| `data` | `Float32Array` | Backing storage. A shared empty `Float32Array` after `destroy()`. |

### Methods

| Method | Returns | Description |
|---|---|---|
| `push(value)` | `void` | Append a sample. Overwrites the oldest when full. The value is coerced like a typed-array store: `null`, `''` and `[]` store 0, `undefined` stores NaN (map missing readings to NaN yourself). **Hot-path safe.** |
| `tryPush(value, options?)` | `boolean` | Like `push`, but returns `false` when full and `options.overwrite === false`. Coerces the value like `push`. |
| `pushBatch(src, srcOffset?, count?)` | `number` | Push `count` samples (default `src.length - srcOffset`) from a `Float32Array` or `Float64Array` `src`; the resulting `data`, `head` and `count` are those of `count` calls of `push` (values round through float32; NaN payload bits unspecified). `count` > `capacity` keeps the last `capacity` samples; `count` 0 is a no-op after validation. Returns `count`. Allocates nothing for a Float32Array / Float64Array `src` while each family's load / store site has seen at most 4 `src` hidden classes (Node 26.8.2 arm64; DETERMINISTIC, `npm run alloc`). Throws `TypeError` if `src` is not a TypedArray or is any TypedArray other than Float32Array / Float64Array (BigInt kinds included, even at count 0), if (count > 0) `this.data` is not a Float32Array (the `capacity`-slots RangeError is checked first), or if (count > 0) the ring is frozen; throws `RangeError` if `srcOffset` / `count` is not a non-negative integer (no coercion) or `srcOffset + count > src.length` (checked before the element-type check), or (count > 0) `data` no longer holds `capacity` slots or `src` shares the ring's ArrayBuffer. Nothing is written in any case. |
| `get(offset)` | `number \| undefined` | Sample at offset (0 = newest). `undefined` if out of range. |
| `getOrDefault(offset, default?)` | `number \| D` | Same, with a default for out-of-range (`undefined` when omitted). With a numeric default it allocates nothing in a hot loop; prefer it to `get`. |
| `peekNewest()` | `number` | Convenience for `getOrDefault(0, 0)`. |
| `peekOldest()` | `number` | Convenience for `getOrDefault(count - 1, 0)`. |
| `isFull()` | `boolean` | `count === capacity`. |
| `isEmpty()` | `boolean` | `count === 0`. |
| `copyTo(dst, dstOffset?)` | `number` | Write samples oldest-first into a `Float32Array` or `Float64Array`. Returns `count`. Allocates 0 B at every size until a store site has seen more than 4 `dst` hidden classes (then 16 B per non-integer sample; see Bulk copy). Throws `TypeError` if `dst` is not a TypedArray (or is a `BigInt64Array` / `BigUint64Array` that does not alias the ring and the buffer is not empty) and `RangeError` if it is too small, shares the ring's ArrayBuffer (an aliasing BigInt64Array / BigUint64Array `dst` gets this RangeError, not the TypeError), or (count > 0) the ring's `data` no longer holds `capacity` slots (replaced, resized or detached), writing nothing in any case. The alias check is ArrayBuffer identity: two SharedArrayBuffer objects over one memory block (a `structuredClone` or `postMessage` copy) are not detected; only a caller that replaced `data` with a view of shared memory can reach this. A frozen, sealed or non-extensible ring copies correctly (the cache is not stored, so each copy re-reads the buffer; the array cached before the lock stays referenced until `destroy()`, or for the ring's lifetime when frozen). |
| `copyToFast(dst, dstOffset?)` | `number` | Same result, validation and errors as `copyTo` (detached storage is the storage `RangeError`, not the V8 `TypeError` 1.2.1 threw); not affected by the 4-class limit; copies with at most two `set` calls over `subarray` views, so it allocates 104 B (contiguous) or 208 B (wrapped) per call. Faster than `copyTo` only for a wrapped or partly filled Float32 ring of 256+ samples (`copyTo` / `copyToFast` medians 1.18-1.20x at 256, 2.79-3.58x at 1024, 2026-11-12 run above); slower in every other measured cell. |
| `copyLast(dst, dstOffset, n)` | `number` | Write the newest `k = min(n, count)` samples oldest-first into a `Float32Array` or `Float64Array` from `dstOffset` (`undefined` means 0); returns `k`. `n` is required (an omitted `n` is a `RangeError`). Checks in order, all before the first store: `TypeError` if `dst` is not a TypedArray; `RangeError` if `n` is not a non-negative integer (no coercion); `RangeError` if `dstOffset` is not a non-negative integer or `dstOffset + n` exceeds `dst.length` (bounds on `n`, not `k`: an `n` larger than `dst` can hold throws even on an empty ring); returns 0 when `k` is 0, before the alias and storage checks; `RangeError` if `dst` shares the ring's ArrayBuffer; `RangeError` if `data` no longer holds `capacity` slots; a `BigInt64Array` / `BigUint64Array` `dst` with `k > 0` throws `TypeError` at the first store. Nothing is written on any throw. `copyLast(dst, off, rb.count)` writes, returns and throws exactly as `copyTo(dst, off)` (the messages name `copyLast`). Allocates 0 B while each store site has seen at most 4 `dst` hidden classes; the whole-window Float32 path shares `copyTo`'s `rotCopy` store site, so those `dst` classes count against one budget (see Bulk copy). The thrown error for every input is unchanged from 1.5.0 (same order); a view `dst` sees exactly one `dst instanceof DataView` per call (a user `DataView[Symbol.hasInstance]` runs once). Only replaced builtins can tell the difference from 1.5.0: `n` / `dstOffset` are tested before the DataView check, a failing call may call the global `ArrayBuffer.isView` / `Number.isInteger` more often, and a bounds failure with a valid `dstOffset` reads `dst`'s length twice. The checks use the global `ArrayBuffer.isView`, `Number.isInteger`, `DataView` and the intrinsic length getter's `call` at call time; replacing any of them, or anything that changes what that getter's `call` resolves to (replacing or deleting `Function.prototype.call`, an own `call` property on the getter, or a changed prototype of the getter), is unsupported (out of contract). For a whole-window copy `copyTo` is the safe choice (parity ratio medians 0.99-1.02 over two strict runs, a one-off compilation at 1.18-1.19 at head 768, REPORTED; see Bulk copy). |
| `copyLastFast(dst, dstOffset, n)` | `number` | Same result, validation order and errors as `copyLast` (messages name `copyLastFast`); copies with at most two `set` calls over `subarray` views, so it allocates one view per ring half it spans (REPORTED: 104.0 B contiguous / 208.0 B straddling, `npm run alloc`, 2026-11-15, Node v26.8.2 arm64); not affected by the 4-class limit. |
| `forEach(fn)` | `void` | Call `fn(value, index, rb)` for each sample, oldest-first. Zero allocation with a hoisted callback holds for ONE callback function per process: after a second distinct callback has been passed to any `forEach`, the call site is megamorphic and a non-inlined callback boxes each non-integer sample (about 128 B per 8-sample call, REPORTED from the 2026-11-12 audit, not gated). |
| `[Symbol.iterator]()` | `Iterator<number>` | `for (const v of rb)` / `[...rb]`, oldest-first. |
| `reset()` | `void` | Clear the buffer and zero the backing storage. |
| `destroy()` | `void` | Release the backing storage; `data` becomes a shared empty `Float32Array`. Subsequent calls are undefined behavior: `push`, `tryPush` and `reset` no longer throw, they do nothing. |

### Helpers

| Export | Description |
|---|---|
| `ceilPow2(n)` | Smallest power of two `>= n` for an integer `n` in `[1, 2^32]`. `ceilPow2(1) === 1`. Not validated: a fraction above 1 behaves as `Math.floor(n)` (`ceilPow2(1.5) === 1`); `0 < n < 1`, `NaN` and `+/-Infinity` give `1`; a finite `n` in `(-2^31, 0]` gives `2^32` (at or below `-2^31` the uint32 wrap of `n - 1` decides: `ceilPow2(-(2 ** 31)) === 2 ** 31`, `ceilPow2(-1e300) === 1`); `n > 2^32` wraps mod `2^32`. |
| `MAX_CAPACITY` | `2^31`, the largest accepted capacity. |

---

## Edge cases & guarantees

- **Capacity is always rounded up.** `new RingBuffer(100).capacity === 128`. The original is preserved on `requestedCapacity` so you can size sibling structures (e.g. a stats scratchpad) to either value as needed.
- **`get(0)` is the newest.** Any offset that is not an integer in `[0, count)` (negative, out of range, `NaN`, fractional, non-number) returns `undefined` (`get`) or the default (`getOrDefault`). They never throw.
- **NaN and +/-Infinity round-trip.** They store and read back unchanged. Downstream stats consumers must filter NaN themselves; `@zakkster/lite-stats-math` does this for you.
- **Finite values past the float32 range store as +/-Infinity.** A finite `x` with `|x| >= 2^128 - 2^103` (about 3.4028236e38, half a float32 ulp past the float32 max 3.4028234663852886e38) rounds to `+/-Infinity` on store; between the float32 max and that bound it rounds to the max. So `push(1e39)` stores `+Infinity` although `1e39` passes `v === v` and `Number.isFinite`: checking the input for NaN or finiteness does not predict the stored value. Clamp before `push`, or check what you read back.
- **`push` / `tryPush` coerce like a typed-array store.** `push(null)`, `push('')` and `push([])` store 0; `undefined` stores NaN; `'3'` stores 3; `true` stores 1; an object that converts to a non-number (`{}`) stores NaN; one that cannot be converted (a null-prototype object, a throwing `valueOf` / `toString`) throws that TypeError / the user's error and stores nothing. A missing reading is therefore 0 unless you map it to NaN yourself.
- **`pushBatch` errors write nothing.** Every check runs before the first data store. A non-TypedArray `src`, any TypedArray other than Float32Array / Float64Array (BigInt64Array / BigUint64Array too, even at `count` 0) and, for `count` > 0, a `data` that is not a Float32Array (the `capacity`-slots RangeError is checked first) (checked on every call by its intrinsic tag, not `instanceof`) throw `TypeError`; non-integer, negative or non-number `srcOffset` / `count` (no coercion, no user `valueOf`), `srcOffset + count > src.length`, a `data` that is not `capacity` slots (replaced, resized, detached) and a `src` sharing the ring's ArrayBuffer throw `RangeError`. The bounds check runs before the element-type check.
- **`pushBatch` on a frozen ring, and what is not covered.** `head` and `count` are stored before the first sample, so for `count` > 0 an `Object.freeze`d ring throws `TypeError` (`count` 0 returns 0) with `data`, `head` and `count` unchanged (`push` on a frozen ring stores its sample, then throws; `copyTo` from a frozen ring copies normally). Only a whole-ring `Object.freeze` is covered: per-property tampering (a non-writable `count` alone, accessors on `head` / `count` / `data`) is unsupported and may leave `head` written, as with `push`. A sealed or non-extensible ring works.
- **`pushBatch` needs Float32Array storage.** `data` is the library's own Float32Array of `capacity` slots; a replaced `data` of `capacity` slots but another element type (a BigInt64Array included) throws `TypeError` before any write; one of another length throws the storage `RangeError` first. Shares the alias cache (`_bufOf`, `_buf`) with `copyTo`.
- **`pushBatch` on a destroyed ring or a detached `src`.** After `destroy()`, `pushBatch(src)` with valid arguments returns `count`, stores nothing and does not throw (like `push`, a silent no-op); invalid arguments still throw as above. A detached or out-of-bounds `src` (transferred buffer, shrunk resizable buffer) reads as length 0: with `count` omitted it returns 0; an explicit `count` >= 1 throws the bounds `RangeError`. Nothing is written in either case.
- **`tryPush` does not allocate when called without options.** The implementation reads the option object by property access (no destructuring default), so `tryPush(v)` is hot-path-safe just like `push(v)`.
- **`reset()` zeroes the backing memory.** The library's own reads are bounded by `count` and never see old slots; zeroing protects consumers that read `data` directly. The cost is one `Float32Array.fill(0)` (O(capacity)), which is a single memset in V8.
- **`destroy()` is final.** It swaps `data` for a shared empty `Float32Array` so the GC can reclaim the backing buffer in long-lived applications. It does not assign `null`: that would widen the `data` field's tracked type in V8 from `Float32Array` to any value for every live instance (seen with `--trace-generalization`, Node 26.8.2). The trade-off: `push`, `tryPush` and `reset` after `destroy()` used to throw a `TypeError` on `null`; now they do nothing, and `tryPush(v)` returns `true` without storing. Reads were already empty. After `destroy()`, the instance is unusable, and nothing tells you so.
- **Hot-path zero-allocation.** Measured by `npm run alloc` (`test/alloc.mjs`, V8's allocated-bytes counter, 1M calls per window, Node 26.8.2 arm64) in a monomorphic hot loop, with non-integer samples: `push`, `tryPush(v)`, `getOrDefault(i, n)` with a numeric default, `peekNewest`, `peekOldest`, `isFull`, `isEmpty`, `forEach` (with ONE hoisted callback per process) and `copyTo` at every size allocate 0 B per call (every lane <= 0.2 B per call against the < 1 B gate, `npm run alloc` inside `npm run verify`, 2026-11-12), `copyTo` only while each of its three store sites has seen at most 4 `dst` hidden classes: past that it boxes every non-integer sample (16 B each, Node 26.8.2 arm64; the family split is gated by the `npm run alloc` MEGA lanes; the residual is REPORTED), and `forEach` with a second distinct callback boxes about 128 B per 8-sample call (REPORTED). `pushBatch` with a Float32Array / Float64Array `src` allocates 0 B per call while each family's load / store site has seen at most 4 `src` hidden classes (every `pushBatch` lane, BIGINT and MEGA included, <= 0.2 B per call against the < 1 B gate, `npm run verify` of build ff6ee762, 2026-11-14, PRELIMINARY host). `get(i)` allocates 16 B per call: its `number | undefined` result boxes a non-integer sample, so in a hot loop use `getOrDefault(i, 0)`. `getOrDefault(i)` with no default boxes the same way. `copyToFast` allocates one 104 B `subarray` view per ring half (104 B contiguous, 208 B wrapped; REPORTED). `copyLast` allocates 0 B under `copyTo`'s 4-class rule per store site (the whole-window Float32 path shares `copyTo`'s `rotCopy` store site, so those `dst` classes count against one budget; every gated `copyLast` lane <= 0.2 B per call, `npm run alloc` inside `npm run verify`, 2026-11-15); `copyLastFast` allocates one `subarray` view per ring half it spans (104 B contiguous, 208 B straddling; REPORTED). Iteration allocates an iterator. These numbers need V8 to inline the call: any call that is not inlined boxes a non-integer double it passes or returns (16 B), which is V8's calling convention, not this library. That inlining precondition is checked by `npm run inline-diff` (REPORTED: run by hand, outside `verify`). `npm test` runs under `--expose-gc` and includes a 1M-push smoke test that checks sub-MB retained heap growth; that test fails (it does not skip) when gc is not exposed.

---

## Testing

`npm test` needs exactly the pinned engine, Node v26.8.2 / V8 14.6.202.34-node.28: `test/chainsize.test.js` fails closed on any other Node, so `npm run verify` does too. The other dev scripts need Node >= 24 (`test/alloc.mjs` reads V8's `total_allocated_bytes`). The runtime `engines` field stays `>=18`.

| Script | What it runs |
| --- | --- |
| `npm test` | `node test/count.mjs`: runs `test/RingBuffer.test.js` (60 tests), `test/InliningTool.test.js` (35), `test/copyto.test.js` (30), `test/copyto-r1b.test.js` (9), `test/audit-fix.test.js` (10), `test/mutant-kills.test.js` (10), `test/qa-r1.test.js` (15), `test/DeoptTool.test.js` (7), `test/pushbatch.test.js` (48), `test/qa-r2.test.js` (7), `test/copylast.test.js` (19), `test/copylast-parity.test.js` (9), `test/qa-r3.test.js` (22), `test/chainsize.test.js` (5; needs the pinned engine Node v26.8.2 / V8 14.6.202.34-node.28 and fails on any other Node), `test/copylast-hooks.test.js` (4) and `test/qa-m1.test.js` (4) through `node:test` `run()` under `--expose-gc`, then fails unless exactly 294 tests pass with 0 failed and 0 skipped or todo, one passing run summary and one per-file summary per file, no failed suite and no file with zero tests. An empty, skipped, crashed or early-exiting test file fails. Adding or removing a test updates `EXPECTED` in `test/count.mjs` (a test file: `FILES` too). Extra arguments are read as test files, so `--test-name-pattern` is not passed through. The 1M-push heap smoke test fails (not skips) when gc is not exposed. |
| `npm run inline-diff` | `node test/tools/inline-diff.mjs` (REPORTED: not in `verify`; run it by hand under the quiet lock before each release and in any change to `RingBuffer.js`). Stages the before build (`git show HEAD:RingBuffer.js`; override with `--before FILE` or `--before-ref REF`) and the working-tree file, plus three must-fail controls (copies of the after file whose `getOrDefault`, `peekNewest` or `peekOldest` is padded past V8's default 460-byte max-inlined-bytecode-size), then runs `inlining-budget-diff.sh` of the exact-pinned devDependency `@zakkster/lite-utils` 1.0.0 with `--fn getOrDefault,peekNewest,peekOldest` on turbo and maglev. Exit 0: the before/after pair is SAME and every control DIFFs, naming only its own function, in every tier. Exit 1: the pair DIFFs, or a control stayed blind ("gate blind"). Exit 2: NO-VERDICT (a run exited 2 or was killed, missing output, staging or option error, no git / bash, or a VERDICT line that disagrees with its run's exit); never read it as a pass. Options: `--after FILE` (default: the working-tree file), `--tiers LIST` (turbo / maglev, default turbo,maglev), `--cap-ms N` (per-run cap, integer 1000..3600000, default 300000; past it the run's process group is SIGKILLed, NO-VERDICT), `--keep`, `--stage-only DIR`. The script is read only from `node_modules/@zakkster/lite-utils` (package name, version exactly 1.0.0 and script presence are checked; else exit 2 with a named reason) and is pinned by sha256 in `test/InliningTool.test.js`, whose version row also fails on a dependency bump; the tool's own logic is tested in `npm test` against a stub script, with no real-V8 verdict there. Needs bash and git; a host without them fails `npm test` red. |
| `npm run deopt-diff` | `node test/tools/deopt-diff.mjs` (REPORTED: not in `verify`; run it by hand under the quiet lock). Compares the deoptimizations of `copyTo` (`--fn LIST` for others) between `git show HEAD:RingBuffer.js` and the working-tree file (`--after FILE`), by `deopt-diff.sh` of the pinned `@zakkster/lite-utils` 1.0.0, on a Float32 and a Float64 `dst` driver (3 runs each), plus a blind control (the `dst` turns Float64Array half way through the loop) that must read DIFF. The f32 / f64 verdicts are REPORTED, not judged. Options: `--after FILE`, `--fn LIST`, `--cap-ms N` (per-spawn cap, integer 1000..3600000, default 600000; past it the run's process group is SIGKILLed, NO-VERDICT), `--keep` (keep the temp work dir), `--stage-only DIR` (stage into a new or empty DIR, print it, exit 0 without running). Exit 2: any NO-VERDICT, preflight failure, internal error or SIGINT / SIGTERM / SIGHUP (the script's process group is SIGKILLed); else exit 1: the control read SAME (blind); else exit 0. Its deterministic tool tests (`test/DeoptTool.test.js`, 7) are in `npm test`. |
| `npm run alloc` | `test/alloc.mjs`: per-call allocated bytes for every hot method. This is the per-op byte gate. Includes 7 `pushBatch` lanes (Float32 and Float64 `src`, whole / sliced / wrapped / over-capacity), a BIGINT lane (a BigInt64Array call that throws must not make later calls box) and two MEGA lanes (Float32 and Float64 `src` after more than 4 `src` classes), with must-allocate controls `maskBig` / `maskMega` (a single shared masked loop, about 2048 B per call). R3 `copyLast` lanes: n 120 on a full 1024 ring and n 1024 on a full 2048 ring, contiguous and straddling, Float32 and Float64 `dst` (`copyLast 120 F32, cap 1024 contiguous` ... `copyLast 1024 F64, cap 2048 straddling`), the whole window `copyLast(count) F32 1024 full, head 768` (the `rotCopy` path) and `copyLast(count) F64 1024 full, head 768`, all gated at < 1 B; `copyLastFast 120, cap 1024 contiguous` / `straddling` REPORTED; `MEGA copyLast 120 F32, straddling` / `MEGA copyLast 120 F64, straddling` (after 400 polluting calls into every other element type and 3 Float64Array subclasses) gated, with `MEGA copyLast 32 -> Int16Array` as the must-allocate control. |
| `npm run bench:pushbatch` | `node test/bench/pushbatch-ab.mjs` (with `test/bench/pushbatch-probe.mjs`; dev-only, not shipped, STATISTICAL: not in `verify`; a release-gating run holds the strict quiet lock). Interleaved A/B harness for `pushBatch`. REPORTED only. |
| `npm run bench:copyto` | `node test/bench/copyto-ab.mjs` (dev-only, not shipped, STATISTICAL: not in `verify`; a release-gating run holds the strict quiet lock). Interleaved A/B of `copyTo` against a before build (default `git show HEAD:RingBuffer.js`), K 21 rounds x 3 compilations, with A/A and must-fail controls. REPORTED only. |
| `npm run bench:copylast` | `node test/bench/copylast-ab.mjs` (with `test/bench/copylast-probe.mjs`; dev-only, not shipped, STATISTICAL: not in `verify`; a release-gating run holds the strict quiet lock). Interleaved A/B of `copyLast` against a caller's `copyTo` + loop (n 120 / 512 on a 1024 ring) and of `copyLast(count)` against `copyTo`, with A/A and must-fail controls. REPORTED only. |
| `npm run bench:compare` | `node test/bench/compare.mjs` (with `test/bench/compare-probe.mjs`; dev-only, not shipped, REPORTED: not in `verify`; quotable only from a strict quiet-lock run). Public comparison of RingBuffer against a hand-rolled `Float32Array` ring, a hand-rolled `Array` ring and lite-o1 `RingDeque` (push, get / getOrDefault, copyTo n 32 / 1024, plus the `% capacity` vs `& mask` wrap lanes), K 21 rounds x 3 compilations, with an A/A twin and SLOW and BOX controls per row. Options: `--smoke` (K 5 x 1 compilation, not quotable), `--self-test`, `--out DIR`, `--K N` (5..1001), `--comp N` (1..10), `--control box|aa|slow`, `--keep`. Exit 0: every row VALID on a quiet host; 1: any row VOID or a red self-test; 2: usage / git / staging error or host not quiet. |
| `npm run torture` | `test/torture.mjs` (dev-only): lite-leak retention and lite-gc-profiler GC budget (below). |
| `npm run ascii` | `test/ascii.mjs`: fails on any non-ASCII character in `package.json`, the `files[]` entries and `test/` (U+00D7 and U+00B5 are allowed). |
| `npm run verify` | `npm test && npm run alloc && npm run torture && npm run ascii` |

`npm run torture` checks:

- **Retention (lite-leak).** 4096 churned `RingBuffer`s: all 4096 are tracked mid-run (exact count gated) and `tracker.size()` must drain to 0, and the backing `data` of 256 still-live instances is reclaimed after `destroy()`.
- **GC budget (lite-gc-profiler).** Major 0 / minor 0 collections over 2,000,000 ops on each of 6 lanes: `push` + `tryPush` on a full ring; `getOrDefault` in and out of range; `peekNewest` / `peekOldest` / `isFull` / `isEmpty`; `forEach` over 32; `copyTo` of 32 samples (contiguous and wrapped) into Float32 and Float64; `push` x32 + `reset`; and 125,000 ops on each of two more, a seventh (`copyTo` of 1024 Float32 with the start walking 0..1023) and an eighth (`pushBatch 1024 set+slice+F64+over-cap`: a whole Float32 chunk through the `set` route, a sliced one, a Float64 one and an over-capacity one, major 0 / minor 0), then two `copyLast` lanes, `copyLast 120 straddling F32+F64` (250,000 ops, the newest 120 of a full 1024 ring always wrapping) and `copyLast(count) ROT full 1024` (125,000 ops, one push per op, the `rotCopy` path). A control lane must collect or the run fails. A second lite-leak tracker follows the backing `ArrayBuffer` of the 256 live instances after one `copyTo` (rings with `i % 4 === 0`), one `copyLast` (`i % 4 === 2`) or one `pushBatch` (odd rings) each and requires it to be reclaimed after `destroy()` (the alias-check cache must drop it).
- **Reported, not gated.** `copyToFast` and `copyLastFast` (the `subarray` views) and `get(i)` (the `number | undefined` box) allocate by design.

GC-count resolution is nominal: torture prints it as `res=` (the CONTROL lane's B/op divided by its minor-GC count) on the GATE line, and it depends on the V8 new-space size, so a gated lane reading minor 0 proves it allocates less than `res` B/op, not 0 B/op. `npm run alloc` is the per-op byte gate.

---

## Companion libraries

- **[@zakkster/lite-stats-math](https://www.npmjs.com/package/@zakkster/lite-stats-math)** -- single-pass avg/min/max/quantile over a `RingBuffer`, with a NaN-filtering compaction step.
- **[@zakkster/lite-canvas-graph](https://www.npmjs.com/package/@zakkster/lite-canvas-graph)** -- zero-GC `<canvas>` waveform renderer that reads a `RingBuffer` directly. Decimates to per-pixel min/max envelopes when the sample count exceeds canvas width.

The three together form a complete telemetry pipeline:

```mermaid
flowchart LR
    A[sample source<br/>rAF / audio / network] --> RB(RingBuffer)
    RB --> SM[StatsMath]
    RB --> CG[CanvasGraph]
    SM --> UI[label / overlay]
    CG --> UI
```

`push` allocates nothing, and the copy on the read side no longer allocates either. `StatsMath` and `CanvasGraph` read the ring through `copyTo` into a capacity-sized Float32Array scratch, and `copyTo` allocates nothing at any size while its store sites have seen at most 4 `dst` hidden classes, so this path adds no per-frame allocation from the copy itself (at most 0.2 B per call, `npm run alloc` inside `npm run verify`, 2026-11-12, Node 26.8.2 arm64); whether the consumers' own code allocates is theirs to state.

---

## FAQ

**Why power-of-two capacity? Why not just take the user's number?**
Because wrap-around is then `head & mask`, one AND, and the comparison section above measures what `% capacity` costs against it: 1.784x [1.759..1.829] per wrap step at the same power-of-two capacity, 1.057x [1.042..1.203] inside a whole hand-rolled push, and 5.630x / 3.204x at a non-power-of-two capacity (REPORTED, same run).

**Why `Float32Array` and not `Float64Array`?**
Two reasons: (1) telemetry numbers -- frame times in ms, audio amplitudes, mouse velocity in px/s -- fit comfortably in float32; (2) consumers like `<canvas>`, WebGL vertex buffers, and Web Audio nodes are all float32-native, so a downstream `copyTo` into a Float32Array is a same-type copy with no conversion.

**Can I push integers?**
Yes -- they'll be implicitly converted to float32 on store, and read back losslessly for any integer with `|x| <= 2^24`. Larger integers will be rounded (a monotonic energy counter in Wh crosses 2^24 = 16,777,216 and silently loses precision: keep Wh totals in your own Float64 columns, not in this ring); for u32 telemetry use a u32-backed sibling library or pack into the 24-bit mantissa.

**Why is `tryPush` slower than `push` in microbenchmarks?**
It branches on the `options` argument and the full state. For most callers `push` is the right choice; reach for `tryPush` only when discarding samples on overflow is a *correctness* requirement (e.g. lossy network ingest).

**Can I share a `RingBuffer` across a `Worker`?**
No. `head` and `count` are plain fields on the instance, not shared memory, so another thread cannot tell which slots are live; pointing `data` at a `SharedArrayBuffer` does not change that. Moving `head` and `count` into shared memory does not fix it either: a consumer that takes samples off must lower `count` while the producer raises it, so both threads write the same word, and plain stores do not order a slot write against the index that publishes it. Cross-thread streaming needs a different structure, a single-producer / single-consumer (SPSC) ring: two monotonic wrapping indices (write `w`, read `r`) in a `SharedArrayBuffer` header, each written by one side only with `Atomics.store` and read by the other with `Atomics.load`; occupancy is `(w - r) >>> 0` and a slot is `idx & mask`; keep the two indices on separate cache lines, 128 B apart. This package is not that structure, and it will not grow a shared-memory mode; if one is ever wanted it will be a separate package (`lite-spsc-ring`).

---

## License

MIT (c) Zahary Shinikchiev
