// Audit-fix oracle (UNIT 1): copyTo / copyToFast storage check (data replaced,
// resized or detached), non-extensible rings, and a values oracle over every
// dst family. Expected values come from the audit-fix PLAN ASSERTIONS 1-2 and
// from an independent model (Math.fround of what was pushed, converted per dst
// kind by writing it into a fresh 1-element array of that kind); never from
// copyTo / copyToFast. Build under test: RB_BUILD (absolute or package-relative)
// else ../RingBuffer.js. No test reads a cache field by name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = process.env.RB_BUILD
    ? path.resolve(ROOT, process.env.RB_BUILD)
    : path.join(ROOT, 'RingBuffer.js');
// Fail closed: a failed import throws and fails the file (never skips).
const { RingBuffer } = await import(pathToFileURL(BUILD).href);

const METHODS = ['copyTo', 'copyToFast'];
const SENT = 99;

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
const pickStream = prng(0xA0D17F1);
const valueStream = prng(0x0B5E55ED);
const SPECIALS = [-0, NaN, Infinity, -Infinity, 0.5, 1.5, 2.5, 255.5, 70000, -3.25, 1e10, -129];
let specialIdx = 0;
function nextValue() {
    if (pickStream() < 0.4) return SPECIALS[specialIdx++ % SPECIALS.length];
    return (valueStream() * 2 - 1) * 100000;
}

// Ring + independent model (oldest-first Math.fround values).
function makeRing(requested, pushes) {
    const rb = new RingBuffer(requested);
    const all = [];
    for (let i = 0; i < pushes; i++) { const v = nextValue(); rb.push(v); all.push(Math.fround(v)); }
    const model = all.slice(Math.max(0, all.length - rb.capacity));
    return { rb, model };
}
function detach(rb) {
    const b = rb.data.buffer;
    if (typeof ArrayBuffer.prototype.transfer === 'function') b.transfer();
    else structuredClone(b, { transfer: [b] });
}
function filled(Kind, n, v) { return new Kind(n).fill(v); }
function allEq(arr, v) { for (let i = 0; i < arr.length; i++) if (!Object.is(arr[i], v)) return false; return true; }
function convert(Kind, v) { const t = new Kind(1); t[0] = v; return t[0]; }
function bytesOf(buf) { return new Uint8Array(buf).slice(); }

describe('audit-fix: storage check (ASSERTION 1)', () => {
    it('replaced data of the wrong length -> storage RangeError, dst untouched (both methods, 3 calls)', () => {
        for (const name of METHODS) {
            for (const pushes of [74, 40]) {
                for (const len of [72, 56]) {
                    const { rb } = makeRing(64, pushes);
                    const dst = filled(Float32Array, 80, SENT);
                    rb.data = new Float32Array(len);
                    const re = new RegExp('^LiteRingBuffer: ' + name + ' storage holds ' + len + ' slots, capacity is 64 \\(data replaced, resized or detached\\); nothing written$');
                    for (let k = 0; k < 3; k++) {
                        assert.throws(() => rb[name](dst, 2), (e) => e instanceof RangeError && re.test(e.message));
                        assert.ok(allEq(dst, SENT), name + ' wrote into dst');
                    }
                }
            }
        }
    });

    it('detached storage -> storage RangeError (holds 0 slots), dst untouched', () => {
        const cases = [[64, 40, Float32Array], [64, 64, Float64Array], [8, 5, Float32Array], [64, 64, Float32Array]];
        for (const name of METHODS) {
            for (const [cap, pushes, Dst] of cases) {
                const { rb } = makeRing(cap, pushes);
                const dst = filled(Dst, 80, SENT);
                detach(rb);
                const re = new RegExp('^LiteRingBuffer: ' + name + ' storage holds 0 slots, capacity is ' + cap + ' ');
                for (let k = 0; k < 3; k++) {
                    assert.throws(() => rb[name](dst, 2), (e) => e instanceof RangeError && re.test(e.message));
                    assert.ok(allEq(dst, SENT));
                }
            }
        }
    });

    it('an EMPTY ring with detached storage returns 0 (no storage check at count 0)', () => {
        for (const name of METHODS) {
            const rb = new RingBuffer(64);
            detach(rb);
            const dst = filled(Float32Array, 8, SENT);
            assert.equal(rb[name](dst, 0), 0);
            assert.ok(allEq(dst, SENT));
        }
    });

    it('pin: data viewing dst.buffer (72 slots) keeps the alias RangeError, not the storage one', () => {
        for (const name of METHODS) {
            const { rb } = makeRing(64, 70);
            const dst = filled(Float32Array, 80, SENT);
            rb.data = new Float32Array(dst.buffer, 0, 72);
            for (let k = 0; k < 3; k++) {
                assert.throws(() => rb[name](dst, 0), (e) => e instanceof RangeError && /dst shares/.test(e.message));
            }
            assert.ok(allEq(dst, SENT));
        }
    });

    it('pin: non-TypedArray data (Array(72)) keeps the getter TypeError on every call', () => {
        for (const name of METHODS) {
            const { rb } = makeRing(64, 70);
            const dst = filled(Float32Array, 80, SENT);
            rb.data = new Array(72).fill(1);
            for (let k = 0; k < 3; k++) {
                assert.throws(() => rb[name](dst, 0), TypeError);
            }
            assert.ok(allEq(dst, SENT));
        }
    });
});

describe('audit-fix: non-extensible rings (ASSERTION 2)', () => {
    const LOCKS = [['freeze', Object.freeze], ['seal', Object.seal], ['preventExtensions', Object.preventExtensions]];

    it('frozen / sealed / non-extensible rings copy correctly, caps 8 and 64, both methods, 3 calls', () => {
        for (const [, lock] of LOCKS) {
            for (const [cap, pushes] of [[8, 5], [64, 70]]) {
                for (const name of METHODS) {
                    for (const Dst of [Float32Array, Float64Array]) {
                        const { rb, model } = makeRing(cap, pushes);
                        lock(rb);
                        for (let k = 0; k < 3; k++) {
                            const dst = filled(Dst, model.length + 2, SENT);
                            assert.equal(rb[name](dst, 1), model.length);
                            assert.ok(Object.is(dst[0], SENT));
                            assert.ok(Object.is(dst[model.length + 1], SENT));
                            for (let i = 0; i < model.length; i++) {
                                assert.ok(Object.is(dst[1 + i], model[i]), name + ' slot ' + i);
                            }
                        }
                    }
                }
            }
        }
    });

    it('frozen ring, dst over rb.data.buffer -> alias RangeError, dst bytes unchanged', () => {
        for (const name of METHODS) {
            for (const [cap, pushes] of [[8, 5], [64, 70]]) {
                const { rb } = makeRing(cap, pushes);
                Object.freeze(rb);
                const dst = new Float32Array(rb.data.buffer);
                const before = bytesOf(dst.buffer);
                for (let k = 0; k < 3; k++) {
                    assert.throws(() => rb[name](dst, 0), (e) => e instanceof RangeError && /dst shares/.test(e.message));
                }
                assert.deepEqual(bytesOf(dst.buffer), before);
            }
        }
    });

    it('warm copy, data replaced by a fresh same-length array, freeze: alias follows the NEW buffer', () => {
        for (const name of METHODS) {
            const { rb, model } = makeRing(8, 6);
            const warm = filled(Float32Array, 8, SENT);
            assert.equal(rb[name](warm, 0), model.length);
            const old = rb.data;
            const fresh = new Float32Array(8);
            fresh.set(old); // same contents, so the model still holds
            rb.data = fresh;
            Object.freeze(rb);
            // dst over the fresh (current) storage: alias RangeError
            const overFresh = new Float32Array(fresh.buffer);
            const freshBytes = bytesOf(fresh.buffer);
            assert.throws(() => rb[name](overFresh, 0), (e) => e instanceof RangeError && /dst shares/.test(e.message));
            assert.deepEqual(bytesOf(fresh.buffer), freshBytes);
            // dst over the OLD buffer is no longer aliased: copies
            const overOld = new Float32Array(old.buffer);
            assert.equal(rb[name](overOld, 0), model.length);
            for (let i = 0; i < model.length; i++) assert.ok(Object.is(overOld[i], model[i]));
        }
    });

    it('retention: after 1000 calls of each method on a frozen ring every own value is unchanged', () => {
        for (const [cap, pushes] of [[8, 5], [64, 70]]) {
            const { rb } = makeRing(cap, pushes);
            const dst = new Float32Array(cap);
            const keys = Object.getOwnPropertyNames(rb);
            const snap = keys.map((k) => rb[k]);
            Object.freeze(rb);
            for (const name of METHODS) {
                for (let i = 0; i < 1000; i++) rb[name](dst, 0);
            }
            assert.deepEqual(Object.getOwnPropertyNames(rb), keys);
            for (let i = 0; i < keys.length; i++) assert.ok(rb[keys[i]] === snap[i], 'own value changed: ' + keys[i]);
        }
    });
});

describe('audit-fix: values oracle (parity pin, passes on the frozen build too)', () => {
    class F32Sub extends Float32Array {}
    const KINDS = [Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray,
        Int16Array, Uint16Array, Int32Array, Uint32Array, F32Sub];
    if (typeof Float16Array === 'function') KINDS.push(Float16Array);

    it('every dst kind x cap 8/64 x partial/full/wrapped x offset 0/1 x method matches the per-kind model', () => {
        let cells = 0;
        let slotsChecked = 0;
        let nonInt = 0;
        const shapes = (cap) => [['partial', (cap >> 1) + 1], ['full', cap], ['wrapped', cap + 3]];
        for (const Kind of KINDS) {
            for (const cap of [8, 64]) {
                for (const [shape, pushes] of shapes(cap)) {
                    for (const off of [0, 1]) {
                        for (const name of METHODS) {
                            const { rb, model } = makeRing(cap, pushes);
                            const n = model.length;
                            const dst = new Kind(off + n + 3);
                            for (let i = 0; i < dst.length; i++) dst[i] = convert(Kind, i + 1);
                            const before = Array.from(dst);
                            for (let call = 0; call < 2; call++) {
                                assert.equal(rb[name](dst, off), n, Kind.name + ' ' + shape);
                                for (let i = 0; i < dst.length; i++) {
                                    const inside = i >= off && i < off + n;
                                    const want = inside ? convert(Kind, model[i - off]) : before[i];
                                    assert.ok(Object.is(dst[i], want),
                                        [Kind.name, cap, shape, off, name, 'slot', i, 'got', dst[i], 'want', want].join(' '));
                                    slotsChecked++;
                                }
                            }
                            for (const v of model) if (!Number.isInteger(v)) nonInt++;
                            cells++;
                        }
                    }
                }
            }
        }
        // coverage floor: every cell ran (kinds x 2 caps x 3 shapes x 2 offsets x 2 methods)
        assert.equal(cells, KINDS.length * 2 * 3 * 2 * 2);
        assert.ok(cells >= 240);
        assert.ok(slotsChecked > 5000, 'slots checked: ' + slotsChecked);
        assert.ok(nonInt > 100, 'non-integer / special samples: ' + nonInt);
    });
});
