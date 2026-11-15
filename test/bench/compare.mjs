// compare.mjs -- `npm run bench:compare`: the public comparison bench (B1). Tier: REPORTED (docs only, with
// provenance); the QUOTE-OP / QUOTE-PUSH lines are what the README may cite. Dev-only: never part of
// `npm test` / `npm run verify`. A quotable run holds the strict quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-ring-buffer B1" -- \
//        node <abs>/test/bench/compare.mjs --out <abs>/.handoff/B1/strict-1
//
//   node test/bench/compare.mjs [--out DIR] [--K 21] [--comp 3] [--control box|aa|slow] [--keep]
//   node test/bench/compare.mjs --smoke [--out DIR] [--control box|aa|slow] [--keep]
//   node test/bench/compare.mjs --self-test
//
// Sides: RingBuffer = `git show HEAD:RingBuffer.js`, staged into a fresh mkdtemp dir `lrb-compare-*` as
// RingBuffer.mjs (removed on exit, also on SIGINT / SIGTERM, unless --keep; probes are spawned async so a
// signal is handled between and during probes: the running probe is killed, then the dir is removed); RingDeque = the installed
// devDependency @zakkster/lite-o1 (>= 1.11.3), resolved here and passed to the probe with its sha256/8
// (the probe fails closed on a mismatch).
// Rows: push, get, copyto32, copyto1024, wrap-step, wrap-push (see compare-probe.mjs) x --comp compilations,
// each a fresh `node --allow-natives-syntax --expose-gc test/bench/compare-probe.mjs` process,
// compilation-major. --smoke = K 5 x 1 compilation, reps capped at 1e5.
// Statistic: per row and column, type-7 median and [Q1..Q3] of the pooled K x comp paired per-round ratios
// COL/REF; per-compilation medians (D16); MODES flag when a column's per-compilation ns/op max/min >= 1.5
// (D17, REPORTED only).
// A row is VOID on: a crash / missing compilation; TurboFan calibration false or a driver not TurboFan; an
// oracle (before or after timing), mutant, uniqueSrc, sameTpl or wrapOnly failure; B/op not < 8 on REF,
// REF_AA or SLOW (REF is MASK on the wrap rows); BOX or GET B/op outside 12..20; A/A (REF_AA/REF) median
// outside 0.93..1.07; SLOW/REF not (median >= 1.5 and Q1 >= 1.3); a ratio not measured (NaN).
// --smoke turns the two timing bands into "BAND (smoke)" reasons (row stays VALID); the report is headed
// "SMOKE: not quotable".
// Exit 0 = every row VALID on a QUIET host (QUIET_LOCK_HOST=quiet from quiet-lock.mjs); 1 = any VOID (or a
// red self-test); 2 = usage / git / staging error or host not quiet.
// The judge is pure; NaN (and a JSON null) fails every comparison. --self-test runs its synthetic cases;
// every real run runs them first, before any spawn.
// Writes DIR/compare.json and DIR/compare.md; DIR = --out (new or empty), else ROOT/.handoff/B1/compare-<ISO>/.
// Test tooling only: not shipped.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PROBE = join(HERE, 'compare-probe.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const PROBE_TIMEOUT_MS = 900000;
const O1_MIN = [1, 11, 3];

// ---- judge constants ----------------------------------------------------------------------------------
const BOP_MAX = 8;            // half a 16 B box: REF, REF_AA, SLOW must read below it
const BOX_LO = 12;            // one HeapNumber per call (16 B on Node) -> 12..20
const BOX_HI = 20;
const AA_LO = 0.93;
const AA_HI = 1.07;
const SLOW_MED_MIN = 1.5;
const SLOW_Q1_MIN = 1.3;
const MODES_RATIO = 1.5;
const ROWS = {
    push: { label: 'push n1024', ref: 'RB', aa: 'RB_AA', cols: ['RB', 'RB_AA', 'F32H', 'ARR', 'DEQ', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'sameTpl', boxCols: [] },
    get: { label: 'get n1024', ref: 'GOD', aa: 'GOD_AA', cols: ['GOD', 'GOD_AA', 'GET', 'F32H', 'ARR', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_GET', 'MUT_OBO'], tpl: 'sameTpl', boxCols: ['GET'] },
    copyto32: { label: 'copyto32 (full, head n/2, Float32 dst)', ref: 'RB', aa: 'RB_AA', cols: ['RB', 'RB_AA', 'F32H', 'ARR', 'DEQ', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'sameTpl', boxCols: [] },
    copyto1024: { label: 'copyto1024 (full, head n/2, Float32 dst)', ref: 'RB', aa: 'RB_AA', cols: ['RB', 'RB_AA', 'F32H', 'ARR', 'DEQ', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'sameTpl', boxCols: [] },
    'wrap-step': { label: 'wrap-step n1024', ref: 'MASK', aa: 'MASK_AA', cols: ['MASK', 'MASK_AA', 'MOD', 'MOD_NP2', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'wrapOnly', boxCols: [] },
    'wrap-push': { label: 'wrap-push n1024', ref: 'MASK', aa: 'MASK_AA', cols: ['MASK', 'MASK_AA', 'MOD', 'MOD_NP2', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'wrapOnly', boxCols: [] },
};
const ROW_LIST = Object.keys(ROWS);
const COL_NOTE = {
    RB: 'RingBuffer method', GOD: 'getOrDefault(i, 0)', GET: 'get(i)', F32H: 'hand-rolled Float32Array ring',
    ARR: 'hand-rolled Array ring', DEQ: 'RingDeque, emulated', MASK: '& mask', MOD: '% capacity n (pow2, same capacity as MASK)',
    MOD_NP2: '% capacity n - 1 (not pow2)', SLOW: 'control: REF twice', BOX: 'control: REF + one box',
};

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
function judgeRow(row, rs, comp, smoke) {
    const S = ROWS[row];
    const rounds = (r) => (Array.isArray(r.rounds) ? r.rounds : []);
    const ratioOf = (r, k) => rounds(r).map((x) => num(x[k]) / num(x[S.ref]));
    const others = S.cols.filter((k) => k !== S.ref);
    const st = {}, perComp = {};
    for (const k of others) {
        st[k] = stat(rs.flatMap((r) => ratioOf(r, k)));
        perComp[k] = rs.map((r) => q(ratioOf(r, k), 0.5));
    }
    const ns = Object.fromEntries(S.cols.map((k) => [k, q(rs.flatMap((r) => rounds(r).map((x) => num(x[k]))), 0.5)]));
    const perCompNs = Object.fromEntries(S.cols.map((k) => [k, rs.map((r) => q(rounds(r).map((x) => num(x[k])), 0.5))]));
    const modes = Object.fromEntries(S.cols.map((k) => {
        const v = perCompNs[k];
        const lo = Math.min(...v), hi = Math.max(...v);
        return [k, v.length > 1 && v.every((x) => x > 0) && hi / lo >= MODES_RATIO];
    }));
    const lanes = S.cols.concat(['BOX']);
    const bop = Object.fromEntries(lanes.map((k) => [k, rs.map((r) => num(r.bop && r.bop[k]))]));
    const ck = (r) => (r.checks && typeof r.checks === 'object' ? r.checks : {});
    const v = [];
    const b = [];
    if (rs.length !== comp) v.push('only ' + rs.length + '/' + comp + ' compilations');
    if (!rs.every((r) => Array.isArray(r.rounds) && r.rounds.length >= 5 && r.rounds.length === r.K)) v.push('rounds missing or short');
    if (!rs.every((r) => ck(r).tfCalib === true)) v.push('TurboFan bit 32 calibration');
    if (!rs.every((r) => ck(r).turbofan === true)) v.push('driver not TurboFan');
    const okMap = (m, keys) => m !== null && typeof m === 'object' && keys.every((k) => m[k] === true);
    if (!rs.every((r) => okMap(ck(r).oracle, S.cols))) v.push('oracle before timing');
    if (!rs.every((r) => okMap(ck(r).oracleAfter, S.cols))) v.push('oracle after timing');
    for (const m of S.mutants) if (!rs.every((r) => ck(r).mutants && ck(r).mutants[m] === true)) v.push(m + ' not caught');
    if (!rs.every((r) => ck(r).uniqueSrc === true)) v.push('uniqueSrc');
    if (!rs.every((r) => ck(r)[S.tpl] === true)) v.push(S.tpl);
    const gate0 = [['REF ' + S.ref, S.ref], ['REF_AA ' + S.aa, S.aa], ['SLOW', 'SLOW']];
    for (const [nm, k] of gate0) {
        const bad = bop[k].filter((x) => !(x < BOP_MAX));
        if (bad.length || !bop[k].length) v.push(nm + ' B/op ' + bad.map((x) => f(x)).join(',') + ' not < ' + BOP_MAX);
    }
    for (const k of ['BOX'].concat(S.boxCols)) {
        const bad = bop[k].filter((x) => !(x >= BOX_LO && x <= BOX_HI));
        if (bad.length || !bop[k].length) v.push(k + ' B/op ' + bad.map((x) => f(x)).join(',') + ' outside ' + BOX_LO + '..' + BOX_HI);
    }
    for (const k of others) if (!(st[k].q1 <= st[k].med && st[k].med <= st[k].q3 && Number.isFinite(st[k].q3) && st[k].q1 > 0) ||
        !rs.every((r) => ratioOf(r, k).every((x) => Number.isFinite(x) && x > 0))) v.push(k + '/' + S.ref + ' not measured (NaN, 0 or Infinity)');
    const aa = st[S.aa], sl = st.SLOW;
    const band = [];
    if (!(aa.med >= AA_LO && aa.med <= AA_HI)) band.push('A/A ' + f(aa.med, 3) + ' outside ' + AA_LO + '..' + AA_HI);
    if (!(sl.med >= SLOW_MED_MIN && sl.q1 >= SLOW_Q1_MIN)) band.push('SLOW ' + f(sl.med) + ' q1 ' + f(sl.q1) + ' not (>= ' + SLOW_MED_MIN + ', q1 >= ' + SLOW_Q1_MIN + ')');
    for (const w of band) (smoke ? b : v).push(smoke ? 'BAND (smoke): ' + w : w);
    const verdict = v.length ? 'VOID' : 'VALID';
    return { row, label: S.label, ref: S.ref, aa: S.aa, cols: S.cols, verdict, st, perComp, ns, perCompNs, modes, bop, voidWhy: v, bandWhy: b };
}
// input: { rows: [row name], runs: [[probe JSON per compilation] per row], comp, smoke, host, crashed }
function judge(input) {
    const rows = input.rows.map((row, i) => judgeRow(row, input.runs[i] || [], input.comp, input.smoke === true));
    const voidHit = !(input.crashed === 0) || rows.some((r) => r.voidWhy.length > 0);
    const quiet = input.host === 'quiet';
    const exit = voidHit ? 1 : !quiet ? 2 : 0;
    const why = [];
    if (!(input.crashed === 0)) why.push(String(input.crashed) + ' probe crash(es)');
    for (const r of rows) {
        for (const w of r.voidWhy) why.push('VOID ' + r.row + ': ' + w);
        for (const w of r.bandWhy) why.push(r.row + ': ' + w);
    }
    if (!quiet) why.push('HOST ' + String(input.host) + ' (not quiet): no verdict');
    return { exit, rows, why };
}

// ---- report rendering (pure) --------------------------------------------------------------------------
const mx = (a) => (!a.length || a.some((x) => Number.isNaN(x)) ? NaN : Math.max(...a));
const rq = (s, d = 3) => f(s.med, d) + ' [' + f(s.q1, d) + '..' + f(s.q3, d) + ']';
function renderRow(r) {
    const V = r.verdict === 'VOID';
    let md = '#### ' + r.label + ' -- ' + r.verdict + (r.voidWhy.length ? ' (' + r.voidWhy.join('; ') + ')' : '') +
        (r.bandWhy.length ? ' [' + r.bandWhy.join('; ') + ']' : '') + '\n\n';
    md += '| column | what | ns/op med | COL/REF med [Q1..Q3] | per-comp COL/REF med | per-comp ns/op med | max B/op | modes |\n';
    md += '|---|---|---|---|---|---|---|---|\n';
    for (const k of r.cols.concat(['BOX'])) {
        const tag = k === r.ref ? ' (REF)' : k === r.aa ? ' (A/A)' : k === 'DEQ' ? '*' : '';
        const what = k === r.aa ? 'twin of ' + r.ref : (COL_NOTE[k] || '');
        let ratio, pc;
        if (k === 'BOX') { ratio = '-'; pc = '-'; }
        else if (V) { ratio = 'VOID'; pc = 'VOID'; }
        else if (k === r.ref) { ratio = '1 (reference)'; pc = '-'; }
        else { ratio = rq(r.st[k]); pc = r.perComp[k].map((x) => f(x, 3)).join(' / '); }
        const nsC = k === 'BOX' ? '-' : V ? 'VOID' : f(r.ns[k], 2);
        const pcn = k === 'BOX' ? '-' : V ? 'VOID' : r.perCompNs[k].map((x) => f(x, 2)).join(' / ');
        const modes = k === 'BOX' ? '-' : r.modes[k] ? 'MODES' : '-';
        md += '| ' + [k + tag, what, nsC, ratio, pc, pcn, f(mx(r.bop[k]), 2), modes].join(' | ') + ' |\n';
    }
    if (r.row === 'get') md += '\nRingDeque: N/A (no indexed read).\n';
    return md + '\n';
}
function renderQuote(rows, out, smoke, host) {
    const lines = [];
    for (const [tag, row] of [['QUOTE-OP', 'wrap-step'], ['QUOTE-PUSH', 'wrap-push']]) {
        const r = rows.find((x) => x.row === row);
        if (!r) continue;
        const cell = (k) => (r.verdict === 'VOID' ? k + '/MASK VOID' : k + '/MASK ' + rq(r.st[k]) + ', per-compilation ' + r.perComp[k].map((x) => f(x, 3)).join(' / ')) +
            ' (' + COL_NOTE[k] + ')';
        lines.push(tag + (smoke ? ' (SMOKE: not quotable)' : '') + (host !== 'quiet' ? ' (PRELIMINARY: host ' + String(host) + ', not quotable)' : '') + ' (' + r.label + '): ' + cell('MOD') + '; ' + cell('MOD_NP2') +
            '; verdict ' + r.verdict + '; run dir ' + out);
    }
    return lines;
}

// ---- self-test: synthetic cases on both sides of every boundary, a NaN and a null per field --------------
function synthRun(row, o = {}) {
    const S = ROWS[row];
    const rounds = [];
    for (let k = 0; k < 7; k++) {
        const j = (k - 3) * 0.001;
        const x = {};
        for (const c of S.cols) x[c] = 100 * (1 - j) * 1.2;
        x[S.ref] = 100 * (1 - j);
        x[S.aa] = 100 * (1 - j) * (o.aa ?? 1);
        x.SLOW = 100 * (1 - j) * (o.slow ?? 2);
        if (k < 2 && o.slowLow !== undefined) x.SLOW = 100 * (1 - j) * o.slowLow;
        for (const [col, fac] of Object.entries(o.scale || {})) x[col] *= fac;
        if (o.round && k === 0) x[o.round[0]] = o.round[1];
        rounds.push(x);
    }
    const bop = { BOX: 16 };
    for (const c of S.cols) bop[c] = 0;
    for (const c of S.boxCols) bop[c] = 16;
    Object.assign(bop, o.bop || {});
    const all = (v) => Object.fromEntries(S.cols.map((c) => [c, v]));
    const checks = {
        tfCalib: true, turbofan: true, uniqueSrc: true, [S.tpl]: true,
        oracle: all(true), oracleAfter: all(true), mutants: Object.fromEntries(S.mutants.map((m) => [m, true])),
    };
    if (o.checks) o.checks(checks);
    const out = { row, K: 7, rounds, bop, checks };
    if (o.noRounds) delete out.rounds;
    if (o.shortRounds) out.rounds = rounds.slice(0, 6);
    return out;
}
function selfTest() {
    const one = (row, o = {}, x = {}) => judge({
        rows: [row], runs: [[synthRun(row, o), synthRun(row, x.perComp2 || o)]], comp: x.comp ?? 2,
        smoke: x.smoke ?? false, host: 'host' in x ? x.host : 'quiet', crashed: 'crashed' in x ? x.crashed : 0,
    });
    const has = (J, s) => J.why.some((w) => w.includes(s));
    const cases = [];
    const c = (name, want, fn, pred) => cases.push([name, want, fn, pred]);
    for (const row of ROW_LIST) c('baseline ' + row + ' quiet -> 0', 0, () => one(row));
    c('host preliminary -> 2', 2, () => one('push', {}, { host: 'preliminary' }));
    c('host unlocked -> 2', 2, () => one('push', {}, { host: 'unlocked' }));
    c('host undefined -> 2', 2, () => one('push', {}, { host: undefined }));
    c('host null -> 2', 2, () => one('push', {}, { host: null }));
    c('AA 0.9301 in -> 0', 0, () => one('push', { aa: 0.9301 }));
    c('AA 0.929 out -> 1', 1, () => one('push', { aa: 0.929 }), (J) => has(J, 'A/A'));
    c('AA 1.0699 in -> 0', 0, () => one('get', { aa: 1.0699 }));
    c('AA 1.071 out -> 1', 1, () => one('get', { aa: 1.071 }));
    c('AA NaN round -> 1', 1, () => one('push', { round: ['RB_AA', NaN] }));
    c('AA null round -> 1', 1, () => one('wrap-step', { round: ['MASK_AA', null] }));
    c('SLOW med 1.5005 -> 0', 0, () => one('push', { slow: 1.5005 }));
    c('SLOW med 1.49 -> 1', 1, () => one('push', { slow: 1.49 }), (J) => has(J, 'SLOW 1.49'));
    c('SLOW q1 1.31 in -> 0', 0, () => one('push', { slow: 2, slowLow: 1.31 }));
    c('SLOW q1 1.0 out -> 1', 1, () => one('push', { slow: 1.6, slowLow: 1.0 }));
    c('SLOW NaN round -> 1', 1, () => one('push', { round: ['SLOW', NaN] }));
    c('SLOW null round -> 1', 1, () => one('copyto32', { round: ['SLOW', null] }));
    c('REF NaN round -> 1', 1, () => one('push', { round: ['RB', NaN] }));
    c('REF null round -> 1', 1, () => one('get', { round: ['GOD', null] }));
    c('DEQ NaN round -> 1', 1, () => one('push', { round: ['DEQ', NaN] }), (J) => has(J, 'DEQ/RB not measured'));
    c('DEQ null round -> 1', 1, () => one('copyto1024', { round: ['DEQ', null] }));
    c('MOD NaN round -> 1', 1, () => one('wrap-step', { round: ['MOD', NaN] }));
    c('MOD_NP2 null round -> 1', 1, () => one('wrap-push', { round: ['MOD_NP2', null] }));
    c('F32H NaN round -> 1', 1, () => one('get', { round: ['F32H', NaN] }));
    c('GET null round -> 1', 1, () => one('get', { round: ['GET', null] }));
    // B/op: REF / REF_AA / SLOW < 8 (MASK is REF on the wrap rows)
    for (const [row, k] of [['push', 'RB'], ['push', 'RB_AA'], ['push', 'SLOW'], ['wrap-step', 'MASK'], ['get', 'GOD_AA']]) {
        c(row + ' ' + k + ' B/op 7.99 -> 0', 0, () => one(row, { bop: { [k]: 7.99 } }));
        c(row + ' ' + k + ' B/op 8 -> 1', 1, () => one(row, { bop: { [k]: 8 } }));
        c(row + ' ' + k + ' B/op NaN -> 1', 1, () => one(row, { bop: { [k]: NaN } }));
        c(row + ' ' + k + ' B/op null -> 1', 1, () => one(row, { bop: { [k]: null } }));
    }
    c('REF B/op names REF', 1, () => one('copyto32', { bop: { RB: 16 } }), (J) => has(J, 'REF RB B/op 16.00'));
    for (const [row, k] of [['push', 'BOX'], ['get', 'GET']]) {
        c(row + ' ' + k + ' 12 in -> 0', 0, () => one(row, { bop: { [k]: 12 } }));
        c(row + ' ' + k + ' 11.99 out -> 1', 1, () => one(row, { bop: { [k]: 11.99 } }));
        c(row + ' ' + k + ' 20 in -> 0', 0, () => one(row, { bop: { [k]: 20 } }));
        c(row + ' ' + k + ' 20.01 out -> 1', 1, () => one(row, { bop: { [k]: 20.01 } }));
        c(row + ' ' + k + ' NaN -> 1', 1, () => one(row, { bop: { [k]: NaN } }));
        c(row + ' ' + k + ' null -> 1', 1, () => one(row, { bop: { [k]: null } }));
    }
    c('F32H B/op 16 is not gated -> 0', 0, () => one('push', { bop: { F32H: 16, DEQ: 16 } }));
    // checks: false, null, missing
    const chk = (name, row, fn, want = 1) => c(name, want, () => one(row, { checks: fn }));
    chk('tfCalib false -> 1', 'push', (k) => { k.tfCalib = false; });
    chk('tfCalib null -> 1', 'push', (k) => { k.tfCalib = null; });
    chk('turbofan false -> 1', 'get', (k) => { k.turbofan = false; });
    chk('turbofan missing -> 1', 'get', (k) => { delete k.turbofan; });
    chk('oracle F32H false -> 1', 'push', (k) => { k.oracle.F32H = false; });
    chk('oracle null -> 1', 'push', (k) => { k.oracle = null; });
    chk('oracleAfter DEQ false -> 1', 'copyto32', (k) => { k.oracleAfter.DEQ = false; });
    chk('oracleAfter SLOW missing -> 1', 'wrap-push', (k) => { delete k.oracleAfter.SLOW; });
    chk('MUT_WRAP missed -> 1', 'wrap-step', (k) => { k.mutants.MUT_WRAP = false; });
    chk('MUT_OBO null -> 1', 'copyto1024', (k) => { k.mutants.MUT_OBO = null; });
    chk('MUT_GET missing on get -> 1', 'get', (k) => { delete k.mutants.MUT_GET; });
    chk('mutants null -> 1', 'push', (k) => { k.mutants = null; });
    chk('uniqueSrc false -> 1', 'push', (k) => { k.uniqueSrc = false; });
    chk('uniqueSrc null -> 1', 'wrap-step', (k) => { k.uniqueSrc = null; });
    chk('sameTpl false -> 1', 'get', (k) => { k.sameTpl = false; });
    chk('wrapOnly false -> 1', 'wrap-push', (k) => { k.wrapOnly = false; });
    chk('wrapOnly missing -> 1', 'wrap-step', (k) => { delete k.wrapOnly; });
    chk('checks null -> 1', 'push', (k) => { for (const key of Object.keys(k)) delete k[key]; });
    c('missing compilation -> 1', 1, () => one('push', {}, { comp: 3 }));
    c('probe crash -> 1', 1, () => one('push', {}, { crashed: 1 }));
    c('crashed NaN -> 1', 1, () => one('push', {}, { crashed: NaN }));
    c('crashed null -> 1', 1, () => one('push', {}, { crashed: null }));
    c('void beats host -> 1', 1, () => one('push', { bop: { RB: 16 } }, { host: 'preliminary' }));
    // smoke downgrade: the two timing bands become BAND (smoke) reasons, the row stays VALID
    c('smoke AA out -> 0 + BAND (smoke)', 0, () => one('push', { aa: 0.5 }, { smoke: true }),
        (J) => J.rows[0].verdict === 'VALID' && has(J, 'BAND (smoke): A/A'));
    c('smoke SLOW out -> 0 + BAND (smoke)', 0, () => one('wrap-step', { slow: 1.0 }, { smoke: true }),
        (J) => J.rows[0].verdict === 'VALID' && has(J, 'BAND (smoke): SLOW'));
    c('smoke band + preliminary -> 2', 2, () => one('push', { slow: 1.0 }, { smoke: true, host: 'preliminary' }));
    c('smoke does not downgrade B/op -> 1', 1, () => one('push', { bop: { RB: 16 } }, { smoke: true }));
    c('smoke does not downgrade a NaN ratio -> 1', 1, () => one('push', { round: ['ARR', NaN] }, { smoke: true }));
    // MODES (reported only): per-compilation ns max/min >= 1.5
    c('MODES 1.5 flagged, exit 0', 0, () => one('push', {}, { perComp2: { scale: { F32H: 1.5 } } }),
        (J) => J.rows[0].modes.F32H === true && J.rows[0].modes.RB === false);
    c('MODES 1.49 not flagged, exit 0', 0, () => one('push', {}, { perComp2: { scale: { F32H: 1.49 } } }),
        (J) => J.rows[0].modes.F32H === false);
    // VOID-cell masking: a VOID row prints VOID in every ratio cell, and no ratio number
    c('VOID row masks every ratio cell', 1, () => one('push', { bop: { RB: 16 } }), (J) => {
        const md = renderRow(J.rows[0]);
        const rowsMd = md.split('\n').filter((l) => /^\| (RB|RB_AA|F32H|ARR|DEQ|SLOW)/.test(l));
        return rowsMd.length === 6 && rowsMd.every((l) => { const p = l.split(' | '); return p[3] === 'VOID' && p[4] === 'VOID'; }) && !md.includes('1.200');
    });
    c('VALID row prints ratios, no VOID cell', 0, () => one('push'), (J) => {
        const md = renderRow(J.rows[0]);
        return md.includes('1.200 [') && !md.includes('| VOID |');
    });
    c('VOID quote masks both ratios', 1, () => one('wrap-step', { bop: { MASK: 16 } }), (J) => {
        const L = renderQuote(J.rows, '/x', false, 'quiet');
        return L.length === 1 && L[0].includes('MOD/MASK VOID') && L[0].includes('MOD_NP2/MASK VOID') && !L[0].includes('1.200');
    });
    c('VALID quote prints ratios', 0, () => one('wrap-push'), (J) => {
        const L = renderQuote(J.rows, '/x', true, 'quiet');
        return L.length === 1 && L[0].startsWith('QUOTE-PUSH (SMOKE: not quotable)') && L[0].includes('MOD/MASK 1.200 [');
    });
    c('rounds missing in comp 2 -> 1', 1, () => one('push', {}, { perComp2: { noRounds: true } }), (J) => has(J, 'rounds missing or short'));
    c('rounds short in comp 2 -> 1', 1, () => one('wrap-step', {}, { perComp2: { shortRounds: true } }), (J) => has(J, 'rounds missing or short'));
    c('0 ns REF round -> 1', 1, () => one('push', { round: ['RB', 0] }), (J) => has(J, 'not measured'));
    c('0 ns COL round -> 1', 1, () => one('get', { round: ['ARR', 0] }), (J) => has(J, 'ARR/GOD not measured'));
    c('VOID row masks ns cells', 1, () => one('push', { bop: { RB: 16 } }), (J) => {
        const rowsMd = renderRow(J.rows[0]).split('\n').filter((l) => /^\| (RB|RB_AA|F32H|ARR|DEQ|SLOW)/.test(l));
        return rowsMd.length === 6 && rowsMd.every((l) => { const p = l.split(' | '); return p[2] === 'VOID' && p[5] === 'VOID'; });
    });
    c('preliminary host quote not quotable', 2, () => one('wrap-step', {}, { host: 'preliminary' }), (J) => {
        const L = renderQuote(J.rows, '/x', false, 'preliminary');
        const U = renderQuote(J.rows, '/x', false, undefined);
        return L.length === 1 && L[0].startsWith('QUOTE-OP (PRELIMINARY: host preliminary, not quotable)') && U[0].includes('(PRELIMINARY: host undefined, not quotable)') &&
            L[0].includes('(% capacity n (pow2, same capacity as MASK))') && L[0].includes('(% capacity n - 1 (not pow2))');
    });
    c('quiet host quote has no PRELIMINARY tag', 0, () => one('wrap-step'), (J) => !renderQuote(J.rows, '/x', false, 'quiet')[0].includes('PRELIMINARY'));
    let pass = 0;
    const lines = [];
    for (const [name, want, fn, pred] of cases) {
        let got, ok;
        try {
            const J = fn();
            got = J.exit;
            ok = got === want && (pred ? pred(J) === true : true);
        } catch (e) { got = 'throw ' + e.message; ok = false; }
        if (ok) pass++;
        lines.push((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' (got ' + got + ')'));
    }
    const qs = [q([5, 1, 3, 2, 4], 0.25), q([5, 1, 3, 2, 4], 0.5), q([1, 2, 3, 4], 0.5)];
    const qok = qs[0] === 2 && qs[1] === 3 && qs[2] === 2.5 && Number.isNaN(q([1, NaN], 0.5)) && Number.isNaN(q([], 0.5));
    lines.push((qok ? 'ok   ' : 'FAIL ') + 'type-7 quantile + NaN');
    if (qok) pass++;
    const total = cases.length + 1;
    return { ok: pass === total, pass, total, lines };
}

// ---- options ------------------------------------------------------------------------------------------
function die(msg) {
    process.stderr.write('compare: ' + msg + '\ncompare: exit 2 (usage / git / staging)\n');
    process.exit(2);
}
const VALUE_OPTS = ['--out', '--K', '--comp', '--control'];
const FLAG_OPTS = ['--smoke', '--keep', '--self-test'];
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
    process.stdout.write('compare self-test: ' + ST.pass + '/' + ST.total + ' checks ' + (ST.ok ? 'ok' : 'FAILED') + '\n');
    process.exit(ST.ok ? 0 : 1);
}
if (!ST.ok) {
    for (const l of ST.lines) if (l.startsWith('FAIL')) process.stderr.write(l + '\n');
    process.stderr.write('compare: self-test red (' + ST.pass + '/' + ST.total + '): exit 1\n');
    process.exit(1);
}
process.stdout.write('compare self-test: ' + ST.pass + '/' + ST.total + ' checks ok\n');

const SMOKE = opt['--smoke'] === true;
if (SMOKE && ('--K' in opt || '--comp' in opt)) die('--smoke fixes K 5 x 1 compilation; drop --K / --comp');
const K = SMOKE ? '5' : (opt['--K'] ?? '21');
if (!/^[0-9]+$/.test(K) || !(Number(K) >= 5 && Number(K) <= 1001)) die('--K: want an integer 5..1001');
const COMP_S = SMOKE ? '1' : (opt['--comp'] ?? '3');
if (!/^[0-9]+$/.test(COMP_S) || !(Number(COMP_S) >= 1 && Number(COMP_S) <= 10)) die('--comp: want an integer 1..10');
const COMP = Number(COMP_S);
const CONTROL = opt['--control'] ?? '';
if (CONTROL !== '' && CONTROL !== 'box' && CONTROL !== 'aa' && CONTROL !== 'slow') die('--control: box, aa or slow');
const KEEP = opt['--keep'] === true;
const T0 = new Date();
const OUT = resolve(opt['--out'] ?? join(ROOT, '.handoff', 'B1', 'compare-' + T0.toISOString().replace(/[:.]/g, '-')));
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
const rbSrc = git(['show', headFull + ':RingBuffer.js']);
if (rbSrc.length === 0) die('HEAD:RingBuffer.js is empty');
const rbSha8 = sha(rbSrc).slice(0, 8);
const liveState = isFile(LIVE) ? (sha(readFileSync(LIVE)) === sha(rbSrc) ? 'clean' : 'MODIFIED') : 'missing';

let o1Path;
try { o1Path = fileURLToPath(import.meta.resolve('@zakkster/lite-o1')); } catch (e) { die('cannot resolve @zakkster/lite-o1 (npm install): ' + e.message); }
if (!isFile(o1Path)) die('@zakkster/lite-o1 entry is not a file: ' + o1Path);
let o1Pkg;
try { o1Pkg = JSON.parse(readFileSync(join(dirname(o1Path), 'package.json'), 'utf8')); } catch (e) { die('cannot read lite-o1 package.json: ' + e.message); }
const o1Ver = String(o1Pkg && o1Pkg.version);
const o1V = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(o1Ver);
if (!o1Pkg || o1Pkg.name !== '@zakkster/lite-o1' || !o1V) die('lite-o1 package.json name / version unreadable: ' + o1Ver);
const o1Cmp = [1, 2, 3].map((i) => Number(o1V[i])).reduce((acc, x, i) => (acc !== 0 ? acc : Math.sign(x - O1_MIN[i])), 0);
if (o1Cmp < 0) die('lite-o1 ' + o1Ver + ' < ' + O1_MIN.join('.'));
const o1Sha8 = sha(readFileSync(o1Path)).slice(0, 8);

// ---- stage (removed on exit, SIGINT, SIGTERM unless --keep) -------------------------------------------
const work = mkdtempSync(join(os.tmpdir(), 'lrb-compare-'));
if (!KEEP) process.on('exit', () => { rmSync(work, { recursive: true, force: true }); });
let child = null;
const onSignal = (code) => () => { if (child) child.kill('SIGKILL'); process.exit(code); };
process.on('SIGINT', onSignal(130));
process.on('SIGTERM', onSignal(143));
// async spawn: the event loop turns while a probe runs, so a signal is handled at once
function runProbe(args) {
    return new Promise((res) => {
        let out = '', err = '', done = false;
        const fin = (status, signal, error) => { if (done) return; done = true; clearTimeout(timer); child = null; res({ status, signal, stdout: out, stderr: err, error }); };
        const ch = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        child = ch;
        const timer = setTimeout(() => ch.kill('SIGKILL'), PROBE_TIMEOUT_MS);
        ch.stdout.setEncoding('utf8');
        ch.stderr.setEncoding('utf8');
        ch.stdout.on('data', (d) => { out += d; });
        ch.stderr.on('data', (d) => { err += d; });
        ch.on('error', (e) => fin(null, null, e));
        ch.on('close', (status, signal) => fin(status, signal, null));
    });
}
const rbPath = join(work, 'RingBuffer.mjs');
writeFileSync(rbPath, rbSrc);
if (sha(readFileSync(rbPath)) !== sha(rbSrc)) die('staging RingBuffer did not round-trip');
process.stdout.write('RingBuffer   sha256/8 ' + rbSha8 + '  git HEAD ' + headFull.slice(0, 7) + ':RingBuffer.js (worktree ' + liveState + ')\n');
process.stdout.write('lite-o1      sha256/8 ' + o1Sha8 + '  ' + o1Ver + ' ' + o1Path + '\n');
process.stdout.write('work ' + work + (KEEP ? ' (kept)' : ' (removed on exit; --keep keeps it)') + '\n');
try { mkdirSync(OUT, { recursive: true }); } catch (e) { die('--out: cannot create ' + OUT + ': ' + e.message); }

function busyNodes() {
    let out = '';
    try { out = execFileSync('ps', ['-Ao', 'pid=,pcpu=,comm='], { encoding: 'utf8' }); } catch { return ['ps failed']; }
    const hits = [];
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
        if (!m || Number(m[1]) === process.pid || !/node/i.test(m[3]) || !(Number(m[2]) >= 10)) continue;
        hits.push('pid ' + m[1] + ' ' + m[2] + '% ' + m[3].trim());
    }
    return hits;
}

// ---- run ------------------------------------------------------------------------------------------------
const host = process.env.QUIET_LOCK_HOST || 'unlocked';
const hostWhy = process.env.QUIET_LOCK_WHY || '';
const loadStart = os.loadavg();
const busyStart = busyNodes();
const probeFlags = ['--allow-natives-syntax', '--expose-gc'];
const probeExtra = ['--K', K].concat(CONTROL ? ['--control', CONTROL] : [], SMOKE ? ['--smoke'] : []);
const runs = ROW_LIST.map(() => []);
let crashed = 0;
for (let cpi = 0; cpi < COMP; cpi++) {
    for (let i = 0; i < ROW_LIST.length; i++) {
        const row = ROW_LIST[i];
        const args = probeFlags.concat([PROBE, '--rb', rbPath, '--rb-sha8', rbSha8, '--o1', o1Path, '--o1-sha8', o1Sha8, '--row', row], probeExtra);
        const r = await runProbe(args);
        const tag = row + ' comp ' + (cpi + 1);
        if (r.status === 2) die('probe usage error (' + tag + '): ' + String(r.stderr).trim());
        let j = null;
        if (r.status === 0 && r.signal === null) {
            try { j = JSON.parse(r.stdout); } catch { j = null; }
        }
        if (j && j.row === row && j.sha8 && j.sha8.rb === rbSha8 && j.sha8.o1 === o1Sha8 && j.control === CONTROL && j.smoke === SMOKE && j.K === Number(K)) {
            runs[i].push(j);
            process.stdout.write('ran ' + tag + '\n');
        } else {
            crashed++;
            process.stderr.write('probe crashed: ' + tag + ' status ' + r.status + ' signal ' + r.signal + ' ' + String(r.stderr || r.error || '').slice(0, 400) + '\n');
        }
    }
}
const loadEnd = os.loadavg();
const busyEnd = busyNodes();
const T1 = new Date();

// ---- judge + write ------------------------------------------------------------------------------------
const J = judge({ rows: ROW_LIST, runs, comp: COMP, smoke: SMOKE, host, crashed });
const tier = SMOKE ? 'SMOKE: not quotable' : J.exit === 0 ? 'REPORTED (QUIET host, every row VALID)' : J.exit === 2 ? 'PRELIMINARY / NO VERDICT (host not quiet)' : 'VOID rows present';
const p0 = runs.find((r) => r.length)?.[0] || {};
const cpus = os.cpus();
const l3 = (l) => l.map((x) => f(x)).join(' / ');
let md = '### compare -- ' + tier + ' -- exit ' + J.exit + '\n\n';
md += '- Run: ' + T0.toISOString() + ' .. ' + T1.toISOString() + ' (' + f((T1 - T0) / 1000, 1) + ' s wall)\n';
md += '- Host: ' + os.type() + ' ' + os.release() + ' ' + os.arch() + '; ' + (cpus[0] ? cpus[0].model : '?') + ' x ' + cpus.length + ' cores\n';
md += '- Load1/5/15: start ' + l3(loadStart) + ', end ' + l3(loadEnd) + '\n';
md += '- Other node >= 10% CPU: start ' + (busyStart.length ? busyStart.join('; ') : 'none') + '; end ' + (busyEnd.length ? busyEnd.join('; ') : 'none') + '\n';
md += '- Node ' + (p0.node || process.version) + ' / V8 ' + (p0.v8 || process.versions.v8) + '; K ' + K + ' x ' + COMP + ' compilation(s)' + (SMOKE ? ' (smoke: reps capped 1e5)' : '') + (CONTROL ? '; control ' + CONTROL : '') + '\n';
md += '- argv: ' + JSON.stringify(process.argv.slice(1)) + '; execArgv: ' + JSON.stringify(process.execArgv) + '; probe flags: ' + probeFlags.concat(probeExtra).join(' ') + '\n';
md += '- QUIET_LOCK_HOST ' + host + ' (host quiet at start: lock-time check; end load / busy nodes recorded, not judged); QUIET_LOCK_WHY ' + (hostWhy || '-') + '\n';
md += '- RingBuffer: HEAD ' + headFull.slice(0, 7) + ', RingBuffer.js sha256/8 ' + rbSha8 + ' (worktree ' + liveState + '); lite-o1 ' + o1Ver + ', O1.js sha256/8 ' + o1Sha8 + '\n\n';
md += 'RingDeque (@zakkster/lite-o1) is a Float64 double-ended queue that throws when full or on NaN; it is measured here as a ' +
    'keep-last-N window (`if (size === capacity) popFront(); pushBack(v)`; bulk copy through `forEach` with a hoisted store ' +
    'callback). Columns marked * are such emulations. Ratios against hand-rolled columns include driver-inlining effects (D13).\n\n';
md += 'B/op resolution: < 8 = no per-call 16 B box; 0 B/op is proven only by `npm run alloc`. MODES = a column\'s per-compilation ns/op max/min >= ' + MODES_RATIO + ' (D17).\n\n';
for (const r of J.rows) md += renderRow(r);
const quotes = renderQuote(J.rows, OUT, SMOKE, host);
md += quotes.join('\n') + '\n\nJudge: exit ' + J.exit + (J.why.length ? '\n' + J.why.map((w) => '- ' + w).join('\n') : ' (no findings)') + '\n';
writeFileSync(join(OUT, 'compare.json'), JSON.stringify({ t0: T0, t1: T1, wallS: (T1 - T0) / 1000, host, hostWhy, loadStart, loadEnd, busyStart, busyEnd,
    os: { type: os.type(), release: os.release(), arch: os.arch(), cpu: cpus[0] ? cpus[0].model : '', cores: cpus.length },
    K: Number(K), comp: COMP, smoke: SMOKE, control: CONTROL, argv: process.argv.slice(1), execArgv: process.execArgv, probeFlags: probeFlags.concat(probeExtra),
    head: headFull, rbSha8, liveState, o1: { version: o1Ver, sha8: o1Sha8, path: o1Path },
    exit: J.exit, why: J.why, quotes,
    rows: J.rows.map((r) => (r.verdict === 'VOID' ? { ...r, st: 'VOID', perComp: 'VOID', ns: 'VOID', perCompNs: 'VOID' } : r)), raw: runs }, null, 1));
writeFileSync(join(OUT, 'compare.md'), md);
process.stdout.write(md);
process.stdout.write('compare: exit ' + J.exit + (KEEP ? '; work dir kept: ' + work : '') + '\n');
process.exit(J.exit);
