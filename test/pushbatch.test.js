// R2 pushBatch oracle (GROUP G1 batch H, TASK 4): physical parity with n x push,
// bad-argument matrix, storage / alias / frozen / sealed rings, return values.
// Expected values come from PLAN-G1 ASSERTIONS A1-A4, PROPOSAL-r2 sections 2 / 7
// and addendum A1 (frozen ring); the oracle is a TWIN ring driven by n x `push`
// on the same initial state, never the pushBatch implementation.
// Build under test: RB_BUILD (absolute or package-relative) else ../RingBuffer.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The %TypedArray%.prototype.set spy must be live BEFORE the build is imported:
// the build captures the intrinsic at module load. Used to tell the `set` path
// from the loop path without reading any internals.
const TA_PROTO = Object.getPrototypeOf(Float32Array.prototype);
const realSet = TA_PROTO.set;
let setCalls = 0;
TA_PROTO.set = function set() {
    setCalls++;
    return realSet.apply(this, arguments);
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.RB_BUILD
    ? path.resolve(ROOT, process.env.RB_BUILD)
    : path.join(ROOT, 'RingBuffer.js');
// Fail closed: a failed import throws and fails the file (never skips).
const { RingBuffer } = await import(pathToFileURL(BUILD).href);

// Values that round when stored as float32, plus specials (NaN, -0, overflow to
// Infinity, underflow to 0, a float32-inexact integer).
const VAL = (i) => {
    switch (i % 11) {
        case 0: return 0.1 * i;
        case 1: return 1 / 3 + i;
        case 2: return NaN;
        case 3: return -0;
        case 4: return 1e39;
        case 5: return -7e-46;
        case 6: return -1e300;
        case 7: return 16777217 + i;
        default: return (i * 0.37) - 100.125;
    }
};
function fillSrc(Kind, len) {
    const s = new Kind(len);
    for (let i = 0; i < len; i++) s[i] = VAL(i + 1);
    return s;
}
// A ring in a chosen physical state; every data slot distinct and nonzero.
function mkRing(cap, head, count) {
    const r = new RingBuffer(cap);
    for (let i = 0; i < r.capacity; i++) r.data[i] = -1000 - i * 0.5;
    r.head = head;
    r.count = count;
    return r;
}
function sameState(a, b) {
    if (a.head !== b.head || a.count !== b.count || a.capacity !== b.capacity) return false;
    for (let i = 0; i < a.capacity; i++) if (!Object.is(a.data[i], b.data[i])) return false;
    return true;
}
function describeState(r) {
    return 'head ' + r.head + ' count ' + r.count + ' data [' + Array.from(r.data).join(',') + ']';
}

// Byte / value snapshot of anything a failed call must leave alone.
function viewBytes(v) {
    if (Array.isArray(v)) return v.slice();
    if (!v || !ArrayBuffer.isView(v)) return null;
    try { return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice(); } catch { return null; }
}
function sameBytes(a, b) {
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
}
function takeSnap(rb, src) {
    return {
        head: rb.head, count: rb.count, data: rb.data, dataB: viewBytes(rb.data),
        cacheOf: rb._bufOf, cache: rb._buf, src, srcB: viewBytes(src),
    };
}
function assertUnchanged(rb, s, label) {
    assert.equal(rb.head, s.head, label + ' head');
    assert.equal(rb.count, s.count, label + ' count');
    assert.equal(rb.data, s.data, label + ' data identity');
    assert.ok(sameBytes(s.dataB, viewBytes(rb.data)), label + ' data bytes');
    assert.equal(rb._bufOf, s.cacheOf, label + ' _bufOf identity');
    assert.equal(rb._buf, s.cache, label + ' _buf identity');
    assert.ok(sameBytes(s.srcB, viewBytes(s.src)), label + ' src bytes');
}
// class (exact) AND message pattern; re === null for a V8-own message
function expectThrow(fn, Cls, re, label) {
    assert.throws(fn, (e) => {
        assert.ok(e && e.constructor === Cls, label + ': want ' + Cls.name + ', got ' + (e && e.constructor && e.constructor.name) + ' ' + (e && e.message));
        if (re) assert.match(e.message, re, label);
        return true;
    });
}
const PB = /^LiteRingBuffer: pushBatch /;
function detach(rb) {
    const b = rb.data.buffer;
    if (typeof ArrayBuffer.prototype.transfer === 'function') b.transfer();
    else structuredClone(b, { transfer: [b] });
}

// seeded 32-bit-exact PRNG (mulberry32); independent streams
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

// A1 sweep, A4 -------------------------------------------------------------
describe('pushBatch A1 physical parity with n x push', () => {
    // Sweep: caps {1,2,8,64} x every head x initial count {0,1,cap} x count
    // {0,1,7,cap-1,cap,cap+1,2cap+3} x srcOffset {0,3} x tail {0,2} x {F32,F64};
    // tail 0 also runs the count-omitted call.
    // Precomputed total by hand: distinct initial counts 2 (cap 1) / 3 (others);
    // distinct counts 5 / 5 / 6 / 7 for cap 1 / 2 / 8 / 64; cases per
    // (head, c0, count) = 2 off x 2 tail x 2 kinds + 2 off x 2 kinds (omitted) = 12:
    // 1*2*5*12 + 2*3*5*12 + 8*3*6*12 + 64*3*7*12 = 120 + 360 + 1728 + 16128 = 18336.
    const SWEEP_TOTAL = 18336;
    it('18336 cases: returns count, same data slots (Object.is), head, count; set path exact', () => {
        let cases = 0;
        let setHits = 0;
        let f64Sets = 0;
        let omitted = 0;
        for (const cap of [1, 2, 8, 64]) for (let h = 0; h < cap; h++) {
            for (const c0 of [...new Set([0, 1, cap])]) {
                for (const cnt of [...new Set([0, 1, 7, cap - 1, cap, cap + 1, 2 * cap + 3])]) {
                    for (const off of [0, 3]) for (const tail of [0, 2]) for (const Kind of [Float32Array, Float64Array]) {
                        for (const useDefault of tail === 0 ? [false, true] : [false]) {
                            const src = fillSrc(Kind, off + cnt + tail);
                            const srcB = viewBytes(src);
                            const ref = mkRing(cap, h, c0);
                            const t = mkRing(cap, h, c0);
                            for (let i = 0; i < cnt; i++) ref.push(src[off + i]);
                            const before = setCalls;
                            const r = useDefault ? t.pushBatch(src, off) : t.pushBatch(src, off, cnt);
                            const sets = setCalls - before;
                            // SPEC step 6: one TA set iff Float32Array, whole src, no wrap, count > 0
                            const wantSet = Kind === Float32Array && off === 0 && tail === 0 && cnt > 0 && h + cnt <= cap ? 1 : 0;
                            if (r !== cnt || !sameState(ref, t) || sets !== wantSet || !sameBytes(srcB, viewBytes(src))) {
                                assert.fail('cap ' + cap + ' head ' + h + ' c0 ' + c0 + ' cnt ' + cnt + ' off ' + off + ' tail ' + tail +
                                    ' ' + Kind.name + (useDefault ? ' default-count' : '') + ': ret ' + r + ' sets ' + sets + ' (want ' + wantSet +
                                    ')\n  got  ' + describeState(t) + '\n  want ' + describeState(ref));
                            }
                            cases++;
                            setHits += sets;
                            if (Kind === Float64Array) f64Sets += sets;
                            if (useDefault) omitted++;
                        }
                    }
                }
            }
        }
        assert.equal(cases, SWEEP_TOTAL, 'cases-run total (no silently skipped case)');
        assert.equal(omitted, 2 * 2 * (64 * 3 * 7 + 8 * 3 * 6 + 2 * 3 * 5 + 1 * 2 * 5), 'count-omitted cases');
        assert.ok(setHits >= 1, 'the set path was hit: ' + setHits);
        assert.equal(f64Sets, 0, 'Float64 src never takes set');
    });

    it('set path: F32 whole contiguous = exactly one set; F64, slice, wrapped, over-cap = none', () => {
        const rb = new RingBuffer(1024);
        const whole = fillSrc(Float32Array, 128);
        setCalls = 0;
        assert.equal(rb.pushBatch(whole), 128);
        assert.equal(setCalls, 1, 'F32 whole, contiguous');
        setCalls = 0;
        rb.pushBatch(fillSrc(Float32Array, 131), 3);
        assert.equal(setCalls, 0, 'F32 slice (srcOffset 3)');
        setCalls = 0;
        rb.pushBatch(fillSrc(Float32Array, 131), 0, 128);
        assert.equal(setCalls, 0, 'F32 prefix of a longer src (count !== slen)');
        setCalls = 0;
        rb.pushBatch(fillSrc(Float64Array, 128));
        assert.equal(setCalls, 0, 'F64 whole');
        const w = mkRing(128, 100, 128);
        setCalls = 0;
        w.pushBatch(fillSrc(Float32Array, 64));
        assert.equal(setCalls, 0, 'F32 wrapped (head 100 + 64 > 128)');
        const w2 = mkRing(128, 64, 128);
        setCalls = 0;
        w2.pushBatch(fillSrc(Float32Array, 64));
        assert.equal(setCalls, 1, 'F32 ends exactly at the wrap point (64 + 64 <= 128)');
        const o = mkRing(64, 0, 0);
        setCalls = 0;
        o.pushBatch(fillSrc(Float32Array, 200));
        assert.equal(setCalls, 0, 'F32 count > capacity');
    });

    it('seeded random op mix on twin rings (push / tryPush / pushBatch), physical parity after every op', () => {
        let ops = 0, batches = 0, wholeF32 = 0, wrapped = 0, over = 0, slice = 0, f64 = 0, zero = 0, sets = 0, wantSets = 0;
        for (const seed of [0x1A2B3C4D, 0x5EED0002, 0x0DDBA11]) {
            const keyS = prng(seed);                   // op kinds
            const sizeS = prng(seed ^ 0x9E3779B9);     // capacities, counts, offsets
            const valS = prng(seed ^ 0x85EBCA6B);      // sample values
            const nextVal = () => {
                const u = valS();
                if (u < 0.2) return VAL(Math.floor(valS() * 1000));
                return (valS() * 2 - 1) * 100000;
            };
            const cap = 1 + Math.floor(sizeS() * 70);  // requested; pow2-rounded by the ring
            const a = new RingBuffer(cap);             // pushBatch side
            const b = new RingBuffer(cap);             // n x push twin
            for (let op = 0; op < 1500; op++) {
                const k = keyS();
                ops++;
                if (k < 0.15) { const v = nextVal(); a.push(v); b.push(v); }
                else if (k < 0.2) {
                    const v = nextVal(), ow = keyS() < 0.5 ? { overwrite: false } : undefined;
                    assert.equal(a.tryPush(v, ow), b.tryPush(v, ow));
                } else {
                    const C = a.capacity;
                    const kind = keyS() < 0.5 ? Float32Array : Float64Array;
                    let n, off, tail;
                    const shape = keyS();
                    if (shape < 0.3) { n = 1 + Math.floor(sizeS() * C); off = 0; tail = 0; }          // whole
                    else if (shape < 0.5) { n = Math.floor(sizeS() * (2 * C + 4)); off = Math.floor(sizeS() * 4); tail = Math.floor(sizeS() * 3); }
                    else if (shape < 0.7) { n = C + 1 + Math.floor(sizeS() * (C + 3)); off = Math.floor(sizeS() * 3); tail = 0; } // over
                    else { n = Math.floor(sizeS() * (C + 1)); off = Math.floor(sizeS() * 4); tail = Math.floor(sizeS() * 3); }
                    const src = new kind(off + n + tail);
                    for (let i = 0; i < src.length; i++) src[i] = nextVal();
                    const h0 = a.head;
                    for (let i = 0; i < n; i++) b.push(src[off + i]);
                    const before = setCalls;
                    const r = a.pushBatch(src, off, n);
                    sets += setCalls - before;
                    const ws = kind === Float32Array && off === 0 && n === src.length && n > 0 && h0 + n <= C ? 1 : 0;
                    wantSets += ws;
                    assert.equal(r, n);
                    if (!sameState(a, b)) assert.fail('seed ' + seed.toString(16) + ' op ' + op + ' n ' + n + ' off ' + off + '\n  got  ' + describeState(a) + '\n  want ' + describeState(b));
                    batches++;
                    if (n === 0) zero++;
                    if (n > C) over++;
                    if (ws === 1) wholeF32++;
                    if (n > 0 && n <= C && h0 + n > C) wrapped++;
                    if (off > 0) slice++;
                    if (kind === Float64Array) f64++;
                }
            }
        }
        assert.equal(sets, wantSets, 'set calls equal the SPEC step-6 prediction');
        // coverage floors (seeded, so these are stable numbers, not luck)
        assert.equal(ops, 4500);
        assert.ok(batches >= 3000, 'batches ' + batches);
        assert.ok(wholeF32 >= 100, 'whole F32 contiguous (set) ' + wholeF32);
        assert.ok(wrapped >= 100, 'wrapped ' + wrapped);
        assert.ok(over >= 200, 'count > capacity ' + over);
        assert.ok(slice >= 400, 'srcOffset > 0 ' + slice);
        assert.ok(f64 >= 1000, 'F64 ' + f64);
        assert.ok(zero >= 10, 'count 0 ' + zero);
    });

    it('subclasses of Float32Array / Float64Array are accepted; length / toStringTag overrides are ignored', () => {
        class F32S extends Float32Array {}
        class F64S extends Float64Array {
            get length() { return 0; }
            get [Symbol.toStringTag]() { return 'Int8Array'; }
        }
        for (const [Kind, label] of [[F32S, 'F32 subclass'], [F64S, 'F64 subclass with overrides']]) {
            const src = new Kind(11);
            for (let i = 0; i < 11; i++) src[i] = VAL(i + 1);
            const ref = mkRing(8, 5, 8), t = mkRing(8, 5, 8);
            for (let i = 0; i < 11; i++) ref.push(src[i]);
            assert.equal(t.pushBatch(src, 0, 11), 11, label);
            assert.ok(sameState(ref, t), label);
        }
    });
});

// A4 ----------------------------------------------------------------------
describe('pushBatch A4 return values and defaults', () => {
    it('(src) returns slen; (src, 3) equals (src, 3, slen - 3); explicit undefined equals omitted', () => {
        const src = fillSrc(Float64Array, 13);
        const mk = () => mkRing(8, 6, 3);
        const a = mk(), b = mk(), c = mk();
        for (let i = 0; i < 13; i++) a.push(src[i]);
        assert.equal(b.pushBatch(src), 13);
        assert.ok(sameState(a, b), '(src)');
        const calls = [
            (r) => r.pushBatch(src, undefined),
            (r) => r.pushBatch(src, undefined, undefined),
        ];
        for (const f of calls) { const r = mk(); assert.equal(f(r), 13); assert.ok(sameState(a, r), 'explicit undefined'); }
        const d = mk(), e = mk(), f = mk(), g = mk();
        for (let i = 3; i < 13; i++) d.push(src[i]);
        assert.equal(e.pushBatch(src, 3), 10);
        assert.equal(f.pushBatch(src, 3, 10), 10);
        assert.equal(g.pushBatch(src, 3, undefined), 10);
        assert.ok(sameState(d, e) && sameState(d, f) && sameState(d, g), '(src, 3) family');
        const h = mk(), i2 = mk();
        for (let i = 0; i < 4; i++) h.push(src[i]);
        assert.equal(i2.pushBatch(src, undefined, 4), 4);
        assert.ok(sameState(h, i2), '(src, undefined, 4)');
        void c;
    });

    it('count 2cap+3 returns 2cap+3 (not cap); srcOffset == slen with count 0 is valid and returns 0', () => {
        for (const cap of [1, 8, 64]) {
            const n = 2 * cap + 3;
            const src = fillSrc(Float32Array, n);
            const rb = mkRing(cap, cap - 1, 0), ref = mkRing(cap, cap - 1, 0);
            for (let i = 0; i < n; i++) ref.push(src[i]);
            assert.equal(rb.pushBatch(src), n, 'cap ' + cap);
            assert.ok(sameState(rb, ref));
        }
        const rb = mkRing(8, 2, 5);
        const s = takeSnap(rb, fillSrc(Float32Array, 6));
        assert.equal(rb.pushBatch(s.src, 6), 0, 'srcOffset == slen, count omitted');
        assert.equal(rb.pushBatch(s.src, 6, 0), 0, 'srcOffset == slen, count 0');
        assert.equal(rb.pushBatch(s.src, 0, 0), 0, 'count 0');
        assertUnchanged(rb, s, 'count 0 no-op');
    });

    it('-0 is accepted as srcOffset and as count (integers); count -0 is a no-op returning 0', () => {
        const src = fillSrc(Float32Array, 9);
        const ref = mkRing(8, 3, 4), t = mkRing(8, 3, 4);
        for (let i = 0; i < 9; i++) ref.push(src[i]);
        assert.equal(t.pushBatch(src, -0), 9);
        assert.ok(sameState(ref, t), 'srcOffset -0');
        const t2 = mkRing(8, 3, 4), ref2 = mkRing(8, 3, 4);
        for (let i = 0; i < 4; i++) ref2.push(src[i]);
        assert.equal(t2.pushBatch(src, -0, 4), 4);
        assert.ok(sameState(ref2, t2), '(src, -0, 4)');
        const t3 = mkRing(8, 3, 4), s3 = takeSnap(t3, src);
        assert.equal(t3.pushBatch(src, 2, -0), 0);
        assertUnchanged(t3, s3, 'count -0');
    });
});

// A2 ----------------------------------------------------------------------
describe('pushBatch A2 bad arguments (class, message, nothing changed)', () => {
    // each case runs on a COLD-cache and a WARM-cache ring (a warm call first)
    function rings() {
        const cold = mkRing(8, 3, 5);
        const warm = mkRing(8, 3, 5);
        warm.pushBatch(fillSrc(Float64Array, 2), 0, 2);   // populates the alias cache
        return [['cold', cold], ['warm', warm]];
    }
    let calls = 0;
    const hostile = () => ({
        valueOf() { calls++; return 1; },
        toString() { calls++; return '1'; },
        [Symbol.toPrimitive]() { calls++; return 1; },
    });

    it('RangeError: srcOffset in {-1, 1.5, NaN, Infinity, null, "1", 1n, Symbol(), obj}, count given and omitted', () => {
        let ran = 0;
        const offs = [['-1', -1], ['1.5', 1.5], ['NaN', NaN], ['Infinity', Infinity], ['null', null], ["'1'", '1'],
            ['1n', 1n], ['Symbol()', Symbol('o')], ['obj', hostile()], ['-Infinity', -Infinity]];
        calls = 0;
        for (const Kind of [Float32Array, Float64Array]) for (const [lab, off] of offs) {
            for (const [rl, rb] of rings()) for (const withCount of [true, false]) {
                const src = fillSrc(Kind, 8);
                const s = takeSnap(rb, src);
                const fn = withCount ? () => rb.pushBatch(src, off, 2) : () => rb.pushBatch(src, off);
                expectThrow(fn, RangeError, PB, Kind.name + ' srcOffset ' + lab + ' ' + rl + (withCount ? '' : ' count omitted'));
                assertUnchanged(rb, s, Kind.name + ' srcOffset ' + lab + ' ' + rl);
                ran++;
            }
        }
        assert.equal(ran, 2 * offs.length * 2 * 2, 'cases run');
        assert.equal(calls, 0, 'valueOf / toString / toPrimitive calls');
    });

    it('RangeError: count in {-1, 0.5, NaN, null, "2", 1n, Infinity, Symbol(), obj}; srcOffset + count = slen + 1', () => {
        let ran = 0;
        calls = 0;
        const cnts = [['-1', -1], ['0.5', 0.5], ['NaN', NaN], ['null', null], ["'2'", '2'], ['1n', 1n],
            ['Infinity', Infinity], ['Symbol()', Symbol('c')], ['obj', hostile()]];
        for (const Kind of [Float32Array, Float64Array]) {
            for (const [lab, cnt] of cnts) for (const [rl, rb] of rings()) {
                const src = fillSrc(Kind, 8);
                const s = takeSnap(rb, src);
                expectThrow(() => rb.pushBatch(src, 0, cnt), RangeError, PB, Kind.name + ' count ' + lab + ' ' + rl);
                assertUnchanged(rb, s, Kind.name + ' count ' + lab + ' ' + rl);
                ran++;
            }
            // srcOffset + count = slen + 1 (slen 8), several splits
            for (const [off, cnt] of [[0, 9], [3, 6], [8, 1], [7, 2], [9, 0]]) for (const [rl, rb] of rings()) {
                const src = fillSrc(Kind, 8);
                const s = takeSnap(rb, src);
                expectThrow(() => rb.pushBatch(src, off, cnt), RangeError, PB, Kind.name + ' (' + off + ',' + cnt + ') ' + rl);
                assertUnchanged(rb, s, Kind.name + ' (' + off + ',' + cnt + ') ' + rl);
                ran++;
            }
        }
        assert.equal(ran, 2 * (cnts.length * 2 + 5 * 2), 'cases run');
        assert.equal(calls, 0, 'valueOf / toString / toPrimitive calls');
    });

    it('srcOffset 1n / Symbol() / {valueOf} with count omitted -> RangeError (not TypeError), valueOf not called', () => {
        calls = 0;
        const src = fillSrc(Float32Array, 8);
        for (const off of [1n, Symbol('s'), hostile(), { valueOf() { calls++; return 1; } }]) {
            const rb = mkRing(8, 1, 2);
            const s = takeSnap(rb, src);
            expectThrow(() => rb.pushBatch(src, off), RangeError, PB, 'omitted count, srcOffset ' + typeof off);
            assertUnchanged(rb, s, 'omitted count');
        }
        assert.equal(calls, 0, 'no user code ran');
    });

    it('TypeError at count 0 AND count > 0: every other TypedArray (BigInt kinds, Float16 if present), DataView, Array, {length:4}, null', () => {
        const kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];
        if (typeof Float16Array === 'function') kinds.push(Float16Array);
        let ran = 0;
        calls = 0;
        const mkSrcs = () => {
            const out = kinds.map((K) => [K.name, new K(8), true]);
            out.push(['DataView', new DataView(new ArrayBuffer(32)), false], ['Array', [1, 2, 3, 4, 5, 6, 7, 8], false],
                ['{length:4}', { length: 4, 0: 1, 1: 2, 2: 3, 3: 4 }, false], ['null', null, false], ['undefined', undefined, false],
                ['string', 'abcd', false], ['number', 4, false]);
            return out;
        };
        for (const cnt of [0, 2]) for (const [lab, src, isTA] of mkSrcs()) for (const [rl, rb] of rings()) {
            const s = takeSnap(rb, src);
            // a non-TypedArray: the intrinsic length getter throws V8's own TypeError (no package message)
            expectThrow(() => rb.pushBatch(src, 0, cnt), TypeError, isTA ? PB : null, lab + ' count ' + cnt + ' ' + rl);
            assertUnchanged(rb, s, lab + ' count ' + cnt + ' ' + rl);
            ran++;
        }
        assert.equal(ran, 2 * mkSrcs().length * 2, 'cases run');
        assert.ok(kinds.length >= 9);
        assert.equal(calls, 0);
        // the count-omitted call too (default count = slen - 0)
        for (const [lab, src] of mkSrcs()) {
            const rb = mkRing(8, 3, 5), s = takeSnap(rb, src);
            expectThrow(() => rb.pushBatch(src), TypeError, null, lab + ' count omitted');
            assertUnchanged(rb, s, lab + ' count omitted');
        }
    });

    it('order: bounds before type (BigInt64Array(2) count 5 -> RangeError); type at count 0 (Int16Array(0) -> TypeError)', () => {
        for (const [rl, rb] of rings()) {
            const big = new BigInt64Array(2);
            let s = takeSnap(rb, big);
            expectThrow(() => rb.pushBatch(big, 0, 5), RangeError, PB, 'BigInt64Array(2) count 5 ' + rl);
            assertUnchanged(rb, s, 'big');
            const i16 = new Int16Array(2);
            s = takeSnap(rb, i16);
            expectThrow(() => rb.pushBatch(i16, 0, 5), RangeError, PB, 'Int16Array(2) count 5 ' + rl);
            assertUnchanged(rb, s, 'i16');
            const empty = new Int16Array(0);
            s = takeSnap(rb, empty);
            expectThrow(() => rb.pushBatch(empty), TypeError, PB, 'Int16Array(0) ' + rl);
            assertUnchanged(rb, s, 'i16 empty');
            const bad = new BigUint64Array(0);
            s = takeSnap(rb, bad);
            expectThrow(() => rb.pushBatch(bad, 0, 0), TypeError, PB, 'BigUint64Array(0) count 0 ' + rl);
            assertUnchanged(rb, s, 'bu64 empty');
        }
    });
});

// A3 ----------------------------------------------------------------------
describe('pushBatch A3 storage, alias, sealed and frozen rings', () => {
    it('storage RangeError at counts 1 and 2: data length cap-1 / cap+1 / detached; count 0 returns 0', () => {
        let ran = 0;
        for (const cap of [8, 64]) for (const mode of ['short', 'long', 'detached']) {
            for (const cnt of [1, 2, 0]) for (const Kind of [Float32Array, Float64Array]) {
                const rb = mkRing(cap, 3, 5);
                if (mode === 'short') rb.data = new Float32Array(cap - 1).fill(7.5);
                else if (mode === 'long') rb.data = new Float32Array(cap + 1).fill(7.5);
                else detach(rb);
                const len = mode === 'short' ? cap - 1 : mode === 'long' ? cap + 1 : 0;
                const src = fillSrc(Kind, 4);
                const s = takeSnap(rb, src);
                const label = 'cap ' + cap + ' ' + mode + ' count ' + cnt + ' ' + Kind.name;
                if (cnt === 0) {
                    assert.equal(rb.pushBatch(src, 0, 0), 0, label);
                } else {
                    expectThrow(() => rb.pushBatch(src, 0, cnt), RangeError,
                        new RegExp('^LiteRingBuffer: pushBatch storage holds ' + len + ' slots, capacity is ' + cap +
                            ' \\(data replaced, resized or detached\\); nothing written$'), label);
                }
                assertUnchanged(rb, s, label);
                ran++;
            }
        }
        assert.equal(ran, 2 * 3 * 3 * 2, 'cases run');
    });

    it('alias RangeError /shares/ at count 1: src = data, F32 view, F64 view of the ring buffer; count 0 returns 0', () => {
        let ran = 0;
        const mkSrcs = {
            'src = rb.data': (r) => r.data,
            'F32 view of data buffer': (r) => new Float32Array(r.data.buffer, 8, 2),
            'F64 view of data buffer': (r) => new Float64Array(r.data.buffer, 0, 2),
            'Float32 subarray': (r) => r.data.subarray(1, 5),
        };
        for (const [lab, mk] of Object.entries(mkSrcs)) for (const warm of [false, true]) for (const cnt of [1, 2]) {
            const rb = mkRing(8, 2, 8);
            if (warm) rb.pushBatch(fillSrc(Float32Array, 2), 0, 2);
            const src = mk(rb);
            const s = takeSnap(rb, src);
            const label = lab + (warm ? ' warm' : ' cold') + ' count ' + cnt;
            expectThrow(() => rb.pushBatch(src, 0, cnt), RangeError, /^LiteRingBuffer: pushBatch .*shares/, label);
            // the check may populate a COLD cache (legitimately); data, head, count, src stay
            assert.equal(rb.head, s.head, label + ' head');
            assert.equal(rb.count, s.count, label + ' count');
            assert.ok(sameBytes(s.dataB, viewBytes(rb.data)), label + ' data bytes');
            assert.ok(sameBytes(s.srcB, viewBytes(src)), label + ' src bytes');
            if (warm) { assert.equal(rb._bufOf, s.cacheOf, label + ' _bufOf'); assert.equal(rb._buf, s.cache, label + ' _buf'); }
            else assert.equal(rb._buf, rb._bufOf.buffer, label + ' cache invariant _buf === _bufOf.buffer');
            // count 0: no check, returns 0, nothing changes
            const s0 = takeSnap(rb, src);
            assert.equal(rb.pushBatch(src, 0, 0), 0, label + ' count 0');
            assertUnchanged(rb, s0, label + ' count 0');
            ran++;
        }
        assert.equal(ran, 4 * 2 * 2);
    });

    it('A1a analogue: warm call, data replaced, src = view of the new buffer -> RangeError x3, nothing written', () => {
        const rb = mkRing(64, 5, 30);
        rb.pushBatch(fillSrc(Float32Array, 64), 0, 64);       // warm: caches the old data's buffer
        const nd = new Float32Array(64);
        for (let i = 0; i < 64; i++) nd[i] = 50 + i;
        rb.data = nd;
        for (const Kind of [Float32Array, Float64Array, Float32Array]) {
            const src = new Kind(nd.buffer, 0, Kind === Float64Array ? 1 : 2);
            const s = takeSnap(rb, src);
            expectThrow(() => rb.pushBatch(src, 0, 1), RangeError, /^LiteRingBuffer: pushBatch .*shares/, Kind.name);
            assert.equal(rb.head, s.head);
            assert.equal(rb.count, s.count);
            assert.ok(sameBytes(s.dataB, viewBytes(rb.data)));
            assert.ok(sameBytes(s.srcB, viewBytes(src)));
            assert.equal(rb._buf, rb._bufOf.buffer, 'cache invariant');
        }
    });

    it('A1b analogue: warm call, data = Array -> TypeError on each of 3 calls, nothing written', () => {
        const rb = mkRing(64, 5, 30);
        rb.pushBatch(fillSrc(Float32Array, 64), 0, 64);
        rb.data = Array(64).fill(1);
        for (let k = 0; k < 3; k++) {
            const src = fillSrc(k === 1 ? Float64Array : Float32Array, 4);
            const s = takeSnap(rb, src);
            expectThrow(() => rb.pushBatch(src, 0, 2), TypeError, null, 'call ' + k);
            assertUnchanged(rb, s, 'call ' + k);
        }
    });

    it('data length 2cap with src a subarray of it -> storage RangeError, not shares (storage is checked first)', () => {
        const rb = mkRing(8, 2, 8);
        rb.data = new Float32Array(16).fill(3.5);
        const src = rb.data.subarray(0, 4);
        const s = takeSnap(rb, src);
        expectThrow(() => rb.pushBatch(src, 0, 2), RangeError,
            /^LiteRingBuffer: pushBatch storage holds 16 slots, capacity is 8/, 'subarray of 2cap data');
        assertUnchanged(rb, s, '2cap');
    });

    it('sealed and preventExtensions rings: 3 calls match the push twin, _bufOf / _buf unchanged', () => {
        for (const [lock, lab] of [[Object.seal, 'seal'], [Object.preventExtensions, 'preventExtensions']]) {
            for (const Kind of [Float32Array, Float64Array]) {
                const rb = mkRing(8, 0, 0), twin = mkRing(8, 0, 0);
                lock(rb);
                const of0 = rb._bufOf, buf0 = rb._buf;
                // contiguous whole (set path for F32), wrapped, over-capacity
                for (const n of [4, 6, 19]) {
                    const src = fillSrc(Kind, n);
                    for (let i = 0; i < n; i++) twin.push(src[i]);
                    assert.equal(rb.pushBatch(src), n, lab + ' ' + Kind.name + ' n ' + n);
                    assert.ok(sameState(rb, twin), lab + ' ' + Kind.name + ' n ' + n + '\n  got  ' + describeState(rb) + '\n  want ' + describeState(twin));
                    assert.equal(rb._bufOf, of0, lab + ' _bufOf unchanged');
                    assert.equal(rb._buf, buf0, lab + ' _buf unchanged');
                }
            }
            // a locked ring whose data was replaced BEFORE the lock: still works, cache not written, alias follows the new buffer
            const rb2 = mkRing(8, 1, 3);
            rb2.data = new Float32Array(8).fill(9.5);
            lock(rb2);
            const of2 = rb2._bufOf, buf2 = rb2._buf;
            const view = new Float32Array(rb2.data.buffer, 0, 2);
            const s = takeSnap(rb2, view);
            expectThrow(() => rb2.pushBatch(view, 0, 1), RangeError, /^LiteRingBuffer: pushBatch .*shares/, lab + ' replaced-then-locked alias');
            assertUnchanged(rb2, s, lab + ' alias');
            assert.equal(rb2._bufOf, of2);
            assert.equal(rb2._buf, buf2);
            assert.equal(rb2.pushBatch(fillSrc(Float64Array, 3)), 3, lab + ' replaced-then-locked push');
            assert.equal(rb2._bufOf, of2, lab + ' _bufOf unchanged after push');
        }
    });

    it('frozen ring (Q-R2-FROZEN): TypeError, data / head / count unchanged; count 0 still returns 0', () => {
        const shapes = [
            ['F32 whole contiguous (set path)', Float32Array, 4, 0, 4, 0],
            ['F32 wrapped', Float32Array, 6, 0, 6, 6],
            ['F64 slice', Float64Array, 9, 3, 4, 2],
            ['F32 count > cap', Float32Array, 19, 0, 19, 5],
            ['F64 count > cap', Float64Array, 19, 2, 17, 0],
        ];
        for (const cap of [8, 64]) for (const [lab, Kind, slen0, off, cnt0, head] of shapes) {
            const over = lab.includes('> cap');
            const slen = over ? 2 * cap + 3 + off : slen0;      // count 2cap+3 for the over-capacity shapes
            const cnt = over ? 2 * cap + 3 : cnt0;
            const rb = mkRing(cap, head, Math.min(cap, 5));
            Object.freeze(rb);
            const src = fillSrc(Kind, slen);
            const s = takeSnap(rb, src);
            for (let k = 0; k < 2; k++) {
                expectThrow(() => rb.pushBatch(src, off, cnt), TypeError, /head/, lab + ' cap ' + cap + ' call ' + k);
                assertUnchanged(rb, s, lab + ' cap ' + cap + ' call ' + k);
            }
            assert.equal(rb.pushBatch(src, off, 0), 0, lab + ' count 0');
            assertUnchanged(rb, s, lab + ' count 0');
        }
    });

    it('own keys are the same after pushBatch calls (no field added to the ring)', () => {
        const rb = new RingBuffer(8);
        const keys0 = Reflect.ownKeys(rb);
        rb.pushBatch(fillSrc(Float32Array, 5));
        rb.pushBatch(fillSrc(Float64Array, 19), 2, 11);
        rb.pushBatch(fillSrc(Float32Array, 3), 3, 0);
        rb.data = new Float32Array(8);
        rb.pushBatch(fillSrc(Float32Array, 5));
        rb.destroy();
        assert.deepEqual(Reflect.ownKeys(rb), keys0);
    });
});

// Q-R2-DATA (addendum A3) ---------------------------------------------------
// Ruling: count > 0 and rb.data not a Float32Array (intrinsic toStringTag) ->
// TypeError on EVERY call, nothing written, alias cache untouched. count 0
// never runs the data check. Expectations come from the ruling text only.
describe('replaced storage element type (Q-R2-DATA)', () => {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const msg = (tag) => new RegExp('^' + esc('LiteRingBuffer: pushBatch storage is a ' + tag +
        ', not a Float32Array; nothing written') + '$');
    const CAP = 8;
    const KINDS = [BigInt64Array, BigUint64Array, Float64Array, Int16Array];
    function badData(Kind) {
        const d = new Kind(CAP);
        const big = Kind === BigInt64Array || Kind === BigUint64Array;
        for (let i = 0; i < CAP; i++) d[i] = big ? BigInt(i + 11) : (i + 11);
        return d;
    }
    function badRing(Kind, head) {
        const rb = new RingBuffer(CAP);
        rb.head = head;
        rb.count = 3;
        rb.data = badData(Kind);
        return rb;
    }
    // path name, ring head, src maker (n), srcOffset
    const PATHS = [
        ['F32 set path (offset 0, h + n <= cap)', 2, (n) => fillSrc(Float32Array, n), 0],
        ['F32 loop path (srcOffset > 0)', 2, (n) => fillSrc(Float32Array, n + 1), 1],
        ['F32 loop path (wrapping head)', 7, (n) => fillSrc(Float32Array, n), 0],
        ['F64 src', 2, (n) => fillSrc(Float64Array, n), 0],
    ];
    function threeThrows(rb, tag, src, off, n, lab) {
        const s = takeSnap(rb, src);
        for (let k = 0; k < 3; k++) {
            expectThrow(() => rb.pushBatch(src, off, n), TypeError, msg(tag), lab + ' call ' + k);
            assertUnchanged(rb, s, lab + ' call ' + k);
        }
    }

    for (const Kind of KINDS) {
        for (const [pname, head, mk, off] of PATHS) {
            it(Kind.name + ' storage, ' + pname + ': TypeError every call, nothing written', () => {
                for (const n of [1, 2]) {
                    const rb = badRing(Kind, head);
                    threeThrows(rb, Kind.name, mk(n), off, n, Kind.name + ' n ' + n);
                }
            });
        }
    }

    for (const Kind of KINDS) {
        it(Kind.name + ' storage, alias cache primed by copyTo: same throw, cache untouched', () => {
            for (const [pname, head, mk, off] of PATHS) {
                for (const n of [1, 2]) {
                    const rb = badRing(Kind, head);
                    try { rb.copyTo(new Float32Array(CAP)); } catch { /* may throw; only the cache matters */ }
                    assert.ok(rb._bufOf === rb.data, 'scenario: copyTo must have cached the bad data (' + Kind.name + ')');
                    threeThrows(rb, Kind.name, mk(n), off, n, Kind.name + ' cached ' + pname + ' n ' + n);
                }
            }
        });
    }

    for (const Kind of KINDS) {
        it(Kind.name + ' storage, count 0: returns 0, nothing changes (check is count > 0 only)', () => {
            for (const [pname, head, mk, off] of PATHS) {
                const rb = badRing(Kind, head);
                const src = mk(2);
                const s = takeSnap(rb, src);
                for (let k = 0; k < 3; k++) {
                    assert.equal(rb.pushBatch(src, off, 0), 0, Kind.name + ' ' + pname + ' call ' + k);
                    assertUnchanged(rb, s, Kind.name + ' ' + pname + ' call ' + k);
                }
            }
        });
    }

    it('restoring a Float32Array(cap) after a bad kind: pushBatch works and matches the n x push twin', () => {
        for (const Kind of KINDS) {
            for (const [pname, head, mk, off] of PATHS) {
                const rb = badRing(Kind, head);
                expectThrow(() => rb.pushBatch(mk(2), off, 2), TypeError, msg(Kind.name), Kind.name);
                const good = new Float32Array(CAP);
                for (let i = 0; i < CAP; i++) good[i] = -1000 - i * 0.5;
                rb.data = good;
                const twin = mkRing(CAP, head, 3);
                const src = mk(2);
                assert.equal(rb.pushBatch(src, off, 2), 2, Kind.name + ' ' + pname);
                for (let i = 0; i < 2; i++) twin.push(src[off + i]);
                assert.ok(sameState(rb, twin), Kind.name + ' ' + pname + ': ' + describeState(rb) + ' vs ' + describeState(twin));
            }
        }
    });

    // Pins the INTRINSIC tag: a spoofed prototype / toStringTag / constructor
    // must not make a BigInt64Array pass as a Float32Array.
    it('spoofed Float32Array identity on BigInt64Array storage still throws (intrinsic tag)', () => {
        class SpoofTag extends BigInt64Array { get [Symbol.toStringTag]() { return 'Float32Array'; } }
        const makers = [
            () => { const d = badData(BigInt64Array); Object.setPrototypeOf(d, Float32Array.prototype); return d; },
            () => { const d = new SpoofTag(CAP); for (let i = 0; i < CAP; i++) d[i] = BigInt(i + 11); return d; },
            () => { const d = badData(BigInt64Array); Object.defineProperty(d, 'constructor', { value: Float32Array }); return d; },
        ];
        for (let m = 0; m < makers.length; m++) {
            for (const [pname, head, mk, off] of PATHS) {
                for (const n of [1, 2]) {
                    const rb = new RingBuffer(CAP);
                    rb.head = head;
                    rb.count = 3;
                    rb.data = makers[m]();
                    threeThrows(rb, 'BigInt64Array', mk(n), off, n, 'spoof ' + m + ' ' + pname + ' n ' + n);
                }
            }
        }
    });

    // Real Float32Arrays (cross-realm, subclass) are accepted and match the twin.
    it('cross-realm Float32Array and a Float32Array subclass storage push like the n x push twin', () => {
        class F32Sub extends Float32Array {}
        const makers = [
            () => vm.runInNewContext('new Float32Array(8)'),
            () => new F32Sub(CAP),
        ];
        for (let m = 0; m < makers.length; m++) {
            for (const [pname, head, mk, off] of PATHS) {
                const rb = new RingBuffer(CAP);
                const good = makers[m]();
                assert.equal(good.length, CAP);
                for (let i = 0; i < CAP; i++) good[i] = -1000 - i * 0.5;
                rb.data = good;
                rb.head = head;
                rb.count = 3;
                const twin = mkRing(CAP, head, 3);
                const src = mk(2);
                assert.equal(rb.pushBatch(src, off, 2), 2, 'maker ' + m + ' ' + pname);
                for (let i = 0; i < 2; i++) twin.push(src[off + i]);
                assert.ok(sameState(rb, twin), 'maker ' + m + ' ' + pname + ': ' + describeState(rb) + ' vs ' + describeState(twin));
            }
        }
    });

    it('non-typed-array storage keeps its own error; wrong-length BigInt64Array hits the storage RangeError', () => {
        const rb = new RingBuffer(CAP);
        rb.data = [];
        expectThrow(() => rb.pushBatch(fillSrc(Float32Array, 2), 0, 2), TypeError, null, 'data []');
        assert.throws(() => rb.pushBatch(fillSrc(Float32Array, 2), 0, 2),
            (e) => e instanceof TypeError && !/storage is a /.test(e.message));
        const rb2 = new RingBuffer(CAP);
        rb2.data = new BigInt64Array(CAP + 1);
        expectThrow(() => rb2.pushBatch(fillSrc(Float32Array, 2), 0, 2), RangeError, /holds 9 slots/, 'len 9');
    });
});
