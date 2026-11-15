// copyLast / copyLastFast under user-controlled hooks (M1 unpark, R3-M2). Tier: DETERMINISTIC.
// The oracle is `model15`: the 1.5.0 lastCheck (a771a79) copied verbatim, with its error builders, over the same
// ring class, so it asks `dst instanceof DataView` BEFORE `n` / `dstOffset` are validated, exactly once per call.
// Intrinsics (Number.isInteger, the TypedArray getters) are captured at load, so a replaced global cannot reach it.
// Hooks: a stateful DataView[Symbol.hasInstance] and Proxy prototypes on the dst; each call's outcome, dst slots,
// ring state and hook / trap event sequence must equal the model's.
//   T1  stage H, 31,464 rows (2 methods x 3 ring fills x 6 hooks x 19 dsts x (9 n x 5 offsets + omitted form)).
//   T2  literal golden rows (cut from the frozen 1.5.0 build): a second instanceof call (parked 0083e04b) shows here.
//   T3  re-entry: a hasInstance hook that re-enters copyLast once (30 rows), live == model.
//   T4  re-entry: a replaced Number.isInteger that re-enters copyLast once (30 rows; out of contract, pinned
//       because it guards the cold builder reading its flag first); live outcome == the unhooked model outcome.
// Every replaced global is restored in finally and asserted restored at the end of each test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { RingBuffer } from '../RingBuffer.js';

// ---------------------------------------------------------------- captured intrinsics
const TA_PROTO = Object.getPrototypeOf(Float32Array.prototype);
const TA_LEN = Object.getOwnPropertyDescriptor(TA_PROTO, 'length').get;
const TA_BUF = Object.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get;
const TA_TAG = Object.getOwnPropertyDescriptor(TA_PROTO, Symbol.toStringTag).get;
const DV_BUF = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const REAL_HI = Function.prototype[Symbol.hasInstance];
const REAL_ISINT = Number.isInteger;
const isExt = Object.isExtensible;

// ---------------------------------------------------------------- model15: 1.5.0 builders and lastCheck, verbatim
function dstTypeError(name, dst) {
    return new TypeError(
        'LiteRingBuffer: ' + name + ' needs a TypedArray dst (got ' + (dst === null ? 'null' : typeof dst) + ')'
    );
}
function boundsError(name, c, dstOffset, dlen) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' needs ' + c + ' slots from offset ' + String(dstOffset) +
        ' (dst.length ' + dlen + ')'
    );
}
function aliasError(name) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' dst shares the ring\'s buffer (copy into a separate array); nothing written'
    );
}
function storageError(name, len, cap) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' storage holds ' + len + ' slots, capacity is ' + cap +
        ' (data replaced, resized or detached); nothing written'
    );
}
function lastNError(name, n) {
    return new RangeError(
        'LiteRingBuffer: ' + name + ' needs a non-negative integer n (got ' +
        (typeof n === 'number' ? '' + n : n === null ? 'null' : typeof n) + ')'
    );
}
function lastCheck15(rb, data, dst, dstOffset, n, name) {
    if (!ArrayBuffer.isView(dst) || dst instanceof DataView) throw dstTypeError(name, dst);
    const dlen = TA_LEN.call(dst);
    if (!REAL_ISINT(n) || n < 0) throw lastNError(name, n);
    if (!REAL_ISINT(dstOffset) || dstOffset < 0 || !(dstOffset + n <= dlen)) {
        throw boundsError(name, n, dstOffset, dlen);
    }
    const c = rb.count;
    const k = n < c ? n : c;
    if (k !== 0) {
        let buf = rb._buf;
        if (data !== rb._bufOf) {
            buf = TA_BUF.call(data);
            if (isExt(rb)) {
                rb._buf = buf;
                rb._bufOf = data;
            }
        }
        if (TA_BUF.call(dst) === buf) throw aliasError(name);
        const len = TA_LEN.call(data);
        if (len !== rb.capacity) throw storageError(name, len, rb.capacity);
    }
    return k;
}
// The copy itself, as a plain masked loop (copyLast's contract: the newest k samples, oldest first).
function model15(rb, name, dst, dstOffset, n) {
    if (dstOffset === undefined) dstOffset = 0;
    const data = rb.data;
    const k = lastCheck15(rb, data, dst, dstOffset, n, name);
    if (k === 0) return 0;
    const mask = rb.mask;
    const start = (rb.head - k) & mask;
    for (let i = 0; i < k; i++) dst[dstOffset + i] = data[(start + i) & mask];
    return k;
}
const LIVE = (rb, name, dst, off, n, form) => (form === 'omit' ? rb[name](dst) : rb[name](dst, off, n));
const MODEL = (rb, name, dst, off, n, form) => (form === 'omit' ? model15(rb, name, dst) : model15(rb, name, dst, off, n));

// ---------------------------------------------------------------- helpers
const F64 = new Float64Array(1), U32 = new Uint32Array(F64.buffer);
function hashData(d) {
    let n;
    try { n = TA_LEN.call(d); } catch { return 'nolen'; }
    let h = 2166136261 >>> 0;
    for (let i = 0; i < n; i++) { F64[0] = d[i]; h = Math.imul(h ^ U32[0], 16777619) >>> 0; h = Math.imul(h ^ U32[1], 16777619) >>> 0; }
    return h;
}
function stateOf(rb) {
    const d = rb.data;
    return [rb.head, rb.count, rb.capacity, rb.mask, d.constructor.name, TA_LEN.call(d), hashData(d),
        rb._bufOf === d, rb._buf === TA_BUF.call(d), isExt(rb)];
}
// Slots through intrinsics only: no prototype lookups, so no trap fires and a re-prototyped dst still reads.
function slotsOf(dst) {
    if (dst === null || typeof dst !== 'object') return 'nodst';
    if (Array.isArray(dst)) return dst.slice();
    if (TA_TAG.call(dst) !== undefined) { const n = TA_LEN.call(dst); const o = []; for (let i = 0; i < n; i++) o.push(dst[i]); return o; }
    return Array.from(new Uint8Array(DV_BUF.call(dst)));
}
// Serializer that tells -0, NaN, Infinity, undefined and bigint apart (so a row can not pass on a coerced value).
const ser = (v) => JSON.stringify(v, (_, x) => {
    if (typeof x === 'number') return Object.is(x, -0) ? '#-0' : (Number.isFinite(x) ? x : '#' + x);
    if (x === undefined) return '#undef';
    if (typeof x === 'bigint') return '#' + x + 'n';
    return x;
});
const errStr = (e) => (e && e.constructor ? e.constructor.name : typeof e) + ': ' + (e && e.message);
const VALS = [1.5, -0, NaN, 3.25, -7, 0.5, 1e-3, 42, -0.25, 9, Infinity, -2];
function mkRing(cap, m) {
    const rb = new RingBuffer(cap);
    for (let i = 0; i < m; i++) rb.push(VALS[i % VALS.length] + (i % 5));
    return rb;
}
const restored = () => !Object.hasOwn(DataView, Symbol.hasInstance) && Number.isInteger === REAL_ISINT;

// ---------------------------------------------------------------- stage H: hooks, proxies, dsts
const EV = [];
const truthDV = (v) => REAL_HI.call(DataView, v); // OrdinaryHasInstance: walks dst's chain (a Proxy trap logs 'gp')
const HOOKS = {
    none: null,
    count: () => (v) => { EV.push('hi'); return truthDV(v); },
    flip2: () => { let c = 0; return (v) => { c++; EV.push('hi' + c); const t = truthDV(v); return c >= 2 ? !t : t; }; },
    throw2: () => { let c = 0; return (v) => { c++; EV.push('hi' + c); if (c >= 2) throw new EvalError('hook call ' + c); return truthDV(v); }; },
    liar: () => () => { EV.push('hi'); return true; },
    throw1: () => () => { EV.push('hi'); throw new EvalError('hook call 1'); },
};
const pxProto = (target, mode) => {
    let w = 0;
    return new Proxy(target, {
        getPrototypeOf(t) {
            w++; EV.push('gp' + w);
            if (mode === 'flip' && w >= 2) return DataView.prototype;
            if (mode === 'throw' && w >= 2) throw new SyntaxError('trap ' + w);
            return Reflect.getPrototypeOf(t);
        },
    });
};
const withProto = (o, p) => { Object.setPrototypeOf(o, p); return o; };
const f32n = (k) => new Float32Array(k).fill(-99);
const DSTS_H = {
    f32: (rb) => f32n(rb.capacity + 6),
    small: () => f32n(3),
    arr: (rb) => new Array(rb.capacity + 6).fill(-99),
    nul: () => null,
    dv: (rb) => new DataView(new ArrayBuffer(8 * (rb.capacity + 6))),
    dvRealm: () => vm.runInNewContext('new DataView(new ArrayBuffer(64))'),
    f32Realm: () => vm.runInNewContext('new Float32Array(20).fill(-99)'),
    dvSub: () => new (class SubDV extends DataView {})(new ArrayBuffer(64)),
    taAsDv: (rb) => withProto(f32n(rb.capacity + 6), DataView.prototype),
    taAsDvSmall: () => withProto(f32n(3), DataView.prototype),
    dvNull: () => withProto(new DataView(new ArrayBuffer(64)), null),
    pxF32: (rb) => withProto(f32n(rb.capacity + 6), pxProto(Float32Array.prototype, 'count')),
    pxF32Small: () => withProto(f32n(3), pxProto(Float32Array.prototype, 'count')),
    pxDv: () => withProto(new DataView(new ArrayBuffer(64)), pxProto(DataView.prototype, 'count')),
    pxFlip: (rb) => withProto(f32n(rb.capacity + 6), pxProto(Float32Array.prototype, 'flip')),
    pxFlipSmall: () => withProto(f32n(3), pxProto(Float32Array.prototype, 'flip')),
    pxThrow: (rb) => withProto(f32n(rb.capacity + 6), pxProto(Float32Array.prototype, 'throw')),
    pxThrowSmall: () => withProto(f32n(3), pxProto(Float32Array.prototype, 'throw')),
    i16: (rb) => new Int16Array(rb.capacity + 6).fill(-99),
};
const NS_H = [2, 0, -0, -1, 1.5, NaN, '1', 100, undefined];
const OFFS_H = [0, -0, -1, NaN, 5];
const METHODS = ['copyLast', 'copyLastFast'];
const FILLS = [0, 3, 11];

// One hooked call: outcome, dst slots, ring state, event sequence. No assertion runs while a hook is installed.
function callH(impl, rb, method, dst, off, n, hk, form) {
    EV.length = 0;
    const f = HOOKS[hk] ? HOOKS[hk]() : null;
    if (f) Object.defineProperty(DataView, Symbol.hasInstance, { value: f, configurable: true });
    let r;
    try {
        try { r = { r: impl(rb, method, dst, off, n, form) }; } catch (e) { r = { e: errStr(e) }; }
    } finally { if (f) delete DataView[Symbol.hasInstance]; }
    r.ev = EV.join(',');
    EV.length = 0;
    r.slots = slotsOf(dst);
    r.st = stateOf(rb);
    return r;
}
function rowH(impl, method, m, hk, dk, n, off, form) {
    const rb = mkRing(8, m);
    return callH(impl, rb, method, DSTS_H[dk](rb), off, n, hk, form);
}

test('T1 stage H: hooks and Proxy prototypes, live == model15 (outcome, slots, state, event sequence)', () => {
    let rows = 0, hookRows = 0, maxGp = 0, badHi = 0, nMism = 0;
    const bad = [], shown = [];
    const check = (label, args) => {
        rows++;
        const live = rowH(LIVE, ...args), want = rowH(MODEL, ...args);
        const hi = (live.ev.match(/hi/g) || []).length;
        const gp = (live.ev.match(/gp/g) || []).length;
        if (gp > maxGp) maxGp = gp;
        const isView = DSTS_H[args[3]] && ArrayBuffer.isView(DSTS_H[args[3]](mkRing(8, 0)));
        // the hook runs exactly once for a view dst when hooked (the instanceof of 1.5.0), never for a non-view
        const wantHi = isView && args[2] !== 'none' ? 1 : 0;
        if (wantHi === 1) hookRows++;
        if (hi !== wantHi) { badHi++; if (bad.length < 5) bad.push('hi=' + hi + ' want ' + wantHi + ' ' + label); }
        if (ser(live) !== ser(want)) {
            nMism++;
            if (shown.length < 3) shown.push(label + ' live ' + ser(live).slice(0, 300) + ' want ' + ser(want).slice(0, 300));
        }
    };
    try {
        for (const method of METHODS) for (const m of FILLS) for (const hk of Object.keys(HOOKS)) for (const dk of Object.keys(DSTS_H)) {
            for (const n of NS_H) for (const off of OFFS_H) {
                check(method + ' m' + m + ' hook=' + hk + ' dst=' + dk + ' n=' + String(n) + ' off=' + String(off), [method, m, hk, dk, n, off, 'full']);
            }
            check(method + ' m' + m + ' hook=' + hk + ' dst=' + dk + ' omit', [method, m, hk, dk, undefined, undefined, 'omit']);
        }
    } finally {
        delete DataView[Symbol.hasInstance];
    }
    assert.equal(rows, 31464, 'row count');
    assert.equal(hookRows, 23460, 'rows where the hook must run once');
    assert.equal(nMism, 0, nMism + ' mismatching rows, first: ' + shown.join(' | '));
    assert.equal(badHi, 0, badHi + ' rows with a wrong hook call count: ' + bad.join(' | '));
    assert.ok(maxGp <= 1, 'at most one prototype-trap walk per row, saw ' + maxGp);
    assert.ok(restored(), 'globals restored');
});

// ---------------------------------------------------------------- T2: golden rows
// Expected values are literals cut from the frozen 1.5.0 build (9765c21e) by the unpark evidence run; the ring is
// mkRing(8, m), the hook installed for the one call only. Row 7's slots are by hand: m = 11 keeps pushes 3..10 of
// VALS[i % 12] + (i % 5); the newest two are i = 9 -> 9 + 4 = 13 and i = 10 -> Infinity + 0.
const TWO_RE = 'RangeError: LiteRingBuffer: copyLast needs 0 slots from offset 5 (dst.length 3)';
const GOLDEN = [
    // [method, m, hook, dst, n, off, outcome, events, first slots]
    ['copyLast', 11, 'count', 'small', 0, 5, TWO_RE, 'hi', [-99, -99, -99]],
    ['copyLast', 11, 'flip2', 'small', 0, 5, TWO_RE, 'hi1', [-99, -99, -99]],
    ['copyLast', 11, 'count', 'f32', NaN, 0, 'RangeError: LiteRingBuffer: copyLast needs a non-negative integer n (got NaN)', 'hi', [-99, -99]],
    ['copyLastFast', 3, 'throw2', 'f32', -1, 0, 'RangeError: LiteRingBuffer: copyLastFast needs a non-negative integer n (got -1)', 'hi1', [-99, -99]],
    ['copyLast', 3, 'none', 'pxFlip', -0, -0, 'ret 0', 'gp1', [-99, -99]],
    ['copyLastFast', 11, 'liar', 'f32', 2, 0, 'TypeError: LiteRingBuffer: copyLastFast needs a TypedArray dst (got object)', 'hi', [-99, -99]],
    ['copyLast', 11, 'count', 'f32', 2, 0, 'ret 2', 'hi', [13, Infinity, -99, -99]],
    ['copyLast', 3, 'count', 'small', 0, -0, 'ret 0', 'hi', [-99, -99, -99]],
    ['copyLast', 3, 'count', 'arr', 2, 0, 'TypeError: LiteRingBuffer: copyLast needs a TypedArray dst (got object)', '', [-99, -99]],
];
test('T2 golden rows from the frozen 1.5.0 build: live and model15 both match (one instanceof per call)', () => {
    const bad = [];
    let rows = 0;
    try {
        for (const [method, m, hk, dk, n, off, out, ev, slots] of GOLDEN) {
            for (const [who, impl] of [['live', LIVE], ['model15', MODEL]]) {
                rows++;
                const r = rowH(impl, method, m, hk, dk, n, off, 'full');
                const got = ser([r.e !== undefined ? r.e : 'ret ' + r.r, r.ev, r.slots.slice(0, slots.length)]);
                if (got !== ser([out, ev, slots])) bad.push(who + ' ' + method + ' m' + m + ' ' + hk + ' ' + dk + ' n=' + String(n) + ': ' + got);
            }
        }
    } finally {
        delete DataView[Symbol.hasInstance];
    }
    assert.equal(rows, 18, 'row count');
    assert.equal(bad.length, 0, bad.length + ' mismatches, first: ' + bad.slice(0, 3).join(' | '));
    assert.ok(restored(), 'globals restored');
});

// ---------------------------------------------------------------- T3 / T4: re-entry
const DST_R = { f32: () => new Float32Array(14), small: () => new Float32Array(3), dv: () => new DataView(new ArrayBuffer(64)) };
const RE_CASES = [[2, 0], [-1, 0], [2, -1], [2, 5], [100, 0]];
function* reRows() {
    for (const od of Object.keys(DST_R)) for (const id of ['dv', 'f32']) for (const [n, off] of RE_CASES) yield [od, id, n, off];
}
const mk11 = () => mkRing(8, 11);
// mode 'O1': hasInstance hook re-enters once; 'O3': Number.isInteger wrapper re-enters once; 'none': no hook.
function runRe(impl, mode, outerDst, innerDst, n, off) {
    const ev = [];
    let depth = 0;
    const inner = () => {
        depth++;
        try { impl(mk11(), 'copyLast', DST_R[innerDst](), 0, 1, 'full'); ev.push('in:ok'); } catch (e) { ev.push('in:' + e.constructor.name); }
        depth--;
    };
    if (mode === 'O1') Object.defineProperty(DataView, Symbol.hasInstance, { configurable: true, value(v) { ev.push('hi' + depth); if (depth === 0) inner(); return REAL_HI.call(DataView, v); } });
    else if (mode === 'O3') Number.isInteger = function (x) { ev.push('ii' + depth); if (depth === 0) inner(); return REAL_ISINT(x); };
    let out;
    try { out = 'ret ' + impl(mk11(), 'copyLast', DST_R[outerDst](), off, n, 'full'); } catch (e) { out = errStr(e); }
    finally { delete DataView[Symbol.hasInstance]; Number.isInteger = REAL_ISINT; }
    return { out, ev: ev.join(',') };
}

test('T3 re-entry O1: a hasInstance hook re-entering copyLast, live == model15 (30 rows, outcome and events)', () => {
    let rows = 0;
    const bad = [];
    try {
        for (const [od, id, n, off] of reRows()) {
            rows++;
            const live = runRe(LIVE, 'O1', od, id, n, off), want = runRe(MODEL, 'O1', od, id, n, off);
            if (ser(live) !== ser(want)) bad.push('O1 outer=' + od + ' inner=' + id + ' n=' + n + ' off=' + off + ' live ' + ser(live) + ' want ' + ser(want));
        }
    } finally {
        delete DataView[Symbol.hasInstance];
        Number.isInteger = REAL_ISINT;
    }
    assert.equal(rows, 30, 'row count');
    assert.equal(bad.length, 0, bad.length + ' mismatches, first: ' + bad.slice(0, 3).join(' | '));
    assert.ok(restored(), 'globals restored');
});

test('T4 re-entry O3: a replaced re-entrant Number.isInteger (out of contract), live outcome == unhooked model15 (30 rows)', () => {
    let rows = 0;
    const bad = [];
    try {
        for (const [od, id, n, off] of reRows()) {
            rows++;
            const live = runRe(LIVE, 'O3', od, id, n, off);
            const want = runRe(MODEL, 'none', od, id, n, off);
            if (live.out !== want.out) bad.push('O3 outer=' + od + ' inner=' + id + ' n=' + n + ' off=' + off + ' live ' + live.out + ' want ' + want.out);
        }
    } finally {
        delete DataView[Symbol.hasInstance];
        Number.isInteger = REAL_ISINT;
    }
    assert.equal(rows, 30, 'row count');
    assert.equal(bad.length, 0, bad.length + ' mismatches, first: ' + bad.slice(0, 3).join(' | '));
    assert.ok(restored(), 'globals restored');
});
