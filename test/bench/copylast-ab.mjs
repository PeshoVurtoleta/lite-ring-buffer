// copylast-ab.mjs -- `npm run bench:copylast`: the copyLast timed A/B (copyLast vs a caller's copyTo + loop, and
// copyLast(count) vs copyTo).
// Tier: STATISTICAL, dev-only. Never part of `npm test` / `npm run verify`; a release-gating run holds the
// strict quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-ring-buffer R3 strict" -- \
//        npm run bench:copylast -- --cand FILE --out DIR
//
//   node test/bench/copylast-ab.mjs --out DIR [--cand FILE] [--ref-rev REF]
//        [--kinds caller,parity] [--no-f64] [--K 21] [--comp 3] [--control box|aa] [--keep]
//   node test/bench/copylast-ab.mjs --self-test
//
// Sides (each printed with commit + sha256/8 + clean/MODIFIED vs HEAD:RingBuffer.js): cand = a copy of the live
// RingBuffer.js or --cand FILE (every timed call runs on it); ref = git show REF:RingBuffer.js (default HEAD),
// the oracle reference (the last k of its `copyTo`) only. Both are staged into a fresh mkdtemp dir (prefix
// lrb-copylast-ab-) as ref/RingBuffer.mjs and cand/RingBuffer.mjs (two module instances); the dir is removed on
// exit unless --keep. A cand without copyLast exits 1 before any probe spawn (not 2: 2 reads as PENDING under
// quiet-lock).
// Configs (14 by default, compilation-major, each x dst {f32, f64} unless --no-f64), every ring full:
//   caller  1024 ring, n 120 at head 0 / 60, n 512 at head 0 / 256   (BASE = callerCopy: copyTo into a
//           Float32Array(cap) scratch, then a loop over its last n)
//   parity  32 ring head 13, 1024 ring head 0 / 768, n = capacity     (BASE = rb.copyTo)
// each x --comp compilations, a fresh `node --allow-natives-syntax --expose-gc test/bench/copylast-probe.mjs`
// process per config per compilation.
// Statistic: per config, type-7 median and [Q1..Q3] of the K x comp paired per-round ratios CAND/BASE,
// AA_CAND = CAND_AA/CAND, AA_BASE = BASE_AA/BASE (the reference twin, LEDGER D12 (3)), SLOW/CAND;
// per-compilation CAND/BASE medians.
// Label (REPORTED): FASTER (CAND/BASE Q3 < 1.00) / SLOWER (Q1 > 1.00) / TIE. A label never moves the exit.
// Claim rule (caller rows only; parity rows are REPORTED, Q-R3-PARGAP A): CLAIM(n, dst) holds only if the run
//   exits 0, both layouts (heads) of (n, dst) are FASTER and all per-compilation CAND/BASE medians of both are
//   < 1.00 (all --comp of them present). "Nx faster": N = min over the two layouts of 1/Q3, rounded down to 0.1.
//   Docs quote 1/median with IQR [1/Q3..1/Q1]. No claim -> no speed sentence.
// Exit 1 (VOID): a probe crashed, a compilation is missing or has not exactly K rounds, the oracle failed on
//   any of the 5 timed columns (before or after timing), MUT_OBO, MUT_OLDEST or MUT_NEGZERO not caught (before
//   or after timing), uniqueSrc false, TurboFan calibration or a driver not TurboFan, BASE / BASE_AA / CAND /
//   CAND_AA / SLOW B/op not inside (-8, 8), BOX B/op outside 12..20, CAND/BASE not measured (NaN, LEDGER C13),
//   a cand without copyLast (or not importable), or a red self-test.
// Exit 2: host not 'quiet' (QUIET_LOCK_HOST from quiet-lock.mjs), an A/A median outside 0.93..1.07 (a NaN A/A
//   is outside), SLOW/CAND not (median >= 1.5 and Q1 >= 1.3), or a usage / git / staging error.  Else 0.
// The judge is pure; NaN (and a JSON null) fails every comparison. --self-test runs its synthetic cases;
// every real run runs them first, before any spawn.
// Writes DIR/ab.json and DIR/ab.md (DIR must be new or empty). Test tooling only: not shipped.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PROBE = join(HERE, 'copylast-probe.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const PROBE_TIMEOUT_MS = 900000;

// ---- judge constants ----------------------------------------------------------------------------------
const BOP_MAX = 8;            // half a 16 B box: every timed lane must read below it
const BOX_LO = 12;            // one HeapNumber per call (16 B on Node) -> 12..20
const BOX_HI = 20;
const AA_LO = 0.93;
const AA_HI = 1.07;
const SLOW_MED_MIN = 1.5;
const SLOW_Q1_MIN = 1.3;
const TIMED = ['BASE', 'BASE_AA', 'CAND', 'CAND_AA', 'SLOW'];
const ZERO_BOP_LANES = TIMED;
const KINDS = ['caller', 'parity'];
// [kind, cap, head, n]; n = capacity on parity rows (ring full: copyLast(count) vs copyTo)
const CELLS = [
    ['caller', 1024, 0, 120], ['caller', 1024, 60, 120], ['caller', 1024, 0, 512], ['caller', 1024, 256, 512],
    ['parity', 32, 13, 32], ['parity', 1024, 0, 1024], ['parity', 1024, 768, 1024],
];

function die(msg) {
    process.stderr.write('copylast-ab: ' + msg + '\ncopylast-ab: exit 2 (usage / git / staging)\n');
    process.exit(2);
}
function voidExit(msg) {
    process.stderr.write('copylast-ab: ' + msg + '\ncopylast-ab: exit 1 (VOID, no probe spawned)\n');
    process.exit(1);
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
// JSON turns NaN into null; a non-number is NaN here, so it fails every comparison below.
const num = (x) => (typeof x === 'number' ? x : NaN);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// type-7 quantile; any NaN in the sample -> NaN
function q(arr, p) {
    if (!arr.length || arr.some((x) => Number.isNaN(x))) return NaN;
    const a = [...arr].sort((x, y) => x - y);
    const h = (a.length - 1) * p, lo = Math.floor(h);
    return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (h - lo);
}
const stat = (v) => ({ med: q(v, 0.5), q1: q(v, 0.25), q3: q(v, 0.75) });
// the single FASTER test (label and claim share it); NaN -> false
const faster = (s) => s.q3 < 1;

// ---- the judge (pure) ---------------------------------------------------------------------------------
// input: { configs: [{kind, cap, head, n, dst}], runs: [[probe JSON, ...] per config], comp, K, host, crashed }
const tagOf = (r) => r.kind + ' ' + r.cap + '/h' + r.head + '/n' + r.n + '/' + r.dst;
function judgeRow(cfg, rs, comp, K) {
    const roundsOf = (r) => (Array.isArray(r.rounds) ? r.rounds : []);
    const pooled = (fn) => rs.flatMap((r) => roundsOf(r).map(fn));
    const ratio = {
        CAND_BASE: pooled((x) => num(x.CAND) / num(x.BASE)),
        AA_CAND: pooled((x) => num(x.CAND_AA) / num(x.CAND)),
        AA_BASE: pooled((x) => num(x.BASE_AA) / num(x.BASE)),
        SLOW_CAND: pooled((x) => num(x.SLOW) / num(x.CAND)),
    };
    const st = Object.fromEntries(Object.entries(ratio).map(([k, v]) => [k, stat(v)]));
    const ns = Object.fromEntries(TIMED.map((k) => [k, q(pooled((x) => num(x[k])), 0.5)]));
    const perComp = rs.map((r) => q(roundsOf(r).map((x) => num(x.CAND) / num(x.BASE)), 0.5));
    const lanes = TIMED.concat(['BOX']);
    const bop = Object.fromEntries(lanes.map((k) => [k, rs.map((r) => num(r.bop && r.bop[k]))]));
    const ck = (r) => r.checks || {};
    const v = [];
    if (rs.length !== comp) v.push('only ' + rs.length + '/' + comp + ' compilations');
    if (!rs.every((r) => Array.isArray(r.rounds) && r.rounds.length === K)) v.push('a compilation without exactly ' + K + ' rounds');
    if (!rs.every((r) => ck(r).tfCalib === true)) v.push('TurboFan bit 32 calibration');
    if (!rs.every((r) => ck(r).uniqueSrc === true)) v.push('uniqueSrc (two columns share source text)');
    for (const when of ['oracle', 'oracleAfter']) {
        if (!rs.every((r) => ck(r)[when] && TIMED.every((k) => ck(r)[when][k] === true))) v.push(when === 'oracle' ? 'oracle before timing' : 'oracle after timing');
    }
    for (const [key, nm] of [['mutObo', 'MUT_OBO'], ['mutOldest', 'MUT_OLDEST'], ['mutNegZero', 'MUT_NEGZERO']]) {
        if (!rs.every((r) => ck(r)[key] && ck(r)[key].before === true && ck(r)[key].after === true)) v.push(nm + ' not caught');
    }
    if (!rs.every((r) => ck(r).turbofan === true)) v.push('driver not TurboFan');
    for (const k of ZERO_BOP_LANES) {
        const bad = bop[k].filter((b) => !(b < BOP_MAX && b > -BOP_MAX));
        if (bad.length) v.push(k + ' B/op ' + bad.map((b) => f(b)).join(',') + ' not inside (-' + BOP_MAX + ', ' + BOP_MAX + ')');
    }
    const badBox = bop.BOX.filter((b) => !(b >= BOX_LO && b <= BOX_HI));
    if (badBox.length) v.push('BOX B/op ' + badBox.map((b) => f(b)).join(',') + ' outside ' + BOX_LO + '..' + BOX_HI + ' (control)');
    if (!(st.CAND_BASE.q1 <= st.CAND_BASE.q3)) v.push('CAND_BASE not measured (NaN)');
    const b = [];
    for (const k of ['AA_CAND', 'AA_BASE']) {
        if (!(st[k].med >= AA_LO && st[k].med <= AA_HI)) b.push('A/A ' + k + ' ' + f(st[k].med, 4) + ' outside ' + AA_LO + '..' + AA_HI);
    }
    if (!(st.SLOW_CAND.med >= SLOW_MED_MIN && st.SLOW_CAND.q1 >= SLOW_Q1_MIN)) b.push('SLOW ' + f(st.SLOW_CAND.med) + ' q1 ' + f(st.SLOW_CAND.q1));
    const r = st.CAND_BASE;
    const label = faster(r) ? 'FASTER' : r.q1 > 1 ? 'SLOWER' : (r.q1 <= 1 && r.q3 >= 1) ? 'TIE' : 'n/a';
    const verdict = v.length ? 'VOID' : b.length ? 'INCONCLUSIVE' : label;
    return { ...cfg, verdict, label, reported: cfg.kind === 'parity', st, ns, perComp, bop, voidWhy: v, bandWhy: b };
}
// the claim rule (caller rows only; parity rows never claim)
function claimsOf(rows, exit, comp) {
    const groups = [];
    for (const r of rows) {
        if (r.kind !== 'caller') continue;
        let g = groups.find((x) => x.n === r.n && x.dst === r.dst);
        if (!g) { g = { n: r.n, dst: r.dst, rows: [] }; groups.push(g); }
        g.rows.push(r);
    }
    return groups.map((g) => {
        const why = [];
        if (exit !== 0) why.push('run exit ' + exit);
        if (g.rows.length !== 2) why.push(g.rows.length + '/2 layouts');
        for (const r of g.rows) {
            if (!faster(r.st.CAND_BASE)) why.push('h' + r.head + ' not FASTER (Q3 ' + f(r.st.CAND_BASE.q3, 3) + ')');
            if (!(r.perComp.length === comp && r.perComp.every((m) => m < 1))) why.push('h' + r.head + ' per-comp medians ' + r.perComp.map((m) => f(m, 3)).join('/'));
        }
        const claim = why.length === 0;
        let maxQ3 = NaN;
        for (const r of g.rows) { const x = r.st.CAND_BASE.q3; if (!(x <= maxQ3)) maxQ3 = x; }
        const N = claim ? Math.floor(10 / maxQ3) / 10 : NaN;
        const quote = g.rows.map((r) => ({ head: r.head, x: 1 / r.st.CAND_BASE.med, lo: 1 / r.st.CAND_BASE.q3, hi: 1 / r.st.CAND_BASE.q1 }));
        return { n: g.n, dst: g.dst, claim, N, quote, why };
    });
}
function judge(input) {
    const rows = input.configs.map((cfg, i) => judgeRow(cfg, input.runs[i] || [], input.comp, input.K));
    const voidHit = input.crashed > 0 || rows.some((r) => r.voidWhy.length > 0);
    const bandHit = rows.some((r) => r.bandWhy.length > 0);
    const quiet = input.host === 'quiet';
    const exit = voidHit ? 1 : (!quiet || bandHit) ? 2 : 0;
    const why = [];
    if (input.crashed > 0) why.push(input.crashed + ' probe crash(es)');
    for (const r of rows) {
        for (const w of r.voidWhy) why.push('VOID ' + tagOf(r) + ': ' + w);
        for (const w of r.bandWhy) why.push('BAND ' + tagOf(r) + ': ' + w);
    }
    if (!quiet) why.push('HOST ' + String(input.host) + ' (not quiet): no verdict');
    return { exit, rows, why, claims: claimsOf(rows, exit, input.comp) };
}

// ---- self-test: synthetic cases on both sides of every boundary, a NaN per column ----------------------
// o.ratio: 7 CAND/BASE multipliers per run; a multiplier of exactly 1 gives a ratio of exactly 1.
function synthRun(cfg, o = {}) {
    const rounds = [];
    for (let k = 0; k < 7; k++) {
        const j = (k - 3) * 0.001;
        const BASE = 100 * (1 + j);
        const CAND = BASE * (o.ratio ? o.ratio[k] : 0.5);
        const row = { BASE, BASE_AA: BASE * (o.aaB ?? 1), CAND, CAND_AA: CAND * (o.aaC ?? 1), SLOW: CAND * (o.slow ?? 2) };
        if (k < 2 && o.slowLow !== undefined) row.SLOW = CAND * o.slowLow;
        if (o.roundNaN && k === 0) row[o.roundNaN] = NaN;
        rounds.push(row);
    }
    const bop = { BASE: 0, BASE_AA: 0, CAND: 0, CAND_AA: 0, SLOW: 0, BOX: 16 };
    Object.assign(bop, o.bop || {});
    const all = () => Object.fromEntries(TIMED.map((k) => [k, true]));
    const checks = {
        tfCalib: true, uniqueSrc: true, turbofan: true, oracle: all(), oracleAfter: all(),
        mutObo: { before: true, after: true }, mutOldest: { before: true, after: true }, mutNegZero: { before: true, after: true },
    };
    if (o.checks) o.checks(checks);
    return { ...cfg, rounds, bop, checks, copyToSrcSame: true };
}
function selfTest() {
    const C = { kind: 'caller', cap: 1024, head: 0, n: 120, dst: 'f32' };
    const C2 = { kind: 'caller', cap: 1024, head: 60, n: 120, dst: 'f32' };
    const D = { kind: 'caller', cap: 1024, head: 256, n: 512, dst: 'f64' };
    const P = { kind: 'parity', cap: 1024, head: 768, n: 1024, dst: 'f32' };
    // extra.run2 edits the second compilation only (the first stays well-formed)
    const one = (cfg, o, extra = {}) => {
        const r2 = synthRun(cfg, o);
        if (extra.run2) extra.run2(r2);
        return judge({
            configs: [cfg], runs: [[synthRun(cfg, o), r2]], K: 7,
            comp: extra.comp ?? 2, host: 'host' in extra ? extra.host : 'quiet', crashed: extra.crashed ?? 0,
        });
    };
    // claim cases: both layouts of caller (n 120, f32), 3 compilations each; oc[i] edits compilation i only
    const pair = (oA, oB, extra = {}) => {
        const mk = (cfg, o, oc) => [0, 1, 2].map((i) => synthRun(cfg, (oc && oc[i]) || o));
        const configs = [C, C2].slice(0, extra.layouts ?? 2);
        const runs = [mk(C, oA, extra.ocA), mk(C2, oB, extra.ocB)].slice(0, configs.length);
        return judge({ configs, runs, K: 7, comp: 3, host: 'host' in extra ? extra.host : 'quiet', crashed: extra.crashed ?? 0 });
    };
    const Q999 = { ratio: [0.99, 0.99, 0.99, 0.995, 0.999, 0.999, 1.2] };
    const Q1000 = { ratio: [0.99, 0.99, 0.99, 0.995, 1, 1, 1.2] };
    const HALF = { ratio: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] };
    const MED1 = { ratio: [0.5, 0.5, 0.5, 1, 1, 1, 1] };
    const claim0 = (J) => J.claims[0] || { claim: 'absent', N: NaN };
    // [name, want exit, fn, check (optional: J -> true or a reason string)]
    const label = (want) => (J) => J.rows[0].label === want || 'label ' + J.rows[0].label;
    const noClaim = (J) => J.claims.every((c) => c.claim === false) || 'claim ' + JSON.stringify(J.claims.map((c) => c.claim));
    const cases = [
        ['baseline quiet -> 0 FASTER', 0, () => one(C, {}), label('FASTER')],
        ['baseline f64 n512 -> 0', 0, () => one(D, {})],
        ['baseline parity -> 0', 0, () => one(P, {})],
        ['Q3 0.999 -> FASTER', 0, () => one(C, Q999), label('FASTER')],
        ['Q3 1.000 -> TIE', 0, () => one(C, Q1000), label('TIE')],
        ['Q1 1.001 -> SLOWER', 0, () => one(C, { ratio: [0.8, 1.001, 1.001, 1.01, 1.02, 1.03, 1.04] }), label('SLOWER')],
        ['Q1 1.000 -> TIE', 0, () => one(C, { ratio: [0.8, 1, 1, 1.01, 1.02, 1.03, 1.04] }), label('TIE')],
        ['parity SLOWER row (REPORTED) -> 0, no claim', 0, () => one(P, { ratio: [1.5, 1.5, 1.5, 1.6, 1.7, 1.7, 1.8] }),
            (J) => (J.rows[0].label === 'SLOWER' && J.rows[0].reported === true && J.claims.length === 0) || 'label ' + J.rows[0].label + ' claims ' + J.claims.length],
        ['parity FASTER row -> 0, no claim', 0, () => one(P, HALF), (J) => J.claims.length === 0 || 'claims ' + J.claims.length],
        ['claim: Q3 0.999 both layouts -> CLAIM N 1.0', 0, () => pair(Q999, Q999),
            (J) => (claim0(J).claim === true && claim0(J).N === 1) || 'claim ' + claim0(J).claim + ' N ' + claim0(J).N],
        ['claim: ratio 0.24 / 0.5 -> CLAIM N 2.0 (min over layouts)', 0, () => pair({ ratio: Array(7).fill(0.24) }, HALF),
            (J) => (claim0(J).claim === true && claim0(J).N === 2) || 'claim ' + claim0(J).claim + ' N ' + claim0(J).N],
        ['claim: ratio 0.24 both -> CLAIM N 4.1 (rounded down)', 0, () => pair({ ratio: Array(7).fill(0.24) }, { ratio: Array(7).fill(0.24) }),
            (J) => (claim0(J).claim === true && claim0(J).N === 4.1) || 'claim ' + claim0(J).claim + ' N ' + claim0(J).N],
        ['claim: one layout Q3 1.000 -> no claim', 0, () => pair(Q999, Q1000), noClaim],
        ['claim: one per-comp median 1.000 (pooled Q3 < 1) -> no claim', 0, () => pair(HALF, HALF, { ocB: [null, null, MED1] }),
            (J) => (faster(J.rows[1].st.CAND_BASE) ? noClaim(J) : 'precondition: pooled Q3 ' + J.rows[1].st.CAND_BASE.q3 + ' not < 1')],
        ['claim: per-comp median NaN -> no claim', 1, () => pair(HALF, HALF, { ocA: [{ ...HALF, roundNaN: 'CAND' }] }), noClaim],
        ['claim: one layout only -> no claim', 0, () => pair(HALF, HALF, { layouts: 1 }), noClaim],
        ['claim: host preliminary -> 2, no claim', 2, () => pair(HALF, HALF, { host: 'preliminary' }), noClaim],
        ['claim: band (A/A) -> 2, no claim', 2, () => pair(HALF, { ...HALF, aaC: 1.2 }), noClaim],
        ['claim: VOID (BOX) -> 1, no claim', 1, () => pair(HALF, { ...HALF, bop: { BOX: 0 } }), noClaim],
        ['host preliminary -> 2', 2, () => one(C, {}, { host: 'preliminary' })],
        ['host unlocked -> 2', 2, () => one(C, {}, { host: 'unlocked' })],
        ['host undefined -> 2', 2, () => one(C, {}, { host: undefined })],
        ['AA_CAND 0.93 in -> 0', 0, () => one(C, { aaC: 0.9301 })],
        ['AA_CAND 0.929 out -> 2', 2, () => one(C, { aaC: 0.929 })],
        ['AA_CAND 1.07 in -> 0', 0, () => one(C, { aaC: 1.0699 })],
        ['AA_CAND 1.071 out -> 2', 2, () => one(C, { aaC: 1.071 })],
        ['AA_BASE 0.93 in -> 0', 0, () => one(C, { aaB: 0.9301 })],
        ['AA_BASE 0.929 out -> 2', 2, () => one(C, { aaB: 0.929 })],
        ['AA_BASE 1.07 in -> 0', 0, () => one(C, { aaB: 1.0699 })],
        ['AA_BASE 1.071 out -> 2', 2, () => one(C, { aaB: 1.071 })],
        ['parity AA_BASE 0.92 out -> 2', 2, () => one(P, { aaB: 0.92 })],
        ['SLOW med 1.5 -> 0', 0, () => one(C, { slow: 1.5005 })],
        ['SLOW med 1.49 -> 2', 2, () => one(C, { slow: 1.49 })],
        ['SLOW q1 1.3 in -> 0', 0, () => one(C, { slow: 2, slowLow: 1.31 })],
        ['SLOW q1 1.29 out -> 2', 2, () => one(C, { slow: 1.6, slowLow: 1.0 })],
        ['BASE NaN round -> 1', 1, () => one(C, { roundNaN: 'BASE' })],
        ['CAND NaN round -> 1', 1, () => one(C, { roundNaN: 'CAND' })],
        ['BASE_AA NaN round -> 2', 2, () => one(C, { roundNaN: 'BASE_AA' })],
        ['CAND_AA NaN round -> 2', 2, () => one(C, { roundNaN: 'CAND_AA' })],
        ['SLOW NaN round -> 2', 2, () => one(C, { roundNaN: 'SLOW' })],
        ['parity CAND NaN round -> 1', 1, () => one(P, { roundNaN: 'CAND' })],
        ['BASE B/op 7.99 -> 0', 0, () => one(C, { bop: { BASE: 7.99 } })],
        ['BASE B/op 8 -> 1', 1, () => one(C, { bop: { BASE: 8 } })],
        ['BASE_AA B/op 8 -> 1', 1, () => one(C, { bop: { BASE_AA: 8 } })],
        ['CAND B/op 7.99 -> 0', 0, () => one(C, { bop: { CAND: 7.99 } })],
        ['CAND B/op 8 -> 1', 1, () => one(C, { bop: { CAND: 8 } })],
        ['CAND B/op -7.99 -> 0', 0, () => one(C, { bop: { CAND: -7.99 } })],
        ['CAND B/op -8 -> 1', 1, () => one(C, { bop: { CAND: -8 } })],
        ['CAND B/op NaN -> 1', 1, () => one(C, { bop: { CAND: NaN } })],
        ['CAND B/op null (JSON NaN) -> 1', 1, () => one(C, { bop: { CAND: null } })],
        ['CAND_AA B/op 8 -> 1', 1, () => one(C, { bop: { CAND_AA: 8 } })],
        ['SLOW B/op 8.01 -> 1', 1, () => one(C, { bop: { SLOW: 8.01 } })],
        ['SLOW B/op NaN -> 1', 1, () => one(C, { bop: { SLOW: NaN } })],
        ['parity BASE B/op 8 -> 1', 1, () => one(P, { bop: { BASE: 8 } })],
        ['BOX 12 in -> 0', 0, () => one(C, { bop: { BOX: 12 } })],
        ['BOX 11.99 out -> 1', 1, () => one(C, { bop: { BOX: 11.99 } })],
        ['BOX 20 in -> 0', 0, () => one(C, { bop: { BOX: 20 } })],
        ['BOX 20.01 out -> 1', 1, () => one(C, { bop: { BOX: 20.01 } })],
        ['BOX null (JSON NaN) -> 1', 1, () => one(C, { bop: { BOX: null } })],
        ['oracle BASE false -> 1', 1, () => one(C, { checks: (c) => { c.oracle.BASE = false; } })],
        ['oracle CAND false -> 1', 1, () => one(C, { checks: (c) => { c.oracle.CAND = false; } })],
        ['oracle SLOW missing -> 1', 1, () => one(C, { checks: (c) => { delete c.oracle.SLOW; } })],
        ['oracleAfter CAND_AA false -> 1', 1, () => one(D, { checks: (c) => { c.oracleAfter.CAND_AA = false; } })],
        ['oracleAfter BASE_AA false -> 1', 1, () => one(P, { checks: (c) => { c.oracleAfter.BASE_AA = false; } })],
        ['MUT_OBO missed before -> 1', 1, () => one(C, { checks: (c) => { c.mutObo.before = false; } })],
        ['MUT_OBO missed after -> 1', 1, () => one(C, { checks: (c) => { c.mutObo.after = false; } })],
        ['MUT_OLDEST missed before -> 1', 1, () => one(C, { checks: (c) => { c.mutOldest.before = false; } })],
        ['MUT_OLDEST missed after -> 1', 1, () => one(P, { checks: (c) => { c.mutOldest.after = false; } })],
        ['MUT_OLDEST missing (mutHead given) -> 1', 1, () => one(C, { checks: (c) => { c.mutHead = c.mutOldest; delete c.mutOldest; } })],
        ['MUT_NEGZERO missed before -> 1', 1, () => one(C, { checks: (c) => { c.mutNegZero.before = false; } })],
        ['MUT_NEGZERO missed after -> 1', 1, () => one(D, { checks: (c) => { c.mutNegZero.after = false; } })],
        ['MUT_NEGZERO missing -> 1', 1, () => one(C, { checks: (c) => { delete c.mutNegZero; } })],
        ['compilation with rounds [] -> 1', 1, () => one(C, {}, { run2: (r) => { r.rounds = []; } })],
        ['compilation with 1 round -> 1', 1, () => one(C, {}, { run2: (r) => { r.rounds = r.rounds.slice(0, 1); } })],
        ['compilation with rounds undefined -> 1', 1, () => one(C, {}, { run2: (r) => { delete r.rounds; } })],
        ['uniqueSrc false -> 1', 1, () => one(C, { checks: (c) => { c.uniqueSrc = false; } })],
        ['turbofan false -> 1', 1, () => one(C, { checks: (c) => { c.turbofan = false; } })],
        ['tfCalib false -> 1', 1, () => one(C, { checks: (c) => { c.tfCalib = false; } })],
        ['tfCalib missing -> 1', 1, () => one(C, { checks: (c) => { delete c.tfCalib; } })],
        ['missing compilation -> 1', 1, () => one(C, {}, { comp: 3 })],
        ['probe crash -> 1', 1, () => one(C, {}, { crashed: 1 })],
        ['void beats host -> 1', 1, () => one(C, { bop: { CAND: 16 } }, { host: 'preliminary' })],
        ['void beats band -> 1', 1, () => one(C, { aaC: 2, bop: { CAND: 16 } })],
    ];
    // --K is one canonical-integer rule here and in copylast-probe.mjs (CANON_INT, same text as compare.mjs).
    // The source rows read the files; the selfTest body is cut out first so its own literals never match.
    const okIf = (b) => ({ exit: b === true ? 0 : 1 });
    const canonLine = 'const CANON_INT = /' + CANON_INT.source + '/;';
    const count = (s, t) => s.split(t).length - 1;
    cases.push(['driver --K: one CANON_INT line, CANON_INT.test(K), no other .test(K)', 0, () => {
        const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
        const st = String(selfTest);
        if (count(own, st) !== 1) return okIf(false);
        const body = own.replace(st, '');
        return okIf(CANON_INT.source === '^(?:0|[1-9][0-9]*)$' &&
            body.split('\n').filter((l) => l === canonLine).length === 1 &&
            count(body, 'CANON_INT.test(K)') === 1 && count(body, '.test(K)') === 1);
    }]);
    cases.push(['copylast-probe.mjs --K: one CANON_INT line, CANON_INT.test(--K), no other --K test', 0, () => {
        const src = readFileSync(PROBE, 'utf8');
        return okIf(src.split('\n').filter((l) => l === canonLine).length === 1 &&
            count(src, "CANON_INT.test(opt['--K'] ?? '21')") === 1 && count(src, ".test(opt['--K']") === 1);
    }]);
    cases.push(['CANON_INT rejects 021 0021 +21 21.0 2e1 " 21" "", accepts 0 5 21 1001', 0, () => okIf(
        ['021', '0021', '+21', '21.0', '2e1', ' 21', ''].every((s) => !CANON_INT.test(s)) &&
        ['0', '5', '21', '1001'].every((s) => CANON_INT.test(s)))]);
    let pass = 0;
    const lines = [];
    for (const [name, want, fn, check] of cases) {
        let got;
        try {
            const J = fn();
            got = J.exit;
            if (got === want && check !== undefined) {
                const c = check(J);
                if (c !== true) got = String(c);
            }
        } catch (e) { got = 'throw ' + e.message; }
        const ok = got === want;
        if (ok) pass++;
        lines.push((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' (got ' + got + ')'));
    }
    // statistic sanity: type-7 on 1..5
    const qs = [q([5, 1, 3, 2, 4], 0.25), q([5, 1, 3, 2, 4], 0.5), q([1, 2, 3, 4], 0.5)];
    const qok = qs[0] === 2 && qs[1] === 3 && qs[2] === 2.5 && Number.isNaN(q([1, NaN], 0.5)) && Number.isNaN(q([NaN, 1, 2, 3, 4, 5, 6], 0.5)) && Number.isNaN(q([], 0.5));
    lines.push((qok ? 'ok   ' : 'FAIL ') + 'type-7 quantile + NaN');
    if (qok) pass++;
    const total = cases.length + 1;
    return { ok: pass === total, pass, total, lines };
}

// ---- options ------------------------------------------------------------------------------------------
const VALUE_OPTS = ['--out', '--cand', '--ref-rev', '--kinds', '--K', '--comp', '--control'];
const FLAG_OPTS = ['--no-f64', '--keep', '--self-test'];
// canonical decimal integer: no sign, no leading zero, no exponent, no fraction (same text as compare.mjs's CANON_INT)
const CANON_INT = /^(?:0|[1-9][0-9]*)$/;
function lev(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return d[a.length][b.length];
}
const opt = Object.create(null);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!VALUE_OPTS.includes(a) && !FLAG_OPTS.includes(a)) {
        let best = VALUE_OPTS[0];
        for (const o of VALUE_OPTS.concat(FLAG_OPTS)) if (lev(a, o) < lev(a, best)) best = o;
        die('unknown argument ' + JSON.stringify(a) + ' (did you mean ' + best + '?)');
    }
    if (a in opt) die(a + ' given twice');
    if (FLAG_OPTS.includes(a)) { opt[a] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) die(a + ' needs a value');
    opt[a] = v;
    i++;
}

// self-test first, always, before any spawn
const ST = selfTest();
if (opt['--self-test'] === true) {
    for (const l of ST.lines) process.stdout.write(l + '\n');
    process.stdout.write('copylast-ab self-test: ' + ST.pass + '/' + ST.total + ' checks ' + (ST.ok ? 'ok' : 'FAILED') + '\n');
    process.exit(ST.ok ? 0 : 1);
}
if (!ST.ok) {
    for (const l of ST.lines) if (l.startsWith('FAIL')) process.stderr.write(l + '\n');
    process.stderr.write('copylast-ab: self-test red (' + ST.pass + '/' + ST.total + '): exit 1\n');
    process.exit(1);
}
process.stdout.write('copylast-ab self-test: ' + ST.pass + '/' + ST.total + ' checks ok\n');

if (!('--out' in opt)) die('--out DIR is required (a new or empty dir for ab.json / ab.md)');
const KIND_LIST = String(opt['--kinds'] ?? 'caller,parity').split(',');
for (let k = 0; k < KIND_LIST.length; k++) {
    const s = KIND_LIST[k];
    if (!KINDS.includes(s)) die('--kinds: ' + JSON.stringify(s) + ' is not one of ' + KINDS.join(','));
    if (KIND_LIST.indexOf(s) !== k) die('--kinds: ' + s + ' given twice');
}
const K = opt['--K'] ?? '21';
if (!CANON_INT.test(K) || !(Number(K) >= 5 && Number(K) <= 1001)) die('--K: want a canonical integer 5..1001');
const COMP_S = opt['--comp'] ?? '3';
if (!/^[0-9]+$/.test(COMP_S) || !(Number(COMP_S) >= 1 && Number(COMP_S) <= 10)) die('--comp: want an integer 1..10');
const COMP = Number(COMP_S);
const CONTROL = opt['--control'] ?? '';
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'aa') die('--control: box or aa');
const NO_F64 = opt['--no-f64'] === true;
const KEEP = opt['--keep'] === true;
const OUT = resolve(opt['--out']);
if (existsSync(OUT) && (!statSync(OUT).isDirectory() || readdirSync(OUT).length > 0)) die('--out must be a new or empty dir: ' + OUT);
if (!isFile(PROBE)) die('probe missing: ' + PROBE);

// ---- git + sides --------------------------------------------------------------------------------------
function git(args) {
    const r = spawnSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 << 20, timeout: 60000, killSignal: 'SIGKILL' });
    if (r.error) die('git ' + args.join(' ') + ': ' + r.error.message);
    if (r.status !== 0 || r.signal !== null) die('git ' + args.join(' ') + ' exited ' + r.status + ': ' + String(r.stderr).trim());
    return r.stdout;
}
const headFull = String(git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
if (!/^[0-9a-f]{40,64}$/.test(headFull)) die('cannot resolve HEAD');
const headSha = sha(git(['show', headFull + ':RingBuffer.js']));
const vsHead = (src) => '(HEAD ' + headFull.slice(0, 7) + ', ' + (sha(src) === headSha ? 'clean' : 'MODIFIED') + ')';
let cand;
if ('--cand' in opt) {
    const p = resolve(opt['--cand']);
    if (!isFile(p)) die('--cand not found: ' + p);
    const src = readFileSync(p);
    cand = { src, name: 'file ' + p + ' ' + vsHead(src) };
} else {
    if (!isFile(LIVE)) die('live RingBuffer.js missing: ' + LIVE);
    const src = readFileSync(LIVE);
    cand = { src, name: 'worktree RingBuffer.js ' + vsHead(src) };
}
const refRev = opt['--ref-rev'] ?? 'HEAD';
const refCommit = String(git(['rev-parse', '--verify', '--quiet', refRev + '^{commit}'])).trim();
if (!/^[0-9a-f]{40,64}$/.test(refCommit)) die('cannot resolve --ref-rev ' + refRev);
const refSrc = git(['show', refCommit + ':RingBuffer.js']);
const ref = { src: refSrc, name: 'git ' + refRev + ' = commit ' + refCommit.slice(0, 7) + ':RingBuffer.js ' + vsHead(refSrc) };
if (ref.src.length === 0 || cand.src.length === 0) die('a side is empty');

// ---- stage ----------------------------------------------------------------------------------------------
const work = mkdtempSync(join(os.tmpdir(), 'lrb-copylast-ab-'));
if (!KEEP) process.on('exit', () => { rmSync(work, { recursive: true, force: true }); });
const sides = { ref, cand };
for (const key of ['ref', 'cand']) {
    const s = sides[key];
    mkdirSync(join(work, key));
    s.path = join(work, key, 'RingBuffer.mjs');
    writeFileSync(s.path, s.src);
    s.sha8 = sha(s.src).slice(0, 8);
    if (sha(readFileSync(s.path)) !== sha(s.src)) die('staging ' + key + ' did not round-trip');
    process.stdout.write('side ' + key.padEnd(4) + ' sha256/8 ' + s.sha8 + '  ' + s.name + '\n');
}
process.stdout.write('work ' + work + (KEEP ? ' (kept)' : ' (removed on exit; --keep keeps it)') + '\n');
// a cand without copyLast: exit 1 (VOID) before any probe spawn
let candRB;
try { candRB = (await import(pathToFileURL(cand.path).href)).RingBuffer; } catch (e) { voidExit('cannot import the staged cand (no copyLast): ' + e.message); }
if (typeof candRB !== 'function' || typeof candRB.prototype.copyLast !== 'function') voidExit('cand has no copyLast (RingBuffer.prototype.copyLast): ' + cand.name);
try { mkdirSync(OUT, { recursive: true }); } catch (e) { die('--out: cannot create ' + OUT + ': ' + e.message); }

// ---- run ------------------------------------------------------------------------------------------------
const configs = [];
for (const [kind, cap, head, n] of CELLS) {
    if (!KIND_LIST.includes(kind)) continue;
    for (const dst of NO_F64 ? ['f32'] : ['f32', 'f64']) configs.push({ kind, cap, head, n, dst });
}
const host = process.env.QUIET_LOCK_HOST || 'unlocked';
const hostWhy = process.env.QUIET_LOCK_WHY || '';
const t0 = new Date();
const loadStart = os.loadavg()[0];
const runs = configs.map(() => []);
let crashed = 0;
for (let c = 0; c < COMP; c++) {
    for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        const args = ['--allow-natives-syntax', '--expose-gc', PROBE,
            '--ref', ref.path, '--ref-sha8', ref.sha8, '--cand', cand.path, '--cand-sha8', cand.sha8,
            '--kind', cfg.kind, '--cap', String(cfg.cap), '--head', String(cfg.head), '--n', String(cfg.n), '--dst', cfg.dst, '--K', K];
        if (CONTROL) args.push('--control', CONTROL);
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, maxBuffer: 1 << 24, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
        const tag = tagOf(cfg) + ' comp ' + (c + 1);
        if (r.status === 2) die('probe usage error (' + tag + '): ' + String(r.stderr).trim());
        let j = null;
        if (r.status === 0 && r.signal === null) {
            try { j = JSON.parse(r.stdout); } catch { j = null; }
        }
        if (j && j.K === Number(K) && Array.isArray(j.rounds) && j.rounds.length === Number(K) && j.kind === cfg.kind && j.cap === cfg.cap &&
            j.head === cfg.head && j.n === cfg.n && j.dst === cfg.dst && j.control === CONTROL &&
            j.sha8 && j.sha8.ref === ref.sha8 && j.sha8.cand === cand.sha8) {
            runs[i].push(j);
            process.stdout.write('ran ' + tag + '\n');
        } else {
            crashed++;
            process.stderr.write('probe crashed: ' + tag + ' status ' + r.status + ' signal ' + r.signal + ' ' + String(r.stderr || r.error || '').slice(0, 400) + '\n');
        }
    }
}
const loadEnd = os.loadavg()[0];
const t1 = new Date();

// ---- judge + write ------------------------------------------------------------------------------------
const J = judge({ configs, runs, comp: COMP, K: Number(K), host, crashed });
const tier = J.exit === 0 ? 'STATISTICAL (QUIET host, all checks ok)' : J.exit === 2 ? 'PRELIMINARY / NO VERDICT' : 'VOID';
const p0 = runs.find((r) => r.length)?.[0] || {};
// copyToSrcSame (REPORTED): does cand's copyTo source equal ref's? one value per probe run
const srcSame = runs.flat().map((j) => j.copyToSrcSame);
const copyToSrcSame = !srcSame.length ? 'no runs' : srcSame.every((x) => x === true) ? 'true (' + srcSame.length + '/' + srcSame.length + ' runs)' :
    'NOT true in ' + srcSame.filter((x) => x !== true).length + '/' + srcSame.length + ' runs (' + [...new Set(srcSame.map(String))].join(',') + ')';
let md = '### copylast-ab -- ' + tier + ' -- exit ' + J.exit + '\n\n';
md += 'Provenance: ' + t0.toISOString() + ' .. ' + t1.toISOString() + ' (' + f((t1 - t0) / 1000, 1) + ' s); ' +
    os.cpus()[0].model + ', ' + os.cpus().length + ' cores; Node ' + (p0.node || process.version) + ' / V8 ' + (p0.v8 || process.versions.v8) +
    '; cand ' + cand.sha8 + ' ' + cand.name + '; ref ' + ref.sha8 + ' ' + ref.name +
    '; QUIET_LOCK_HOST ' + host + '; QUIET_LOCK_WHY ' + (hostWhy || '-') + '; load1 start ' + f(loadStart) + ', end ' + f(loadEnd) +
    '; K=' + K + ' x comp ' + COMP + ' = ' + (Number(K) * COMP) + ' paired rounds per config' + (CONTROL ? '; control ' + CONTROL : '') +
    '; copyToSrcSame ' + copyToSrcSame + '.\n\n';
md += 'Ratio = column / BASE per round, paired; < 1 = copyLast is faster. BASE = callerCopy (copyTo into a Float32Array(cap) ' +
    'scratch + a loop over its last n) on caller rows, rb.copyTo on parity rows. Parity rows are REPORTED: their label never ' +
    'moves the exit and never makes a claim.\n\n';
md += '| kind | cap | head | n | dst | BASE ns | CAND ns | CAND/BASE med [Q1..Q3] | per-comp med | A/A CAND med | A/A BASE med |' +
    ' SLOW/CAND med (q1) | B/op BASE / BASE_AA / CAND / CAND_AA / SLOW / BOX (max over comps) | label | verdict |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
const mx = (a) => (a.some((x) => Number.isNaN(x)) ? NaN : Math.max(...a));
for (const r of J.rows) {
    const cells = [r.kind, r.cap, r.head, r.n, r.dst, f(r.ns.BASE, 1), f(r.ns.CAND, 1),
        f(r.st.CAND_BASE.med) + ' [' + f(r.st.CAND_BASE.q1) + '..' + f(r.st.CAND_BASE.q3) + ']',
        r.perComp.map((x) => f(x)).join(' / '),
        f(r.st.AA_CAND.med, 4), f(r.st.AA_BASE.med, 4),
        f(r.st.SLOW_CAND.med) + ' (' + f(r.st.SLOW_CAND.q1) + ')',
        TIMED.concat(['BOX']).map((k) => f(mx(r.bop[k]), 2)).join(' / '),
        r.label + (r.reported ? ' (REPORTED)' : ''),
        r.verdict + (r.voidWhy.length ? ' (' + r.voidWhy.join('; ') + ')' : '') + (r.bandWhy.length ? ' (' + r.bandWhy.join('; ') + ')' : '')];
    md += '| ' + cells.join(' | ') + ' |\n';
}
if (J.claims.length) {
    md += '\nClaims (caller rows; CLAIM only on exit 0, both layouts FASTER, every per-comp median < 1.00; N = min 1/Q3, rounded down to 0.1):\n\n';
    md += '| n | dst | claim | N | per layout: 1/median [1/Q3..1/Q1] | why not |\n|---|---|---|---|---|---|\n';
    for (const c of J.claims) {
        md += '| ' + c.n + ' | ' + c.dst + ' | ' + (c.claim ? 'CLAIM' : 'no claim') + ' | ' + (c.claim ? f(c.N, 1) + 'x faster' : '-') + ' | ' +
            c.quote.map((x) => 'h' + x.head + ' ' + f(x.x) + 'x [' + f(x.lo) + '..' + f(x.hi) + ']').join('; ') + ' | ' +
            (c.why.length ? c.why.join('; ') : '-') + ' |\n';
    }
}
md += '\nJudge: exit ' + J.exit + (J.why.length ? '\n' + J.why.map((w) => '- ' + w).join('\n') : ' (no findings)') + '\n';
writeFileSync(join(OUT, 'ab.json'), JSON.stringify({ t0, t1, host, hostWhy, loadStart, loadEnd, K: Number(K), comp: COMP,
    control: CONTROL, cand: { sha8: cand.sha8, name: cand.name }, ref: { sha8: ref.sha8, name: ref.name }, copyToSrcSame,
    exit: J.exit, why: J.why, claims: J.claims, rows: J.rows, raw: runs }, null, 1));
writeFileSync(join(OUT, 'ab.md'), md);
process.stdout.write(md);
process.stdout.write('copylast-ab: exit ' + J.exit + (KEEP ? '; work dir kept: ' + work : '') + '\n');
process.exit(J.exit);
