// pushbatch-ab.mjs -- `npm run bench:pushbatch`: the pushBatch timed A/B (pushBatch vs a caller's push loop).
// Tier: STATISTICAL, dev-only. Never part of `npm test` / `npm run verify`; a release-gating run holds the
// strict quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-ring-buffer pushbatch-ab R2" -- \
//        node test/bench/pushbatch-ab.mjs --out DIR
//
//   node test/bench/pushbatch-ab.mjs --out DIR [--cand FILE] [--ref-rev REF]
//        [--chunks 1,8,32,128] [--no-over] [--K 21] [--comp 3] [--control box|aa] [--keep]
//   node test/bench/pushbatch-ab.mjs --self-test
//
// Sides (each printed with commit + sha256/8 + clean/MODIFIED vs HEAD:RingBuffer.js): cand = a copy of the live
// RingBuffer.js or --cand FILE (every timed call runs on it); ref = git show REF:RingBuffer.js (default HEAD),
// the oracle reference (its `push`) only. Both are staged into a fresh mkdtemp dir (prefix lrb-pushbatch-ab-)
// as ref/RingBuffer.mjs and cand/RingBuffer.mjs (two module instances); the dir is removed on exit unless
// --keep. A cand without pushBatch exits 2 before any spawn.
// Configs: chunks x src {f32, f64} x layout {whole, slice}, plus layout over at every chunk >= 32 (20 by
// default: 16 + over at 32 / 128) unless --no-over, x --comp compilations, each a fresh
// `node --allow-natives-syntax --expose-gc test/bench/pushbatch-probe.mjs` process, compilation-major.
// Statistic: per config, type-7 median and [Q1..Q3] of the K x comp paired per-round ratios CAND/PUSHN,
// AA_CAND = CAND_AA/CAND, AA_PUSHN = PUSHN_AA/PUSHN, SLOW/CAND; per-compilation CAND/PUSHN medians.
// Label (REPORTED): FASTER (CAND/PUSHN Q3 < 1.00) / SLOWER (Q1 > 1.00) / TIE.
// Exit 1 (VOID): a probe crashed, a compilation is missing or has not exactly K rounds, the oracle failed on
//   any of the 5 timed columns (before or after timing), MUT_OBO, MUT_HEAD or MUT_NEGZERO not caught (before
//   or after timing), uniqueSrc false, TurboFan calibration or a driver not TurboFan, PUSHN / PUSHN_AA / CAND /
//   CAND_AA / SLOW B/op not inside (-8, 8), BOX
//   B/op outside 12..20, CAND/PUSHN not measured (NaN, LEDGER C13), or a red self-test.
// Exit 2: host not 'quiet' (QUIET_LOCK_HOST from quiet-lock.mjs), an A/A median outside 0.93..1.07 (a NaN A/A
//   is outside), SLOW/CAND not (median >= 1.5 and Q1 >= 1.3), a cand without pushBatch, or a usage / git /
//   staging error.  Else 0.
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
const PROBE = join(HERE, 'pushbatch-probe.mjs');
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
const TIMED = ['PUSHN', 'PUSHN_AA', 'CAND', 'CAND_AA', 'SLOW'];
const ZERO_BOP_LANES = TIMED;
const LAYOUTS = ['whole', 'slice', 'over'];

function die(msg) {
    process.stderr.write('pushbatch-ab: ' + msg + '\npushbatch-ab: exit 2 (usage / git / staging)\n');
    process.exit(2);
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

// ---- the judge (pure) ---------------------------------------------------------------------------------
// input: { configs: [{chunk, src, layout}], runs: [[probe JSON, ...] per config], comp, host, crashed }
function judgeRow(cfg, rs, comp, K) {
    const roundsOf = (r) => (Array.isArray(r.rounds) ? r.rounds : []);
    const pooled = (fn) => rs.flatMap((r) => roundsOf(r).map(fn));
    const ratio = {
        CAND_PUSHN: pooled((x) => num(x.CAND) / num(x.PUSHN)),
        AA_CAND: pooled((x) => num(x.CAND_AA) / num(x.CAND)),
        AA_PUSHN: pooled((x) => num(x.PUSHN_AA) / num(x.PUSHN)),
        SLOW_CAND: pooled((x) => num(x.SLOW) / num(x.CAND)),
    };
    const st = Object.fromEntries(Object.entries(ratio).map(([k, v]) => [k, stat(v)]));
    const ns = Object.fromEntries(TIMED.map((k) => [k, q(pooled((x) => num(x[k])), 0.5)]));
    const perComp = rs.map((r) => q(roundsOf(r).map((x) => num(x.CAND) / num(x.PUSHN)), 0.5));
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
    for (const [key, nm] of [['mutObo', 'MUT_OBO'], ['mutHead', 'MUT_HEAD'], ['mutNegZero', 'MUT_NEGZERO']]) {
        if (!rs.every((r) => ck(r)[key] && ck(r)[key].before === true && ck(r)[key].after === true)) v.push(nm + ' not caught');
    }
    if (!rs.every((r) => ck(r).turbofan === true)) v.push('driver not TurboFan');
    for (const k of ZERO_BOP_LANES) {
        const bad = bop[k].filter((b) => !(b < BOP_MAX && b > -BOP_MAX));
        if (bad.length) v.push(k + ' B/op ' + bad.map((b) => f(b)).join(',') + ' not inside (-' + BOP_MAX + ', ' + BOP_MAX + ')');
    }
    const badBox = bop.BOX.filter((b) => !(b >= BOX_LO && b <= BOX_HI));
    if (badBox.length) v.push('BOX B/op ' + badBox.map((b) => f(b)).join(',') + ' outside ' + BOX_LO + '..' + BOX_HI + ' (control)');
    if (!(st.CAND_PUSHN.q1 <= st.CAND_PUSHN.q3)) v.push('CAND_PUSHN not measured (NaN)');
    const b = [];
    for (const k of ['AA_CAND', 'AA_PUSHN']) {
        if (!(st[k].med >= AA_LO && st[k].med <= AA_HI)) b.push('A/A ' + k + ' ' + f(st[k].med, 3) + ' outside ' + AA_LO + '..' + AA_HI);
    }
    if (!(st.SLOW_CAND.med >= SLOW_MED_MIN && st.SLOW_CAND.q1 >= SLOW_Q1_MIN)) b.push('SLOW ' + f(st.SLOW_CAND.med) + ' q1 ' + f(st.SLOW_CAND.q1));
    const r = st.CAND_PUSHN;
    const label = r.q3 < 1 ? 'FASTER' : r.q1 > 1 ? 'SLOWER' : (r.q1 <= 1 && r.q3 >= 1) ? 'TIE' : 'n/a';
    const verdict = v.length ? 'VOID' : b.length ? 'INCONCLUSIVE' : label;
    return { ...cfg, verdict, label, st, ns, perComp, bop, voidWhy: v, bandWhy: b };
}
function judge(input) {
    const rows = input.configs.map((cfg, i) => judgeRow(cfg, input.runs[i] || [], input.comp, input.K));
    const voidHit = input.crashed > 0 || rows.some((r) => r.voidWhy.length > 0);
    const bandHit = rows.some((r) => r.bandWhy.length > 0);
    const quiet = input.host === 'quiet';
    const exit = voidHit ? 1 : (!quiet || bandHit) ? 2 : 0;
    const why = [];
    if (input.crashed > 0) why.push(input.crashed + ' probe crash(es)');
    const tag = (r) => r.chunk + '/' + r.src + '/' + r.layout;
    for (const r of rows) {
        for (const w of r.voidWhy) why.push('VOID ' + tag(r) + ': ' + w);
        for (const w of r.bandWhy) why.push('BAND ' + tag(r) + ': ' + w);
    }
    if (!quiet) why.push('HOST ' + String(input.host) + ' (not quiet): no verdict');
    return { exit, rows, why };
}

// ---- self-test: synthetic cases on both sides of every boundary, a NaN per column ----------------------
// o.ratio: 7 CAND/PUSHN multipliers (pooled over 2 runs: med = r[3], q1 = r[1] + 0.25 (r[2] - r[1]),
// q3 = r[4] + 0.75 (r[5] - r[4]) of the sorted list); a multiplier of exactly 1 gives a ratio of exactly 1.
function synthRun(cfg, o = {}) {
    const rounds = [];
    for (let k = 0; k < 7; k++) {
        const j = (k - 3) * 0.001;
        const PUSHN = 100 * (1 + j);
        const CAND = PUSHN * (o.ratio ? o.ratio[k] : 0.5);
        const row = { PUSHN, PUSHN_AA: PUSHN * (o.aaP ?? 1), CAND, CAND_AA: CAND * (o.aaC ?? 1), SLOW: CAND * (o.slow ?? 2) };
        if (k < 2 && o.slowLow !== undefined) row.SLOW = CAND * o.slowLow;
        if (o.roundNaN && k === 0) row[o.roundNaN] = NaN;
        rounds.push(row);
    }
    const bop = { PUSHN: 0, PUSHN_AA: 0, CAND: 0, CAND_AA: 0, SLOW: 0, BOX: 16 };
    Object.assign(bop, o.bop || {});
    const all = () => Object.fromEntries(TIMED.map((k) => [k, true]));
    const checks = {
        tfCalib: true, uniqueSrc: true, turbofan: true, oracle: all(), oracleAfter: all(),
        mutObo: { before: true, after: true }, mutHead: { before: true, after: true }, mutNegZero: { before: true, after: true },
    };
    if (o.checks) o.checks(checks);
    return { ...cfg, rounds, bop, checks };
}
function selfTest() {
    const C = { chunk: 1, src: 'f32', layout: 'whole' };
    const Sl = { chunk: 8, src: 'f64', layout: 'slice' };
    const O = { chunk: 32, src: 'f32', layout: 'over' };
    // extra.run2 edits the second compilation only (the first stays well-formed)
    const one = (cfg, o, extra = {}) => {
        const r2 = synthRun(cfg, o);
        if (extra.run2) extra.run2(r2);
        return judge({
            configs: [cfg], runs: [[synthRun(cfg, o), r2]], K: 7,
            comp: extra.comp ?? 2, host: 'host' in extra ? extra.host : 'quiet', crashed: extra.crashed ?? 0,
        });
    };
    // [name, want exit, fn, want label (optional)]
    const cases = [
        ['baseline quiet -> 0 FASTER', 0, () => one(C, {}), 'FASTER'],
        ['baseline slice -> 0', 0, () => one(Sl, {})],
        ['baseline over -> 0', 0, () => one(O, {})],
        ['Q3 0.999 -> FASTER', 0, () => one(C, { ratio: [0.99, 0.99, 0.99, 0.995, 0.999, 0.999, 1.2] }), 'FASTER'],
        ['Q3 1.000 -> TIE', 0, () => one(C, { ratio: [0.99, 0.99, 0.99, 0.995, 1, 1, 1.2] }), 'TIE'],
        ['Q1 1.001 -> SLOWER', 0, () => one(C, { ratio: [0.8, 1.001, 1.001, 1.01, 1.02, 1.03, 1.04] }), 'SLOWER'],
        ['Q1 1.000 -> TIE', 0, () => one(C, { ratio: [0.8, 1, 1, 1.01, 1.02, 1.03, 1.04] }), 'TIE'],
        ['host preliminary -> 2', 2, () => one(C, {}, { host: 'preliminary' })],
        ['host unlocked -> 2', 2, () => one(C, {}, { host: 'unlocked' })],
        ['host undefined -> 2', 2, () => one(C, {}, { host: undefined })],
        ['AA_CAND 0.93 in -> 0', 0, () => one(C, { aaC: 0.9301 })],
        ['AA_CAND 0.929 out -> 2', 2, () => one(C, { aaC: 0.929 })],
        ['AA_CAND 1.07 in -> 0', 0, () => one(C, { aaC: 1.0699 })],
        ['AA_CAND 1.071 out -> 2', 2, () => one(C, { aaC: 1.071 })],
        ['AA_PUSHN 0.93 in -> 0', 0, () => one(C, { aaP: 0.9301 })],
        ['AA_PUSHN 0.929 out -> 2', 2, () => one(C, { aaP: 0.929 })],
        ['AA_PUSHN 1.07 in -> 0', 0, () => one(C, { aaP: 1.0699 })],
        ['AA_PUSHN 1.071 out -> 2', 2, () => one(C, { aaP: 1.071 })],
        ['SLOW med 1.5 -> 0', 0, () => one(C, { slow: 1.5005 })],
        ['SLOW med 1.49 -> 2', 2, () => one(C, { slow: 1.49 })],
        ['SLOW q1 1.3 in -> 0', 0, () => one(C, { slow: 2, slowLow: 1.31 })],
        ['SLOW q1 1.29 out -> 2', 2, () => one(C, { slow: 1.6, slowLow: 1.0 })],
        ['PUSHN NaN round -> 1', 1, () => one(C, { roundNaN: 'PUSHN' })],
        ['CAND NaN round -> 1', 1, () => one(C, { roundNaN: 'CAND' })],
        ['PUSHN_AA NaN round -> 2', 2, () => one(C, { roundNaN: 'PUSHN_AA' })],
        ['CAND_AA NaN round -> 2', 2, () => one(C, { roundNaN: 'CAND_AA' })],
        ['SLOW NaN round -> 2', 2, () => one(C, { roundNaN: 'SLOW' })],
        ['PUSHN B/op 7.99 -> 0', 0, () => one(C, { bop: { PUSHN: 7.99 } })],
        ['PUSHN B/op 8 -> 1', 1, () => one(C, { bop: { PUSHN: 8 } })],
        ['PUSHN_AA B/op 8 -> 1', 1, () => one(C, { bop: { PUSHN_AA: 8 } })],
        ['CAND B/op 7.99 -> 0', 0, () => one(C, { bop: { CAND: 7.99 } })],
        ['CAND B/op 8 -> 1', 1, () => one(C, { bop: { CAND: 8 } })],
        ['CAND B/op -7.99 -> 0', 0, () => one(C, { bop: { CAND: -7.99 } })],
        ['CAND B/op -8 -> 1', 1, () => one(C, { bop: { CAND: -8 } })],
        ['CAND B/op NaN -> 1', 1, () => one(C, { bop: { CAND: NaN } })],
        ['CAND B/op null (JSON NaN) -> 1', 1, () => one(C, { bop: { CAND: null } })],
        ['CAND_AA B/op 8 -> 1', 1, () => one(C, { bop: { CAND_AA: 8 } })],
        ['SLOW B/op 8.01 -> 1', 1, () => one(C, { bop: { SLOW: 8.01 } })],
        ['SLOW B/op NaN -> 1', 1, () => one(C, { bop: { SLOW: NaN } })],
        ['BOX 12 in -> 0', 0, () => one(C, { bop: { BOX: 12 } })],
        ['BOX 11.99 out -> 1', 1, () => one(C, { bop: { BOX: 11.99 } })],
        ['BOX 20 in -> 0', 0, () => one(C, { bop: { BOX: 20 } })],
        ['BOX 20.01 out -> 1', 1, () => one(C, { bop: { BOX: 20.01 } })],
        ['BOX null (JSON NaN) -> 1', 1, () => one(C, { bop: { BOX: null } })],
        ['oracle PUSHN false -> 1', 1, () => one(C, { checks: (c) => { c.oracle.PUSHN = false; } })],
        ['oracle CAND false -> 1', 1, () => one(C, { checks: (c) => { c.oracle.CAND = false; } })],
        ['oracle SLOW missing -> 1', 1, () => one(C, { checks: (c) => { delete c.oracle.SLOW; } })],
        ['oracleAfter CAND_AA false -> 1', 1, () => one(Sl, { checks: (c) => { c.oracleAfter.CAND_AA = false; } })],
        ['oracleAfter PUSHN_AA false -> 1', 1, () => one(O, { checks: (c) => { c.oracleAfter.PUSHN_AA = false; } })],
        ['MUT_OBO missed before -> 1', 1, () => one(C, { checks: (c) => { c.mutObo.before = false; } })],
        ['MUT_OBO missed after -> 1', 1, () => one(C, { checks: (c) => { c.mutObo.after = false; } })],
        ['MUT_HEAD missed before -> 1', 1, () => one(C, { checks: (c) => { c.mutHead.before = false; } })],
        ['MUT_HEAD missed after -> 1', 1, () => one(O, { checks: (c) => { c.mutHead.after = false; } })],
        ['MUT_NEGZERO missed before -> 1', 1, () => one(C, { checks: (c) => { c.mutNegZero.before = false; } })],
        ['MUT_NEGZERO missed after -> 1', 1, () => one(Sl, { checks: (c) => { c.mutNegZero.after = false; } })],
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
    let pass = 0;
    const lines = [];
    for (const [name, want, fn, wantLabel] of cases) {
        let got;
        try {
            const J = fn();
            got = J.exit;
            if (wantLabel !== undefined && J.rows[0].label !== wantLabel) got = 'label ' + J.rows[0].label;
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
const VALUE_OPTS = ['--out', '--cand', '--ref-rev', '--chunks', '--K', '--comp', '--control'];
const FLAG_OPTS = ['--no-over', '--keep', '--self-test'];
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
    process.stdout.write('pushbatch-ab self-test: ' + ST.pass + '/' + ST.total + ' checks ' + (ST.ok ? 'ok' : 'FAILED') + '\n');
    process.exit(ST.ok ? 0 : 1);
}
if (!ST.ok) {
    for (const l of ST.lines) if (l.startsWith('FAIL')) process.stderr.write(l + '\n');
    process.stderr.write('pushbatch-ab: self-test red (' + ST.pass + '/' + ST.total + '): exit 1\n');
    process.exit(1);
}
process.stdout.write('pushbatch-ab self-test: ' + ST.pass + '/' + ST.total + ' checks ok\n');

if (!('--out' in opt)) die('--out DIR is required (a new or empty dir for ab.json / ab.md)');
const CHUNKS = String(opt['--chunks'] ?? '1,8,32,128').split(',');
for (let k = 0; k < CHUNKS.length; k++) {
    const s = CHUNKS[k], v = Number(s);
    if (!/^[0-9]+$/.test(s) || !(v >= 1 && v <= 4096) || (v & (v - 1)) !== 0) die('--chunks: ' + JSON.stringify(s) + ' is not a power of two in 1..4096');
    if (CHUNKS.indexOf(s) !== k) die('--chunks: ' + s + ' given twice');
}
const K = opt['--K'] ?? '21';
if (!/^[0-9]+$/.test(K) || !(Number(K) >= 5 && Number(K) <= 1001)) die('--K: want an integer 5..1001');
const COMP_S = opt['--comp'] ?? '3';
if (!/^[0-9]+$/.test(COMP_S) || !(Number(COMP_S) >= 1 && Number(COMP_S) <= 10)) die('--comp: want an integer 1..10');
const COMP = Number(COMP_S);
const CONTROL = opt['--control'] ?? '';
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'aa') die('--control: box or aa');
const NO_OVER = opt['--no-over'] === true;
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
const work = mkdtempSync(join(os.tmpdir(), 'lrb-pushbatch-ab-'));
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
// a cand without pushBatch: exit 2 before any spawn (the probe would fail closed with exit 1 on every config)
let candRB;
try { candRB = (await import(pathToFileURL(cand.path).href)).RingBuffer; } catch (e) { die('cannot import the staged cand: ' + e.message); }
if (typeof candRB !== 'function' || typeof candRB.prototype.pushBatch !== 'function') die('cand has no RingBuffer.prototype.pushBatch: ' + cand.name);
try { mkdirSync(OUT, { recursive: true }); } catch (e) { die('--out: cannot create ' + OUT + ': ' + e.message); }

// ---- run ------------------------------------------------------------------------------------------------
const configs = [];
for (const s of CHUNKS) {
    const chunk = Number(s);
    for (const src of ['f32', 'f64']) {
        for (const layout of LAYOUTS) {
            if (layout === 'over' && (NO_OVER || chunk < 32)) continue;
            configs.push({ chunk, src, layout });
        }
    }
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
            '--chunk', String(cfg.chunk), '--src', cfg.src, '--layout', cfg.layout, '--K', K];
        if (CONTROL) args.push('--control', CONTROL);
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, maxBuffer: 1 << 24, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
        const tag = cfg.chunk + '/' + cfg.src + '/' + cfg.layout + ' comp ' + (c + 1);
        if (r.status === 2) die('probe usage error (' + tag + '): ' + String(r.stderr).trim());
        let j = null;
        if (r.status === 0 && r.signal === null) {
            try { j = JSON.parse(r.stdout); } catch { j = null; }
        }
        if (j && j.K === Number(K) && Array.isArray(j.rounds) && j.rounds.length === Number(K) && j.chunk === cfg.chunk && j.src === cfg.src && j.layout === cfg.layout && j.control === CONTROL &&
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
let md = '### pushbatch-ab -- ' + tier + ' -- exit ' + J.exit + '\n\n';
md += 'Provenance: ' + t0.toISOString() + ' .. ' + t1.toISOString() + ' (' + f((t1 - t0) / 1000, 1) + ' s); ' +
    os.cpus()[0].model + ', ' + os.cpus().length + ' cores; Node ' + (p0.node || process.version) + ' / V8 ' + (p0.v8 || process.versions.v8) +
    '; cand ' + cand.sha8 + ' ' + cand.name + '; ref ' + ref.sha8 + ' ' + ref.name +
    '; QUIET_LOCK_HOST ' + host + '; QUIET_LOCK_WHY ' + (hostWhy || '-') + '; load1 start ' + f(loadStart) + ', end ' + f(loadEnd) +
    '; K=' + K + ' x comp ' + COMP + ' = ' + (Number(K) * COMP) + ' paired rounds per config' + (CONTROL ? '; control ' + CONTROL : '') + '.\n\n';
md += 'Ratio = column / PUSHN (a caller loop of `push` on the same class) per round, paired; < 1 = pushBatch is faster.\n\n';
md += '| chunk | src | layout | PUSHN ns | CAND ns | CAND/PUSHN med [Q1..Q3] | per-comp med | A/A CAND med | A/A PUSHN med |' +
    ' SLOW/CAND med (q1) | B/op PUSHN / PUSHN_AA / CAND / CAND_AA / SLOW / BOX (max over comps) | label | verdict |\n';
md += '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
const mx = (a) => (a.some((x) => Number.isNaN(x)) ? NaN : Math.max(...a));
for (const r of J.rows) {
    const cells = [r.chunk, r.src, r.layout, f(r.ns.PUSHN, 1), f(r.ns.CAND, 1),
        f(r.st.CAND_PUSHN.med) + ' [' + f(r.st.CAND_PUSHN.q1) + '..' + f(r.st.CAND_PUSHN.q3) + ']',
        r.perComp.map((x) => f(x)).join(' / '),
        f(r.st.AA_CAND.med, 3), f(r.st.AA_PUSHN.med, 3),
        f(r.st.SLOW_CAND.med) + ' (' + f(r.st.SLOW_CAND.q1) + ')',
        TIMED.concat(['BOX']).map((k) => f(mx(r.bop[k]), 2)).join(' / '),
        r.label,
        r.verdict + (r.voidWhy.length ? ' (' + r.voidWhy.join('; ') + ')' : '') + (r.bandWhy.length ? ' (' + r.bandWhy.join('; ') + ')' : '')];
    md += '| ' + cells.join(' | ') + ' |\n';
}
// label grid: chunk x (src, layout); each cell = label + CAND/PUSHN median
const gridCols = [];
for (const src of ['f32', 'f64']) for (const layout of LAYOUTS) if (J.rows.some((r) => r.src === src && r.layout === layout)) gridCols.push([src, layout]);
md += '\nLabel grid (CAND/PUSHN median):\n\n| chunk | ' + gridCols.map(([s, l]) => s + ' ' + l).join(' | ') + ' |\n';
md += '|---|' + gridCols.map(() => '---|').join('') + '\n';
for (const s of CHUNKS) {
    const cells = gridCols.map(([src, layout]) => {
        const r = J.rows.find((x) => x.chunk === Number(s) && x.src === src && x.layout === layout);
        return r ? r.label + ' ' + f(r.st.CAND_PUSHN.med) : '-';
    });
    md += '| ' + s + ' | ' + cells.join(' | ') + ' |\n';
}
md += '\nJudge: exit ' + J.exit + (J.why.length ? '\n' + J.why.map((w) => '- ' + w).join('\n') : ' (no findings)') + '\n';
writeFileSync(join(OUT, 'ab.json'), JSON.stringify({ t0, t1, host, hostWhy, loadStart, loadEnd, K: Number(K), comp: COMP,
    control: CONTROL, cand: { sha8: cand.sha8, name: cand.name }, ref: { sha8: ref.sha8, name: ref.name },
    exit: J.exit, why: J.why, rows: J.rows, raw: runs }, null, 1));
writeFileSync(join(OUT, 'ab.md'), md);
process.stdout.write(md);
process.stdout.write('pushbatch-ab: exit ' + J.exit + (KEEP ? '; work dir kept: ' + work : '') + '\n');
process.exit(J.exit);
