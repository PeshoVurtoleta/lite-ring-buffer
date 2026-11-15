// QA M1 unpark: a user DataView[Symbol.hasInstance] hook that changes state DURING copyLast /
// copyLastFast's check. 1.5.0 asks `dst instanceof DataView` before it reads dst's length and before it
// reads the ring's count, so the hook's effect on the ring (reset / destroy / push / pushBatch) and on a
// resizable or transferred dst buffer is what the call sees. Expectations are literals from the frozen
// 1.5.0 build (a771a79); this file imports only ../RingBuffer.js. Every hook is removed in finally and
// each test asserts it.
//
// Revert checks (.handoff/M1/unpark/qa/): Q1-Q3 fail on a same-size reorder that reads rb.count before the
// type / n / bounds check (MK_countEarly; the shipped suite passes it, chain 765); Q4 fails on a build that
// reads dst's length before the hook runs (MM_lenBeforeHook).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../RingBuffer.js';

const REAL_HI = Function.prototype[Symbol.hasInstance];
const truth = (v) => REAL_HI.call(DataView, v);
const METHODS = ['copyLast', 'copyLastFast'];
const restored = () => !Object.prototype.hasOwnProperty.call(DataView, Symbol.hasInstance);

function ring(pushes) {
    const r = new RingBuffer(8);
    for (let i = 0; i < pushes; i++) r.push(i + 1);
    return r;
}
// Runs one call with `act` installed as the hook; no assertion runs while the hook is installed.
function hooked(act, call) {
    let calls = 0;
    Object.defineProperty(DataView, Symbol.hasInstance, {
        configurable: true,
        value(v) { calls++; act(); return truth(v); },
    });
    let out;
    try {
        try { out = 'ret ' + call(); } catch (e) { out = e.constructor.name + ': ' + e.message; }
    } finally {
        delete DataView[Symbol.hasInstance];
    }
    return { out, calls };
}

test('Q1 hook resets the full ring mid-check: k is taken after the hook, so 0 is returned and dst is untouched', () => {
    for (const m of METHODS) {
        const r = ring(11), d = new Float32Array(10).fill(-99);
        const { out, calls } = hooked(() => r.reset(), () => r[m](d, 1, 4));
        assert.equal(out, 'ret 0', m);
        assert.equal(calls, 1, m + ' one hook call');
        assert.deepEqual(Array.from(d), new Array(10).fill(-99), m + ' dst untouched');
        assert.equal(r.head + ':' + r.count, '0:0', m);
    }
    assert.ok(restored(), 'hook removed');
});

test('Q2 hook destroys the ring mid-check: 0 returned (not the storage RangeError), dst untouched', () => {
    for (const m of METHODS) {
        const r = ring(11), d = new Float32Array(10).fill(-99);
        const { out, calls } = hooked(() => r.destroy(), () => r[m](d, 1, 4));
        assert.equal(out, 'ret 0', m);
        assert.equal(calls, 1, m + ' one hook call');
        assert.deepEqual(Array.from(d), new Array(10).fill(-99), m + ' dst untouched');
        assert.equal(r.head + ':' + r.count, '0:0', m);
    }
    assert.ok(restored(), 'hook removed');
});

test('Q3 hook pushes into a partial ring mid-check: the copy sees the new samples (push x2, pushBatch x3)', () => {
    for (const m of METHODS) {
        let r = ring(3), d = new Float32Array(10).fill(-99);
        let h = hooked(() => { r.push(100); r.push(101); }, () => r[m](d, 1, 4));
        assert.equal(h.out, 'ret 4', m + ' push n 4');
        assert.deepEqual(Array.from(d), [-99, 2, 3, 100, 101, -99, -99, -99, -99, -99], m + ' push n 4');

        r = ring(3); d = new Float32Array(10).fill(-99);
        h = hooked(() => { r.push(100); r.push(101); }, () => r[m](d, 1, 9));
        assert.equal(h.out, 'ret 5', m + ' push n 9');
        assert.deepEqual(Array.from(d), [-99, 1, 2, 3, 100, 101, -99, -99, -99, -99], m + ' push n 9');

        r = ring(3); d = new Float32Array(10).fill(-99);
        h = hooked(() => r.pushBatch(new Float32Array([50, 51, 52]), 0, 3), () => r[m](d, 1, 4));
        assert.equal(h.out, 'ret 4', m + ' pushBatch');
        assert.deepEqual(Array.from(d), [-99, 3, 50, 51, 52, -99, -99, -99, -99, -99], m + ' pushBatch');
        assert.equal(r.head + ':' + r.count + ':' + h.calls, '6:6:1', m);
    }
    assert.ok(restored(), 'hook removed');
});

test('Q4 hook resizes / transfers a resizable dst buffer mid-check: the bounds use the length read after the hook', () => {
    // [view, resize-to bytes (transfer when null), n, expected outcome, expected dst slots after]
    const rows = [
        ['track', 8, 4, (m) => 'RangeError: LiteRingBuffer: ' + m + ' needs 4 slots from offset 0 (dst.length 2)', [0, 0]],
        ['track', 16, 4, () => 'ret 4', [8, 9, 10, 11]],
        ['fixed', 8, 4, (m) => 'RangeError: LiteRingBuffer: ' + m + ' needs 4 slots from offset 0 (dst.length 0)', null],
        ['track', null, 1, (m) => 'RangeError: LiteRingBuffer: ' + m + ' needs 1 slots from offset 0 (dst.length 0)', null],
        ['track', null, 0, () => 'ret 0', null],
        ['trackOff', 16, 2, () => 'ret 2', [10, 11, 0]],
        ['trackOff', 16, 3, () => 'ret 3', [9, 10, 11]],
    ];
    for (const m of METHODS) for (const [view, to, n, want, slots] of rows) {
        const label = m + ' ' + view + ' to=' + to + ' n=' + n;
        const r = ring(11), ab = new ArrayBuffer(32, { maxByteLength: 64 });
        const d = view === 'fixed' ? new Float32Array(ab, 0, 8) : view === 'trackOff' ? new Float32Array(ab, 4) : new Float32Array(ab);
        const { out, calls } = hooked(() => { if (to === null) ab.transfer(); else ab.resize(to); }, () => r[m](d, 0, n));
        assert.equal(out, want(m), label);
        assert.equal(calls, 1, label + ' one hook call');
        if (slots === null) assert.equal(d.length, 0, label + ' dst out of bounds / detached');
        else assert.deepEqual(Array.from(d), slots, label);
    }
    assert.ok(restored(), 'hook removed');
});
