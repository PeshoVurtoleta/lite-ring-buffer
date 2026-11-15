// QA R2 suite (qa pass 2026-11-14): pushBatch reads src / data through the
// INTRINSIC TypedArray getters (length, buffer, toStringTag), never through
// properties a subclass or another realm can change. Each test closes a gap a
// named mutant of build ff6ee762 survived in the rest of the suite
// (.handoff/archive/1.4.0/R2/qa/mutants/): q-default-length-prop, q-set-length-prop,
// q-src-instanceof, q-alias-prop, q-data-buf-prop. The last two tests pin the
// maintainer rulings Q-R2-DESTROY and Q-R2-DETACH (2026-11-14, documented as-is);
// controls q-destroyed-throw and q-detached-throw.
// Oracle: a model ring driven by the documented push semantics (store at
// head, head = (head + 1) % capacity, count saturates at capacity; values
// round through Math.fround), never the engine. The real length / buffer of a
// lying subclass come from the %TypedArray% intrinsic getters, read here.
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

const TA_PROTO = Object.getPrototypeOf(Float32Array.prototype);
const realLength = (v) => Object.getOwnPropertyDescriptor(TA_PROTO, 'length').get.call(v);
const realBuffer = (v) => Object.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get.call(v);

const val = (i) => (i % 5 === 0 ? -0 : i % 7 === 0 ? NaN : i * 1.3 - 40.1);

// A ring in a known state plus its independent model.
function pair(cap, head, count) {
    const rb = new RingBuffer(cap);
    assert.equal(rb.capacity, cap, 'cap is a power of two');
    const slots = [];
    for (let i = 0; i < cap; i++) { rb.data[i] = -500 - i; slots.push(Math.fround(-500 - i)); }
    rb.head = head;
    rb.count = count;
    return { rb, m: { slots, head, count, cap } };
}
function modelPush(m, src, off, n) {
    for (let i = 0; i < n; i++) {
        m.slots[m.head] = Math.fround(src[off + i]);
        m.head = (m.head + 1) % m.cap;
        if (m.count < m.cap) m.count++;
    }
}
function assertModel(rb, m, label) {
    assert.equal(rb.head, m.head, label + ' head');
    assert.equal(rb.count, m.count, label + ' count');
    for (let i = 0; i < m.cap; i++) {
        assert.ok(Object.is(rb.data[i], m.slots[i]), label + ' slot ' + i + ': got ' + rb.data[i] + ' want ' + m.slots[i]);
    }
}
function fill(src) { const n = realLength(src); for (let i = 0; i < n; i++) src[i] = val(i + 1); return src; }

describe('pushBatch reads src / data through intrinsic getters (qa R2)', () => {
    it('count omitted defaults to the INTRINSIC src length, not a subclass length getter (q-default-length-prop)', () => {
        class F32Short extends Float32Array { get length() { return 2; } }
        class F64Short extends Float64Array { get length() { return 2; } }
        for (const Kind of [F32Short, F64Short]) {
            const src = fill(new Kind(11));
            assert.equal(src.length, 2, 'scenario: the getter lies');
            const a = pair(8, 5, 8);
            modelPush(a.m, src, 0, 11);
            assert.equal(a.rb.pushBatch(src), 11, Kind.name + ' (src)');
            assertModel(a.rb, a.m, Kind.name + ' (src)');
            const b = pair(8, 1, 3);
            modelPush(b.m, src, 3, 8);
            assert.equal(b.rb.pushBatch(src, 3), 8, Kind.name + ' (src, 3)');
            assertModel(b.rb, b.m, Kind.name + ' (src, 3)');
        }
    });

    it('set path is taken only when count equals the INTRINSIC length: a lying length cannot widen the copy (q-set-length-prop)', () => {
        class F32Lie extends Float32Array { get length() { return 4; } }
        for (const head of [0, 2]) {
            const src = fill(new F32Lie(6));
            const p = pair(8, head, 1);
            modelPush(p.m, src, 0, 4);
            assert.equal(p.rb.pushBatch(src, 0, 4), 4, 'head ' + head);
            // slots head+4, head+5 must keep their old values
            assertModel(p.rb, p.m, 'head ' + head);
        }
    });

    it('cross-realm Float32Array / Float64Array src is accepted (tag check, not instanceof); other cross-realm kinds throw TypeError (q-src-instanceof)', () => {
        const ctx = vm.createContext({});
        for (const name of ['Float32Array', 'Float64Array']) {
            const X = vm.runInContext(name, ctx);
            assert.ok(!(new X(1) instanceof globalThis[name]), 'scenario: foreign realm');
            // whole contiguous (set path for F32), slice, wrapped, over capacity
            for (const [cap, head, c0, len, off, n] of [[16, 0, 0, 8, 0, 8], [16, 3, 3, 10, 2, 7], [8, 6, 8, 5, 0, 5], [8, 3, 8, 21, 1, 20]]) {
                const src = fill(new X(len));
                const p = pair(cap, head, c0);
                modelPush(p.m, src, off, n);
                assert.equal(p.rb.pushBatch(src, off, n), n, name + ' cap ' + cap + ' n ' + n);
                assertModel(p.rb, p.m, 'cross-realm ' + name + ' cap ' + cap + ' n ' + n);
            }
        }
        for (const name of ['Int16Array', 'BigInt64Array', 'Uint8ClampedArray']) {
            const src = vm.runInContext('new ' + name + '(4)', ctx);
            const p = pair(8, 2, 3);
            for (const cnt of [0, 2]) {
                assert.throws(() => p.rb.pushBatch(src, 0, cnt), (e) => e instanceof TypeError && /^LiteRingBuffer: pushBatch /.test(e.message), name + ' count ' + cnt);
            }
            assertModel(p.rb, p.m, 'cross-realm ' + name + ' rejected');
        }
    });

    it('alias check reads src\'s buffer through the intrinsic getter: a lying buffer getter cannot hide a view of the ring (q-alias-prop)', () => {
        class F32BufLie extends Float32Array { get buffer() { return new ArrayBuffer(8); } }
        class F64BufLie extends Float64Array { get buffer() { return new ArrayBuffer(8); } }
        for (const warm of [false, true]) {
            const p = pair(8, 2, 3);
            if (warm) { p.rb.pushBatch(fill(new Float32Array(3))); modelPush(p.m, fill(new Float32Array(3)), 0, 3); }
            const views = [new F32BufLie(p.rb.data.buffer, 4, 4), new F64BufLie(p.rb.data.buffer, 0, 2)];
            for (const src of views) {
                assert.notEqual(src.buffer, p.rb.data.buffer, 'scenario: the getter lies');
                assert.throws(() => p.rb.pushBatch(src, 0, 1), (e) => e instanceof RangeError && /shares/.test(e.message), (warm ? 'warm ' : 'cold ') + src.constructor.name);
                assertModel(p.rb, p.m, (warm ? 'warm ' : 'cold ') + src.constructor.name + ' nothing written');
            }
        }
    });

    it('alias check reads data\'s buffer through the intrinsic getter: replaced storage with a lying buffer getter still rejects a view of it (q-data-buf-prop)', () => {
        class StoreLie extends Float32Array { get buffer() { return new ArrayBuffer(16); } }
        for (const warm of [false, true]) {
            const rb = new RingBuffer(8);
            if (warm) rb.pushBatch(fill(new Float32Array(3)));
            rb.data = new StoreLie(8);
            for (let i = 0; i < 8; i++) rb.data[i] = 10 + i;
            const head = rb.head, count = rb.count;
            const src = new Float32Array(realBuffer(rb.data), 8, 3);
            for (let k = 0; k < 3; k++) {
                assert.throws(() => rb.pushBatch(src, 0, 1), (e) => e instanceof RangeError && /shares/.test(e.message), (warm ? 'warm' : 'cold') + ' call ' + k);
            }
            assert.equal(rb.head, head, 'head unchanged');
            assert.equal(rb.count, count, 'count unchanged');
            for (let i = 0; i < 8; i++) assert.equal(rb.data[i], 10 + i, 'slot ' + i + ' unchanged');
            // a separate array still pushes into the replaced storage
            const ok = fill(new Float32Array(2));
            assert.equal(rb.pushBatch(ok), 2, (warm ? 'warm' : 'cold') + ' separate src works');
        }
    });
});

describe('pushBatch rulings Q-R2-DESTROY / Q-R2-DETACH (qa R2, documented as-is)', () => {
    it('Q-R2-DESTROY: after destroy(), pushBatch returns count, stores nothing, does not throw (F32 and F64 src) (q-destroyed-throw)', () => {
        for (const Kind of [Float32Array, Float64Array]) {
            const rb = new RingBuffer(8);
            rb.pushBatch(fill(new Float32Array(5)));
            rb.destroy();
            const data = rb.data, head = rb.head, count = rb.count, cap = rb.capacity;
            const src = fill(new Kind(5));
            for (const [args, want] of [[[src], 5], [[src, 2], 3], [[src, 1, 4], 4], [[src, 0, 0], 0]]) {
                let r;
                assert.doesNotThrow(() => { r = rb.pushBatch(...args); }, Kind.name + ' (' + args.slice(1) + ')');
                assert.equal(r, want, Kind.name + ' return (' + args.slice(1) + ')');
                assert.equal(rb.data, data, 'data identity');
                assert.equal(realLength(rb.data), 0, 'data stays empty');
                assert.equal(rb.head, head, 'head');
                assert.equal(rb.count, count, 'count');
                assert.equal(rb.capacity, cap, 'capacity');
            }
        }
    });

    it('Q-R2-DETACH: a detached or out-of-bounds src is a length-0 src: count omitted -> 0, count 1 -> bounds RangeError naming src.length 0; nothing written (q-detached-throw)', () => {
        const srcs = [];
        for (const Kind of [Float32Array, Float64Array]) {
            const d = fill(new Kind(6));
            if (typeof ArrayBuffer.prototype.transfer === 'function') d.buffer.transfer();
            else structuredClone(d.buffer, { transfer: [d.buffer] });
            assert.equal(realLength(d), 0, 'scenario: detached');
            srcs.push(['detached ' + Kind.name, d]);
            if (typeof ArrayBuffer.prototype.resize === 'function') {
                const ab = new ArrayBuffer(8 * Kind.BYTES_PER_ELEMENT, { maxByteLength: 16 * Kind.BYTES_PER_ELEMENT });
                const fixed = fill(new Kind(ab, 2 * Kind.BYTES_PER_ELEMENT, 4));
                const tracking = fill(new Kind(ab, 4 * Kind.BYTES_PER_ELEMENT));
                ab.resize(Kind.BYTES_PER_ELEMENT);
                assert.equal(realLength(fixed), 0, 'scenario: fixed view out of bounds');
                assert.equal(realLength(tracking), 0, 'scenario: tracking view out of bounds');
                srcs.push(['out-of-bounds fixed ' + Kind.name, fixed], ['out-of-bounds tracking ' + Kind.name, tracking]);
            }
        }
        assert.ok(srcs.length >= 2, 'scenarios ran: ' + srcs.length);
        for (const [label, src] of srcs) {
            const p = pair(8, 3, 5);
            assert.equal(p.rb.pushBatch(src), 0, label + ' count omitted');
            assert.equal(p.rb.pushBatch(src, 0), 0, label + ' (src, 0)');
            assertModel(p.rb, p.m, label + ' count omitted, nothing written');
            assert.throws(() => p.rb.pushBatch(src, 0, 1), (e) => e instanceof RangeError &&
                /^LiteRingBuffer: pushBatch needs non-negative integer srcOffset and count/.test(e.message) &&
                /src\.length 0\)/.test(e.message), label + ' count 1');
            assertModel(p.rb, p.m, label + ' count 1, nothing written');
        }
    });
});
