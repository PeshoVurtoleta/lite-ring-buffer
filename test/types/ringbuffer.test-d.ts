/**
 * @zakkster/lite-ring-buffer -- ambient type tests (npm run test:types =
 * tsc -p test/types/tsconfig.json, noEmit, strict).
 * Imports every export of RingBuffer.d.ts, exercises every member (both
 * getOrDefault overloads, for..of and forEach), and pins six misuse errors with
 * @ts-expect-error: an expect-error row that stops erroring fails the run (TS2578).
 * ASCII-only.
 */

import { RingBuffer, ceilPow2, MAX_CAPACITY, type TryPushOptions } from '../../RingBuffer.js';

// --- module exports --------------------------------------------------------
const maxCap: number = MAX_CAPACITY;
const pow2: number = ceilPow2(100);
void maxCap;
void pow2;

// --- construction + readonly fields ----------------------------------------
const rb = new RingBuffer(64);
const rbDefault = new RingBuffer();
void rbDefault;

const requested: number = rb.requestedCapacity;
const capacity: number = rb.capacity;
const mask: number = rb.mask;
const data: Float32Array = rb.data;
void requested;
void capacity;
void mask;
void data;

// head / count are writable fields (documented field-set states).
rb.head = 0;
rb.count = 0;
const head: number = rb.head;
const count: number = rb.count;
void head;
void count;

// --- writes ------------------------------------------------------------------
rb.push(1.5);

const opts: TryPushOptions = { overwrite: true };
const pushedA: boolean = rb.tryPush(2);
const pushedB: boolean = rb.tryPush(3, opts);
const pushedC: boolean = rb.tryPush(4, {});
void pushedA;
void pushedB;
void pushedC;

const f32 = new Float32Array(128);
const f64 = new Float64Array(128);
const wroteA: number = rb.pushBatch(f32);
const wroteB: number = rb.pushBatch(f64, 4);
const wroteC: number = rb.pushBatch(f32, 0, 16);
void wroteA;
void wroteB;
void wroteC;

// --- reads -------------------------------------------------------------------
const maybe: number | undefined = rb.get(0);
void maybe;

// overload 1: no default -> number | undefined
const godA: number | undefined = rb.getOrDefault(0);
void godA;
// overload 2: a default of type D -> number | D
const godB: number = rb.getOrDefault(0, 0);
const godC: number | null = rb.getOrDefault(0, null);
const godD: number | string = rb.getOrDefault(0, 'none');
void godB;
void godC;
void godD;

const newest: number = rb.peekNewest();
const oldest: number = rb.peekOldest();
const full: boolean = rb.isFull();
const empty: boolean = rb.isEmpty();
void newest;
void oldest;
void full;
void empty;

// --- bulk copies -------------------------------------------------------------
const c1: number = rb.copyTo(f32);
const c2: number = rb.copyTo(f64, 8);
const c3: number = rb.copyToFast(f32);
const c4: number = rb.copyToFast(f64, 8);
const c5: number = rb.copyLast(f32, 0, 16);
const c6: number = rb.copyLast(f64, undefined, 16);
const c7: number = rb.copyLastFast(f32, 0, 16);
const c8: number = rb.copyLastFast(f64, undefined, 16);
void c1;
void c2;
void c3;
void c4;
void c5;
void c6;
void c7;
void c8;

// --- iteration -----------------------------------------------------------------
let sum = 0;
for (const v of rb) {
    const n: number = v;
    sum += n;
}
const it: IterableIterator<number> = rb[Symbol.iterator]();
void it;
const asIterable: Iterable<number> = rb;
void asIterable;

rb.forEach((value: number, index: number, self: RingBuffer) => {
    sum += value + index + self.count;
});
rb.forEach((value) => { sum += value; });
void sum;

// --- lifecycle -----------------------------------------------------------------
rb.reset();
rb.destroy();

// --- misuse rows (each must error) ----------------------------------------------
// @ts-expect-error -- capacity is readonly.
rb.capacity = 8;

// @ts-expect-error -- data is readonly.
rb.data = new Float32Array(8);

// @ts-expect-error -- copyTo takes a Float32Array | Float64Array, not number[].
rb.copyTo([0, 0, 0]);

// @ts-expect-error -- copyLast requires n (the third argument).
rb.copyLast(f32, 0);

// @ts-expect-error -- pushBatch takes a Float32Array | Float64Array src, not Int16Array.
rb.pushBatch(new Int16Array(8));

// @ts-expect-error -- get returns number | undefined (out of range), not number.
const notNumber: number = rb.get(0);
void notNumber;
