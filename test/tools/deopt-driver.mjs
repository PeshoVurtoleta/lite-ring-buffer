// deopt-driver.mjs -- the ONE driver of `npm run deopt-diff` (test/tools/deopt-diff.mjs, unit LU2), run by
// deopt-diff.sh of the exact-pinned devDependency @zakkster/lite-utils 1.0.0 for RingBuffer#copyTo.
// Body = .handoff/R1/deopt/ctl-before/drv.mjs lines 9-67 (to its end) byte-identical (R1 T7: drv-f32 + the SWITCH line).
// deopt-diff.mjs stages it beside a copy of RingBuffer.js (in a dir whose package.json says "type":"module")
// and makes each variant by ONE exact edit of an anchor that must match exactly once (0x / 2x = exit 2):
//   f32         this file as is (Float32Array dst, SWITCH false)
//   f64         `const DST = Float32Array;\n` -> `const DST = Float64Array;\n`
//   ctl-before  this file as is (blind control, driver mode; both sides hold the same RingBuffer.js)
//   ctl-after   `const SWITCH = false;\n` -> `const SWITCH = true;\n`: half way through the steady loop the
//               dst becomes a Float64Array (copyTo saw only one dst type until then) -> the control must read DIFF.
// deopt-diff.sh passes the driver no argv and the env cannot differ per side, so a variant is a source edit.
// Deterministic, no timing, no argv, no env. Exit 0; exit 1 on a wrong copyTo return, a wrong sample count or a
// NaN checksum. Warm: SWEEPS rounds over capacities 32, 64, 1024; each round walks every state the public API
// reaches -- empty, non-full at every count (head = count), full at every head position -- and copies at
// dstOffset 0 and 3. Then a steady loop on all three. Test tooling only: not shipped.
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
