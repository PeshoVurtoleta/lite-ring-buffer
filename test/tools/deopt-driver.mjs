// deopt-driver.mjs -- the ONE driver of `npm run deopt-diff` (test/tools/deopt-diff.mjs, unit LU2), run by
// deopt-diff.sh of the exact-pinned devDependency @zakkster/lite-utils 1.0.0 for RingBuffer#copyTo and
// RingBuffer#pushBatch (R2).
// Two phases. Phase 1 (copyTo) is .handoff/archive/1.3.0/R1/deopt/ctl-before/drv.mjs lines 9-67 (R1 T7: drv-f32 + the SWITCH
// line), unchanged. Phase 2 (pushBatch, R2) is appended after it and runs only when
// RingBuffer.prototype.pushBatch is a function (a build before R2, e.g. the git-HEAD side before R2 is committed,
// prints 'drv pushBatch skipped' and has no pushBatch to compare); it never calls copyTo, so phase 1's copyTo
// history is the same on both sides.
// deopt-diff.mjs stages it beside a copy of RingBuffer.js (in a dir whose package.json says "type":"module")
// and makes each variant by ONE exact edit of an anchor that must match exactly once (0x / 2x = exit 2):
//   f32         this file as is (Float32Array dst and src, SWITCH false)
//   f64         `const DST = Float32Array;\n` -> `const DST = Float64Array;\n`: copyTo's dst AND pushBatch's src
//   ctl-before  this file as is (blind control, driver mode; both sides hold the same RingBuffer.js)
//   ctl-after   `const SWITCH = false;\n` -> `const SWITCH = true;\n`: half way through each steady loop the
//               copyTo dst and the pushBatch src become Float64Arrays (each method saw one type until then) ->
//               the control must read DIFF.
// deopt-diff.sh passes the driver no argv and the env cannot differ per side, so a variant is a source edit.
// Deterministic, no timing, no argv, no env. Exit 0; exit 1 on a wrong copyTo / pushBatch return, a wrong sample
// count, a wrong newest sample after pushBatch, a wrong count after pushBatch, or a NaN checksum.
// Phase 1 warm: SWEEPS rounds over capacities 32, 64, 1024; each round walks every state the public API
// reaches -- empty, non-full at every count (head = count), full at every head position -- and copies at
// dstOffset 0 and 3. Then a steady loop on all three.
// Phase 2: its own rings (capacities 32, 64, 1024, full) and srcs (`new DST(max(cap + 3, 128) + 3)`); for every head (set
// directly on the full ring: a state push reaches) x chunk {1, 7, 128, cap + 3} x srcOffset {0, 3}, one
// pushBatch; then a steady loop of PB_STEADY calls (chunk 128, srcOffset 3). Own acc slots; the returned sum
// must equal the expected sum. Test tooling only: not shipped.
import { RingBuffer } from './RingBuffer.js';

const DST = Float32Array;
const SWITCH = false;
const CAPS = [32, 64, 1024];
const SWEEPS = 48;
const STEADY = 200000;
const OFF = 3;

const rings = [];
const dsts = [];
const dsts64 = [];
for (let j = 0; j < CAPS.length; j++) {
    rings.push(new RingBuffer(CAPS[j]));
    dsts.push(new DST(CAPS[j] + OFF));
    dsts64.push(new Float64Array(CAPS[j] + OFF));
}
const acc = new Float64Array(2); // [0] checksum, [1] copied-sample count

function fail(msg) {
    process.stdout.write('drv: FAIL ' + msg + '\n');
    process.exit(1);
}

function copyBoth(rb, dst) {
    const c = rb.count;
    if (rb.copyTo(dst, 0) !== c) fail('copyTo return at offset 0');
    if (rb.copyTo(dst, OFF) !== c) fail('copyTo return at offset 3');
    if (c > 0) acc[0] += dst[OFF] + dst[OFF + c - 1];
    acc[1] += c;
}

function sweep(rb, dst) {
    const cap = rb.capacity;
    rb.reset();
    copyBoth(rb, dst);                       // empty
    for (let k = 1; k < 2 * cap; k++) {      // non-full counts 1..cap-1, then full at heads 0..cap-1
        rb.push(k * 0.5);
        copyBoth(rb, dst);
    }
}

for (let s = 0; s < SWEEPS; s++) {
    for (let j = 0; j < CAPS.length; j++) sweep(rings[j], dsts[j]);
}
for (let i = 0; i < STEADY; i++) {
    const j = i % 3;
    rings[j].push(i * 0.25);
    copyBoth(rings[j], (SWITCH && i >= STEADY / 2) ? dsts64[j] : dsts[j]);
}

// Expected samples: per sweep and cap, sum(1..cap-1) + cap * cap; steady rings are full.
let want = 0;
for (let j = 0; j < CAPS.length; j++) want += SWEEPS * (CAPS[j] * (CAPS[j] - 1) / 2 + CAPS[j] * CAPS[j]);
for (let j = 0; j < CAPS.length; j++) want += Math.ceil((STEADY - j) / 3) * CAPS[j];
if (acc[1] !== want) fail('samples ' + acc[1] + ' != ' + want);
if (!(acc[0] === acc[0])) fail('checksum is NaN');
process.stdout.write('drv ok switch=' + SWITCH + ' dst=' + DST.name + ' sweeps=' + SWEEPS + ' steady=' + STEADY +
    ' samples=' + acc[1] + ' checksum=' + acc[0] + '\n');

// ---- phase 2: pushBatch (R2) -- appended; phase 1 above is unchanged ----------------------------------------
if (typeof RingBuffer.prototype.pushBatch === 'function') {
    const PB_STEADY = 200000;
    const PB_CHUNK = 128;
    const pbRings = [];
    const pbSrcs = [];
    const pbSrcs64 = [];
    for (let j = 0; j < CAPS.length; j++) {
        const rb = new RingBuffer(CAPS[j]);
        for (let k = 0; k < CAPS[j]; k++) rb.push(k * 0.5);
        pbRings.push(rb);
        const len = (CAPS[j] + 3 > PB_CHUNK ? CAPS[j] + 3 : PB_CHUNK) + OFF;
        const s = new DST(len);
        const s64 = new Float64Array(len);
        for (let k = 0; k < s.length; k++) { s[k] = k * 0.75 + 0.125; s64[k] = k * 0.75 + 0.125; }
        pbSrcs.push(s);
        pbSrcs64.push(s64);
    }
    const pbAcc = new Float64Array(2); // [0] checksum of the newest sample, [1] sum of pushBatch returns
    let pbWant = 0;
    const pbOne = (rb, src, off, c) => {
        if (rb.pushBatch(src, off, c) !== c) fail('pushBatch return');
        if (rb.count !== rb.capacity) fail('pushBatch count');
        const newest = rb.data[(rb.head - 1) & rb.mask];
        if (newest !== Math.fround(src[off + c - 1])) fail('pushBatch newest sample');
        pbAcc[0] += newest;
        pbAcc[1] += c;
    };
    for (let j = 0; j < CAPS.length; j++) {
        const rb = pbRings[j];
        const cap = CAPS[j];
        const chunks = [1, 7, PB_CHUNK, cap + 3];
        for (let h = 0; h < cap; h++) {
            for (let c = 0; c < chunks.length; c++) {
                for (let off = 0; off <= OFF; off += OFF) {
                    rb.head = h;
                    pbOne(rb, pbSrcs[j], off, chunks[c]);
                    pbWant += chunks[c];
                }
            }
        }
    }
    for (let i = 0; i < PB_STEADY; i++) {
        const j = i % 3;
        pbOne(pbRings[j], (SWITCH && i >= PB_STEADY / 2) ? pbSrcs64[j] : pbSrcs[j], OFF, PB_CHUNK);
    }
    pbWant += PB_STEADY * PB_CHUNK;
    if (pbAcc[1] !== pbWant) fail('pushBatch samples ' + pbAcc[1] + ' != ' + pbWant);
    if (!(pbAcc[0] === pbAcc[0])) fail('pushBatch checksum is NaN');
    process.stdout.write('drv pushBatch ok switch=' + SWITCH + ' src=' + DST.name + ' steady=' + PB_STEADY +
        ' samples=' + pbAcc[1] + ' checksum=' + pbAcc[0] + '\n');
} else {
    process.stdout.write('drv pushBatch skipped (no pushBatch on this build)\n');
}
