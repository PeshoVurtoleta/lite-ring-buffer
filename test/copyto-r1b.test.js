// R1b oracle: copyTo / copyToFast data-buffer cache, reassigned `data`, getter
// reads, `set` routing, full-ring parity, copyToFast error parity, retention.
// Expected values come from the R1b FIX plan ASSERTIONS 1, 2, 3 and 5 and from
// an independent model (Math.fround of what was pushed); never from the build.
// Build under test: RB_BUILD (absolute or package-relative) else ../RingBuffer.js.
// No test reads a cache field by name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The %TypedArray%.prototype.set spy must be live BEFORE the build is imported:
// the build captures the intrinsic at module load.
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
const kindStream = prng(0x51B0C0DE);
const valueStream = prng(0x7E57AB1E);
let specialIdx = 0;
function nextValue() {
    if (kindStream() < 0.5) return SPECIALS[specialIdx++ % SPECIALS.length];
    return (valueStream() * 2 - 1) * 100000;
}
const ceilPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };

function filledRing(requested, pushes) {
    const rb = new RingBuffer(requested);
    for (let i = 0; i < pushes; i++) rb.push(nextValue());
    return rb;
}
function bytesOf(buf) { return new Uint8Array(buf).slice(); }
function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

describe('R1b A1 reassigned data (both methods)', () => {
    // regression pin on the frozen before build (passes there); must fail on a fail-open cache
    it('A1a data replaced by a view of dst: RangeError on 3 calls in a row, dst unchanged', () => {
        const rb = filledRing(64, 100);
        const dst = new Float32Array(64).fill(SENT);
        rb.copyTo(new Float32Array(64), 0); // warm copy into a separate array
        rb.data = new Float32Array(dst.buffer, 0, 64);
        for (const m of ['copyTo', 'copyToFast', 'copyTo']) {
            assert.throws(() => rb[m](dst, 0), (e) => {
                assert.ok(e instanceof RangeError, m + ' want RangeError, got ' + e);
                assert.match(e.message, new RegExp('^LiteRingBuffer: ' + m + ' dst shares'));
                return true;
            });
        }
        for (let i = 0; i < 64; i++) assert.equal(dst[i], SENT);
    });

    it('A1b data replaced by an Array: TypeError on each of 3 calls, dst untouched', () => {
        const rb = filledRing(64, 100);
        const dst = new Float32Array(64).fill(SENT);
        rb.copyTo(new Float32Array(64), 0); // warm copy
        rb.data = Array(64).fill(1);
        for (const m of ['copyTo', 'copyToFast', 'copyTo']) {
            assert.throws(() => rb[m](dst, 0), TypeError, m);
            for (let i = 0; i < 64; i++) assert.equal(dst[i], SENT, m + ' wrote slot ' + i);
        }
    });
});

describe('R1b A2 one getter read, set routing', () => {
    // regression pin on the frozen before build; b93aab2c reads `data` twice
    it('A2a accessor data: exactly one getter call per non-empty copy', () => {
        for (const m of METHODS) {
            for (const cap of [8, 64]) {
                const rb = filledRing(cap, cap + 5);
                const real = rb.data;
                let reads = 0;
                Object.defineProperty(rb, 'data', { get() { reads++; return real; }, configurable: true });
                const dst = new Float32Array(cap);
                for (let k = 1; k <= 3; k++) {
                    rb[m](dst, 0);
                    assert.equal(reads, k, m + ' cap ' + cap + ' after call ' + k);
                }
            }
        }
    });

    // must fail on the frozen before build (router: full rings <= 32 took `set`)
    it('A2b set spy: loop at <= 32, one set above, none for Float64 / partial', () => {
        function setsOf(rb, dst) {
            setCalls = 0;
            rb.copyTo(dst, 0);
            const n = setCalls;
            setCalls = 0;
            return n;
        }
        for (let req = 1; req <= 32; req++) {
            const cap = ceilPow2(req);
            const rb = new RingBuffer(req);
            for (let i = 0; i < cap; i++) rb.push(nextValue());
            for (let h = 0; h < cap; h++) {
                assert.equal(rb.count, cap);
                assert.equal(setsOf(rb, new Float32Array(cap)), 0, 'cap ' + cap + ' head ' + rb.head);
                rb.push(nextValue());
            }
        }
        for (const cap of [64, 128]) {
            const rb = new RingBuffer(cap);
            for (let i = 0; i < cap; i++) rb.push(nextValue());
            for (let h = 0; h < cap; h++) {
                assert.equal(setsOf(rb, new Float32Array(cap)), 1, 'cap ' + cap + ' head ' + rb.head);
                rb.push(nextValue());
            }
        }
        const full64 = filledRing(64, 64 + 9);
        assert.equal(setsOf(full64, new Float64Array(64)), 0, 'Float64 dst');
        const part = filledRing(64, 63);
        assert.equal(part.count, 63);
        assert.equal(setsOf(part, new Float32Array(64)), 0, '63 of 64');
    });
});

describe('R1b A3 full-ring parity and copyToFast errors', () => {
    it('A3a full Float32 rings, every head, offsets 0 and 1, guards intact', () => {
        let cases = 0;
        let want = 0;
        const reqs = [];
        for (let r = 1; r <= 32; r++) reqs.push(r);
        reqs.push(64, 128);
        for (const m of METHODS) {
            for (const req of reqs) {
                const cap = ceilPow2(req);
                want += cap * 2;
                const rb = new RingBuffer(req);
                const model = [];
                for (let i = 0; i < cap; i++) { const v = nextValue(); rb.push(v); model.push(Math.fround(v)); }
                for (let h = 0; h < cap; h++) {
                    assert.equal(rb.head, h);
                    for (const off of [0, 1]) {
                        const back = new Float32Array(cap + 7).fill(SENT);
                        const win = back.subarray(3, 3 + cap + off);
                        const ret = rb[m](win, off);
                        assert.equal(ret, cap, m + ' return');
                        for (let i = 0; i < back.length; i++) {
                            const k = i - 3 - off;
                            const inside = k >= 0 && k < cap;
                            const wantV = inside ? model[k] : SENT;
                            if (!Object.is(back[i], wantV)) {
                                assert.fail(m + ' cap ' + cap + ' head ' + h + ' off ' + off + ' slot ' + i +
                                    ' got ' + back[i] + ' want ' + wantV);
                            }
                        }
                        cases++;
                    }
                    const v = nextValue(); rb.push(v); model.push(Math.fround(v)); model.shift();
                }
            }
        }
        assert.equal(cases, want, 'coverage floor');
        assert.ok(cases >= 2000, 'coverage floor: ' + cases);
    });

    it('A3b copyToFast errors match copyTo (class, message, dst unchanged)', () => {
        const mk = () => filledRing(8, 8);
        const cases = [
            ['{}', () => ({}), 0],
            ['null', () => null, 0],
            ['Array', () => [1, 2, 3, 4, 5, 6, 7, 8], 0],
            ['DataView', () => new DataView(new ArrayBuffer(64)), 0],
            ['BigInt64Array', () => new BigInt64Array(16), 0],
            ['BigUint64Array', () => new BigUint64Array(16), 0],
            ['alias Float32 view', (rb) => new Float32Array(rb.data.buffer, 0, 8), 0],
            ['alias Uint8 view', (rb) => new Uint8Array(rb.data.buffer), 0],
            ['too small', () => new Float32Array(4), 0],
            ['offset -1', () => new Float32Array(16), -1],
            ['offset 0.5', () => new Float32Array(16), 0.5],
            ['offset NaN', () => new Float32Array(16), NaN],
            ['offset string', () => new Float32Array(16), '1'],
        ];
        assert.ok(cases.length >= 12);
        for (const [label, make, off] of cases) {
            const out = {};
            for (const m of METHODS) {
                const rb = mk();
                const dst = make(rb);
                const buf = dst && dst.buffer instanceof ArrayBuffer ? dst.buffer : null;
                const before = buf ? bytesOf(buf) : null;
                try { rb[m](dst, off); out[m] = null; } catch (e) { out[m] = e; }
                assert.ok(out[m] !== null, label + ' ' + m + ' must throw');
                if (buf) assert.ok(sameBytes(before, bytesOf(buf)), label + ' ' + m + ' changed dst');
            }
            assert.equal(out.copyToFast.constructor, out.copyTo.constructor, label + ' class');
            // BigInt dst: the TypeError is V8's own (value-dependent, differs between set and the
            // loop), not a package message -- class only there.
            if (!/^Big/.test(label)) {
                assert.equal(out.copyToFast.message.replace(/copyToFast/g, 'copyTo'), out.copyTo.message, label + ' message');
                // The rewrite above is blind to the method name: pin it (MUT_NAME).
                assert.match(out.copyToFast.message, /copyToFast/, label + ' copyToFast names itself');
            }
        }
    });
});

describe('R1b shape and count-1 alias pins', () => {
    // T-A: the constructor initialises every own property; later steps add none.
    it('own keys are the same after push, copy, data reassignment and destroy', () => {
        const rb = new RingBuffer(8);
        const keys0 = Reflect.ownKeys(rb);
        for (let i = 0; i < 11; i++) rb.push(i + 0.5);
        rb.copyTo(new Float32Array(8), 0);
        rb.copyToFast(new Float32Array(8), 0);
        rb.data = new Float32Array(8);
        rb.copyTo(new Float32Array(8), 0);
        rb.copyToFast(new Float32Array(8), 0);
        rb.destroy();
        assert.deepEqual(Reflect.ownKeys(rb), keys0);
    });

    // T-B: a count-1 ring still alias-checks.
    it('count 1: dst sharing the ring buffer throws RangeError, dst unchanged', () => {
        for (const m of METHODS) {
            const rb = new RingBuffer(8);
            rb.push(1.5);
            assert.equal(rb.count, 1);
            const dst = new Float32Array(rb.data.buffer, 0, 8);
            const before = bytesOf(dst.buffer);
            assert.throws(() => rb[m](dst, 0), (e) => {
                assert.ok(e instanceof RangeError, m + ' want RangeError, got ' + e);
                assert.match(e.message, /dst shares/);
                return true;
            });
            assert.ok(sameBytes(before, bytesOf(dst.buffer)), m + ' changed dst');
        }
    });
});

describe('R1b A5 retention after destroy', () => {
    // regression pin: destroy() must drop the old data AND its buffer from every own property
    it('after warm copy + destroy no own value is the old data or its buffer', () => {
        for (const m of METHODS) {
            for (const cap of [8, 64]) {
                const rb = filledRing(cap, cap + 5);
                rb[m](new Float32Array(cap), 0); // warm: populates any cache
                const oldData = rb.data;
                const oldBuf = oldData.buffer;
                rb.destroy();
                for (const k of Reflect.ownKeys(rb)) {
                    const d = Object.getOwnPropertyDescriptor(rb, k);
                    if (!('value' in d)) continue;
                    assert.notEqual(d.value, oldData, m + ' cap ' + cap + ' key ' + String(k) + ' holds old data');
                    assert.notEqual(d.value, oldBuf, m + ' cap ' + cap + ' key ' + String(k) + ' holds old buffer');
                }
            }
        }
    });
});
