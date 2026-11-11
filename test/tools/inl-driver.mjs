// inl-driver.mjs -- driver for test/tools/inlining-budget-diff.sh (driver mode).
//
//   node test/tools/inl-driver.mjs [path/to/RingBuffer.js]
//
// The script runs a driver with NO argv from the driver's own directory, so inline-diff.mjs
// copies this file beside a staged RingBuffer.js and the default import is './RingBuffer.js'
// relative to this file. A path argument overrides it (manual runs only).
//
// Exercises the three methods whose 0 B/op claim needs inlining (they return non-integer
// doubles and box when NOT inlined; see test/alloc.mjs): getOrDefault(i & 7, 0),
// peekNewest(), peekOldest(), each in its own lane function on filled(8, 13) with x + 0.5
// values (alloc.mjs style). Every lane call is one 1000-op CHUNK, called many times after a
// warmup -- never one long loop, so the lanes tier up by call count, not by OSR.
// Accumulators live in a Float64Array (the harness itself does not box).
//
// Prints nothing on success. Exit 1 (stderr line) when a sum is not the expected finite
// value; exit 2 when the module cannot be loaded. Test tooling only: not shipped.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const arg = process.argv[2];
const url = arg === undefined ? new URL('./RingBuffer.js', import.meta.url).href : pathToFileURL(resolve(arg)).href;
let RingBuffer;
try {
    ({ RingBuffer } = await import(url));
} catch (e) {
    process.stderr.write('inl-driver: cannot import ' + url + ': ' + (e && e.message) + '\n');
    process.exit(2);
}
if (typeof RingBuffer !== 'function') {
    process.stderr.write('inl-driver: ' + url + ' exports no RingBuffer\n');
    process.exit(2);
}

const CHUNK = 1000;
const WARM = 200;
const CHUNKS = 3000;
const acc = new Float64Array(3);

function filled(cap, n) {
    const rb = new RingBuffer(cap);
    for (let i = 0; i < n; i++) rb.push(i + 0.5);
    return rb;
}

function laneGet(rb, a) {
    for (let i = 0; i < CHUNK; i++) a[0] += rb.getOrDefault(i & 7, 0);
}
function laneNewest(rb, a) {
    for (let i = 0; i < CHUNK; i++) a[1] += rb.peekNewest();
}
function laneOldest(rb, a) {
    for (let i = 0; i < CHUNK; i++) a[2] += rb.peekOldest();
}

const rbG = filled(8, 13);
const rbN = filled(8, 13);
const rbO = filled(8, 13);
const total = WARM + CHUNKS;
for (let c = 0; c < WARM; c++) {
    laneGet(rbG, acc);
    laneNewest(rbN, acc);
    laneOldest(rbO, acc);
}
for (let c = 0; c < CHUNKS; c++) {
    laneGet(rbG, acc);
    laneNewest(rbN, acc);
    laneOldest(rbO, acc);
}

// Live samples 5.5 .. 12.5 (newest 12.5, oldest 5.5). Per chunk: getOrDefault cycles
// offsets 0..7 (sum 72) 125 times = 9000; peekNewest 12500; peekOldest 5500. All exact.
const want = [9000 * total, 12500 * total, 5500 * total];
const names = ['getOrDefault', 'peekNewest', 'peekOldest'];
for (let k = 0; k < 3; k++) {
    if (!(acc[k] === want[k])) {
        process.stderr.write('inl-driver: ' + names[k] + ' sum ' + acc[k] + ' != expected ' + want[k] + '\n');
        process.exit(1);
    }
}
