// R3 qa boundary suite for copyLast(dst, dstOffset, n) / copyLastFast (independent of the
// helper's copylast.test.js / copylast-parity.test.js). Oracle: PLAN-G1 ASSERTIONS A1-A4 +
// addenda A1 (literal +0 at k === 0) and A2 (exact n message), PROPOSAL-r3 section 7, and the
// RingBuffer.d.ts copyLast / copyLastFast JSDoc. Expected values come from a plain JS model of
// the pushed values (Math.fround, then the dst element type's own conversion) and, as a second
// oracle, from the newest k slots of copyTo on the same ring -- never from copyLast itself.
// Messages: copyTo's builders with the method name swapped (d.ts: "throws exactly as copyTo,
// the messages name copyLast") and the A2 n text.
// Build under test: RB_BUILD (absolute or package-relative) else ../RingBuffer.js. A failed
// import throws (never skips). Every case first asserts the method exists, so against a build
// without copyLast each test fails on its own.
// Not coverable here: a counter / position crossing 2^30 / 2^31 -- head is masked to < capacity
// and a capacity >= 2^30 needs a >= 4 GiB Float32Array; the large-n / large-offset integers are
// covered as arguments instead, and head wrap is exercised 2^17 times by one pushBatch.
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
const KINDS = [Float32Array, Float64Array, Int16Array];
const SENT = -4321; // exact in every kind used here, never a pushed value

// Pushed values: non-integers of both signs plus -0, NaN and +/-Infinity every few slots.
function pv(i) {
    const r = i % 23;
    if (r === 5) return -0;
    if (r === 11) return NaN;
    if (r === 17) return (i & 1) ? -Infinity : Infinity;
    return (i % 3 === 0 ? -1 : 1) * (i * 0.6180339 + 0.0625);
}
const conv = (T, v) => T.of(v)[0];
const stored = (v) => Math.fround(v);

function call(rb, m, ...args) {
    assert.equal(typeof rb[m], 'function', 'RingBuffer.prototype.' + m + ' missing in ' + BUILD);
    return rb[m](...args);
}

// Throws with exactly this class (and message when given); rethrows a harness assertion.
function throwsExact(fn, Cls, msg, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    if (err instanceof assert.AssertionError) throw err;
    assert.ok(err !== null, label + ': did not throw');
    assert.ok(err instanceof Cls, label + ': got ' + (err && err.name) + ' ' + (err && err.message));
    if (msg !== undefined) assert.equal(err.message, msg, label);
    return err;
}

const msgDst = (m, d) => 'LiteRingBuffer: ' + m + ' needs a TypedArray dst (got ' + d + ')';
const msgN = (m, g) => 'LiteRingBuffer: ' + m + ' needs a non-negative integer n (got ' + g + ')';
const msgBounds = (m, n, off, dlen) => 'LiteRingBuffer: ' + m + ' needs ' + n + ' slots from offset ' + off +
    ' (dst.length ' + dlen + ')';
const msgAlias = (m) => 'LiteRingBuffer: ' + m + ' dst shares the ring\'s buffer (copy into a separate array); nothing written';
const msgStorage = (m, len, cap) => 'LiteRingBuffer: ' + m + ' storage holds ' + len + ' slots, capacity is ' + cap +
    ' (data replaced, resized or detached); nothing written';

function bytesOf(ta) { return new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength).slice(); }
function snapRing(rb) { return { d: bytesOf(rb.data), h: rb.head, c: rb.count, bo: rb._bufOf, b: rb._buf }; }
function sameRing(rb, s, label) {
    assert.deepEqual(bytesOf(rb.data), s.d, label + ' ring data');
    assert.equal(rb.head, s.h, label + ' head');
    assert.equal(rb.count, s.c, label + ' count');
}

// A ring plus its model (the stored values in push order).
function mk(cap, pushes, base = 0) {
    const rb = new RingBuffer(cap);
    const model = [];
    for (let i = 0; i < pushes; i++) { const v = pv(base + i); rb.push(v); model.push(stored(v)); }
    return { rb, model };
}
function lastK(model, cap, n) {
    const win = model.length > cap ? model.slice(model.length - cap) : model.slice();
    const k = Math.min(n, win.length);
    return win.slice(win.length - k);
}

// One call: return === k (Object.is, so +0 at k 0), [off, off+k) = expected, every other
// slot the sentinel, ring unchanged; the same window via the newest k of copyTo.
function check(rb, model, m, T, dlen, off, n, label) {
    const exp = lastK(model, rb.capacity, n);
    const k = exp.length;
    const dst = new T(dlen).fill(SENT);
    const s = snapRing(rb);
    const ret = call(rb, m, dst, off, n);
    assert.ok(Object.is(ret, k), label + ': returned ' + ret + ', want ' + k);
    for (let i = 0; i < dlen; i++) {
        const want = i >= off && i < off + k ? conv(T, exp[i - off]) : SENT;
        assert.ok(Object.is(dst[i], want), label + ': slot ' + i + ' = ' + dst[i] + ', want ' + want);
    }
    sameRing(rb, s, label);
    if (k > 0) {
        const whole = new T(rb.count);
        rb.copyTo(whole, 0);
        for (let i = 0; i < k; i++) {
            assert.ok(Object.is(dst[off + i], whole[rb.count - k + i]), label + ': copyTo oracle slot ' + i);
        }
    }
    return dst;
}

describe('qa-r3 tiny rings', () => {
    it('cap 1: pushes 0..4 x n {0,1,2} x off {0,1} x 3 kinds x both methods (dst exact and +1 slack)', () => {
        let cases = 0;
        for (const m of METHODS) for (let p = 0; p <= 4; p++) for (const n of [0, 1, 2]) for (const off of [0, 1])
            for (const T of KINDS) for (const slack of [0, 1]) {
                const { rb, model } = mk(1, p, p * 7);
                check(rb, model, m, T, off + n + slack, off, n, m + ' cap1 p' + p + ' n' + n + ' off' + off + ' ' + T.name);
                cases++;
            }
        assert.equal(cases, 2 * 5 * 3 * 2 * 3 * 2);
    });

    it('cap 2: pushes 0..6 x n {0,1,2,3} x off {0,2} x 3 kinds x both methods', () => {
        let cases = 0;
        for (const m of METHODS) for (let p = 0; p <= 6; p++) for (const n of [0, 1, 2, 3]) for (const off of [0, 2])
            for (const T of KINDS) {
                const { rb, model } = mk(2, p, 40 + p);
                check(rb, model, m, T, off + n + 1, off, n, m + ' cap2 p' + p + ' n' + n + ' off' + off + ' ' + T.name);
                cases++;
            }
        assert.equal(cases, 2 * 7 * 4 * 2 * 3);
    });
});

describe('qa-r3 exact fit and the dst edge', () => {
    it('n = count = dst.length - dstOffset (zero slack) on caps 1/2/8/64, partial and wrapped rings', () => {
        let cases = 0;
        for (const m of METHODS) for (const cap of [1, 2, 8, 64]) for (const p of [1, cap - 1 || 1, cap, cap + 3, 3 * cap + 1])
            for (const off of [0, 5]) for (const T of KINDS) {
                const { rb, model } = mk(cap, p, cap + p);
                const c = rb.count;
                const dst = check(rb, model, m, T, off + c, off, c, m + ' fit cap' + cap + ' p' + p + ' off' + off);
                assert.equal(dst.length - off, c);
                // N-1: one slot fewer than n needs -> bounds error naming n, dst untouched.
                const small = new T(off + c - 1).fill(SENT);
                throwsExact(() => call(rb, m, small, off, c), RangeError, msgBounds(m, c, off, off + c - 1), m + ' N-1');
                assert.ok(small.every((x) => x === SENT), m + ' N-1 dst untouched');
                cases++;
            }
        assert.equal(cases, 2 * 4 * 5 * 2 * 3);
    });

    it('dstOffset = dst.length with n 0 returns +0 (empty, partial, full ring, length-0 dst); n 1 or offset L+1 throws', () => {
        for (const m of METHODS) for (const p of [0, 3, 8, 20]) for (const L of [0, 1, 6]) {
            const { rb } = mk(8, p);
            const dst = new Float32Array(L).fill(SENT);
            const r = call(rb, m, dst, L, 0);
            assert.ok(Object.is(r, 0), m + ' p' + p + ' L' + L + ' returned ' + r);
            assert.ok(dst.every((x) => x === SENT), m + ' dst untouched');
            throwsExact(() => call(rb, m, dst, L, 1), RangeError, msgBounds(m, 1, L, L), m + ' offset L, n 1');
            throwsExact(() => call(rb, m, dst, L + 1, 0), RangeError, msgBounds(m, 0, L + 1, L), m + ' offset L+1, n 0');
            assert.ok(dst.every((x) => x === SENT), m + ' dst untouched after throws');
        }
    });

    it('a dst far larger than the ring: n = dst.length (2^20) clamps to count, only [off, off+count) written', () => {
        for (const m of METHODS) {
            const { rb, model } = mk(64, 150, 9);
            const L = 1 << 20;
            const dst = new Float32Array(L).fill(SENT);
            const r = call(rb, m, dst, 0, L);
            assert.equal(r, 64);
            const exp = lastK(model, 64, 64);
            for (let i = 0; i < 64; i++) assert.ok(Object.is(dst[i], exp[i]), m + ' slot ' + i);
            for (let i = 64; i < L; i += 4093) assert.equal(dst[i], SENT, m + ' tail ' + i);
            assert.equal(dst[L - 1], SENT);
            throwsExact(() => call(rb, m, dst, 1, L), RangeError, msgBounds(m, L, 1, L), m + ' off 1 n L');
        }
    });
});

describe('qa-r3 -0, integer edges, null / undefined / NaN', () => {
    it('-0: dstOffset -0 writes from slot 0 and returns k; n -0 returns +0 on empty, full and destroyed rings', () => {
        for (const m of METHODS) for (const T of KINDS) {
            const { rb, model } = mk(8, 13, 3);
            check(rb, model, m, T, 6, -0, 5, m + ' off -0 ' + T.name);
            for (const [label, ring] of [['full', rb], ['empty', new RingBuffer(8)], ['destroyed', mk(8, 5).rb]]) {
                if (label === 'destroyed') ring.destroy();
                const dst = new T(4).fill(SENT);
                for (const off of [-0, 0, 4]) {
                    const r = call(ring, m, dst, off, -0);
                    assert.ok(Object.is(r, 0), m + ' ' + label + ' n -0 off ' + off + ' returned ' + (Object.is(r, -0) ? '-0' : r));
                }
                const r2 = call(ring, m, dst, -0, 0);
                assert.ok(Object.is(r2, 0), m + ' ' + label + ' n 0 off -0');
                assert.ok(dst.every((x) => x === SENT), m + ' ' + label + ' dst untouched');
            }
            // String(-0) is "0": the bounds message prints offset 0.
            throwsExact(() => call(rb, m, new T(3), -0, 4), RangeError, msgBounds(m, 4, '0', 3), m + ' -0 bounds');
        }
    });

    it('n integer edges: -1 / -2^31 / -2^53 -> n error; 2^30 .. 2^53 -> bounds error naming n (empty, cap 1, full 64)', () => {
        const NEG = [-1, -(2 ** 31), -(2 ** 53)];
        const BIG = [2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53];
        const STR = ['1073741824', '2147483647', '2147483648', '4294967295', '4294967296', '9007199254740991', '9007199254740992'];
        for (const m of METHODS) for (const ring of [new RingBuffer(8), mk(1, 3).rb, mk(64, 70).rb]) {
            const dst = new Float64Array(8).fill(SENT);
            const s = snapRing(ring);
            for (const n of NEG) throwsExact(() => call(ring, m, dst, 0, n), RangeError, msgN(m, '' + n), m + ' n ' + n);
            BIG.forEach((n, i) => {
                throwsExact(() => call(ring, m, dst, 0, n), RangeError, msgBounds(m, STR[i], 0, 8), m + ' n ' + n);
            });
            assert.ok(dst.every((x) => x === SENT), m + ' dst untouched');
            sameRing(ring, s, m + ' ring');
        }
    });

    it('dstOffset integer edges with n 0: -1 and 2^30 .. 2^53 -> bounds error naming the offset', () => {
        const OFFS = [-1, 2 ** 30, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53];
        for (const m of METHODS) {
            const { rb } = mk(8, 11);
            const dst = new Float32Array(4).fill(SENT);
            for (const off of OFFS) {
                throwsExact(() => call(rb, m, dst, off, 0), RangeError, msgBounds(m, 0, String(off), 4), m + ' off ' + off);
            }
            assert.ok(dst.every((x) => x === SENT));
        }
    });

    it('null / undefined / NaN / non-TypedArray in every position: class and exact message', () => {
        for (const m of METHODS) {
            const { rb, model } = mk(8, 6);
            const ok = new Float32Array(8);
            const cases = [
                [() => call(rb, m, null, 0, 1), TypeError, msgDst(m, 'null')],
                [() => call(rb, m, undefined, 0, 1), TypeError, msgDst(m, 'undefined')],
                [() => call(rb, m), TypeError, msgDst(m, 'undefined')],
                [() => call(rb, m, [1, 2, 3], 0, 1), TypeError, msgDst(m, 'object')],
                [() => call(rb, m, 'abcdefgh', 0, 1), TypeError, msgDst(m, 'string')],
                [() => call(rb, m, new Proxy(new Float32Array(8), {}), 0, 1), TypeError, msgDst(m, 'object')],
                [() => call(rb, m, new ArrayBuffer(32), 0, 1), TypeError, msgDst(m, 'object')],
                [() => call(rb, m, ok, 0, null), RangeError, msgN(m, 'null')],
                [() => call(rb, m, ok, 0, undefined), RangeError, msgN(m, 'undefined')],
                [() => call(rb, m, ok, 0), RangeError, msgN(m, 'undefined')],
                [() => call(rb, m, ok, undefined), RangeError, msgN(m, 'undefined')],
                [() => call(rb, m, ok, 0, NaN), RangeError, msgN(m, 'NaN')],
                [() => call(rb, m, ok, null, 1), RangeError, msgBounds(m, 1, 'null', 8)],
                [() => call(rb, m, ok, NaN, 1), RangeError, msgBounds(m, 1, 'NaN', 8)],
                [() => call(rb, m, ok, Infinity, 0), RangeError, msgBounds(m, 0, 'Infinity', 8)],
            ];
            cases.forEach(([fn, C, msg], i) => throwsExact(fn, C, msg, m + ' case ' + i));
            // dstOffset undefined means 0.
            const dst = new Float32Array(4).fill(SENT);
            assert.equal(call(rb, m, dst, undefined, 4), 4);
            const exp = lastK(model, 8, 4);
            for (let i = 0; i < 4; i++) assert.ok(Object.is(dst[i], exp[i]), m + ' undefined offset slot ' + i);
        }
    });

    it('re-entrant dstOffset: a toString that pushes runs only for the message; dst untouched; a throwing / null-proto offset', () => {
        for (const m of METHODS) {
            const { rb } = mk(8, 5);
            const dst = new Float32Array(8).fill(SENT);
            let calls = 0;
            const off = { toString() { calls++; rb.push(99); return 'X'; } };
            throwsExact(() => call(rb, m, dst, off, 3), RangeError, msgBounds(m, 3, 'X', 8), m + ' toString offset');
            assert.equal(calls, 1);
            assert.ok(dst.every((x) => x === SENT), m + ' dst untouched after re-entrant push');
            const mine = new Error('mine');
            const err = throwsExact(() => call(rb, m, dst, { toString() { throw mine; } }, 3), Error, 'mine', m + ' throwing toString');
            assert.equal(err, mine, m + ' the user error propagates');
            throwsExact(() => call(rb, m, dst, Object.create(null), 3), TypeError, undefined, m + ' null-proto offset');
            assert.ok(dst.every((x) => x === SENT));
        }
    });
});

describe('qa-r3 check order ladder (TypeError > n > bounds > k 0 > alias > storage > BigInt store)', () => {
    it('remove one violation at a time; each rung throws its own error; nothing written', () => {
        for (const m of METHODS) {
            const { rb } = mk(8, 5);
            const short = new Float32Array(7);          // storage violation (7 != 8)
            short.set([1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]);
            rb.data = short;
            const alias = short.subarray(1, 3);           // shares data's buffer, byteOffset 4, length 2
            const before = bytesOf(short);
            throwsExact(() => call(rb, m, new DataView(new ArrayBuffer(8)), -1, NaN), TypeError, msgDst(m, 'object'), m + ' rung 0');
            throwsExact(() => call(rb, m, alias, -1, NaN), RangeError, msgN(m, 'NaN'), m + ' rung 1');
            throwsExact(() => call(rb, m, alias, -1, 5), RangeError, msgBounds(m, 5, -1, 2), m + ' rung 2');
            throwsExact(() => call(rb, m, alias, 0, 5), RangeError, msgBounds(m, 5, 0, 2), m + ' rung 3');
            assert.ok(Object.is(call(rb, m, alias, 0, 0), 0), m + ' rung 4: k 0 returns +0 before alias / storage');
            throwsExact(() => call(rb, m, alias, 0, 1), RangeError, msgAlias(m), m + ' rung 5: alias before storage');
            const sep = new Float32Array(2).fill(SENT);
            throwsExact(() => call(rb, m, sep, 0, 1), RangeError, msgStorage(m, 7, 8), m + ' rung 6');
            assert.deepEqual(bytesOf(short), before, m + ' storage untouched');
            assert.ok(sep.every((x) => x === SENT), m + ' sep untouched');
            const good = new Float32Array(8);
            good.set(short);
            rb.data = good;
            const big = new BigInt64Array(2).fill(7n);
            throwsExact(() => call(rb, m, big, 0, 1), TypeError, undefined, m + ' rung 7: BigInt at the store');
            assert.ok(Object.is(call(rb, m, big, 0, 0), 0), m + ' BigInt n 0 returns +0');
            assert.equal(call(rb, m, sep, 0, 2), 2, m + ' rung 8: copies');
            assert.deepEqual([...sep], [good[3], good[4]], m + ' rung 8 values (head 5, newest 2)');
        }
    });
});

describe('qa-r3 exotic dst storage', () => {
    it('resizable ArrayBuffer dst: length-tracking grows / shrinks, fixed view goes out of bounds, detached dst', () => {
        assert.equal(typeof ArrayBuffer.prototype.resize, 'function', 'resizable ArrayBuffer missing on ' + process.version);
        for (const m of METHODS) for (const T of [Float32Array, Float64Array]) {
            const B = T.BYTES_PER_ELEMENT;
            const { rb, model } = mk(64, 64 + 21, 5);  // full, wrapped
            const rab = new ArrayBuffer(10 * B, { maxByteLength: 100 * B });
            const track = new T(rab, 2 * B);            // length-tracking, byteOffset != 0
            const fixed = new T(rab, 4 * B, 4);
            new T(rab).fill(SENT);
            assert.equal(call(rb, m, track, 1, 5), 5);
            const e5 = lastK(model, 64, 5);
            for (let i = 0; i < 5; i++) assert.ok(Object.is(track[1 + i], conv(T, e5[i])), m + ' track slot ' + i);
            assert.equal(track[0], SENT);
            assert.equal(track[6], SENT);
            rab.resize(80 * B);                          // grow: 78 tracked slots
            new T(rab).fill(SENT);
            assert.equal(call(rb, m, track, 3, 64), 64, m + ' whole window (ROT for F32 copyLast) into grown dst');
            const e64 = lastK(model, 64, 64);
            for (let i = 0; i < 64; i++) assert.ok(Object.is(track[3 + i], conv(T, e64[i])), m + ' grown slot ' + i);
            assert.equal(track[2], SENT);
            assert.equal(track[67], SENT);
            rab.resize(6 * B);                           // track length 4, fixed (4..8) now out of bounds
            new T(rab).fill(SENT);
            throwsExact(() => call(rb, m, track, 0, 5), RangeError, msgBounds(m, 5, 0, 4), m + ' shrunk tracking');
            throwsExact(() => call(rb, m, fixed, 0, 1), RangeError, msgBounds(m, 1, 0, 0), m + ' out-of-bounds fixed');
            assert.ok(Object.is(call(rb, m, fixed, 0, 0), 0), m + ' out-of-bounds fixed n 0');
            assert.ok(new T(rab).every((x) => x === SENT), m + ' nothing written after the shrink throws');
            const det = new T(8).fill(SENT);
            det.buffer.transfer();
            throwsExact(() => call(rb, m, det, 0, 1), RangeError, msgBounds(m, 1, 0, 0), m + ' detached dst');
            assert.ok(Object.is(call(rb, m, det, 0, 0), 0), m + ' detached dst n 0');
        }
    });

    it('resizable ring storage: length-tracking data shrunk -> storage error at k > 0, +0 at k 0; restored copies', () => {
        for (const m of METHODS) {
            const { rb, model } = mk(8, 13);
            const rab = new ArrayBuffer(8 * 4, { maxByteLength: 16 * 4 });
            const nd = new Float32Array(rab);
            nd.set(rb.data);
            rb.data = nd;
            rab.resize(7 * 4);
            const dst = new Float32Array(8).fill(SENT);
            throwsExact(() => call(rb, m, dst, 0, 1), RangeError, msgStorage(m, 7, 8), m + ' shrunk data');
            assert.ok(Object.is(call(rb, m, dst, 0, 0), 0));
            assert.ok(dst.every((x) => x === SENT));
            rab.resize(8 * 4);
            // the shrink zeroed slot 7 on regrow; rebuild the window from the model before copying
            const h = rb.head;
            const win = lastK(model, 8, 8);
            for (let i = 0; i < 8; i++) nd[(h + i) & 7] = win[i];
            check(rb, model, m, Float32Array, 9, 1, 8, m + ' restored');
            assert.equal(rb._bufOf, nd, m + ' cache keyed to the resizable data');
        }
    });

    it('growable SharedArrayBuffer dst: copies before and after grow, length-tracking view', () => {
        assert.equal(typeof SharedArrayBuffer, 'function', 'SharedArrayBuffer missing');
        assert.equal(typeof SharedArrayBuffer.prototype.grow, 'function', 'growable SharedArrayBuffer missing on ' + process.version);
        for (const m of METHODS) for (const T of [Float32Array, Float64Array, Int16Array]) {
            const B = T.BYTES_PER_ELEMENT;
            const { rb, model } = mk(64, 100, 1);
            const sab = new SharedArrayBuffer(8 * B, { maxByteLength: 80 * B });
            const v = new T(sab, B);                    // tracking, byteOffset != 0
            new T(sab).fill(SENT);
            assert.equal(call(rb, m, v, 2, 5), 5);
            const e5 = lastK(model, 64, 5);
            for (let i = 0; i < 5; i++) assert.ok(Object.is(v[2 + i], conv(T, e5[i])));
            throwsExact(() => call(rb, m, v, 0, 8), RangeError, msgBounds(m, 8, 0, 7), m + ' before grow');
            sab.grow(70 * B);
            new T(sab).fill(SENT);
            assert.equal(call(rb, m, v, 0, 64), 64);
            const e64 = lastK(model, 64, 64);
            for (let i = 0; i < 64; i++) assert.ok(Object.is(v[i], conv(T, e64[i])), m + ' ' + T.name + ' grown slot ' + i);
            assert.equal(v[64], SENT);
            assert.equal(new T(sab)[0], SENT, m + ' slot before the view untouched');
        }
    });

    it('other-realm Float32Array / Float64Array / Int16Array dst (node:vm): partial and whole-window (ROT) copies', () => {
        const ctx = vm.createContext({});
        for (const m of METHODS) for (const name of ['Float32Array', 'Float64Array', 'Int16Array']) {
            const T = vm.runInContext(name, ctx);
            assert.notEqual(T, globalThis[name]);
            const { rb, model } = mk(64, 64 + 40, 2);
            for (const n of [1, 33, 63, 64, 70]) {
                const dst = new T(n + 4).fill(SENT);
                assert.equal(call(rb, m, dst, 2, n), Math.min(n, 64), m + ' ' + name + ' n ' + n);
                const e = lastK(model, 64, n);
                for (let i = 0; i < n + 4; i++) {
                    const want = i >= 2 && i < 2 + e.length ? conv(globalThis[name], e[i - 2]) : SENT;
                    assert.ok(Object.is(dst[i], want), m + ' ' + name + ' n ' + n + ' slot ' + i);
                }
            }
        }
        for (const m of METHODS) {
            const { rb } = mk(8, 3);
            throwsExact(() => call(rb, m, vm.runInContext('[1,2,3,4]', ctx), 0, 1), TypeError, msgDst(m, 'object'), m + ' other-realm Array');
            const big = vm.runInContext('new BigInt64Array(4)', ctx);
            let err = null;
            try { call(rb, m, big, 0, 1); } catch (e) { err = e; }
            assert.ok(err && err.name === 'TypeError', m + ' other-realm BigInt64Array k 1 -> TypeError (either realm)');
            assert.ok(Object.is(call(rb, m, big, 0, 0), 0));
            assert.equal(big[0], 0n);
        }
    });

    it('subarray dsts with non-zero byteOffset: neighbours untouched; a view of the ring storage is the alias error', () => {
        for (const m of METHODS) for (const T of KINDS) {
            const { rb, model } = mk(64, 64 + 29, 4);
            for (const n of [3, 32, 33, 64]) {
                const parent = new T(n + 20).fill(SENT);
                const dst = parent.subarray(7, 7 + n + 5);
                assert.ok(dst.byteOffset > 0);
                assert.equal(call(rb, m, dst, 2, n), n);
                const e = lastK(model, 64, n);
                for (let i = 0; i < parent.length; i++) {
                    const want = i >= 9 && i < 9 + n ? conv(T, e[i - 9]) : SENT;
                    assert.ok(Object.is(parent[i], want), m + ' ' + T.name + ' n ' + n + ' parent slot ' + i);
                }
            }
            // A view of another ring's storage is not an alias.
            const other = mk(64, 5).rb;
            const view = other.data.subarray(10, 20);
            assert.equal(call(rb, m, view, 0, 10), 10);
        }
        for (const m of METHODS) {
            const { rb } = mk(64, 70);
            const own = rb.data.subarray(3, 13);
            const before = bytesOf(rb.data);
            throwsExact(() => call(rb, m, own, 0, 1), RangeError, msgAlias(m), m + ' own-storage subarray');
            assert.ok(Object.is(call(rb, m, own, 0, 0), 0), m + ' own-storage subarray n 0');
            assert.deepEqual(bytesOf(rb.data), before);
        }
    });

    it('adversarial: a dst own `set` and a patched Float32Array.prototype.set are never called (intrinsic set)', () => {
        let spy = 0;
        class Sneaky extends Float32Array { set() { spy++; throw new Error('own set'); } }
        const saved = TypedArrayProto().set;
        try {
            TypedArrayProto().set = function () { spy++; throw new Error('patched set'); };
            for (const m of METHODS) for (const n of [5, 64]) {
                const { rb, model } = mk(64, 64 + 50, 8);
                const d1 = new Sneaky(n + 1).fill(SENT);
                assert.equal(call(rb, m, d1, 1, n), n);
                const e = lastK(model, 64, n);
                for (let i = 0; i < n; i++) assert.ok(Object.is(d1[1 + i], e[i]), m + ' sneaky slot ' + i);
                const d2 = new Float64Array(n).fill(SENT);
                assert.equal(call(rb, m, d2, 0, n), n);
            }
        } finally {
            TypedArrayProto().set = saved;
        }
        assert.equal(spy, 0, 'user set ran ' + spy + ' times');
    });
});

function TypedArrayProto() { return Object.getPrototypeOf(Float32Array.prototype); }

describe('qa-r3 ring states', () => {
    it('destroy()-ed ring: count 0 -> +0 for n 0..L with a big enough dst, dst untouched; n > L still throws; twice; mid-iteration', () => {
        for (const m of METHODS) for (const T of KINDS) {
            const { rb } = mk(64, 90);
            rb.destroy();
            const dst = new T(16).fill(SENT);
            for (const n of [0, 1, 5, 15, 16]) {
                assert.ok(Object.is(call(rb, m, dst, 0, n), 0), m + ' destroyed n ' + n);
                assert.ok(Object.is(call(rb, m, dst, 16 - n, n), 0), m + ' destroyed tail n ' + n);
            }
            throwsExact(() => call(rb, m, dst, 0, 17), RangeError, msgBounds(m, 17, 0, 16), m + ' destroyed n > L');
            throwsExact(() => call(rb, m, dst, 0, -1), RangeError, msgN(m, '-1'), m + ' destroyed n -1');
            rb.destroy();
            assert.ok(Object.is(call(rb, m, dst, 0, 16), 0), m + ' destroyed twice');
            rb.push(3.25);                               // a push after destroy stores nothing
            assert.ok(Object.is(call(rb, m, dst, 0, 16), 0), m + ' push after destroy');
            assert.ok(dst.every((x) => x === SENT), m + ' dst untouched');
            const { rb: r2 } = mk(8, 6);
            let seen = 0;
            r2.forEach(() => { if (seen++ === 2) r2.destroy(); });
            assert.ok(Object.is(call(r2, m, dst, 0, 8), 0), m + ' destroy during forEach');
            assert.ok(dst.every((x) => x === SENT));
        }
    });

    it('frozen / sealed ring with replaced data, every interesting head, ROT path (n >= 64, Float32) and loop paths', () => {
        for (const m of METHODS) for (const how of ['freeze', 'seal', 'preventExtensions']) for (const h of [0, 1, 31, 32, 33, 63]) {
            const rb = new RingBuffer(64);
            const keyBefore = rb._bufOf;
            const nd = new Float32Array(64);
            for (let i = 0; i < 64; i++) nd[i] = pv(300 + i);
            rb.data = nd;
            rb.head = h;
            rb.count = 64;
            Object[how](rb);
            // Independent window: oldest-first from head (full ring).
            const win = [];
            for (let i = 0; i < 64; i++) win.push(nd[(h + i) & 63]);
            for (const T of KINDS) for (const n of [64, 69, 63, 33, 1]) {
                const k = Math.min(n, 64);
                const dst = new T(n + 5).fill(SENT);
                assert.equal(call(rb, m, dst, 3, n), k, m + ' ' + how + ' h' + h + ' n' + n);
                for (let i = 0; i < dst.length; i++) {
                    const want = i >= 3 && i < 3 + k ? conv(T, win[64 - k + i - 3]) : SENT;
                    assert.ok(Object.is(dst[i], want), m + ' ' + how + ' h' + h + ' ' + T.name + ' n' + n + ' slot ' + i);
                }
            }
            assert.equal(rb._bufOf, keyBefore, m + ' ' + how + ': cache key never written');
            assert.equal(rb.head, h);
        }
    });

    it('after pushBatch over capacity (F32 / F64 src, srcOffset, partial ring first) and a 2^20+3 pushBatch (head wraps 2^17 times)', () => {
        for (const m of METHODS) for (const cap of [1, 8, 64]) for (const S of [Float32Array, Float64Array]) for (const pre of [0, 3]) {
            const { rb, model } = mk(cap, pre, 50);
            const src = new S(3 * cap + 9);
            for (let i = 0; i < src.length; i++) src[i] = pv(700 + i);
            assert.equal(rb.pushBatch(src, 2, 3 * cap + 5), 3 * cap + 5);
            for (let i = 2; i < 2 + 3 * cap + 5; i++) model.push(stored(src[i]));
            for (const n of [1, cap - 1, cap, cap + 1]) for (const T of KINDS) {
                check(rb, model, m, T, n + 3, 2, n, m + ' pushBatch cap' + cap + ' ' + S.name + ' pre' + pre + ' n' + n);
            }
        }
        for (const m of METHODS) {
            const rb = new RingBuffer(8);
            const N = (1 << 20) + 3;
            const src = new Float32Array(N);
            for (let i = 0; i < N; i++) src[i] = i + 0.5;
            rb.pushBatch(src, 0, N);
            assert.equal(rb.head, N & 7);
            const dst = new Float32Array(9).fill(SENT);
            assert.equal(call(rb, m, dst, 1, 8), 8);
            for (let i = 0; i < 8; i++) assert.equal(dst[1 + i], N - 8 + i + 0.5, m + ' wrap slot ' + i);
            assert.equal(dst[0], SENT);
        }
    });

    it('interleaved push / pushBatch / copyTo / copyLast / copyLastFast / data swap / reset: model + cache keyed to data', () => {
        let seed = 0x2545F491;
        const rnd = (k) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % k; };
        let checks = 0;
        for (const cap of [1, 2, 8, 64]) {
            const rb = new RingBuffer(cap);
            let model = [];
            let vi = 1000 * cap;
            for (let step = 0; step < 1500; step++) {
                const op = rnd(9);
                if (op === 0) { const v = pv(vi++); rb.push(v); model.push(stored(v)); }
                else if (op === 1) {
                    const S = rnd(2) ? Float32Array : Float64Array;
                    const len = rnd(2 * cap + 4);
                    const src = new S(len + 1);
                    for (let i = 0; i < src.length; i++) src[i] = pv(vi++);
                    rb.pushBatch(src, 1, len);
                    for (let i = 1; i <= len; i++) model.push(stored(src[i]));
                } else if (op === 2) {
                    const d = new Float32Array(rb.count + 1);
                    assert.equal(rb.copyTo(d, 1), rb.count);
                    if (rb.count > 0) assert.equal(rb._bufOf, rb.data, 'copyTo keyed the cache');
                } else if (op === 3) {
                    const nd = new Float32Array(cap);
                    nd.set(rb.data);
                    rb.data = nd;                        // same contents, new identity: the cache must re-key
                } else if (op === 4 && rnd(8) === 0) { rb.reset(); model = []; }
                else {
                    const m = METHODS[op & 1];
                    const T = KINDS[rnd(3)];
                    const n = rnd(cap + 3);
                    const off = rnd(3);
                    check(rb, model, m, T, off + n + rnd(2), off, n, m + ' cap' + cap + ' step ' + step);
                    if (Math.min(n, rb.count) > 0) {
                        assert.equal(rb._bufOf, rb.data, m + ' step ' + step + ': cache keyed to the current data');
                        assert.equal(rb._buf, rb.data.buffer, m + ' step ' + step + ': cached buffer');
                    }
                    checks++;
                }
            }
        }
        assert.ok(checks > 1500, 'checks ran: ' + checks);
    });

    it('copyLastFast == copyLast over caps x fill x kind x 8 offsets x 12 n x random dst length: same return, bytes, class and message (names mapped)', () => {
        let seed = 77;
        const rnd = (k) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % k; };
        const outcome = (rb, m, dst, off, n) => {
            try { return { r: call(rb, m, dst, off, n), b: bytesOf(dst) }; } catch (e) {
                if (e instanceof assert.AssertionError) throw e;
                return { e: e.name, msg: e.message.replace(m, 'M'), b: bytesOf(dst) };
            }
        };
        const offs = [0, 1, -0, -1, 1.5, NaN, undefined, null];
        const ns = [0, 1, 7, 8, 9, 64, 65, -0, -1, NaN, 2 ** 31, undefined];
        let cases = 0;
        for (const cap of [1, 8, 64]) for (const p of [0, cap - 1, cap, 2 * cap + 5]) for (const T of KINDS) {
            const { rb } = mk(cap, p, p + cap);
            for (const off of offs) for (const n of ns) {
                const L = rnd(12) + (rnd(3) === 0 ? 64 : 0);
                const a = outcome(rb, 'copyLast', new T(L).fill(SENT), off, n);
                const b = outcome(rb, 'copyLastFast', new T(L).fill(SENT), off, n);
                assert.deepEqual(b, a, 'cap ' + cap + ' p ' + p + ' ' + T.name + ' off ' + off + ' n ' + n + ' L ' + L);
                if ('r' in a) assert.ok(Object.is(a.r, b.r));
                cases++;
            }
        }
        assert.equal(cases, 3 * 4 * 3 * offs.length * ns.length);
    });
});
