// R1 oracle: copyTo / copyToFast against an independent model of the ring.
// Expected values come from the pushes made here (a JS array of Math.fround'd
// values), converted through the dst type by writing into a same-type scratch
// array. No copy method is ever used to compute an expectation.
// Build under test: RB_BUILD (absolute or package-relative) else ../RingBuffer.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.RB_BUILD
    ? path.resolve(ROOT, process.env.RB_BUILD)
    : path.join(ROOT, 'RingBuffer.js');
// Fail closed: a failed import throws and fails the file (never skips).
const { RingBuffer } = await import(pathToFileURL(BUILD).href);

const METHODS = ['copyTo', 'copyToFast'];
const SENT = 99;
const SPECIALS = [-0, NaN, Infinity, -Infinity, 0.5, 1.5, 2.5, 70000, -3.25];

// seeded 32-bit-exact PRNG (mulberry32); two independent streams
function prng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const kindStream = prng(0xC0FFEE01);
const valueStream = prng(0x1234ABCD);
let specialIdx = 0;
function nextValue() {
    if (kindStream() < 0.5) return SPECIALS[specialIdx++ % SPECIALS.length];
    return (valueStream() * 2 - 1) * 100000;
}
const key = (v) => (Object.is(v, -0) ? '-0' : String(v));

class F extends Float32Array {}
const XF32 = vm.runInNewContext('Float32Array');
const TYPES = [
    ['Float32Array', (n) => new Float32Array(n)],
    ['Float64Array', (n) => new Float64Array(n)],
    ['Int16Array', (n) => new Int16Array(n)],
    ['Uint8ClampedArray', (n) => new Uint8ClampedArray(n)],
    ['plain Float32Array subclass', (n) => new F(n)],
    ['cross-realm Float32Array', (n) => new XF32(n)],
];

function expectedOf(arr, c) { return arr.slice(arr.length - c); }

// One call, fully checked. Returns number of slots verified.
function check(rb, arr, method, make, off) {
    const c = rb.count;
    const dst = make(off + c + 3);
    dst.fill(SENT);
    const ret = rb[method](dst, off);
    if (ret !== c) assert.fail(method + ' returned ' + ret + ', want ' + c);
    const exp = expectedOf(arr, c);
    const scratch = make(1);
    for (let i = 0; i < c; i++) {
        scratch[0] = exp[i];
        if (!Object.is(dst[off + i], scratch[0])) {
            assert.fail(method + ' cap ' + rb.capacity + ' head ' + rb.head + ' count ' + c + ' off ' + off +
                ' slot ' + i + ': got ' + key(dst[off + i]) + ' want ' + key(scratch[0]));
        }
        seen.add(key(exp[i]));
    }
    for (let i = 0; i < dst.length; i++) {
        if (i >= off && i < off + c) continue;
        if (!Object.is(dst[i], SENT)) assert.fail(method + ' wrote guard slot ' + i);
    }
    return c;
}
const seen = new Set();

function sweep(method, make) {
    let cases = 0, want = 0;
    for (let cap = 1; cap <= 256; cap *= 2) {
        // non-full rings: head == count; counts deduped and clamped to [0, cap-1]
        const counts = new Set();
        for (const c of [0, 1, cap >> 1, (cap >> 1) + 1, cap - 1]) if (c >= 0 && c < cap) counts.add(c);
        want += (counts.size + cap) * 3;
        for (const c of counts) {
            const rb = new RingBuffer(cap), arr = [];
            for (let i = 0; i < c; i++) { const v = nextValue(); rb.push(v); arr.push(Math.fround(v)); }
            for (const off of [0, 1, 5]) { check(rb, arr, method, make, off); cases++; }
        }
        // full ring at every head position
        const rb = new RingBuffer(cap), arr = [];
        for (let i = 0; i < cap; i++) { const v = nextValue(); rb.push(v); arr.push(Math.fround(v)); }
        for (let h = 0; h < cap; h++) {
            assert.equal(rb.head, h);
            for (const off of [0, 1, 5]) { check(rb, arr, method, make, off); cases++; }
            const v = nextValue(); rb.push(v); arr.push(Math.fround(v));
        }
    }
    assert.equal(cases, want, 'coverage floor');
    assert.ok(cases >= 1600, 'coverage floor: ' + cases);
}

describe('A1 parity sweep vs independent model', () => {
    for (const method of METHODS) {
        for (const [name, make] of TYPES) {
            it(method + ' into ' + name, () => sweep(method, make));
        }
    }
    it('sweep exercised every special value', () => {
        for (const v of SPECIALS) assert.ok(seen.has(key(v)), 'never saw ' + key(v));
    });
});

describe('A2 BigInt dst fails closed', () => {
    for (const method of METHODS) {
        it(method + ' throws TypeError, writes nothing', () => {
            assert.equal(typeof RingBuffer.prototype[method], 'function');
            for (const cap of [8, 64]) for (const c of [1, cap]) for (const Big of [BigInt64Array, BigUint64Array]) {
                const rb = new RingBuffer(cap);
                for (let i = 0; i < c; i++) rb.push(i + 0.5);
                const dst = new Big(cap + 2).fill(7n);
                assert.throws(() => rb[method](dst, 0), TypeError);
                for (let i = 0; i < dst.length; i++) assert.equal(dst[i], 7n);
            }
        });
    }
});

function snap(rb) {
    return { bytes: new Uint8Array(rb.data.buffer).slice(), head: rb.head, count: rb.count };
}
function assertUnchanged(rb, s) {
    assert.deepEqual(new Uint8Array(rb.data.buffer), s.bytes);
    assert.equal(rb.head, s.head);
    assert.equal(rb.count, s.count);
}
function fill(rb, n) {
    const arr = [];
    for (let i = 0; i < n; i++) { const v = i * 1.25 - 7; rb.push(v); arr.push(Math.fround(v)); }
    return arr;
}

describe('A3 destination aliasing the ring storage', () => {
    class Liar extends Float32Array { get buffer() { return new ArrayBuffer(8); } }
    for (const method of METHODS) {
        it(method + ' alias -> RangeError, ring untouched', () => {
            // pushes: 64 -> start 0; 74 -> start 10 (<= n/2); 104 -> start 40 (> n/2); 20 -> non-full
            for (const pushes of [64, 74, 104, 20]) {
                const makers = [
                    (rb) => new Float32Array(rb.data.buffer),
                    (rb) => new Uint8Array(rb.data.buffer),
                    (rb) => new Liar(rb.data.buffer),
                    (rb) => rb.data,
                ];
                for (const mk of makers) {
                    const rb = new RingBuffer(64);
                    fill(rb, pushes);
                    const s = snap(rb);
                    assert.throws(() => rb[method](mk(rb), 0), {
                        name: 'RangeError',
                        message: new RegExp('^LiteRingBuffer: ' + method + ' dst shares'),
                    });
                    assertUnchanged(rb, s);
                }
            }
            // offset view: only meaningful when count fits in 63 slots
            const rb = new RingBuffer(64);
            fill(rb, 20);
            const s = snap(rb);
            assert.throws(() => rb[method](rb.data.subarray(1), 0), {
                name: 'RangeError',
                message: new RegExp('^LiteRingBuffer: ' + method + ' dst shares'),
            });
            assertUnchanged(rb, s);
        });
        it(method + ' foreign buffer whose getter returns the ring buffer copies correctly', () => {
            const rb = new RingBuffer(64);
            const arr = fill(rb, 90);
            const dst = new Float32Array(64 + 4);
            Object.defineProperty(dst, 'buffer', { get() { return rb.data.buffer; } });
            assert.equal(rb[method](dst, 2), 64);
            const exp = expectedOf(arr, 64);
            for (let i = 0; i < 64; i++) assert.ok(Object.is(dst[2 + i], exp[i]), 'slot ' + i);
        });
        it(method + ' empty and destroyed ring with alias dst return 0', () => {
            const rb = new RingBuffer(8);
            assert.equal(rb[method](new Float32Array(rb.data.buffer), 0), 0);
            assert.equal(rb[method](rb.data, 0), 0);
            const d = new RingBuffer(8);
            fill(d, 5);
            d.destroy();
            assert.equal(d[method](new Float32Array(d.data.buffer), 0), 0);
            assert.equal(d[method](d.data, 0), 0);
        });
    }
});

describe('A4 copyTo / copyToFast ignore overridden set / copyWithin', () => {
    class Evil extends Float32Array {
        set() { this.fill(777); }
        copyWithin() { this.fill(777); return this; }
    }
    for (const method of METHODS) it(method + ' into a lying subclass at cap 64, all start branches', () => {
        // pushes 64 -> start 0; 74 -> start 10 (<= n/2); 104 -> start 40 (> n/2)
        for (const pushes of [64, 74, 104]) {
            const rb = new RingBuffer(64);
            const arr = fill(rb, pushes);
            const dst = new Evil(64 + 3);
            dst.fill(SENT);
            assert.equal(rb[method](dst, 3), 64);
            const exp = expectedOf(arr, 64);
            for (let i = 0; i < 64; i++) assert.ok(Object.is(dst[3 + i], exp[i]), 'pushes ' + pushes + ' slot ' + i);
            for (let i = 0; i < 3; i++) assert.equal(dst[i], SENT);
        }
    });
    it('copyTo into a Float64Array re-prototyped to Float32Array gets float64 values', () => {
        for (const pushes of [64, 74, 104]) {
            const rb = new RingBuffer(64);
            const arr = fill(rb, pushes);
            const dst = Object.setPrototypeOf(new Float64Array(64 + 3), Float32Array.prototype);
            assert.equal(rb.copyTo(dst, 3), 64);
            const exp = expectedOf(arr, 64);
            for (let i = 0; i < 64; i++) assert.ok(Object.is(dst[3 + i], exp[i]), 'pushes ' + pushes + ' slot ' + i);
        }
    });
});

describe('copyTo / copyToFast validation (Q-F2): same checks, own name in the message', () => {
    const ring = () => { const rb = new RingBuffer(8); fill(rb, 5); return rb; };
    for (const method of METHODS) {
        const typeRe = new RegExp('^LiteRingBuffer: ' + method + ' needs a TypedArray dst');
        const rangeRe = new RegExp('^LiteRingBuffer: ' + method + ' needs ');
        it(method + ' TypeError for non-TypedArray dst', () => {
            assert.equal(typeof RingBuffer.prototype[method], 'function');
            for (const bad of [{}, null, [0, 0, 0, 0, 0, 0], new DataView(new ArrayBuffer(64))]) {
                assert.throws(() => ring()[method](bad, 0), (e) => e instanceof TypeError && typeRe.test(e.message));
            }
        });
        it(method + ' RangeError for bad dstOffset', () => {
            for (const off of [-1, 0.5, NaN]) {
                const dst = new Float32Array(16).fill(SENT);
                assert.throws(() => ring()[method](dst, off), (e) => e instanceof RangeError && rangeRe.test(e.message));
                for (let i = 0; i < 16; i++) assert.equal(dst[i], SENT);
            }
        });
        it(method + ' RangeError for a too-small dst, nothing written', () => {
            const dst = new Float32Array(6).fill(SENT);
            assert.throws(() => ring()[method](dst, 2), (e) => e instanceof RangeError && rangeRe.test(e.message));
            for (let i = 0; i < 6; i++) assert.equal(dst[i], SENT);
        });
    }
});
