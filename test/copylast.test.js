// R3 copyLast / copyLastFast oracle (GROUP G1 batch H, TASK 4): ASSERTIONS A1, A2, A3
// of .handoff/archive/1.5.0/R3/PLAN-G1.md plus addenda A1 (literal 0 at k === 0) and A2 (exact n message).
// Expected values come from a plain array of the pushed values (Math.fround, then the
// destination element type's own conversion) and from the message texts in the plan;
// never from copyTo and never from a run of the build.
// Build under test: RB_BUILD (absolute or package-relative) else ../RingBuffer.js.
// Each test title names the mutants (M*, MA, MB-*, MK, MZ, M7F, MF, MN, MX) it kills.
// Against the frozen build the methods do not exist: the first test fails (expected).
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

const METHODS = ['copyLast', 'copyLastFast'];
const SENT = 12345; // representable in Float32 / Float64 / Int16, never an expected value

// VAL(i): non-integer, both signs, deterministic (no PRNG needed: the matrix is exhaustive).
function VAL(i) { return (i % 2 === 0 ? 1 : -1) * (i * 1.37 + 0.31); }

function bytesOf(ta) { return new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength).slice(); }
function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
function ringState(rb) {
    return { data: bytesOf(rb.data), head: rb.head, count: rb.count };
}
function assertRing(rb, s, label) {
    assert.ok(sameBytes(s.data, bytesOf(rb.data)), label + ' ring data changed');
    assert.equal(rb.head, s.head, label + ' head');
    assert.equal(rb.count, s.count, label + ' count');
}
function ringWith(cap, pushes) {
    const rb = new RingBuffer(cap);
    for (let i = 0; i < pushes; i++) rb.push(VAL(i));
    return rb;
}
function throwsWith(fn, Cls, msg, label) {
    assert.throws(fn, (e) => {
        assert.ok(e instanceof Cls, label + ' want ' + Cls.name + ', got ' + e);
        assert.equal(e.message, msg, label + ' message');
        return true;
    });
}
const P = (m) => 'LiteRingBuffer: ' + m;
const nMsg = (m, got) => P(m + ' needs a non-negative integer n (got ' + got + ')');
const boundsMsg = (m, n, off, dlen) => P(m + ' needs ' + n + ' slots from offset ' + off + ' (dst.length ' + dlen + ')');
const aliasMsg = (m) => P(m + " dst shares the ring's buffer (copy into a separate array); nothing written");
const storageMsg = (m, len, cap) => P(m + ' storage holds ' + len + ' slots, capacity is ' + cap +
    ' (data replaced, resized or detached); nothing written');
const dstTypeMsg = (m, got) => P(m + ' needs a TypedArray dst (got ' + got + ')');

describe('copyLast A0 surface', () => {
    it('both methods exist on the prototype (fails on the frozen 4b471da build)', () => {
        for (const m of METHODS) {
            assert.equal(typeof RingBuffer.prototype[m], 'function', m);
        }
    });
});

describe('copyLast A1 sweep', () => {
    // kills M1 (start+1), M2 (k not clamped), M3 (k clamped to capacity), M4 (ROT for k < count on a
    // full ring: n 33 on a full 64 ring overruns a 38-slot dst), M12 (start from count), MF (second set at dstOffset)
    it('caps x pushes x n x off x element type x both methods: return, last-k values, guards, ring', () => {
        const TYPES = [['Float32Array', Float32Array], ['Float64Array', Float64Array], ['Int16Array', Int16Array]];
        let cases = 0, rot = 0;
        for (const cap of [1, 2, 8, 64]) {
            for (let p = 0; p <= 2 * cap + 3; p++) {
                const rb = ringWith(cap, p);
                const c = Math.min(p, cap);
                assert.equal(rb.count, c);
                const model = [];
                for (let i = Math.max(0, p - cap); i < p; i++) model.push(Math.fround(VAL(i)));
                assert.equal(model.length, c);
                const ns = [...new Set([0, 1, 2, 33, cap - 1, cap, c, c + 1, cap + 5])];
                const st = ringState(rb);
                for (const [tname, T] of TYPES) {
                    for (const m of METHODS) {
                        for (const off of [0, 3]) {
                            for (const n of ns) {
                                const k = n < c ? n : c;
                                const dst = new T(off + n + 2).fill(SENT);
                                const ret = rb[m](dst, off, n);
                                const label = m + ' ' + tname + ' cap ' + cap + ' pushes ' + p + ' off ' + off + ' n ' + n;
                                assert.ok(Object.is(ret, k), label + ' return ' + ret + ' want ' + k);
                                for (let i = 0; i < dst.length; i++) {
                                    const j = i - off;
                                    let want = SENT;
                                    if (j >= 0 && j < k) want = T.of(model[c - k + j])[0];
                                    if (!Object.is(dst[i], want)) {
                                        assert.fail(label + ' slot ' + i + ' got ' + dst[i] + ' want ' + want);
                                    }
                                }
                                assertRing(rb, st, label);
                                cases++;
                                if (tname === 'Float32Array' && cap === 64 && c === 64 && n >= 64) rot++;
                            }
                        }
                    }
                }
            }
        }
        // Independent total (scratch counting script, not the build): per cap and pushes p the deduped n set
        // has size s(p); total = sum(s) * 2 offsets * 3 types * 2 methods = 16152 over the four caps.
        assert.equal(cases, 16152, 'cases-run total');
        // Float32 full-64 cases with n >= 64: 2 offsets x 2 methods x (n sets of the 68 pushes with
        // count 64: pushes 64..131 = 68 pushes x 3 n values {64, 65 (c+1), 69 (cap+5)}, c = cap dedupes) = 816.
        assert.equal(rot, 816, 'full-ring Float32 whole-window cases');
        assert.ok(rot >= 64, 'ROT floor');
    });

    it('a full 64 ring, Float32, k = 64 at every head: whole window in order (ROT path of copyLast, kills M1 / M12 / M4)', () => {
        const cap = 64;
        const rb = new RingBuffer(cap);
        const pushed = [];
        for (let i = 0; i < cap; i++) { rb.push(VAL(i)); pushed.push(Math.fround(VAL(i))); }
        let hits = 0;
        for (let h = 0; h < cap; h++) {
            for (const m of METHODS) {
                const dst = new Float32Array(cap + 5).fill(SENT);
                assert.equal(rb[m](dst, 2, cap), cap);
                for (let i = 0; i < dst.length; i++) {
                    const j = i - 2;
                    const want = j >= 0 && j < cap ? pushed[pushed.length - cap + j] : SENT;
                    if (!Object.is(dst[i], want)) assert.fail(m + ' head ' + rb.head + ' slot ' + i + ' got ' + dst[i] + ' want ' + want);
                }
                hits++;
            }
            const v = VAL(cap + h);
            rb.push(v); pushed.push(Math.fround(v));
        }
        assert.equal(hits, 128);
    });
});

describe('copyLast A2 n, bounds, order', () => {
    // dst, ring and cache untouched on every throw; both methods; exact text of addendum A2
    function untouched(m, mk, make, call, Cls, msg, label) {
        const rb = mk();
        const dst = make(rb);
        const dBytes = dst && ArrayBuffer.isView(dst) ? bytesOf(dst) : null;
        const st = ringState(rb);
        const bo = rb._bufOf, bf = rb._buf;
        throwsWith(() => call(rb, dst), Cls, msg, label);
        if (dBytes) assert.ok(sameBytes(dBytes, bytesOf(dst)), label + ' dst changed');
        assertRing(rb, st, label);
        assert.equal(rb._bufOf, bo, label + ' _bufOf');
        assert.equal(rb._buf, bf, label + ' _buf');
    }
    const cold = () => ringWith(8, 5);
    const warm = () => { const rb = ringWith(8, 11); rb.copyTo(new Float32Array(8), 0); return rb; };

    // kills M5 (n check dropped), M10 (n <= 0 throws), MA (n checked after the bounds), MN (name hard-coded)
    it('a bad n is a RangeError with the exact message (12 shapes, cold and warm cache, both methods)', () => {
        const NS = [
            ['NaN', NaN, 'NaN'], ['-1', -1, '-1'], ['1.5', 1.5, '1.5'], ["'1'", '1', 'string'], ['null', null, 'null'],
            ['Infinity', Infinity, 'Infinity'], ['-Infinity', -Infinity, '-Infinity'], ['true', true, 'boolean'],
            ['1n', 1n, 'bigint'], ['{}', {}, 'object'], ['Symbol()', Symbol('s'), 'symbol'], ['undefined', undefined, 'undefined'],
        ];
        let cases = 0;
        for (const m of METHODS) {
            for (const mk of [cold, warm]) {
                for (const [label, n, got] of NS) {
                    untouched(m, mk, () => new Float32Array(8).fill(SENT),
                        (rb, dst) => rb[m](dst, 0, n), RangeError, nMsg(m, got), m + ' n ' + label);
                    cases++;
                }
                // omitted n, with and without dstOffset
                untouched(m, mk, () => new Float32Array(8).fill(SENT), (rb, dst) => rb[m](dst, 0), RangeError,
                    nMsg(m, 'undefined'), m + ' n omitted');
                untouched(m, mk, () => new Float32Array(8).fill(SENT), (rb, dst) => rb[m](dst), RangeError,
                    nMsg(m, 'undefined'), m + ' dstOffset and n omitted');
                cases += 2;
            }
        }
        assert.equal(cases, 2 * 2 * 14, 'cases run');
    });

    // kills M5: a coercing check would call user code
    it('an object n never has valueOf / toString / Symbol.toPrimitive called', () => {
        for (const m of METHODS) {
            let calls = 0;
            const n = {
                valueOf() { calls++; return 3; },
                toString() { calls++; return '3'; },
                [Symbol.toPrimitive]() { calls++; return 3; },
            };
            const rb = cold();
            throwsWith(() => rb[m](new Float32Array(8), 0, n), RangeError, nMsg(m, 'object'), m);
            assert.equal(calls, 0, m + ' user code ran');
        }
    });

    // kills M10 (n <= 0 throws) and the -0 HeapNumber return (addendum A1)
    it('n = -0 and n = 0 return +0, dst untouched', () => {
        for (const m of METHODS) {
            for (const mk of [cold, () => ringWith(8, 0)]) {
                const rb = mk();
                const dst = new Float32Array(3).fill(SENT);
                const st = ringState(rb);
                assert.ok(Object.is(rb[m](dst, 0, -0), 0), m + ' -0');
                assert.ok(Object.is(rb[m](dst, 0, 0), 0), m + ' 0');
                for (let i = 0; i < 3; i++) assert.equal(dst[i], SENT);
                assertRing(rb, st, m);
            }
        }
    });

    // kills M6 (bounds on count), MK (bounds on k), MA
    it('n 2^31 and 2^53 are integers: bounds error naming n (empty and full ring)', () => {
        for (const m of METHODS) {
            for (const mk of [() => ringWith(8, 0), () => ringWith(8, 8)]) {
                untouched(m, mk, () => new Float32Array(8).fill(SENT), (rb, dst) => rb[m](dst, 0, 2147483648),
                    RangeError, boundsMsg(m, '2147483648', 0, 8), m + ' 2^31');
                untouched(m, mk, () => new Float32Array(8).fill(SENT), (rb, dst) => rb[m](dst, 0, 9007199254740992),
                    RangeError, boundsMsg(m, '9007199254740992', 0, 8), m + ' 2^53');
            }
        }
    });

    // kills MK (bounds on k: would return 3), M6
    it('bounds are on n: count 3, n 120, dst length 3 -> needs 120 slots; count 8, n 3, dst length 5 -> 3', () => {
        for (const m of METHODS) {
            untouched(m, () => ringWith(8, 3), () => new Float32Array(3).fill(SENT), (rb, dst) => rb[m](dst, 0, 120),
                RangeError, boundsMsg(m, 120, 0, 3), m + ' n 120');
            const rb = ringWith(8, 8);
            const dst = new Float32Array(5).fill(SENT);
            assert.equal(rb[m](dst, 0, 3), 3, m);
            for (let i = 0; i < 3; i++) assert.ok(Object.is(dst[i], Math.fround(VAL(5 + i))), m + ' slot ' + i);
            assert.equal(dst[3], SENT);
            assert.equal(dst[4], SENT);
        }
    });

    // kills M6, MK: dstOffset arms of the bounds check
    it('dstOffset errors: -1, 1.5, NaN, "1", past the end, too small (exact text)', () => {
        for (const m of METHODS) {
            for (const [label, off, shown] of [['-1', -1, '-1'], ['1.5', 1.5, '1.5'], ['NaN', NaN, 'NaN'], ["'1'", '1', '1'], ['5', 5, '5']]) {
                untouched(m, cold, () => new Float32Array(8).fill(SENT), (rb, dst) => rb[m](dst, off, 4),
                    RangeError, boundsMsg(m, 4, shown, 8), m + ' off ' + label);
            }
        }
    });

    // kills MA (n after bounds), MB-len (dst.length instead of the intrinsic)
    it('check order by message: DataView TypeError; n before dstOffset; n before bounds; bounds before alias / storage', () => {
        for (const m of METHODS) {
            untouched(m, cold, () => new DataView(new ArrayBuffer(32)), (rb, dv) => rb[m](dv, -1, NaN),
                TypeError, dstTypeMsg(m, 'object'), m + ' DataView');
            untouched(m, cold, () => new Float32Array(8).fill(SENT), (rb, dst) => rb[m](dst, -1, NaN),
                RangeError, nMsg(m, 'NaN'), m + ' (dst, -1, NaN)');
            untouched(m, cold, () => new Float32Array(0), (rb, dst) => rb[m](dst, 0, 1.5),
                RangeError, nMsg(m, '1.5'), m + ' (F32(0), 0, 1.5)');
            // bounds before alias: dst aliases the ring but is too small for n
            untouched(m, cold, (rb) => new Float32Array(rb.data.buffer, 0, 2), (rb, dst) => rb[m](dst, 0, 4),
                RangeError, boundsMsg(m, 4, 0, 2), m + ' bounds before alias');
            // bounds before storage: storage short, dst too small
            untouched(m, () => { const rb = cold(); rb.data = new Float32Array(7); return rb; },
                () => new Float32Array(2).fill(SENT), (rb, dst) => rb[m](dst, 0, 4),
                RangeError, boundsMsg(m, 4, 0, 2), m + ' bounds before storage');
            // alias before storage: storage is a 72-slot view over dst's buffer (cap 64), dst aliases it (kills X2)
            {
                const rb = ringWith(64, 100), adst = new Float32Array(80);
                rb.data = new Float32Array(adst.buffer, 0, 72);
                const before = bytesOf(adst), st = ringState(rb);
                throwsWith(() => rb[m](adst, 0, 3), RangeError, aliasMsg(m), m + ' alias before storage');
                assert.ok(sameBytes(before, bytesOf(adst)), m + ' alias before storage: dst changed');
                assertRing(rb, st, m + ' alias before storage');
            }
            // dst type before the n check, even for an other-realm DataView (kills X10)
            assert.throws(() => ringWith(8, 5)[m](vm.runInNewContext('new DataView(new ArrayBuffer(64))'), 0, NaN), TypeError, m + ' other-realm DataView');
            // dst type before everything
            untouched(m, cold, () => null, (rb) => rb[m](null, 0, 1), TypeError, dstTypeMsg(m, 'null'), m + ' null');
            untouched(m, cold, () => [1, 2, 3], (rb, d) => rb[m](d, 0, 1), TypeError, dstTypeMsg(m, 'object'), m + ' Array');
        }
    });
});

describe('copyLast A3 k = 0, alias, storage, cache', () => {
    // kills M7F (copyLastFast without its k === 0 return), MZ (alias / storage gated on rb.count)
    it('n 0 returns 0 with an aliasing dst, short storage, or a BigInt64Array dst (both methods); no cache fill', () => {
        for (const m of METHODS) {
            let rb = ringWith(8, 5);
            assert.equal(rb[m](rb.data, 0, 0), 0, m + ' alias');
            assert.equal(rb._bufOf === rb.data, false, m + ' k = 0 must not fill the cache');
            rb = ringWith(8, 5);
            rb.data = new Float32Array(7);
            assert.equal(rb[m](new Float32Array(2), 0, 0), 0, m + ' cap-1 storage');
            rb = ringWith(8, 5);
            assert.equal(rb[m](new BigInt64Array(4), 0, 0), 0, m + ' BigInt64Array');
            rb = ringWith(8, 5);
            assert.equal(rb[m](new BigUint64Array(4), 0, 0), 0, m + ' BigUint64Array');
            // empty ring, n > 0: k = 0 as well
            rb = new RingBuffer(8);
            assert.equal(rb[m](rb.data, 0, 5), 0, m + ' empty ring, aliasing dst');
            assert.equal(rb[m](new BigInt64Array(8), 0, 5), 0, m + ' empty ring, BigInt dst');
        }
    });

    // kills M7F (a BigInt set throws even when empty is covered above); here the non-empty arm
    it('n 2 with a BigInt64Array dst is a TypeError (both methods)', () => {
        for (const m of METHODS) {
            const rb = ringWith(8, 5);
            const dst = new BigInt64Array(8).fill(7n);
            const before = bytesOf(dst);
            assert.equal(typeof rb[m], 'function', m + ' exists');
            assert.throws(() => rb[m](dst, 0, 2), TypeError, m);
            assert.ok(sameBytes(before, bytesOf(dst)), m + ' dst changed');
        }
    });

    // kills M8 (alias dropped), M11 (storage dropped), MZ
    it('alias and storage errors at n 1 (cap+1, cap-1, detached), exact text', () => {
        for (const m of METHODS) {
            const mkRb = () => ringWith(8, 11);
            throwsWith(() => { const rb = mkRb(); rb[m](rb.data, 0, 1); }, RangeError, aliasMsg(m), m + ' alias');
            throwsWith(() => { const rb = mkRb(); rb[m](new Uint8Array(rb.data.buffer), 0, 1); }, RangeError, aliasMsg(m), m + ' alias bytes');
            throwsWith(() => { const rb = mkRb(); rb.data = new Float32Array(9); rb[m](new Float32Array(4), 0, 1); },
                RangeError, storageMsg(m, 9, 8), m + ' cap+1');
            throwsWith(() => { const rb = mkRb(); rb.data = new Float32Array(7); rb[m](new Float32Array(4), 0, 1); },
                RangeError, storageMsg(m, 7, 8), m + ' cap-1');
            throwsWith(() => {
                const rb = mkRb();
                structuredClone(rb.data.buffer, { transfer: [rb.data.buffer] });
                rb[m](new Float32Array(4), 0, 1);
            }, RangeError, storageMsg(m, 0, 8), m + ' detached');
            // dst untouched on each
            const rb = mkRb(); rb.data = new Float32Array(9);
            const dst = new Float32Array(4).fill(SENT);
            assert.throws(() => rb[m](dst, 0, 3), RangeError);
            for (let i = 0; i < 4; i++) assert.equal(dst[i], SENT);
        }
    });

    // regression pin (A1a analogue on the new methods); kills M9 (cache key before the read), M8
    it('A1a analogue: data replaced by a view of dst -> RangeError on 3 calls in a row, dst unchanged', () => {
        for (const warmWith of ['copyTo', 'copyLast']) {
            const rb = ringWith(64, 100);
            const dst = new Float32Array(64).fill(SENT);
            if (warmWith === 'copyTo') rb.copyTo(new Float32Array(64), 0); else rb.copyLast(new Float32Array(64), 0, 64);
            rb.data = new Float32Array(dst.buffer, 0, 64);
            for (const m of ['copyLast', 'copyLastFast', 'copyLast']) {
                throwsWith(() => rb[m](dst, 0, 3), RangeError, aliasMsg(m), warmWith + ' ' + m);
            }
            for (let i = 0; i < 64; i++) assert.equal(dst[i], SENT);
        }
    });

    // regression pin (A1b analogue); kills M9: a throw must leave the cache identity unchanged
    it('A1b analogue: data replaced by an Array -> TypeError on 3 calls, cache identity unchanged, dst untouched', () => {
        for (const warmWith of ['copyTo', 'copyLast']) {
            const rb = ringWith(64, 100);
            const dst = new Float32Array(64).fill(SENT);
            if (warmWith === 'copyTo') rb.copyTo(new Float32Array(64), 0); else rb.copyLast(new Float32Array(64), 0, 64);
            const bo = rb._bufOf, bf = rb._buf;
            rb.data = Array(64).fill(1);
            for (const m of ['copyLast', 'copyLastFast', 'copyLast']) {
                assert.throws(() => rb[m](dst, 0, 3), TypeError, warmWith + ' ' + m);
                assert.equal(rb._bufOf, bo, 'cache key');
                assert.equal(rb._buf, bf, 'cache buf');
                for (let i = 0; i < 64; i++) assert.equal(dst[i], SENT);
            }
        }
    });

    // kills M13 (cache written on a locked ring)
    it('sealed / preventExtensions / frozen rings with replaced data copy correctly and never write the cache', () => {
        const LOCKS = [['seal', Object.seal], ['preventExtensions', Object.preventExtensions], ['freeze', Object.freeze]];
        for (const [lname, lock] of LOCKS) {
            for (const m of METHODS) {
                const rb = ringWith(8, 11);
                const model = [];
                for (let i = 3; i < 11; i++) model.push(Math.fround(VAL(i)));
                rb.copyTo(new Float32Array(8), 0); // fill the cache against the original data
                const copy = new Float32Array(rb.data);
                rb.data = copy; // replaced data, same contents; cache is now stale
                lock(rb);
                const bo = rb._bufOf, bf = rb._buf;
                const dst = new Float32Array(10).fill(SENT);
                assert.equal(rb[m](dst, 1, 5), 5, lname + ' ' + m);
                for (let i = 0; i < 5; i++) assert.ok(Object.is(dst[1 + i], model[3 + i]), lname + ' ' + m + ' slot ' + i);
                assert.equal(dst[0], SENT);
                assert.equal(dst[6], SENT);
                assert.equal(rb._bufOf, bo, lname + ' ' + m + ' _bufOf');
                assert.equal(rb._buf, bf, lname + ' ' + m + ' _buf');
                // alias still caught on a locked ring
                throwsWith(() => rb[m](rb.data, 0, 1), RangeError, aliasMsg(m), lname + ' ' + m + ' alias');
            }
        }
    });

    // kills MX (an extra `_lbuf` cache field), M9: copyLast shares the cache with copyTo / pushBatch
    it('cache sharing via a poisoned _buf: copyLast fills and copyTo / pushBatch hit', () => {
        const poisonDst = new Float32Array(16);
        // copyLast fills -> copyTo hits
        let rb = ringWith(8, 11);
        rb.copyLast(new Float32Array(8), 0, 3);
        assert.equal(rb._bufOf, rb.data, 'copyLast fills _bufOf');
        assert.equal(rb._buf, rb.data.buffer, 'copyLast fills _buf');
        rb._buf = poisonDst.buffer;
        throwsWith(() => rb.copyTo(poisonDst, 0), RangeError, aliasMsg('copyTo'), 'copyTo hit');
        // copyLast fills -> pushBatch hits
        rb = ringWith(8, 11);
        rb.copyLastFast(new Float32Array(8), 0, 3);
        rb._buf = poisonDst.buffer;
        const src = new Float32Array(poisonDst.buffer, 0, 4);
        assert.throws(() => rb.pushBatch(src, 0, 2), (e) => e instanceof RangeError && /^LiteRingBuffer: pushBatch /.test(e.message));
    });

    it('cache sharing via a poisoned _buf: copyTo / pushBatch fill and copyLast hits', () => {
        const poisonDst = new Float32Array(16);
        for (const m of METHODS) {
            let rb = ringWith(8, 11);
            rb.copyTo(new Float32Array(8), 0);
            rb._buf = poisonDst.buffer;
            throwsWith(() => rb[m](poisonDst, 0, 3), RangeError, aliasMsg(m), m + ' after copyTo');
            rb = ringWith(8, 11);
            rb.pushBatch(new Float32Array(4), 0, 4);
            assert.equal(rb._bufOf, rb.data, 'pushBatch fills _bufOf');
            rb._buf = poisonDst.buffer;
            throwsWith(() => rb[m](poisonDst, 0, 3), RangeError, aliasMsg(m), m + ' after pushBatch');
        }
    });

    // kills M9: a stale key must miss and refresh, not hit
    it('a cache keyed to other data misses: copy succeeds and the cache is re-keyed', () => {
        for (const m of METHODS) {
            const rb = ringWith(8, 11);
            rb.copyTo(new Float32Array(8), 0);
            const poisonDst = new Float32Array(16);
            rb._buf = poisonDst.buffer;
            const other = new Float32Array(rb.data); // same contents, new array
            rb.data = other;
            const dst = poisonDst;
            assert.equal(rb[m](dst, 0, 2), 2, m);
            assert.equal(rb._bufOf, other, m + ' re-keyed');
            assert.equal(rb._buf, other.buffer, m + ' re-buffered');
        }
    });
});
