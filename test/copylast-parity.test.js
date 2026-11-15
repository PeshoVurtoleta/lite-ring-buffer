// R3 copyLast / copyLastFast parity oracle (GROUP G1 batch H, TASK 5): ASSERTION A4 of
// .handoff/archive/1.5.0/R3/PLAN-G1.md. copyLast(d, off, count) must equal copyTo(d', off) on twin rings:
// outcome, return, error class, error message (method names mapped to one name), dst bytes,
// ring state and cache state; copyLastFast likewise against copyToFast, and against copyLast.
// Expected values for the lying-subclass lane come from a plain model (Math.fround then the
// element type's own conversion); the parity side is copyTo of the SAME build, an oracle the
// plan names. Build under test: RB_BUILD (absolute or package-relative) else ../RingBuffer.js.
// Kills: MB-len / MB-buf (dst.length / dst.buffer instead of the intrinsics), MN (name
// hard-coded 'copyLast'). MB-tag is killed by the copyWithin spy test in mutant-kills.
// Against the frozen build the methods do not exist: the first test fails (expected).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.RB_BUILD
    ? path.resolve(ROOT, process.env.RB_BUILD)
    : path.join(ROOT, 'RingBuffer.js');
const { RingBuffer } = await import(pathToFileURL(BUILD).href);

const SENT = 12345;
function VAL(i) { return (i % 2 === 0 ? 1 : -1) * (i * 1.37 + 0.31); }
function bytesOf(ta) { return new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength).slice(); }
function sameBytes(a, b) {
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function ringWith(cap, pushes) {
    const rb = new RingBuffer(cap);
    for (let i = 0; i < pushes; i++) rb.push(VAL(i));
    return rb;
}
// Method names mapped to one token, Fast names first (copyLastFast contains copyLast).
function norm(msg) { return msg.replace(/copyLastFast|copyToFast/g, 'M').replace(/copyLast|copyTo/g, 'M'); }
function isDetached(ta) { return ta.byteLength === 0 && ta.buffer.byteLength === 0 && ta.length === 0; }

// One call on one twin; returns a comparable record.
function run(rb, dst, call) {
    const dBytes = dst && ArrayBuffer.isView(dst) ? bytesOf(dst) : null;
    const rec = { ret: undefined, cls: null, msg: null, err: null };
    try { rec.ret = call(rb, dst); } catch (e) {
        rec.err = e;
        rec.cls = e instanceof TypeError ? 'TypeError' : e instanceof RangeError ? 'RangeError' : 'other ' + String(e);
        rec.msg = String(e && e.message);
    }
    rec.dst = dst && ArrayBuffer.isView(dst) && !isDetached(dst) ? bytesOf(dst) : null;
    rec.dstBefore = dBytes;
    rec.ring = Array.isArray(rb.data) ? null : (isDetached(rb.data) ? null : bytesOf(rb.data));
    rec.head = rb.head; rec.count = rb.count;
    return rec;
}
function cacheShape(rb) {
    const keyIsData = rb._bufOf === rb.data;
    let bufIsDataBuf = null;
    try { bufIsDataBuf = rb._buf === rb.data.buffer; } catch (e) { bufIsDataBuf = 'n/a'; }
    return [keyIsData, bufIsDataBuf].join('/');
}

// Compare a copyLast-family run against a copyTo-family run on twin rings.
function assertParity(label, a, b, bigDst) {
    assert.equal(a.cls, b.cls, label + ' class (' + a.msg + ' | ' + b.msg + ')');
    if (a.cls === null) assert.ok(Object.is(a.ret, b.ret), label + ' return ' + a.ret + ' vs ' + b.ret);
    else if (!bigDst) assert.equal(norm(a.msg), norm(b.msg), label + ' message');
    assert.ok(sameBytes(a.dst, b.dst), label + ' dst bytes');
    assert.ok(sameBytes(a.ring, b.ring), label + ' ring bytes');
    assert.equal(a.head, b.head, label + ' head');
    assert.equal(a.count, b.count, label + ' count');
    assert.equal(a.cache, b.cache, label + ' cache shape');
}
function finish(rb, rec) { rec.cache = cacheShape(rb); return rec; }

// Pairs: [copyLast-family method, its copyTo-family twin]
const PAIRS = [['copyLast', 'copyTo'], ['copyLastFast', 'copyToFast']];

describe('copyLast parity A0 surface', () => {
    it('both methods exist (fails on the frozen 4b471da build)', () => {
        for (const m of ['copyLast', 'copyLastFast']) assert.equal(typeof RingBuffer.prototype[m], 'function', m);
    });
});

describe('copyLast parity A4 matrix at n = count', () => {
    // kills MN (name), and any k / start / cache divergence from copyTo
    it('caps x pushes x off x element type: copyLast(d, off, count) == copyTo(d, off), Fast likewise, Fast == slow', () => {
        const TYPES = [Float32Array, Float64Array, Int16Array];
        let cases = 0;
        for (const cap of [1, 2, 8, 64]) {
            for (let p = 0; p <= 2 * cap + 3; p++) {
                for (const T of TYPES) {
                    for (const off of [0, 3]) {
                        const count = Math.min(p, cap);
                        const recs = {};
                        for (const [lm, tm] of PAIRS) {
                            const r1 = ringWith(cap, p), r2 = ringWith(cap, p);
                            const d1 = new T(off + count + 2).fill(SENT), d2 = new T(off + count + 2).fill(SENT);
                            const a = finish(r1, run(r1, d1, (rb, d) => rb[lm](d, off, count)));
                            const b = finish(r2, run(r2, d2, (rb, d) => rb[tm](d, off)));
                            assertParity(lm + ' vs ' + tm + ' ' + T.name + ' cap ' + cap + ' p ' + p + ' off ' + off, a, b, false);
                            recs[lm] = a;
                            cases++;
                        }
                        assertParity('Fast vs slow ' + T.name + ' cap ' + cap + ' p ' + p + ' off ' + off,
                            recs.copyLastFast, recs.copyLast, false);
                        cases++;
                    }
                }
            }
        }
        // (4 caps: pushes 0..2cap+3 -> 4+8... counted by sum of (2cap+4) = 12+16+...): sum over caps of
        // (2*cap + 4) = (6 + 8 + 20 + 132) = 166 pushes; x 3 types x 2 offsets x 3 comparisons = 2988.
        assert.equal(cases, 2988, 'cases run');
    });

    it('every head of a full 64 Float32 ring (ROT path of copyTo): copyLast(64) == copyTo, both families', () => {
        const rb1 = ringWith(64, 64), rb2 = ringWith(64, 64), rb3 = ringWith(64, 64), rb4 = ringWith(64, 64);
        for (let h = 0; h < 64; h++) {
            for (const [lm, tm, A, B] of [['copyLast', 'copyTo', rb1, rb2], ['copyLastFast', 'copyToFast', rb3, rb4]]) {
                const d1 = new Float32Array(70).fill(SENT), d2 = new Float32Array(70).fill(SENT);
                const a = finish(A, run(A, d1, (rb, d) => rb[lm](d, 2, 64)));
                const b = finish(B, run(B, d2, (rb, d) => rb[tm](d, 2)));
                assertParity(lm + ' head ' + h, a, b, false);
                assert.equal(a.ret, 64);
            }
            for (const rb of [rb1, rb2, rb3, rb4]) rb.push(VAL(64 + h));
        }
    });
});

describe('copyLast parity A4 error cases (16 rung-0 shapes) at n = count', () => {
    const SH = 8; // ring cap 8, 11 pushed (full, head 3)
    class LongLie extends Float32Array { get length() { return 1e9; } }
    // [label, make(rb) -> dst, off, ringMaker, bigInt]
    const std = () => ringWith(SH, 11);
    const CASES = [
        ['Array dst', () => [1, 2, 3, 4, 5, 6, 7, 8], 0, std],
        ['DataView dst', () => new DataView(new ArrayBuffer(64)), 0, std],
        ['null dst', () => null, 0, std],
        ['{} dst', () => ({}), 0, std],
        ['offset -1', () => new Float32Array(16), -1, std],
        ['offset 1.5', () => new Float32Array(16), 1.5, std],
        ['offset NaN', () => new Float32Array(16), NaN, std],
        ["offset '1'", () => new Float32Array(16), '1', std],
        ['dst too small', () => new Float32Array(4), 0, std],
        ['offset past the end', () => new Float32Array(16), 12, std],
        ['aliasing view', (rb) => new Float32Array(rb.data.buffer, 0, 8), 0, std],
        ['BigInt64Array dst', () => new BigInt64Array(16), 0, std, true],
        ['aliasing BigInt64Array', (rb) => new BigInt64Array(rb.data.buffer, 0, 4), 0, std],
        ['shorter storage', () => new Float32Array(16), 0, () => { const rb = std(); rb.data = new Float32Array(SH - 1); return rb; }],
        ['A1a data -> view of dst', null, 0, null],
        ['A1b data -> Array', () => new Float32Array(16).fill(SENT), 0, () => { const rb = std(); rb.copyTo(new Float32Array(8), 0); rb.data = Array(SH).fill(1); return rb; }, true],
    ];
    assert.equal(CASES.length, 16);

    // kills MN, MB-len, MB-buf
    it('same outcome class, message (names mapped) and untouched state, both families, 3 calls in a row', () => {
        for (const [label, make, off, mk, big] of CASES) {
            for (const [lm, tm] of PAIRS) {
                const build = () => {
                    if (label === 'A1a data -> view of dst') {
                        const rb = std();
                        const dst = new Float32Array(16).fill(SENT);
                        rb.copyTo(new Float32Array(8), 0);
                        rb.data = new Float32Array(dst.buffer, 0, SH);
                        return [rb, dst];
                    }
                    const rb = mk();
                    return [rb, make(rb)];
                };
                const [r1, d1] = build(), [r2, d2] = build();
                for (let rep = 0; rep < 3; rep++) {
                    const a = finish(r1, run(r1, d1, (rb, d) => rb[lm](d, off, r1.count)));
                    const b = finish(r2, run(r2, d2, (rb, d) => rb[tm](d, off)));
                    assertParity(label + ' ' + lm + ' rep ' + rep, a, b, big === true);
                    if (a.cls === 'RangeError' || a.cls === 'TypeError') {
                        assert.ok(sameBytes(a.dst, a.dstBefore), label + ' ' + lm + ' dst changed on throw');
                    }
                    if (a.cls !== null && !big) assert.ok(a.msg.indexOf(lm) >= 0, label + ' ' + lm + ' names itself: ' + a.msg);
                }
            }
        }
    });

    // kills MB-len: the bounds message names the intrinsic length (4), not the lying 1e9
    it('a dst whose length getter lies (1e9) on 4 real slots: RangeError naming dst.length 4', () => {
        for (const m of ['copyLast', 'copyLastFast']) {
            const rb = ringWith(SH, 11);
            const dst = new LongLie(4).fill(SENT);
            assert.throws(() => rb[m](dst, 0, 8), (e) => {
                assert.ok(e instanceof RangeError, String(e));
                assert.equal(e.message, 'LiteRingBuffer: ' + m + ' needs 8 slots from offset 0 (dst.length 4)');
                return true;
            });
            for (let i = 0; i < 4; i++) assert.equal(dst[i], SENT);
            // and the slow twin agrees
            const tm = m === 'copyLast' ? 'copyTo' : 'copyToFast';
            assert.throws(() => rb[tm](dst, 0), (e) => e instanceof RangeError && norm(e.message) === norm('LiteRingBuffer: ' + m + ' needs 8 slots from offset 0 (dst.length 4)'));
        }
    });

    // kills MB-buf: the alias check uses the intrinsic buffer getter
    it('a dst whose buffer getter lies still hits the alias error', () => {
        for (const m of ['copyLast', 'copyLastFast']) {
            const rb = ringWith(SH, 11);
            const dst = new Float32Array(rb.data.buffer, 0, SH);
            Object.defineProperty(dst, 'buffer', { get() { return new ArrayBuffer(64); } });
            const before = bytesOf(rb.data);
            assert.throws(() => rb[m](dst, 0, 3), (e) => e instanceof RangeError &&
                e.message === 'LiteRingBuffer: ' + m + " dst shares the ring's buffer (copy into a separate array); nothing written");
            assert.ok(sameBytes(before, bytesOf(rb.data)));
        }
    });

    // a lying (valid-looking) buffer on a non-aliasing dst must not trigger the alias error
    it('a dst whose buffer getter claims the ring buffer but is separate copies normally', () => {
        for (const m of ['copyLast', 'copyLastFast']) {
            const rb = ringWith(SH, 11);
            const dst = new Float32Array(8).fill(SENT);
            Object.defineProperty(dst, 'buffer', { get() { return rb.data.buffer; } });
            assert.equal(rb[m](dst, 0, 3), 3, m);
            for (let i = 0; i < 3; i++) assert.ok(Object.is(dst[i], Math.fround(VAL(8 + i))), m + ' slot ' + i);
        }
    });
});

describe('copyLast parity A4 lying-tag subclasses', () => {
    // Expected values from the model, independent of copyTo; the tag getter must be ignored.
    function check(label, make, T) {
        for (const [lm, tm] of PAIRS) {
            for (const full of [true, false]) {
                const p = full ? 64 + 21 : 40;
                const model = [];
                for (let i = Math.max(0, p - 64); i < p; i++) model.push(Math.fround(VAL(i)));
                const c = model.length;
                const r1 = ringWith(64, p), r2 = ringWith(64, p);
                const S = T === Int8Array ? 100 : SENT; // 100 is never an Int8 value of the model
                const d1 = make(c + 3).fill(S), d2 = make(c + 3).fill(S);
                assert.equal(r1[lm](d1, 1, c), c, label + ' ' + lm);
                assert.equal(r2[tm](d2, 1), c, label + ' ' + tm);
                for (let i = 0; i < d1.length; i++) {
                    const j = i - 1;
                    const want = j >= 0 && j < c ? T.of(model[j])[0] : S;
                    if (!Object.is(d1[i], want)) assert.fail(label + ' ' + lm + ' full ' + full + ' slot ' + i + ' got ' + d1[i] + ' want ' + want);
                }
                assert.ok(sameBytes(bytesOf(d1), bytesOf(d2)), label + ' ' + lm + ' vs ' + tm + ' bytes');
            }
        }
    }
    it('Float64Array / Int16Array / Int8Array subclasses claiming toStringTag Float32Array', () => {
        class F64AsF32 extends Float64Array { get [Symbol.toStringTag]() { return 'Float32Array'; } }
        class I16AsF32 extends Int16Array { get [Symbol.toStringTag]() { return 'Float32Array'; } }
        class I8AsF32 extends Int8Array { get [Symbol.toStringTag]() { return 'Float32Array'; } }
        check('F64 claims F32', (n) => new F64AsF32(n), Float64Array);
        check('Int16 claims F32', (n) => new I16AsF32(n), Int16Array);
        check('Int8 claims F32', (n) => new I8AsF32(n), Int8Array);
    });
    it('Float32Array subclass claiming toStringTag Float64Array / Int8Array', () => {
        class F32AsF64 extends Float32Array { get [Symbol.toStringTag]() { return 'Float64Array'; } }
        class F32AsI8 extends Float32Array { get [Symbol.toStringTag]() { return 'Int8Array'; } }
        check('F32 claims F64', (n) => new F32AsF64(n), Float32Array);
        check('F32 claims Int8', (n) => new F32AsI8(n), Float32Array);
    });
});
