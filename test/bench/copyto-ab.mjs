// copyto-ab.mjs -- `npm run bench:copyto`: the copyTo timed A/B (before vs candidate). Tier: STATISTICAL,
// dev-only. Never part of `npm test` / `npm run verify`; a release-gating run holds the strict quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-ring-buffer copyto-ab R1" -- \
//        node test/bench/copyto-ab.mjs --out DIR
//
//   node test/bench/copyto-ab.mjs --out DIR [--before-ref REF | --before FILE] [--after FILE]
//        [--sizes 32,64,128,256,1024] [--K 21] [--comp 3] [--no-fast] [--control box|view] [--keep]
//   node test/bench/copyto-ab.mjs --self-test
//
// Sides (each printed with commit + sha256/8 + clean/MODIFIED vs HEAD:RingBuffer.js; identical bytes print
// "A/A"): before = git show REF:RingBuffer.js (default HEAD) or --before FILE; after = a copy of the live
// RingBuffer.js or --after FILE. Both are staged into a fresh mkdtemp dir as before/RingBuffer.mjs and
// after/RingBuffer.mjs (two module instances); the dir is removed on exit unless --keep.
// Configs: sizes x dst {f32, f64} x layout {contig, wrap, part} (30 by default) x --comp compilations, each a
// fresh `node --allow-natives-syntax --expose-gc test/bench/copyto-probe.mjs` process, compilation-major.
// Statistic: per config, type-7 median and [Q1..Q3] of the K x comp paired per-round ratios CAND/BEFORE,
// FAST/BEFORE, CAND/FAST, AA = CAND_AA/CAND, SLOW/CAND. Labels AHEAD (CAND/BEFORE Q3 < 1.00) / BEHIND
// (Q1 > 1.10) / TIE are REPORTED only.
// Exit 1: a probe crashed, a compilation is missing, oracle / sweep failed, a mutant not caught as
//   specified (MUT_OBO by the timed oracle and the sweep; MUT_D7 by the sweep, and by the timed oracle
//   only on layout part), TurboFan calibration or a driver not TurboFan, CAND / CAND_AA / SLOW B/op not
//   < 8, BOX B/op outside 12..20, VIEW B/op < 52 (contig) or < 156 (wrap, part), or a red self-test.
// Exit 2: host not 'quiet' (QUIET_LOCK_HOST from quiet-lock.mjs), AA median outside 0.93..1.07, SLOW not
//   (median >= 1.5 and Q1 >= 1.3), or a usage / git / staging error.  Else 0.
// The judge is pure; NaN (and a JSON null) fails every comparison. --self-test runs its synthetic cases;
// every real run runs them first, before any spawn.
// Writes DIR/ab.json and DIR/ab.md (DIR must be new or empty). Test tooling only: not shipped.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PROBE = join(HERE, 'copyto-probe.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const PROBE_TIMEOUT_MS = 900000;

// ---- judge constants ----------------------------------------------------------------------------------
const BOP_MAX = 8;            // half a 16 B box: CAND, CAND_AA, SLOW must read below it
const BOX_LO = 12;            // one HeapNumber per call (16 B on Node) -> 12..20
const BOX_HI = 20;
const VIEW_MIN_ONE = 52;      // half a 104 B view (contig)
const VIEW_MIN_TWO = 156;     // 1.5 views (wrap, part)
const AA_LO = 0.93;
const AA_HI = 1.07;
const SLOW_MED_MIN = 1.5;
const SLOW_Q1_MIN = 1.3;
const ZERO_BOP_LANES = ['CAND', 'CAND_AA', 'SLOW'];

function die(msg) {
    process.stderr.write('copyto-ab: ' + msg + '\ncopyto-ab: exit 2 (usage / git / staging)\n');
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
// input: { configs: [{n, dst, layout}], runs: [[probe JSON, ...] per config], comp, fast, host, crashed }
function judgeRow(cfg, rs, comp, fast) {
    const pooled = (fn) => rs.flatMap((r) => (Array.isArray(r.rounds) ? r.rounds : []).map(fn));
    const ratio = {
        CAND_BEFORE: pooled((x) => num(x.CAND) / num(x.BEFORE)),
        AA: pooled((x) => num(x.CAND_AA) / num(x.CAND)),
        SLOW_CAND: pooled((x) => num(x.SLOW) / num(x.CAND)),
    };
    if (fast) {
        ratio.FAST_BEFORE = pooled((x) => num(x.FAST) / num(x.BEFORE));
        ratio.CAND_FAST = pooled((x) => num(x.CAND) / num(x.FAST));
    }
    const st = Object.fromEntries(Object.entries(ratio).map(([k, v]) => [k, stat(v)]));
    const cols = ['BEFORE', 'CAND', 'CAND_AA'].concat(fast ? ['FAST'] : [], ['SLOW']);
    const ns = Object.fromEntries(cols.map((k) => [k, q(pooled((x) => num(x[k])), 0.5)]));
    const perComp = rs.map((r) => q((Array.isArray(r.rounds) ? r.rounds : []).map((x) => num(x.CAND) / num(x.BEFORE)), 0.5));
    const lanes = cols.concat(['VIEW', 'BOX']);
    const bop = Object.fromEntries(lanes.map((k) => [k, rs.map((r) => num(r.bop && r.bop[k]))]));
    const ck = (r) => r.checks || {};
    const v = [];
    if (rs.length !== comp) v.push('only ' + rs.length + '/' + comp + ' compilations');
    if (!rs.every((r) => ck(r).tfCalib === true)) v.push('TurboFan bit 32 calibration');
    const oracled = cols.filter((k) => k !== 'BEFORE');
    if (!rs.every((r) => ck(r).oracleAfter === true && oracled.every((k) => ck(r).oracle && ck(r).oracle[k] === true))) v.push('oracle');
    if (!rs.every((r) => oracled.every((k) => ck(r).sweep && ck(r).sweep[k] === true))) v.push('oracle sweep');
    if (!rs.every((r) => ck(r).mutObo && ck(r).mutObo.timedCaught === true && ck(r).mutObo.sweepCaught === true)) v.push('MUT_OBO not caught');
    const d7Timed = cfg.layout === 'part';
    if (!rs.every((r) => ck(r).mutD7 && ck(r).mutD7.sweepCaught === true)) v.push('MUT_D7 not caught by the sweep');
    if (!rs.every((r) => ck(r).mutD7 && ck(r).mutD7.timedCaught === d7Timed)) v.push('MUT_D7 timed oracle ' + (d7Timed ? 'missed it on part' : 'caught it on ' + cfg.layout + ' (D7 not reproduced)'));
    if (!rs.every((r) => ck(r).turbofan === true)) v.push('driver not TurboFan');
    for (const k of ZERO_BOP_LANES) {
        const bad = bop[k].filter((b) => !(b < BOP_MAX));
        if (bad.length) v.push(k + ' B/op ' + bad.map((b) => f(b)).join(',') + ' not < ' + BOP_MAX);
    }
    const badBox = bop.BOX.filter((b) => !(b >= BOX_LO && b <= BOX_HI));
    if (badBox.length) v.push('BOX B/op ' + badBox.map((b) => f(b)).join(',') + ' outside ' + BOX_LO + '..' + BOX_HI + ' (control)');
    const wantView = cfg.layout === 'contig' ? VIEW_MIN_ONE : VIEW_MIN_TWO;
    const badView = bop.VIEW.filter((b) => !(b >= wantView));
    if (badView.length) v.push('VIEW B/op ' + badView.map((b) => f(b, 1)).join(',') + ' < ' + wantView + ' (control)');
    const b = [];
    if (!(st.AA.med >= AA_LO && st.AA.med <= AA_HI)) b.push('A/A ' + f(st.AA.med, 3) + ' outside ' + AA_LO + '..' + AA_HI);
    if (!(st.SLOW_CAND.med >= SLOW_MED_MIN && st.SLOW_CAND.q1 >= SLOW_Q1_MIN)) b.push('SLOW ' + f(st.SLOW_CAND.med) + ' q1 ' + f(st.SLOW_CAND.q1));
    for (const k of ['CAND_BEFORE'].concat(fast ? ['FAST_BEFORE', 'CAND_FAST'] : [])) if (!(st[k].q1 <= st[k].q3)) v.push(k + ' not measured (NaN)');
    const r = st.CAND_BEFORE;
    const label = r.q3 < 1 ? 'AHEAD' : r.q1 > 1.10 ? 'BEHIND' : (r.q1 <= 1.10 && r.q3 >= 1) ? 'TIE' : 'n/a';
    const verdict = v.length ? 'VOID' : b.length ? 'INCONCLUSIVE' : label;
    return { ...cfg, verdict, label, st, ns, perComp, bop, voidWhy: v, bandWhy: b };
}
function judge(input) {
    const rows = input.configs.map((cfg, i) => judgeRow(cfg, input.runs[i] || [], input.comp, input.fast));
    const voidHit = input.crashed > 0 || rows.some((r) => r.voidWhy.length > 0);
    const bandHit = rows.some((r) => r.bandWhy.length > 0);
    const quiet = input.host === 'quiet';
    const exit = voidHit ? 1 : (!quiet || bandHit) ? 2 : 0;
    const why = [];
    if (input.crashed > 0) why.push(input.crashed + ' probe crash(es)');
    for (const r of rows) {
        for (const w of r.voidWhy) why.push('VOID ' + r.n + '/' + r.dst + '/' + r.layout + ': ' + w);
        for (const w of r.bandWhy) why.push('BAND ' + r.n + '/' + r.dst + '/' + r.layout + ': ' + w);
    }
    if (!quiet) why.push('HOST ' + String(input.host) + ' (not quiet): no verdict');
    return { exit, rows, why };
}

// ---- self-test: synthetic cases on both sides of every boundary, a NaN per field -----------------------
function synthRun(cfg, fast, o = {}) {
    const rounds = [];
    for (let k = 0; k < 7; k++) {
        const j = (k - 3) * 0.001;
        const row = { BEFORE: 100 * (1 + j), CAND: 100 * (1 - j), CAND_AA: 100 * (1 - j) * (o.aa ?? 1), SLOW: 100 * (1 - j) * (o.slow ?? 2) };
        if (k < 2 && o.slowLow !== undefined) row.SLOW = 100 * (1 - j) * o.slowLow;
        if (fast) row.FAST = 90;
        if (o.roundNaN && k === 0) row[o.roundNaN] = NaN;
        rounds.push(row);
    }
    const bop = { BEFORE: 0, CAND: 0, CAND_AA: 0, SLOW: 0, VIEW: cfg.layout === 'contig' ? 104 : 208, BOX: 16 };
    if (fast) bop.FAST = 0;
    Object.assign(bop, o.bop || {});
    const checks = {
        tfCalib: true, oracleAfter: true, turbofan: true,
        oracle: { CAND: true, CAND_AA: true, SLOW: true }, sweep: { CAND: true, CAND_AA: true, SLOW: true },
        mutObo: { timedCaught: true, sweepCaught: true },
        mutD7: { timedCaught: cfg.layout === 'part', sweepCaught: true },
    };
    if (fast) { checks.oracle.FAST = true; checks.sweep.FAST = true; }
    if (o.checks) o.checks(checks);
    return { ...cfg, rounds, bop, checks };
}
function selfTest() {
    const C = { n: 32, dst: 'f32', layout: 'contig' };
    const Wr = { n: 32, dst: 'f64', layout: 'wrap' };
    const P = { n: 32, dst: 'f32', layout: 'part' };
    const one = (cfg, o, extra = {}) => judge({
        configs: [cfg], runs: [[synthRun(cfg, extra.fast ?? false, o), synthRun(cfg, extra.fast ?? false, o)]],
        comp: extra.comp ?? 2, fast: extra.fast ?? false, host: 'host' in extra ? extra.host : 'quiet', crashed: extra.crashed ?? 0,
    });
    const cases = [
        ['baseline quiet -> 0', 0, () => one(C, {})],
        ['baseline wrap + fast -> 0', 0, () => one(Wr, {}, { fast: true })],
        ['baseline part -> 0', 0, () => one(P, {})],
        ['host preliminary -> 2', 2, () => one(C, {}, { host: 'preliminary' })],
        ['host unlocked -> 2', 2, () => one(C, {}, { host: 'unlocked' })],
        ['host undefined -> 2', 2, () => one(C, {}, { host: undefined })],
        ['AA 0.93 in -> 0', 0, () => one(C, { aa: 0.9301 })],
        ['AA 0.929 out -> 2', 2, () => one(C, { aa: 0.929 })],
        ['AA 1.07 in -> 0', 0, () => one(C, { aa: 1.0699 })],
        ['AA 1.071 out -> 2', 2, () => one(C, { aa: 1.071 })],
        ['AA NaN round -> 2', 2, () => one(C, { roundNaN: 'CAND_AA' })],
        ['SLOW med 1.5 -> 0', 0, () => one(C, { slow: 1.5005 })],
        ['SLOW med 1.49 -> 2', 2, () => one(C, { slow: 1.49 })],
        ['SLOW q1 1.3 in -> 0', 0, () => one(C, { slow: 2, slowLow: 1.31 })],
        ['SLOW q1 1.29 out -> 2', 2, () => one(C, { slow: 1.6, slowLow: 1.0 })],
        ['SLOW NaN round -> 2', 2, () => one(C, { roundNaN: 'SLOW' })],
        ['BEFORE NaN round -> 1', 1, () => one(C, { roundNaN: 'BEFORE' })],
        ['FAST NaN round -> 1', 1, () => one(Wr, { roundNaN: 'FAST' }, { fast: true })],
        ['CAND B/op 7.99 -> 0', 0, () => one(C, { bop: { CAND: 7.99 } })],
        ['CAND B/op 8 -> 1', 1, () => one(C, { bop: { CAND: 8 } })],
        ['CAND B/op NaN -> 1', 1, () => one(C, { bop: { CAND: NaN } })],
        ['CAND B/op null (JSON NaN) -> 1', 1, () => one(C, { bop: { CAND: null } })],
        ['CAND_AA B/op NaN -> 1', 1, () => one(C, { bop: { CAND_AA: NaN } })],
        ['SLOW B/op 8.01 -> 1', 1, () => one(C, { bop: { SLOW: 8.01 } })],
        ['SLOW B/op NaN -> 1', 1, () => one(C, { bop: { SLOW: NaN } })],
        ['BOX 12 in -> 0', 0, () => one(C, { bop: { BOX: 12 } })],
        ['BOX 11.99 out -> 1', 1, () => one(C, { bop: { BOX: 11.99 } })],
        ['BOX 20 in -> 0', 0, () => one(C, { bop: { BOX: 20 } })],
        ['BOX 20.01 out -> 1', 1, () => one(C, { bop: { BOX: 20.01 } })],
        ['BOX NaN -> 1', 1, () => one(C, { bop: { BOX: NaN } })],
        ['VIEW contig 52 in -> 0', 0, () => one(C, { bop: { VIEW: 52 } })],
        ['VIEW contig 51.9 out -> 1', 1, () => one(C, { bop: { VIEW: 51.9 } })],
        ['VIEW wrap 156 in -> 0', 0, () => one(Wr, { bop: { VIEW: 156 } })],
        ['VIEW wrap 155.9 out -> 1', 1, () => one(Wr, { bop: { VIEW: 155.9 } })],
        ['VIEW part 104 out -> 1', 1, () => one(P, { bop: { VIEW: 104 } })],
        ['VIEW NaN -> 1', 1, () => one(C, { bop: { VIEW: NaN } })],
        ['oracle false -> 1', 1, () => one(C, { checks: (c) => { c.oracle.CAND = false; } })],
        ['FAST oracle false -> 1', 1, () => one(C, { checks: (c) => { c.oracle.FAST = false; } }, { fast: true })],
        ['oracleAfter false -> 1', 1, () => one(C, { checks: (c) => { c.oracleAfter = false; } })],
        ['sweep false -> 1', 1, () => one(C, { checks: (c) => { c.sweep.SLOW = false; } })],
        ['MUT_OBO timed missed -> 1', 1, () => one(C, { checks: (c) => { c.mutObo.timedCaught = false; } })],
        ['MUT_OBO sweep missed -> 1', 1, () => one(C, { checks: (c) => { c.mutObo.sweepCaught = false; } })],
        ['MUT_D7 sweep missed -> 1', 1, () => one(Wr, { checks: (c) => { c.mutD7.sweepCaught = false; } })],
        ['MUT_D7 timed caught on contig -> 1', 1, () => one(C, { checks: (c) => { c.mutD7.timedCaught = true; } })],
        ['MUT_D7 timed missed on part -> 1', 1, () => one(P, { checks: (c) => { c.mutD7.timedCaught = false; } })],
        ['turbofan false -> 1', 1, () => one(C, { checks: (c) => { c.turbofan = false; } })],
        ['tfCalib false -> 1', 1, () => one(C, { checks: (c) => { c.tfCalib = false; } })],
        ['tfCalib missing -> 1', 1, () => one(C, { checks: (c) => { delete c.tfCalib; } })],
        ['missing compilation -> 1', 1, () => one(C, {}, { comp: 3 })],
        ['probe crash -> 1', 1, () => one(C, {}, { crashed: 1 })],
        ['void beats host -> 1', 1, () => one(C, { bop: { CAND: 16 } }, { host: 'preliminary' })],
    ];
    let pass = 0;
    const lines = [];
    for (const [name, want, fn] of cases) {
        let got;
        try { got = fn().exit; } catch (e) { got = 'throw ' + e.message; }
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
const VALUE_OPTS = ['--before-ref', '--before', '--after', '--sizes', '--K', '--comp', '--out', '--control'];
const FLAG_OPTS = ['--no-fast', '--keep', '--self-test'];
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
    process.stdout.write('copyto-ab self-test: ' + ST.pass + '/' + ST.total + ' checks ' + (ST.ok ? 'ok' : 'FAILED') + '\n');
    process.exit(ST.ok ? 0 : 1);
}
if (!ST.ok) {
    for (const l of ST.lines) if (l.startsWith('FAIL')) process.stderr.write(l + '\n');
    process.stderr.write('copyto-ab: self-test red (' + ST.pass + '/' + ST.total + '): exit 1\n');
    process.exit(1);
}
process.stdout.write('copyto-ab self-test: ' + ST.pass + '/' + ST.total + ' checks ok\n');

if ('--before-ref' in opt && '--before' in opt) die('--before-ref and --before are exclusive');
if (!('--out' in opt)) die('--out DIR is required (a new or empty dir for ab.json / ab.md)');
const SIZES = String(opt['--sizes'] ?? '32,64,128,256,1024').split(',');
for (let k = 0; k < SIZES.length; k++) {
    const s = SIZES[k], v = Number(s);
    if (!/^[0-9]+$/.test(s) || !(v >= 32 && v <= 4096) || (v & (v - 1)) !== 0) die('--sizes: ' + JSON.stringify(s) + ' is not a power of two in 32..4096');
    if (SIZES.indexOf(s) !== k) die('--sizes: ' + s + ' given twice');
}
const K = opt['--K'] ?? '21';
if (!/^[0-9]+$/.test(K) || !(Number(K) >= 5 && Number(K) <= 1001)) die('--K: want an integer 5..1001');
const COMP_S = opt['--comp'] ?? '3';
if (!/^[0-9]+$/.test(COMP_S) || !(Number(COMP_S) >= 1 && Number(COMP_S) <= 10)) die('--comp: want an integer 1..10');
const COMP = Number(COMP_S);
const CONTROL = opt['--control'] ?? '';
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'view') die('--control: box or view');
const NO_FAST = opt['--no-fast'] === true;
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
function fileSide(flag) {
    const p = resolve(opt[flag]);
    if (!isFile(p)) die(flag + ' not found: ' + p);
    const src = readFileSync(p);
    return { src, name: 'file ' + p + ' ' + vsHead(src) };
}
let before, after;
if ('--before' in opt) before = fileSide('--before');
else {
    const ref = opt['--before-ref'] ?? 'HEAD';
    const c = String(git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(c)) die('cannot resolve --before-ref ' + ref);
    before = { src: git(['show', c + ':RingBuffer.js']), name: 'git ' + ref + ' = commit ' + c.slice(0, 7) + ':RingBuffer.js' };
}
if ('--after' in opt) after = fileSide('--after');
else {
    if (!isFile(LIVE)) die('live RingBuffer.js missing: ' + LIVE);
    const src = readFileSync(LIVE);
    after = { src, name: 'worktree RingBuffer.js ' + vsHead(src) };
}
if (before.src.length === 0 || after.src.length === 0) die('a side is empty');
const AA = sha(before.src) === sha(after.src);

// ---- stage ----------------------------------------------------------------------------------------------
const work = mkdtempSync(join(os.tmpdir(), 'lrb-copyto-ab-'));
if (!KEEP) process.on('exit', () => { rmSync(work, { recursive: true, force: true }); });
const sides = { before, after };
for (const key of ['before', 'after']) {
    const s = sides[key];
    mkdirSync(join(work, key));
    s.path = join(work, key, 'RingBuffer.mjs');
    writeFileSync(s.path, s.src);
    s.sha8 = sha(s.src).slice(0, 8);
    if (sha(readFileSync(s.path)) !== sha(s.src)) die('staging ' + key + ' did not round-trip');
    process.stdout.write('side ' + key.padEnd(6) + ' sha256/8 ' + s.sha8 + '  ' + s.name + '\n');
}
if (AA) process.stdout.write('A/A: before and after are identical bytes\n');
process.stdout.write('work ' + work + (KEEP ? ' (kept)' : ' (removed on exit; --keep keeps it)') + '\n');
try { mkdirSync(OUT, { recursive: true }); } catch (e) { die('--out: cannot create ' + OUT + ': ' + e.message); }

// ---- run ------------------------------------------------------------------------------------------------
const configs = [];
for (const s of SIZES) for (const dst of ['f32', 'f64']) for (const layout of ['contig', 'wrap', 'part']) configs.push({ n: Number(s), dst, layout });
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
            '--before', before.path, '--before-sha8', before.sha8, '--after', after.path, '--after-sha8', after.sha8,
            '--n', String(cfg.n), '--dst', cfg.dst, '--layout', cfg.layout, '--K', K];
        if (NO_FAST) args.push('--no-fast');
        if (CONTROL) args.push('--control', CONTROL);
        const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, maxBuffer: 1 << 24, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' });
        const tag = cfg.n + '/' + cfg.dst + '/' + cfg.layout + ' comp ' + (c + 1);
        if (r.status === 2) die('probe usage error (' + tag + '): ' + String(r.stderr).trim());
        let j = null;
        if (r.status === 0 && r.signal === null) {
            try { j = JSON.parse(r.stdout); } catch { j = null; }
        }
        if (j && j.n === cfg.n && j.dst === cfg.dst && j.layout === cfg.layout && j.sha8 && j.sha8.before === before.sha8 && j.sha8.after === after.sha8) {
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
const J = judge({ configs, runs, comp: COMP, fast: !NO_FAST, host, crashed });
const tier = J.exit === 0 ? 'STATISTICAL (QUIET host, all checks ok)' : J.exit === 2 ? 'PRELIMINARY / NO VERDICT' : 'VOID';
const p0 = runs.find((r) => r.length)?.[0] || {};
let md = '### copyto-ab -- ' + tier + ' -- exit ' + J.exit + '\n\n';
md += 'Provenance: ' + t0.toISOString() + ' .. ' + t1.toISOString() + ' (' + f((t1 - t0) / 1000, 1) + ' s); ' +
    os.cpus()[0].model + ', ' + os.cpus().length + ' cores; Node ' + (p0.node || process.version) + ' / V8 ' + (p0.v8 || process.versions.v8) +
    '; before ' + before.sha8 + ' ' + before.name + '; after ' + after.sha8 + ' ' + after.name + (AA ? ' (A/A)' : '') +
    '; QUIET_LOCK_HOST ' + host + '; QUIET_LOCK_WHY ' + (hostWhy || '-') + '; load1 start ' + f(loadStart) + ', end ' + f(loadEnd) +
    '; K=' + K + ' x comp ' + COMP + '; fast ' + (NO_FAST ? 'off (--no-fast)' : 'on') + (CONTROL ? '; control ' + CONTROL : '') + '.\n\n';
const fs = !NO_FAST;
md += '| n | dst | layout | BEFORE ns | CAND ns | CAND/BEFORE med [Q1..Q3] | per-comp med |' + (fs ? ' FAST ns | FAST/BEFORE med | CAND/FAST med |' : '') +
    ' AA med | SLOW/CAND med (q1) | B/op BEFORE / CAND / CAND_AA / SLOW' + (fs ? ' / FAST' : '') + ' / VIEW / BOX (max over comps) | verdict |\n';
md += '|---|---|---|---|---|---|---|' + (fs ? '---|---|---|' : '') + '---|---|---|---|\n';
const mx = (a) => (a.some((x) => Number.isNaN(x)) ? NaN : Math.max(...a));
for (const r of J.rows) {
    const cells = [r.n, r.dst, r.layout, f(r.ns.BEFORE, 1), f(r.ns.CAND, 1),
        f(r.st.CAND_BEFORE.med) + ' [' + f(r.st.CAND_BEFORE.q1) + '..' + f(r.st.CAND_BEFORE.q3) + ']',
        r.perComp.map((x) => f(x)).join(' / ')];
    if (fs) cells.push(f(r.ns.FAST, 1), f(r.st.FAST_BEFORE.med), f(r.st.CAND_FAST.med));
    cells.push(f(r.st.AA.med, 3), f(r.st.SLOW_CAND.med) + ' (' + f(r.st.SLOW_CAND.q1) + ')',
        ['BEFORE', 'CAND', 'CAND_AA', 'SLOW'].concat(fs ? ['FAST'] : [], ['VIEW', 'BOX']).map((k) => f(mx(r.bop[k]), 2)).join(' / '),
        r.verdict + (r.voidWhy.length ? ' (' + r.voidWhy.join('; ') + ')' : '') + (r.bandWhy.length ? ' (' + r.bandWhy.join('; ') + ')' : ''));
    md += '| ' + cells.join(' | ') + ' |\n';
}
md += '\nJudge: exit ' + J.exit + (J.why.length ? '\n' + J.why.map((w) => '- ' + w).join('\n') : ' (no findings)') + '\n';
writeFileSync(join(OUT, 'ab.json'), JSON.stringify({ t0, t1, host, hostWhy, loadStart, loadEnd, K: Number(K), comp: COMP, fast: !NO_FAST,
    control: CONTROL, before: { sha8: before.sha8, name: before.name }, after: { sha8: after.sha8, name: after.name }, aa: AA,
    exit: J.exit, why: J.why, rows: J.rows, raw: runs }, null, 1));
writeFileSync(join(OUT, 'ab.md'), md);
process.stdout.write(md);
process.stdout.write('copyto-ab: exit ' + J.exit + (KEEP ? '; work dir kept: ' + work : '') + '\n');
process.exit(J.exit);
