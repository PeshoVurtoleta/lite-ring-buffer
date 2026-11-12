// QA R1 boundary suite (qa pass 2026-11-12): copyTo / copyToFast at the edges.
// Oracles are independent of the engine: a push history stored through a
// Float32Array(1), converted per dst kind by writing it element by element
// into a fresh array of that kind; ring geometry for field-set states comes
// from the documented field meaning (head = next write slot, count = live
// samples) with `%`, never the engine's `& mask`. Every test has a must-fail
// control (a frozen build or a named mutant): .handoff/qa-r1/QA-REPORT.md.
// Build under test: RB_BUILD (absolute or package-relative) else
// ../RingBuffer.js. No test reads a cache field by name.
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
const SPECIALS = [-0, NaN, Infinity, -Infinity, 0.5, 1.5, 2.5, 255.5, 70000, -3.25, 1e10, -129, 3.5e39, 1e-46, -32769.5];
function valueAt(n) { return n % 3 === 0 ? SPECIALS[(n / 3) % SPECIALS.length] : n * 1.25 - 7; }
const F1 = new Float32Array(1);
function stored(v) { F1[0] = v; return F1[0]; }

class F32Sub extends Float32Array {}
class LongLie extends Float32Array { get length() { return 1e9; } }
const XF32 = vm.runInNewContext('Float32Array');
const KINDS = [
    ['Float32Array', Float32Array],
    ['Float64Array', Float64Array],
    ['Int16Array', Int16Array],
    ['Uint8ClampedArray', Uint8ClampedArray],
    ['Float32Array subclass', F32Sub],
    ['cross-realm Float32Array', XF32],
];
const F_KINDS = KINDS.slice(0, 2);

function ring(req, pushes) {
    const rb = new RingBuffer(req);
    const hist = [];
    for (let i = 0; i < pushes; i++) { const v = valueAt(i); rb.push(v); hist.push(stored(v)); }
    return { rb, model: hist.slice(Math.max(0, hist.length - rb.capacity)) };
}
// Expected dst contents: the model written element by element into a fresh dst of the same kind.
function expectedFor(Kind, model) {
    const e = new Kind(model.length);
    for (let j = 0; j < model.length; j++) e[j] = model[j];
    return e;
}
// Copies at offsets 0, 1 and the max valid one (dst.length - c) into a dst of c + 4 slots.
function checkCopy(rb, method, Kind, kname, model, label) {
    const c = model.length;
    const exp = expectedFor(Kind, model);
    const s = expectedFor(Kind, [SENT])[0];
    for (const off of [0, 1, 4]) {
        const dst = new Kind(c + 4).fill(SENT);
        const r = rb[method](dst, off);
        if (r !== c) assert.fail(label + ' ' + kname + ' off ' + off + ': returned ' + r + ', want ' + c);
        for (let j = 0; j < dst.length; j++) {
            const want = j >= off && j < off + c ? exp[j - off] : s;
            if (!Object.is(dst[j], want)) {
                assert.fail(label + ' ' + kname + ' off ' + off + ' slot ' + j + ': got ' + dst[j] + ', want ' + want);
            }
        }
    }
}
// Oldest-first window of `slots` from the documented field meaning, with `%`.
function geomModel(slots, h, k) {
    const cap = slots.length;
    const m = [];
    for (let j = 0; j < k; j++) m.push(slots[(((h - k + j) % cap) + cap) % cap]);
    return m;
}
function bytes(ta) { return new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength).slice(); }
function sameBytes(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
function allSent(dst) { for (let i = 0; i < dst.length; i++) if (!Object.is(dst[i], SENT)) return false; return true; }
function ownValues(o) { return Object.getOwnPropertyNames(o).map((k) => [k, o[k]]); }
function sameOwn(a, b) { return a.length === b.length && a.every(([k, v], i) => b[i][0] === k && Object.is(b[i][1], v)); }
function detachers() {
    assert.equal(typeof structuredClone, 'function', 'structuredClone missing: cannot detach');
    const d = [['structuredClone transfer', (b) => { structuredClone(b, { transfer: [b] }); }]];
    assert.equal(typeof ArrayBuffer.prototype.transfer, 'function', 'ArrayBuffer#transfer missing on ' + process.version);
    d.push(['ArrayBuffer#transfer', (b) => { b.transfer(); }]);
    return d;
}
function storageRe(m, len, cap) {
    return new RegExp('^LiteRingBuffer: ' + m + ' storage holds ' + len + ' slots, capacity is ' + cap + ' \\(data replaced, resized or detached\\); nothing written$');
}
function aliasRe(m) { return new RegExp('^LiteRingBuffer: ' + m + ' dst shares the ring\'s buffer'); }

const CAPS = [1, 2, 32, 33, 64, 1024];
const WANT_CAP = { 1: 1, 2: 2, 32: 32, 33: 64, 64: 64, 1024: 1024 };
function pushPoints(cap) {
    if (cap <= 64) { const p = []; for (let n = 0; n <= 2 * cap + 1; n++) p.push(n); return p; }
    return [0, 1, 2, 31, 32, 33, 511, 512, 513, 1023, 1024, 1025, 1024 + 255, 1024 + 511, 1024 + 512, 1024 + 513, 1024 + 767, 2047, 2048, 2049, 3071];
}
// Push history: one ring per requested capacity, a copy at every push count in pushPoints:
// empty, partial (contiguous), full, and full at every head (cap <= 64) or a head sample (1024).
function historyMatrix(method) {
    for (const req of CAPS) {
        const rb = new RingBuffer(req);
        assert.equal(rb.capacity, WANT_CAP[req], 'capacity for request ' + req);
        const cap = rb.capacity;
        const pts = pushPoints(cap);
        const want = new Set(pts);
        const hist = [];
        for (let n = 0; n <= pts[pts.length - 1]; n++) {
            if (n > 0) { const v = valueAt(n + req); rb.push(v); hist.push(stored(v)); }
            if (!want.has(n)) continue;
            const model = hist.slice(Math.max(0, hist.length - cap));
            const label = method + ' req ' + req + ' cap ' + cap + ' pushes ' + n;
            for (const [kname, Kind] of KINDS) checkCopy(rb, method, Kind, kname, model, label);
        }
    }
}

describe('qa-r1: values matrix (caps 1/2/32/33/64/1024 x 6 dst kinds x offsets 0/1/max)', () => {
    it('copyTo: push history, every head for caps <= 64, a head sample at 1024', () => historyMatrix('copyTo'));
    it('copyToFast: push history, same matrix', () => historyMatrix('copyToFast'));

    it('field-set partial wrapped states (head / count written directly), both methods', () => {
        for (const req of [1, 2, 32, 64, 1024]) {
            const rb = new RingBuffer(req);
            const cap = rb.capacity;
            // Exactly cap pushes from a fresh ring: push i lands in slot i.
            const slots = [];
            for (let i = 0; i < cap; i++) { const v = valueAt(i * 7 + 1); rb.push(v); slots.push(stored(v)); }
            const heads = cap <= 64 ? [...Array(cap).keys()] : [0, 1, 511, 512, 513, 1000, 1023];
            const counts = [...new Set(cap <= 64 ? [0, 1, cap >> 1, cap - 1, cap] : [0, 1, 32, 33, 512, 1023, 1024])];
            for (const h of heads) {
                for (const k of counts) {
                    rb.head = h; rb.count = k;
                    const model = geomModel(slots, h, k);
                    for (const m of METHODS) {
                        for (const [kname, Kind] of KINDS) checkCopy(rb, m, Kind, kname, model, m + ' cap ' + cap + ' head ' + h + ' count ' + k);
                    }
                }
            }
        }
    });
});

describe('qa-r1: copyToFast agrees with copyTo on errors', () => {
    const xDataView = () => vm.runInNewContext('new DataView(new ArrayBuffer(64))');
    const T = 'TypeError', R = 'RangeError';
    // [name, make(rb, c), expected outcome for count c: class name or the return value]
    const DSTS = [
        ['null', () => null, () => T],
        ['undefined', () => undefined, () => T],
        ['{}', () => ({}), () => T],
        ['Array', (rb, c) => Array(c + 4).fill(SENT), () => T],
        ['string', () => 'abc', () => T],
        ['number', () => 42, () => T],
        ['DataView', (rb, c) => new DataView(new ArrayBuffer(4 * c + 16)), () => T],
        ['cross-realm DataView', xDataView, () => T],
        ['too-small Float32Array', (rb, c) => new Float32Array(Math.max(0, c - 1)).fill(SENT), (c) => (c ? R : 0)],
        ['subclass whose length lies (1e9), really c - 1', (rb, c) => new LongLie(Math.max(0, c - 1)).fill(SENT), (c) => (c ? R : 0)],
        ['detached Float32Array', (rb, c) => { const d = new Float32Array(c + 4); structuredClone(d.buffer, { transfer: [d.buffer] }); return d; }, (c) => (c ? R : 0)],
        ['BigInt64Array', (rb, c) => new BigInt64Array(c + 4).fill(7n), (c) => (c ? T : 0)],
        ['BigUint64Array', (rb, c) => new BigUint64Array(c + 4).fill(7n), (c) => (c ? T : 0)],
        ['alias rb.data', (rb) => rb.data, (c) => (c ? R : 0)],
        ['alias Uint8Array over rb.data.buffer', (rb) => (isDetached(rb.data) ? rb.data : new Uint8Array(rb.data.buffer)), (c) => (c ? R : 0)],
        ['alias BigInt64Array over rb.data.buffer', (rb) => (isDetached(rb.data) ? rb.data : new BigInt64Array(rb.data.buffer, 0, rb.capacity >> 1)), (c) => (c ? R : 0)],
        ['Float32Array(c + 4)', (rb, c) => new Float32Array(c + 4).fill(SENT), (c) => c],
    ];
    const STATES = [
        ['cap 2 count 1', () => ring(2, 1).rb],
        ['cap 2 full head 1', () => ring(2, 3).rb],
        ['cap 64 full head 32', () => ring(64, 96).rb],
        ['cap 64 partial 40', () => ring(64, 40).rb],
        ['cap 1024 full head 300', () => ring(1024, 1324).rb],
        ['cap 64 empty', () => ring(64, 0).rb],
        ['cap 64 full, data detached', () => { const rb = ring(64, 70).rb; structuredClone(rb.data.buffer, { transfer: [rb.data.buffer] }); return rb; }],
        ['cap 64 full, data 72 slots', () => { const rb = ring(64, 70).rb; rb.data = new Float32Array(72); return rb; }],
    ];
    function outcome(rb, m, dst) {
        try { return { v: rb[m](dst, 0) }; } catch (e) {
            const cls = e instanceof TypeError ? T : e instanceof RangeError ? R : 'other ' + String(e);
            return { cls, msg: String(e && e.message) };
        }
    }
    it('same class (and same message, own method name) per state x dst, nothing written on a throw', () => {
        for (const [sname, mk] of STATES) {
            for (const [dname, make, expect] of DSTS) {
                const got = {};
                for (const m of METHODS) {
                    const rb = mk();
                    const c = rb.count;
                    const dst = make(rb, c);
                    const dstBytes = ArrayBuffer.isView(dst) && isDetached(dst) === false ? bytes(dst) : null;
                    const ringBytes = isDetached(rb.data) ? null : bytes(rb.data);
                    const o = outcome(rb, m, dst);
                    got[m] = o;
                    const label = m + ' ' + sname + ' dst ' + dname;
                    let want = expect(c);
                    // Storage that is not `capacity` slots: RangeError for every TypedArray dst that
                    // passes the bounds check, an aliasing one included (checked before the store).
                    if (c && (sname.includes('detached') || sname.includes('72')) && want !== T && !(typeof want === 'string')) want = R;
                    if (c && sname.includes('detached') && dname.startsWith('alias')) want = R;
                    if (c && sname.includes('detached') && dname.startsWith('Big')) want = R;
                    if (c && sname.includes('72') && dname.startsWith('Big')) want = R;
                    if (typeof want === 'number') assert.deepEqual(o, { v: want }, label);
                    else assert.equal(o.cls, want, label + ': ' + JSON.stringify(o));
                    if (o.cls) {
                        if (o.msg.startsWith('LiteRingBuffer: ')) assert.ok(o.msg.startsWith('LiteRingBuffer: ' + m + ' '), label + ' names ' + o.msg);
                        if (dstBytes) assert.ok(sameBytes(bytes(dst), dstBytes), label + ': dst written');
                        if (ringBytes) assert.ok(sameBytes(bytes(rb.data), ringBytes), label + ': ring written');
                    }
                }
                const a = got.copyTo, b = got.copyToFast;
                assert.equal(a.cls, b.cls, sname + ' ' + dname + ': class differs');
                if (a.cls && a.msg.startsWith('LiteRingBuffer: ')) {
                    assert.equal(b.msg.replace('copyToFast', 'copyTo'), a.msg, sname + ' ' + dname + ': message differs');
                }
                if (!a.cls) assert.equal(a.v, b.v, sname + ' ' + dname + ': return differs');
            }
        }
    });
});
// Detached test without ArrayBuffer#detached (Node >= 21): a view over a detached buffer cannot be built.
function isDetached(ta) { try { new Uint8Array(ta.buffer, 0, 0); return false; } catch (e) { return true; } }

describe('qa-r1: dstOffset boundary matrix (both methods)', () => {
    const P = 2 ** 30, P31 = 2 ** 31, P32 = 2 ** 32, P53 = 2 ** 53;
    it('valid offsets write at the offset; every invalid one is a RangeError naming the offset, nothing written', () => {
        for (const m of METHODS) {
            // cap 64 full, head 17, dst 70 slots: N = max valid offset = 6.
            const { rb, model } = ring(64, 81);
            const VALID = [[0, 0], [-0, 0], [1, 1], [5, 5], [6, 6], [undefined, 0]];
            for (const [off, at] of VALID) {
                const dst = new Float32Array(70).fill(SENT);
                const r = off === undefined ? rb[m](dst) : rb[m](dst, off);
                assert.equal(r, 64, m + ' off ' + String(off));
                for (let j = 0; j < 70; j++) {
                    const want = j >= at && j < at + 64 ? model[j - at] : SENT;
                    assert.ok(Object.is(dst[j], want), m + ' off ' + String(off) + ' slot ' + j);
                }
            }
            const INVALID = [7, -1, P, P31 - 1, P31, P32 - 1, P32, P53 - 1, P53, -P31, -P32, NaN, Infinity, -Infinity, 0.5, 6.5, 1e-300,
                null, '1', true, 1n, Symbol('o'), [0], {}];
            for (const off of INVALID) {
                const dst = new Float32Array(70).fill(SENT);
                const label = m + ' off ' + (typeof off === 'symbol' ? 'Symbol' : typeof off === 'bigint' ? '1n' : JSON.stringify(off) + '/' + String(off));
                assert.throws(() => rb[m](dst, off), (e) => e instanceof RangeError &&
                    e.message.startsWith('LiteRingBuffer: ' + m + ' needs 64 slots from offset ' + String(off) + ' (dst.length 70)'), label);
                assert.ok(allSent(dst), label + ': dst written');
            }
            // empty ring: offset dst.length is valid (returns 0), dst.length + 1 is not
            const e = new RingBuffer(64);
            const d = new Float32Array(70).fill(SENT);
            assert.equal(e[m](d, 70), 0, m + ' empty off 70');
            for (const off of [71, -1, NaN, P32, 0.5]) assert.throws(() => e[m](d, off), RangeError, m + ' empty off ' + off);
            // cap 1, count 1, dst of 1 slot: offset 0 valid, 1 not
            const one = ring(1, 5);
            const d1 = new Float32Array(1).fill(SENT);
            assert.equal(one.rb[m](d1, 0), 1);
            assert.ok(Object.is(d1[0], one.model[0]), m + ' cap 1 value');
            assert.throws(() => one.rb[m](new Float32Array(1), 1), RangeError, m + ' cap 1 off 1');
        }
    });
});

describe('qa-r1: alias (dst shares the ring buffer)', () => {
    it('views at every offset kind of rb.data.buffer -> alias RangeError; ring and dst untouched', () => {
        for (const req of [1, 2, 32, 64, 1024]) {
            for (const m of METHODS) {
                const full = ring(req, req + 3).rb;
                const cap = full.capacity;
                const fullViews = [['rb.data', full.data], ['F32 over buffer', new Float32Array(full.data.buffer)], ['subarray(0)', full.data.subarray(0)],
                    ['Uint8Array over buffer', new Uint8Array(full.data.buffer)]];
                const one = ring(req, 1).rb; // count 1: every view with >= 1 slot passes the bounds check
                const oneViews = [['subarray(cap-1)', one.data.subarray(cap - 1)], ['Uint8Array at byte 3', new Uint8Array(one.data.buffer, 3)],
                    ['F32 over buffer at slot cap-1', new Float32Array(one.data.buffer, 4 * (cap - 1))]];
                if (cap >= 2) oneViews.push(['subarray(1)', one.data.subarray(1)], ['Float64Array over buffer', new Float64Array(one.data.buffer, 0, cap >> 1)]);
                for (const [rb, views] of [[full, fullViews], [one, oneViews]]) {
                    for (const [vname, dst] of views) {
                        const before = bytes(rb.data), h = rb.head, c = rb.count;
                        const label = m + ' cap ' + cap + ' count ' + c + ' ' + vname;
                        assert.throws(() => rb[m](dst, 0), (e) => e instanceof RangeError && aliasRe(m).test(e.message), label);
                        assert.ok(sameBytes(bytes(rb.data), before), label + ': ring bytes changed');
                        assert.equal(rb.head, h, label); assert.equal(rb.count, c, label);
                    }
                }
                // empty ring: alias dst returns 0
                const e = new RingBuffer(req);
                assert.equal(e[m](e.data, 0), 0, m + ' empty alias');
            }
        }
    });

    it('after rb.data is reassigned (cache warm), the alias check follows the NEW buffer; the old buffer copies', () => {
        for (const req of [1, 2, 64, 1024]) {
            for (const m of METHODS) {
                const { rb } = ring(req, req + 5);
                const cap = rb.capacity;
                rb[m](new Float32Array(cap)); // warm (fills any cache)
                const oldBuf = rb.data.buffer;
                const nd = new Float32Array(cap);
                const slots = [];
                for (let i = 0; i < cap; i++) { nd[i] = valueAt(1000 + i); slots.push(stored(valueAt(1000 + i))); }
                rb.data = nd;
                const model = geomModel(slots, rb.head, rb.count);
                for (let k = 0; k < 3; k++) {
                    const alias = new Float32Array(nd.buffer);
                    assert.throws(() => rb[m](alias, 0), (e) => e instanceof RangeError && aliasRe(m).test(e.message), m + ' cap ' + cap + ' new buffer, call ' + k);
                    const viaOld = new Float32Array(oldBuf).fill(SENT);
                    assert.equal(rb[m](viaOld, 0), cap, m + ' cap ' + cap + ' old buffer');
                    for (let j = 0; j < cap; j++) assert.ok(Object.is(viaOld[j], model[j]), m + ' cap ' + cap + ' old buffer slot ' + j);
                }
            }
        }
    });
});

describe('qa-r1: storage RangeError (data replaced, resized, detached) and check order', () => {
    it('longer / shorter / empty / detached (both detach paths) storage -> storage RangeError, dst untouched; empty ring 0', () => {
        for (const m of METHODS) {
            for (const [req, pushes] of [[1, 1], [64, 40], [64, 70], [1024, 1300]]) {
                const cap = new RingBuffer(req).capacity;
                for (const len of [cap + 1, cap - 1, 2 * cap, 0]) {
                    const { rb } = ring(req, pushes);
                    rb.data = new Float32Array(len);
                    const dst = new Float32Array(cap + 8).fill(SENT);
                    for (let k = 0; k < 3; k++) {
                        assert.throws(() => rb[m](dst, 2), (e) => e instanceof RangeError && storageRe(m, len, cap).test(e.message), m + ' cap ' + cap + ' len ' + len);
                    }
                    assert.ok(allSent(dst), m + ' cap ' + cap + ' len ' + len + ': dst written');
                }
                for (const [dn, detach] of detachers()) {
                    const { rb } = ring(req, pushes);
                    rb[m](new Float32Array(cap)); // warm copy first
                    detach(rb.data.buffer);
                    const dst = new Float64Array(cap + 8).fill(SENT);
                    assert.throws(() => rb[m](dst, 2), (e) => e instanceof RangeError && storageRe(m, 0, cap).test(e.message), m + ' cap ' + cap + ' ' + dn);
                    assert.ok(allSent(dst), m + ' ' + dn + ': dst written');
                    const e = ring(req, 0).rb;
                    detach(e.data.buffer);
                    assert.equal(e[m](dst, 2), 0, m + ' empty detached ' + dn);
                }
            }
        }
    });

    it('order: TypeError, then bounds, then alias, then storage; count 0 skips alias and storage', () => {
        for (const m of METHODS) {
            const mk = () => ring(64, 74).rb; // full, head 10
            // alias beats storage: data = 72-slot view of dst's buffer
            let rb = mk(); let dst = new Float32Array(80).fill(SENT);
            rb.data = new Float32Array(dst.buffer, 0, 72);
            assert.throws(() => rb[m](dst, 0), (e) => e instanceof RangeError && aliasRe(m).test(e.message), m + ' alias vs storage');
            // alias beats storage: data = 32-slot subarray of its own buffer, dst over that buffer
            rb = mk(); const own = rb.data; rb.data = own.subarray(0, 32); dst = new Float32Array(own.buffer);
            assert.throws(() => rb[m](dst, 0), (e) => e instanceof RangeError && aliasRe(m).test(e.message), m + ' alias vs short storage');
            // same 32-slot data, separate dst -> storage
            dst = new Float32Array(70).fill(SENT);
            assert.throws(() => rb[m](dst, 0), (e) => e instanceof RangeError && storageRe(m, 32, 64).test(e.message), m + ' short storage');
            // bounds beats storage
            rb = mk(); rb.data = new Float32Array(72); dst = new Float32Array(63).fill(SENT);
            assert.throws(() => rb[m](dst, 0), (e) => e instanceof RangeError && /needs 64 slots from offset 0 \(dst\.length 63\)/.test(e.message), m + ' bounds vs storage');
            // TypeError beats storage
            assert.throws(() => rb[m]({}, 0), (e) => e instanceof TypeError && /needs a TypedArray dst/.test(e.message), m + ' type vs storage');
            // detached data, dst = that detached view: bounds (dst.length 0) beats alias and storage
            rb = mk(); const d0 = rb.data; structuredClone(d0.buffer, { transfer: [d0.buffer] });
            assert.throws(() => rb[m](d0, 0), (e) => e instanceof RangeError && /needs 64 slots from offset 0 \(dst\.length 0\)/.test(e.message), m + ' detached alias');
            // count 0: no alias / storage check
            rb = mk(); rb.reset(); rb.data = new Float32Array(72);
            assert.equal(rb[m](new Float32Array(1)), 0, m + ' empty, bad storage');
            assert.equal(rb[m](new Float32Array(rb.data.buffer)), 0, m + ' empty, alias + bad storage');
        }
    });

    it('adversarial: length-tracking data on a resizable ArrayBuffer, shrunk / grown / restored', () => {
        assert.equal(typeof ArrayBuffer.prototype.resize, 'function', 'resizable ArrayBuffer missing on ' + process.version);
        for (const m of METHODS) {
            for (const req of [2, 64, 1024]) {
                const { rb } = ring(req, req + 9);
                const cap = rb.capacity;
                const rab = new ArrayBuffer(cap * 4, { maxByteLength: cap * 8 });
                const nd = new Float32Array(rab); // length-tracking
                const slots = [];
                for (let i = 0; i < cap; i++) { nd[i] = valueAt(500 + i); slots.push(stored(valueAt(500 + i))); }
                rb.data = nd;
                checkCopy(rb, m, Float32Array, 'F32', geomModel(slots, rb.head, rb.count), m + ' rab cap ' + cap);
                rab.resize((cap - 1) * 4);
                const dst = new Float32Array(cap + 4).fill(SENT);
                assert.throws(() => rb[m](dst, 0), (e) => e instanceof RangeError && storageRe(m, cap - 1, cap).test(e.message), m + ' shrunk');
                rab.resize(cap * 8);
                assert.throws(() => rb[m](dst, 0), (e) => e instanceof RangeError && storageRe(m, 2 * cap, cap).test(e.message), m + ' grown');
                assert.ok(allSent(dst), m + ' rab: dst written');
                rab.resize(cap * 4);
                slots[cap - 1] = 0; // shrinking dropped the last slot; growing back zero-fills it
                checkCopy(rb, m, Float32Array, 'F32', geomModel(slots, rb.head, rb.count), m + ' rab restored cap ' + cap);
            }
        }
    });
});

describe('qa-r1: non-extensible rings', () => {
    const LOCKS = [['freeze', Object.freeze], ['seal', Object.seal], ['preventExtensions', Object.preventExtensions]];
    it('freeze / seal / preventExtensions: copies are correct, no own value changes (no cache write), alias still caught', () => {
        for (const [lname, lock] of LOCKS) {
            for (const req of [1, 2, 33, 1024]) {
                const { rb, model } = ring(req, req + 3 + (req === 33 ? 31 : 0));
                const cap = rb.capacity;
                lock(rb);
                const before = ownValues(rb);
                for (let k = 0; k < 3; k++) {
                    for (const m of METHODS) for (const [kn, K] of F_KINDS) checkCopy(rb, m, K, kn, model, lname + ' ' + m + ' cap ' + cap);
                }
                assert.ok(sameOwn(ownValues(rb), before), lname + ' cap ' + cap + ': an own value changed');
                for (const m of METHODS) {
                    const alias = new Float32Array(rb.data.buffer);
                    const b0 = bytes(alias);
                    assert.throws(() => rb[m](alias, 0), (e) => e instanceof RangeError && aliasRe(m).test(e.message), lname + ' ' + m + ' alias');
                    assert.ok(sameBytes(bytes(alias), b0), lname + ' alias bytes');
                }
                if (lname === 'freeze') continue;
                // sealed / non-extensible: data is still writable
                const oldBuf = rb.data.buffer;
                const nd = new Float32Array(cap);
                const slots = [];
                for (let i = 0; i < cap; i++) { nd[i] = valueAt(77 + i); slots.push(stored(valueAt(77 + i))); }
                rb.data = nd;
                const before2 = ownValues(rb);
                const m2 = geomModel(slots, rb.head, rb.count);
                for (const m of METHODS) {
                    checkCopy(rb, m, Float32Array, 'F32', m2, lname + ' ' + m + ' replaced cap ' + cap);
                    assert.throws(() => rb[m](new Float32Array(nd.buffer), 0), (e) => e instanceof RangeError && aliasRe(m).test(e.message), lname + ' ' + m + ' new-buffer alias');
                    const viaOld = new Float32Array(oldBuf).fill(SENT);
                    assert.equal(rb[m](viaOld, 0), cap, lname + ' ' + m + ' old buffer copies');
                }
                assert.ok(sameOwn(ownValues(rb), before2), lname + ' cap ' + cap + ': own value changed after data replaced');
            }
        }
    });
});

describe('qa-r1: destroy, reset, iteration', () => {
    it('destroy (twice): copy returns 0, dst untouched, bounds / type still checked, nothing retained', () => {
        for (const req of [1, 64, 1024]) {
            const { rb } = ring(req, req + 5);
            const cap = rb.capacity;
            const oldData = rb.data, oldBuf = oldData.buffer;
            rb.copyTo(new Float32Array(cap)); rb.copyToFast(new Float32Array(cap)); // warm
            for (let round = 0; round < 2; round++) {
                rb.destroy();
                for (const m of METHODS) {
                    const dst = new Float32Array(cap + 4).fill(SENT);
                    assert.equal(rb[m](dst, 0), 0, m + ' after destroy ' + round);
                    assert.equal(rb[m](dst, cap + 4), 0, m + ' off dst.length');
                    assert.ok(allSent(dst), m + ' dst written');
                    assert.equal(rb[m](new Float32Array(oldBuf), 0), 0, m + ' old-buffer alias');
                    assert.throws(() => rb[m](dst, cap + 5), RangeError, m + ' bounds');
                    assert.throws(() => rb[m](null), TypeError, m + ' type');
                }
                assert.equal(rb.count, 0); assert.equal(rb.capacity, 0); assert.equal(rb.isEmpty(), true);
                for (const [k, v] of ownValues(rb)) {
                    assert.ok(v !== oldData && v !== oldBuf, 'req ' + req + ' round ' + round + ': own ' + k + ' retains the old storage');
                }
            }
        }
    });

    it('reset then copy: 0 and dst untouched, then only the new samples; reset of replaced storage', () => {
        for (const m of METHODS) {
            const { rb } = ring(64, 100);
            rb.reset();
            const dst = new Float32Array(68).fill(SENT);
            assert.equal(rb[m](dst, 0), 0, m + ' after reset');
            assert.ok(allSent(dst));
            for (let i = 0; i < 64; i++) assert.ok(Object.is(rb.data[i], 0), m + ' reset zeroes slot ' + i);
            const fresh = [valueAt(3), valueAt(4), valueAt(5)];
            for (const v of fresh) rb.push(v);
            checkCopy(rb, m, Float32Array, 'F32', fresh.map(stored), m + ' after reset + 3');
            rb.data = new Float32Array(72).fill(5);
            rb.reset();
            assert.equal(rb[m](new Float32Array(4)), 0, m + ' reset, bad storage');
            rb.push(1);
            assert.throws(() => rb[m](new Float32Array(4)), (e) => e instanceof RangeError && storageRe(m, 72, 64).test(e.message), m + ' bad storage after push');
        }
    });

    it('destroy during forEach / iteration and a re-entrant push: the walk keeps its snapshot', () => {
        const { rb, model } = ring(8, 11);
        const seen = [];
        rb.forEach((v, i, r) => {
            seen.push(v);
            if (i === 2) { r.destroy(); assert.equal(r.copyTo(new Float32Array(8)), 0); }
        });
        assert.equal(seen.length, 8);
        for (let j = 0; j < 8; j++) assert.ok(Object.is(seen[j], model[j]), 'forEach slot ' + j);

        const b = ring(8, 11);
        const it = b.rb[Symbol.iterator]();
        const first = it.next().value;
        b.rb.destroy();
        const rest = [first, ...{ [Symbol.iterator]: () => it }];
        assert.equal(rest.length, 8);
        for (let j = 0; j < 8; j++) assert.ok(Object.is(rest[j], b.model[j]), 'iterator slot ' + j);

        // re-entrant: push inside the callback overwrites the oldest slot, already visited
        const c = ring(4, 6);
        const vis = [];
        let inner = null;
        c.rb.forEach((v, i, r) => {
            vis.push(v);
            if (i === 0) { r.push(1000); inner = new Float32Array(4); r.copyTo(inner); }
        });
        for (let j = 0; j < 4; j++) assert.ok(Object.is(vis[j], c.model[j]), 're-entrant visit ' + j);
        const after = [...c.model.slice(1), 1000];
        for (let j = 0; j < 4; j++) assert.ok(Object.is(inner[j], after[j]), 're-entrant copy ' + j);
    });
});

describe('qa-r1: constructor boundaries', () => {
    it('rounds 1/1.5/2/32/33/64/1024/1025 and the default; rejects 0, -0, -1, 0.5, NaN, +/-Infinity, null, strings, BigInt, > 2^31', () => {
        const OK = [[1, 1], [1.5, 1], [2, 2], [32, 32], [33, 64], [63, 64], [64, 64], [65, 128], [1024, 1024], [1025, 2048], [undefined, 1024]];
        for (const [n, cap] of OK) {
            const rb = n === undefined ? new RingBuffer() : new RingBuffer(n);
            assert.equal(rb.capacity, cap, String(n));
            assert.equal(rb.mask, cap - 1, String(n));
            assert.equal(rb.data.length, cap, String(n));
        }
        const BAD = [0, -0, -1, 0.5, 0.999, NaN, Infinity, -Infinity, null, '8', 8n, 2 ** 31 + 1, 2 ** 32 - 1, 2 ** 32, 2 ** 53 - 1, 2 ** 53, -(2 ** 31)];
        for (const n of BAD) {
            assert.throws(() => new RingBuffer(n), (e) => e instanceof RangeError && /^LiteRingBuffer: capacity must be a number in \[1, 2\^31\]/.test(e.message), String(n));
        }
    });
});
