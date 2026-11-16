// compare.mjs -- `npm run bench:compare`: the public comparison bench (B1). Tier: REPORTED (docs only, with
// provenance); the QUOTE-OP / QUOTE-PUSH lines are what the README may cite. Dev-only: never part of
// `npm test` / `npm run verify`. A quotable run holds the strict quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run --strict "lite-ring-buffer B1" -- \
//        node <abs>/test/bench/compare.mjs --out <abs>/.handoff/bench-compare/strict-1
//
//   node test/bench/compare.mjs [--out DIR] [--K 21] [--comp 3] [--control box|aa|slow] [--keep]
//   node test/bench/compare.mjs --smoke [--out DIR] [--control box|aa|slow] [--keep]
//   node test/bench/compare.mjs --self-test
//
// Options (parseOpts, pure, self-tested; every error is exit 2 BEFORE the self-test runs): --K and --comp are
// canonical decimal integers (no sign, no leading zero, no exponent) in 5..1001 / 1..10; --control box|aa|slow;
// --smoke takes no --K / --comp; --self-test takes no other argument (each given value is validated first, so
// `--self-test --K 4` names --K). An unknown option gets a did-you-mean hint.
// Sides: RingBuffer = `git show HEAD:RingBuffer.js`, staged into a fresh mkdtemp dir `lrb-compare-*` as
// RingBuffer.mjs (removed on exit, also on SIGINT / SIGTERM, unless --keep; probes and the gc lane are spawned async,
// so a signal is handled between and during them). On SIGINT / SIGTERM (signalPlan, pure, self-tested) the signal is
// FORWARDED to the running child (so the gc lane's own handler runs and kills ITS child), compare waits up to
// SIGNAL_GRACE_MS for the child's exit, SIGKILLs it after that (or on a second signal), then exits 130 / 143 and the
// dir is removed. A probe / gc lane past PROBE_TIMEOUT_MS takes the same forward / wait / SIGKILL path (timeoutPlan,
// pure, self-tested: SIGTERM forwarded, SIGKILL after SIGNAL_GRACE_MS if it has not exited), so a timed-out gc lane
// also kills ITS child. A timed-out probe / gc lane counts as crashed / VOID ("timed out" on stderr), even if it
// exits 0 with valid output or exits 2: ranClean (pure, self-tested) requires timedOut === false before any output
// is read, and only a NOT timed-out exit 2 is a usage error. RingDeque = the installed devDependency
// @zakkster/lite-o1 (>= 1.11.3), resolved here and passed to the probe with its sha256/8
// (the probe fails closed on a mismatch); MN / MN_TA = the devDependency mnemonist, EXACT 0.40.8 (mn-pin.mjs):
// circular-buffer.js is resolved with createRequire from ROOT/package.json (its subpaths are require-only),
// never required here, and checked by mnCheck(ROOT/node_modules) (name, version, combined digest ===
// MN_SHA256) before anything is staged; the probe gets `--mn FILE --mn-sha8 MN_SHA256/8`.
// CHK = F32H's loop plus RingBuffer's own argument checks (text copy); push / get / copy rows require the
// probe's chkTpl (and chkArgs on get / copy) checks === true, and CHK B/op < 8.
// B/op everywhere = V8 heap bytes per op (v8 total_allocated_bytes); off-heap backing stores not counted.
// Rows: push, get, copyto32, copyto1024, wrap-step, wrap-push (see compare-probe.mjs) x --comp compilations,
// each a fresh `node --allow-natives-syntax --expose-gc test/bench/compare-probe.mjs` process,
// compilation-major. --smoke = K 5 x 1 compilation, reps capped at 1e5.
// Statistic: per row and column, type-7 median and [Q1..Q3] of the pooled K x comp paired per-round ratios
// COL/REF; per-compilation medians (D16); MODES flag when a column's per-compilation ns/op max/min >= 1.5
// (D17, REPORTED only).
// A row is VOID on: a crash / missing compilation; TurboFan calibration false or a driver not TurboFan; an
// oracle (before or after timing), mutant, uniqueSrc, sameTpl, wrapOnly, chkTpl or chkArgs failure; B/op not
// < 8 on REF, REF_AA, SLOW or CHK (REF is MASK on the wrap rows; MN / MN_TA B/op is reported, not gated); BOX
// or GET B/op outside 12..20; A/A (REF_AA/REF) median
// outside 0.93..1.07; SLOW/REF not (median >= 1.5 and Q1 >= 1.3); a ratio not measured (NaN).
// --smoke turns the two timing bands into "BAND (smoke)" reasons (row stays VALID); the report is headed
// "SMOKE: not quotable".
// GC lane (HOOK H, SPEC A2): after the probes, one `node test/bench/compare-gc.mjs --out DIR --rb <staged RB>
// --rb-sha8 .. --o1 .. --o1-sha8 .. --mn .. --mn-sha8 .. [--smoke]` (DIR = this run's --out dir, created empty
// here, so it never holds an old compare-gc.{md,json}; the gc lane gets the same staged HEAD RingBuffer the
// probes get; --control is not passed). Its exit 2 = die(2) unless it timed out; it counts VALID (acceptGc)
// only when it ran clean (ranClean: status 0, no signal, not timed out, no spawn error) and DIR/compare-gc.md is
// present.
// DIR/compare-gc.md is appended after the tables; compare.json gets gc: {exit (its raw status), file
// (compare-gc.md path or null)}. compare-gc.mjs's own self-test is a separate entry point, not run by --self-test here.
// Exit (exitAll, pure: combineExit(judge exit, gc lane)): 0 = every row VALID and the gc lane VALID on a QUIET
// host (QUIET_LOCK_HOST=quiet from quiet-lock.mjs); 1 = any VOID row or crashed / timed-out probe, a VOID gc lane
// (or a red self-test);
// 2 = usage / git / staging error (incl. a probe / gc lane exit 2 that did not time out) or host not quiet.
// The judge is pure; NaN (and a JSON null) fails every comparison. --self-test runs its synthetic cases (incl.
// parseOpts, signalPlan, timeoutPlan, ranClean, acceptRun and acceptGc rows, plus source rows pinning the main loop's
// accept lines); every real run runs them first, before any spawn. The probe argv (buildArgs), the expected echo
// (buildWant), the probe's echo of an argv (echoOf), the run accept (acceptRun: ranClean first, then JSON.parse and
// acceptProbe) and the probe-output accept check (acceptProbe: row, the three sha256/8, control, smoke, K; every want
// sha8 must be 8 lowercase hex) are pure and self-tested end to end; a real run re-checks the argv / acceptProbe
// wiring on its real pins (each single-field flip rejected) before any probe spawn.
// Writes DIR/compare.json and DIR/compare.md; DIR = --out (new or empty), else ROOT/.handoff/bench-compare/compare-<ISO>/.
// Test tooling only: not shipped.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MN_VERSION, MN_SHA256, OBLITERATOR_VERSION, mnCheck } from './mn-pin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PROBE = join(HERE, 'compare-probe.mjs');
const GC = join(HERE, 'compare-gc.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const PROBE_TIMEOUT_MS = 900000;
const O1_MIN = [1, 11, 3];

// ---- judge constants ----------------------------------------------------------------------------------
const BOP_MAX = 8;            // half a 16 B box: REF, REF_AA, SLOW and each row's gated columns (CHK) must read below it
const BOX_LO = 12;            // one HeapNumber per call (16 B on Node) -> 12..20
const BOX_HI = 20;
const AA_LO = 0.93;
const AA_HI = 1.07;
const SLOW_MED_MIN = 1.5;
const SLOW_Q1_MIN = 1.3;
const MODES_RATIO = 1.5;
// req = probe checks that must be === true (anything else -> VOID); gated = B/op < 8 columns beyond REF / REF_AA / SLOW
const COPY_COLS = ['RB', 'RB_AA', 'F32H', 'CHK', 'ARR', 'DEQ', 'MN', 'MN_TA', 'SLOW'];
const COPY_MUTS = ['MUT_WRAP', 'MUT_OBO', 'MUT_CHK_BOUNDS', 'MUT_CHK_ALIAS', 'MUT_CHK_STALE', 'MUT_CHK_NOCACHE', 'MUT_CHK_NOBUF'];
const ROWS = {
    push: { label: 'push n1024', ref: 'RB', aa: 'RB_AA', cols: ['RB', 'RB_AA', 'F32H', 'CHK', 'ARR', 'DEQ', 'MN', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'sameTpl', boxCols: [], req: ['chkTpl'], gated: ['CHK'] },
    get: { label: 'get n1024', ref: 'GOD', aa: 'GOD_AA', cols: ['GOD', 'GOD_AA', 'GET', 'F32H', 'CHK', 'ARR', 'MN', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_GET', 'MUT_OBO', 'MUT_CHK_COUNT', 'MUT_CHK_INT'], tpl: 'sameTpl', boxCols: ['GET'], req: ['chkTpl', 'chkArgs'], gated: ['CHK'] },
    copyto32: { label: 'copyto32 (full, head n/2, Float32 dst)', ref: 'RB', aa: 'RB_AA', cols: COPY_COLS, mutants: COPY_MUTS, tpl: 'sameTpl', boxCols: [], req: ['chkTpl', 'chkArgs'], gated: ['CHK'] },
    copyto1024: { label: 'copyto1024 (full, head n/2, Float32 dst)', ref: 'RB', aa: 'RB_AA', cols: COPY_COLS, mutants: COPY_MUTS, tpl: 'sameTpl', boxCols: [], req: ['chkTpl', 'chkArgs'], gated: ['CHK'] },
    'wrap-step': { label: 'wrap-step n1024', ref: 'MASK', aa: 'MASK_AA', cols: ['MASK', 'MASK_AA', 'MOD', 'MOD_NP2', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'wrapOnly', boxCols: [], req: [], gated: [] },
    'wrap-push': { label: 'wrap-push n1024', ref: 'MASK', aa: 'MASK_AA', cols: ['MASK', 'MASK_AA', 'MOD', 'MOD_NP2', 'SLOW'], mutants: ['MUT_WRAP', 'MUT_OBO'], tpl: 'wrapOnly', boxCols: [], req: [], gated: [] },
};
const ROW_LIST = Object.keys(ROWS);
const COL_NOTE = {
    RB: 'RingBuffer method', GOD: 'getOrDefault(i, 0)', GET: 'get(i)', F32H: 'hand-rolled Float32Array ring',
    ARR: 'hand-rolled Array ring', DEQ: 'RingDeque, emulated', MASK: '& mask', MOD: '% capacity n (pow2, same capacity as MASK)',
    MOD_NP2: '% capacity n - 1 (not pow2)', SLOW: 'control: REF twice', BOX: 'control: REF + one box',
    CHK: 'F32H + RingBuffer argument checks (text copy)', MN: 'mnemonist CircularBuffer ' + MN_VERSION + ', own API',
    MN_TA: 'mnemonist toArray + set: allocates a Float32Array per call',
};
const BOP_NOTE = 'max B/op = V8 heap bytes per op; off-heap backing stores not counted.';

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
    for (const k of S.req) if (!rs.every((r) => ck(r)[k] === true)) v.push(k);
    const gate0 = [['REF ' + S.ref, S.ref], ['REF_AA ' + S.aa, S.aa], ['SLOW', 'SLOW']].concat(S.gated.map((k) => [k, k]));
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
    md += '\n' + BOP_NOTE + '\n';
    if (r.row === 'get') md += '\nRingDeque: N/A (no indexed read).\n';
    if (r.row === 'push') md += '\nCHK == F32H here: push validates no argument, so CHK\'s body is F32H\'s (chkTpl checks that).\n';
    if (r.cols.includes('CHK')) md += '\n' + r.ref + ' - CHK = the method call vs the same argument checks inlined in the driver; it includes driver-inlining effects (D13).\n';
    if (r.row === 'copyto1024') md += '\nRB here copies with the intrinsic `set` + `copyWithin` rotate (> 32 samples); CHK, F32H and ARR use a masked scalar loop.\n';
    if (r.cols.includes('MN_TA')) md += '\nMN_TA allocates a fresh Float32Array per call (toArray): its heap B/op counts the typed-array objects only, not their data.\n';
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
    for (const k of S.req) checks[k] = true;
    if (o.checks) o.checks(checks);
    const out = { row, K: 7, rounds, bop, checks };
    if (o.noRounds) delete out.rounds;
    if (o.shortRounds) out.rounds = rounds.slice(0, 6);
    return out;
}
// probe-output accept check (pure): want = { row, rb, o1, mn, control, smoke, K } with K the CLI string; every
// want sha8 must be 8 lowercase hex (a field missing on both sides never passes)
const HEX8 = /^[0-9a-f]{8}$/;
function acceptProbe(j, want) {
    return !!(want && HEX8.test(want.rb) && HEX8.test(want.o1) && HEX8.test(want.mn) &&
        j && j.row === want.row && j.sha8 && j.sha8.rb === want.rb && j.sha8.o1 === want.o1 && j.sha8.mn === want.mn &&
        j.control === want.control && j.smoke === want.smoke && j.K === Number(want.K));
}
// "the child ran clean" (pure, fail closed) on a runProbe result: status 0, signal null, timedOut === false and
// error null. An undefined / null / 'false' / 0 timedOut is unverified -> not clean. Read BEFORE the child's output.
function ranClean(r) {
    return !!r && typeof r === 'object' && r.status === 0 && r.signal === null && r.timedOut === false &&
        r.error === null;
}
// probe run accept (pure): the parsed probe JSON only if ranClean(r), stdout parses and acceptProbe(j, want); else null
function acceptRun(r, want) {
    if (!ranClean(r) || typeof r.stdout !== 'string') return null;
    let j;
    try { j = JSON.parse(r.stdout); } catch { return null; }
    return acceptProbe(j, want) === true ? j : null;
}
// gc lane accept (pure): 0 only on ranClean(run) (status 0, no signal, not timed out, no error) and compare-gc.md
// present (=== true); else 1
function acceptGc(run, mdExists) {
    return ranClean(run) && mdExists === true ? 0 : 1;
}
// overall exit (pure): judge exit 0 / 2 survives only with a gc lane 0; anything else (a VOID row, a VOID gc
// lane, a non-0/1/2 value, NaN, null) is 1. A judge 2 (host not quiet) with a VALID gc lane stays 2.
function combineExit(jExit, gcExit) {
    return gcExit === 0 && (jExit === 0 || jExit === 2) ? jExit : 1;
}
// probe argv (pure): pins = { rbPath, rbSha8, o1Path, o1Sha8, mnPath, mnSha8 }; cfg = { K (CLI string), control ('' = none), smoke }
const PROBE_FLAGS = ['--allow-natives-syntax', '--expose-gc'];
function buildArgs(row, pins, cfg) {
    return PROBE_FLAGS.concat([PROBE, '--rb', pins.rbPath, '--rb-sha8', pins.rbSha8, '--o1', pins.o1Path, '--o1-sha8', pins.o1Sha8,
        '--mn', pins.mnPath, '--mn-sha8', pins.mnSha8, '--row', row, '--K', cfg.K],
    cfg.control ? ['--control', cfg.control] : [], cfg.smoke ? ['--smoke'] : []);
}
function buildWant(row, pins, cfg) {
    return { row, rb: pins.rbSha8, o1: pins.o1Sha8, mn: pins.mnSha8, control: cfg.control, smoke: cfg.smoke, K: cfg.K };
}
// what the probe echoes for an argv (pure, parsed the probe's way: strict options after PROBE, K a Number,
// control '' when absent, smoke a boolean, sha8 = the expected digests it verified); null where the probe exits 2
const ECHO_VALUE = ['--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8', '--row', '--K', '--control'];
function echoOf(args) {
    const at = args.indexOf(PROBE);
    if (at < 0) return null;
    const o = Object.create(null);
    for (let i = at + 1; i < args.length; i++) {
        const a = args[i];
        if (a in o) return null;
        if (a === '--smoke') { o[a] = true; continue; }
        if (!ECHO_VALUE.includes(a)) return null;
        const v = args[i + 1];
        if (typeof v !== 'string' || v === '' || v.startsWith('--')) return null;
        o[a] = v;
        i++;
    }
    for (const k of ['--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8', '--row']) if (!(k in o)) return null;
    const ks = o['--K'] ?? '21';
    if (!CANON_INT.test(ks)) return null;
    return { row: o['--row'], sha8: { rb: o['--rb-sha8'], o1: o['--o1-sha8'], mn: o['--mn-sha8'] }, control: o['--control'] ?? '', smoke: o['--smoke'] === true, K: Number(ks) };
}
// end-to-end wiring (pure): for every row the real argv's echo is accepted against the real want, and each
// single-field flip of the argv (rb / o1 / mn / K / control / smoke / row) is rejected. Returns the failures.
const flipHex = (s) => (typeof s === 'string' && s.length ? s.slice(0, -1) + (s.endsWith('0') ? '1' : '0') : 'x');
function wiringFails(pins, cfg) {
    const bad = [];
    for (const row of ROW_LIST) {
        const want = buildWant(row, pins, cfg);
        if (acceptProbe(echoOf(buildArgs(row, pins, cfg)), want) !== true) bad.push(row + ': real argv not accepted');
        const flips = [
            ['rb', buildArgs(row, { ...pins, rbSha8: flipHex(pins.rbSha8) }, cfg)],
            ['o1', buildArgs(row, { ...pins, o1Sha8: flipHex(pins.o1Sha8) }, cfg)],
            ['mn', buildArgs(row, { ...pins, mnSha8: flipHex(pins.mnSha8) }, cfg)],
            ['K', buildArgs(row, pins, { ...cfg, K: String(Number(cfg.K) + 1) })],
            ['control', buildArgs(row, pins, { ...cfg, control: cfg.control === 'box' ? 'aa' : 'box' })],
            ['smoke', buildArgs(row, pins, { ...cfg, smoke: !cfg.smoke })],
            ['row', buildArgs(row === 'push' ? 'get' : 'push', pins, cfg)],
        ];
        for (const [nm, a] of flips) if (acceptProbe(echoOf(a), want) !== false) bad.push(row + ': ' + nm + ' flip accepted');
    }
    return bad;
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
    // the column-line regex and count come from S.cols, so a new column is masked or this fails
    const colLines = (row, md) => {
        const re = new RegExp('^\\| (' + ROWS[row].cols.join('|') + ')(\\*| \\(| \\|)');
        return md.split('\n').filter((l) => re.test(l));
    };
    const masked = (row, J) => {
        const md = renderRow(J.rows[0]);
        const L = colLines(row, md);
        return L.length === ROWS[row].cols.length && L.every((l) => { const p = l.split(' | '); return p[2] === 'VOID' && p[3] === 'VOID' && p[4] === 'VOID' && p[5] === 'VOID'; }) && !md.includes('1.200');
    };
    c('VOID row masks every ratio cell', 1, () => one('push', { bop: { RB: 16 } }), (J) => masked('push', J));
    for (const row of ['get', 'copyto32', 'copyto1024']) {
        c('VOID ' + row + ' masks every cell incl CHK / MN', 1, () => one(row, { bop: { CHK: 8 } }), (J) => masked(row, J) && has(J, 'CHK B/op 8.00'));
    }
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
    // probe accept check: one baseline, one reject per clause (CONTROL is '' when --control is absent)
    const W = { row: 'push', rb: 'aaaa1111', o1: 'bbbb2222', mn: 'cccc3333', control: '', smoke: false, K: '21' };
    const pj = (o = {}) => Object.assign({ row: 'push', sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: 'cccc3333' }, control: '', smoke: false, K: 21 }, o);
    const acc = (name, want, j, w = W) => c('accept ' + name + ' -> ' + want, want, () => ({ exit: acceptProbe(j, w) === true ? 0 : 1 }));
    acc('baseline', 0, pj());
    acc('K 20', 1, pj({ K: 20 }));
    acc('K string', 1, pj({ K: '21' }));
    acc('K missing', 1, (() => { const j = pj(); delete j.K; return j; })());
    acc('j null', 1, null);
    acc('row', 1, pj({ row: 'get' }));
    acc('sha8 missing', 1, (() => { const j = pj(); delete j.sha8; return j; })());
    acc('sha8.rb', 1, pj({ sha8: { rb: 'aaaa1112', o1: 'bbbb2222', mn: 'cccc3333' } }));
    acc('sha8.o1', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2223', mn: 'cccc3333' } }));
    acc('sha8.mn', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: 'cccc3334' } }));
    acc('sha8.mn missing', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222' } }));
    acc('sha8.mn null', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: null } }));
    acc('mn missing both sides', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222' } }), (() => { const w = { ...W }; delete w.mn; return w; })());
    acc('mn undefined both sides', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: undefined } }), { ...W, mn: undefined });
    acc('o1 missing both sides', 1, pj({ sha8: { rb: 'aaaa1111', mn: 'cccc3333' } }), (() => { const w = { ...W }; delete w.o1; return w; })());
    acc('rb empty both sides', 1, pj({ sha8: { rb: '', o1: 'bbbb2222', mn: 'cccc3333' } }), { ...W, rb: '' });
    acc('non-hex want.mn both sides', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: 'cccc333g' } }), { ...W, mn: 'cccc333g' });
    acc('uppercase want.mn both sides', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: 'CCCC3333' } }), { ...W, mn: 'CCCC3333' });
    acc('9-hex want.mn both sides', 1, pj({ sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: 'cccc33330' } }), { ...W, mn: 'cccc33330' });
    acc('want null', 1, pj(), null);
    acc('control box', 1, pj({ control: 'box' }));
    acc('control undefined', 1, pj({ control: undefined }));
    acc('control null', 1, pj({ control: null }));
    acc('smoke true', 1, pj({ smoke: true }));
    acc('smoke missing', 1, (() => { const j = pj(); delete j.smoke; return j; })());
    acc('control false', 1, pj({ control: false }));
    acc('smoke 0', 1, pj({ smoke: 0 }));
    acc('row array', 1, pj({ row: ['push'] }));
    acc('K 22', 1, pj({ K: 22 }));
    c('accept control box both -> 0', 0, () => ({ exit: acceptProbe(pj({ control: 'box', smoke: true, K: 5 }), { ...W, control: 'box', smoke: true, K: '5' }) === true ? 0 : 1 }));
    // buildArgs -> echoOf -> acceptProbe(buildWant) end to end, per row, with every single-field flip rejected
    const PINS = { rbPath: '/x/RingBuffer.mjs', rbSha8: 'aaaa1111', o1Path: '/x/O1.js', o1Sha8: 'bbbb2222', mnPath: '/x/circular-buffer.js', mnSha8: 'cccc3330' };
    const ok0 = (fn) => () => ({ exit: fn() ? 0 : 1 });
    for (const cfg of [{ K: '21', control: '', smoke: false }, { K: '5', control: 'box', smoke: true }, { K: '1001', control: 'slow', smoke: false }]) {
        c('wiring K ' + cfg.K + ' control ' + (cfg.control || '-') + ' smoke ' + cfg.smoke + ': every row accepted, every flip rejected -> 0', 0, ok0(() => wiringFails(PINS, cfg).length === 0));
    }
    for (const row of ROW_LIST) {
        c('buildWant ' + row + ' end to end -> 0', 0, ok0(() => {
            const cfg = { K: '21', control: '', smoke: false };
            const a = buildArgs(row, PINS, cfg), e = echoOf(a), w = buildWant(row, PINS, cfg);
            return acceptProbe(e, w) === true && e.row === row && e.sha8.mn === 'cccc3330' && a[a.indexOf('--mn') + 1] === PINS.mnPath &&
                a.slice(0, a.indexOf(PROBE)).join(' ') === PROBE_FLAGS.join(' ');
        }));
    }
    c('wiring non-hex mn pin -> 1', 1, ok0(() => wiringFails({ ...PINS, mnSha8: 'cccc333z' }, { K: '21', control: '', smoke: false }).length === 0));
    c('wiring missing mn pin -> 1', 1, ok0(() => wiringFails({ ...PINS, mnSha8: undefined }, { K: '21', control: '', smoke: false }).length === 0));
    c('echoOf drops --mn-sha8 -> 1', 1, ok0(() => {
        const a = buildArgs('push', PINS, { K: '21', control: '', smoke: false });
        a.splice(a.indexOf('--mn-sha8'), 2);
        return acceptProbe(echoOf(a), buildWant('push', PINS, { K: '21', control: '', smoke: false })) === true;
    }));
    c('echoOf unknown argument -> null', 0, ok0(() => echoOf(buildArgs('push', PINS, { K: '21', control: '', smoke: false }).concat(['--bogus', '1'])) === null));
    // new columns: CHK (push / get / copy), MN (push / get / copy), MN_TA (copy)
    const NEW = [['push', 'CHK'], ['get', 'CHK'], ['copyto32', 'CHK'], ['copyto1024', 'CHK'], ['push', 'MN'], ['get', 'MN'], ['copyto32', 'MN'],
        ['copyto1024', 'MN'], ['copyto32', 'MN_TA'], ['copyto1024', 'MN_TA']];
    for (const [row, k] of NEW) {
        const rf = ROWS[row].ref;
        c(row + ' ' + k + ' NaN round -> 1', 1, () => one(row, { round: [k, NaN] }), (J) => has(J, k + '/' + rf + ' not measured'));
        c(row + ' ' + k + ' null round -> 1', 1, () => one(row, { round: [k, null] }), (J) => has(J, k + '/' + rf + ' not measured'));
        chk('oracle ' + row + ' ' + k + ' false -> 1', row, (x) => { x.oracle[k] = false; });
        chk('oracleAfter ' + row + ' ' + k + ' false -> 1', row, (x) => { x.oracleAfter[k] = false; });
    }
    chk('oracle MN missing -> 1', 'get', (x) => { delete x.oracle.MN; });
    chk('oracleAfter MN_TA null -> 1', 'copyto32', (x) => { x.oracleAfter.MN_TA = null; });
    for (const [row, m] of [['get', 'MUT_CHK_COUNT'], ['get', 'MUT_CHK_INT'], ['copyto32', 'MUT_CHK_BOUNDS'], ['copyto1024', 'MUT_CHK_BOUNDS'],
        ['copyto32', 'MUT_CHK_ALIAS'], ['copyto1024', 'MUT_CHK_ALIAS'], ['copyto32', 'MUT_CHK_STALE'], ['copyto1024', 'MUT_CHK_STALE'],
        ['copyto32', 'MUT_CHK_NOCACHE'], ['copyto1024', 'MUT_CHK_NOCACHE'], ['copyto32', 'MUT_CHK_NOBUF'], ['copyto1024', 'MUT_CHK_NOBUF']]) {
        c(row + ' ' + m + ' missed -> 1', 1, () => one(row, { checks: (x) => { x.mutants[m] = false; } }), (J) => has(J, m + ' not caught'));
        chk(row + ' ' + m + ' null -> 1', row, (x) => { x.mutants[m] = null; });
        chk(row + ' ' + m + ' missing -> 1', row, (x) => { delete x.mutants[m]; });
    }
    for (const row of ['push', 'get', 'copyto32', 'copyto1024']) {
        const req = ROWS[row].req;
        for (const k of req) {
            c(row + ' ' + k + ' false -> 1', 1, () => one(row, { checks: (x) => { x[k] = false; } }), (J) => J.rows[0].voidWhy.includes(k));
            chk(row + ' ' + k + ' null -> 1', row, (x) => { x[k] = null; });
            chk(row + ' ' + k + ' missing -> 1', row, (x) => { delete x[k]; });
            chk(row + ' ' + k + ' 1 (not true) -> 1', row, (x) => { x[k] = 1; });
        }
        c(row + ' CHK B/op 7.99 -> 0', 0, () => one(row, { bop: { CHK: 7.99 } }));
        c(row + ' CHK B/op 8 -> 1', 1, () => one(row, { bop: { CHK: 8 } }), (J) => has(J, 'CHK B/op 8.00,8.00 not < 8'));
        c(row + ' CHK B/op NaN -> 1', 1, () => one(row, { bop: { CHK: NaN } }));
        c(row + ' CHK B/op null -> 1', 1, () => one(row, { bop: { CHK: null } }));
        c(row + ' MN B/op 4200 not gated -> 0', 0, () => one(row, { bop: { MN: 4200 } }));
    }
    c('push chkArgs absent is not required -> 0', 0, () => one('push', { checks: (x) => { delete x.chkArgs; } }));
    c('wrap-step chkTpl / chkArgs absent -> 0', 0, () => one('wrap-step', { checks: (x) => { delete x.chkTpl; delete x.chkArgs; } }));
    c('wrap-push chkTpl false is not read -> 0', 0, () => one('wrap-push', { checks: (x) => { x.chkTpl = false; } }));
    for (const row of ['copyto32', 'copyto1024']) {
        c(row + ' MN_TA B/op 4200 not gated -> 0', 0, () => one(row, { bop: { MN_TA: 4200 } }));
        c(row + ' MN_TA B/op 150 not gated -> 0', 0, () => one(row, { bop: { MN_TA: 150 } }));
    }
    c('B/op note once per table, every row', 0, () => one('push'), () => ROW_LIST.every((row) => {
        const md = renderRow(one(row).rows[0]);
        return md.split(BOP_NOTE).length === 2 && md.includes('V8 heap bytes per op; off-heap backing stores not counted');
    }));
    c('row notes: push CHK == F32H, CHK D13, copyto1024 set + copyWithin, MN_TA per-call', 0, () => one('push'), () => {
        const md = (row) => renderRow(one(row).rows[0]);
        return md('push').includes('CHK == F32H') && md('get').includes('GOD - CHK') && md('copyto32').includes('RB - CHK') &&
            md('copyto1024').includes('`set` + `copyWithin`') && !md('copyto32').includes('copyWithin') && md('copyto32').includes('MN_TA allocates') &&
            !md('wrap-step').includes('CHK') && COL_NOTE.MN_TA.includes('allocates a Float32Array per call');
    });
    // HOOK H: gc lane accept + exit combination (pure)
    for (const [jx, gx, want] of [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 1], [2, 0, 2], [2, 1, 1], [0, NaN, 1], [0, null, 1],
        [0, undefined, 1], [0, 2, 1], [null, 0, 1], [undefined, 0, 1], [NaN, 0, 1], [3, 0, 1], ['0', 0, 1]]) {
        c('combineExit judge ' + String(jx) + ' gc ' + String(gx) + ' -> ' + want, want, () => ({ exit: combineExit(jx, gx) }));
    }
    // a runProbe result (RUN() = ran clean); the acceptGc status / signal / md rows run with timedOut false, error null
    const RUN = (o = {}) => Object.assign({ status: 0, signal: null, stdout: '', stderr: '', error: null,
        timedOut: false }, o);
    for (const [st, sg, md, want] of [[0, null, true, 0], [1, null, true, 1], [0, 'SIGKILL', true, 1], [0, null, false, 1], [null, null, true, 1],
        [null, 'SIGTERM', true, 1], [0, undefined, true, 1], [0, null, 1, 1], [0, null, undefined, 1], ['0', null, true, 1], [2, null, true, 1]]) {
        c('acceptGc status ' + String(st) + ' signal ' + String(sg) + ' md ' + String(md) + ' -> ' + want, want,
            () => ({ exit: acceptGc(RUN({ status: st, signal: sg }), md) }));
    }
    // "ran clean" (ranClean, pure, fail closed): every field of a runProbe result checked; timedOut must be === false
    const RC = [['clean', RUN(), 0], ['timedOut true', RUN({ timedOut: true }), 1],
        ['timedOut undefined', RUN({ timedOut: undefined }), 1],
        ['timedOut missing', (() => { const r = RUN(); delete r.timedOut; return r; })(), 1],
        ['timedOut null', RUN({ timedOut: null }), 1], ["timedOut 'false'", RUN({ timedOut: 'false' }), 1],
        ['timedOut 0', RUN({ timedOut: 0 }), 1], ['timedOut NaN', RUN({ timedOut: NaN }), 1],
        ['status 1', RUN({ status: 1 }), 1], ['status null', RUN({ status: null }), 1],
        ["status '0'", RUN({ status: '0' }), 1], ['status NaN', RUN({ status: NaN }), 1],
        ["signal 'SIGTERM'", RUN({ signal: 'SIGTERM' }), 1], ['signal undefined', RUN({ signal: undefined }), 1],
        ['error set', RUN({ error: new Error('spawn ENOENT') }), 1],
        ['error undefined', RUN({ error: undefined }), 1], ['run null', null, 1], ['run undefined', undefined, 1],
        ["run 'ok'", 'ok', 1]];
    for (const [nm, r, want] of RC) c('ranClean ' + nm + ' -> ' + want, want, ok0(() => ranClean(r) === true));
    for (const [nm, r, want] of RC) {
        c('acceptGc ' + nm + ' md true -> ' + want, want, () => ({ exit: acceptGc(r, true) }));
    }
    c('acceptGc clean md false -> 1', 1, () => ({ exit: acceptGc(RUN(), false) }));
    // probe run accept (acceptRun, pure): ranClean BEFORE JSON.parse / acceptProbe; a timed-out clean exit is rejected
    const WR = buildWant('push', PINS, { K: '21', control: '', smoke: false });
    const OUTJ = JSON.stringify({ row: 'push', sha8: { rb: 'aaaa1111', o1: 'bbbb2222', mn: 'cccc3330' }, control: '',
        smoke: false, K: 21 });
    const arOk = (J) => J.j !== null && typeof J.j === 'object' && J.j.row === 'push' && J.j.K === 21;
    const ar = (name, want, r, w = WR) => c('acceptRun ' + name + ' -> ' + want, want, () => {
        const j = acceptRun(r, w);
        return { exit: j === null ? 1 : 0, j };
    }, want === 0 ? arOk : (J) => J.j === null);
    ar('clean, valid probe JSON', 0, RUN({ stdout: OUTJ }));
    for (const [nm, r, want] of RC) {
        if (want === 1 && r && typeof r === 'object') {
            ar(nm + ', valid probe JSON', 1, Object.assign({}, r, { stdout: OUTJ }));
        }
    }
    ar('clean, stdout not JSON', 1, RUN({ stdout: 'x' + OUTJ }));
    ar('clean, stdout empty', 1, RUN({ stdout: '' }));
    ar('clean, stdout a Buffer', 1, RUN({ stdout: Buffer.from(OUTJ) }));
    ar('clean, stdout null', 1, RUN({ stdout: null }));
    ar('clean, wrong row', 1, RUN({ stdout: OUTJ }), buildWant('get', PINS, { K: '21', control: '', smoke: false }));
    ar('clean, want null', 1, RUN({ stdout: OUTJ }), null);
    c('acceptRun source: ranClean(r) before JSON.parse, acceptProbe on the parsed j', 0, ok0(() => {
        const s = String(acceptRun);
        return s.includes('if (!ranClean(r) ') && s.indexOf('ranClean(r)') < s.indexOf('JSON.parse(') &&
            s.split('JSON.parse(').length === 2 && s.includes('acceptProbe(j, want) === true ? j : null');
    }));
    // main-loop wiring (top-level code, read from this file's own source): the probe accept is acceptRun (no
    // JSON.parse, acceptProbe or status test of its own), the gc lane accept is acceptGc on the WHOLE run object
    c('main loop source: probe accept = acceptRun, gc lane accept = acceptGc(g, ..)', 0, ok0(() => {
        const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
        const a = src.indexOf('\nlet crashed = 0;\n'), b = src.indexOf('\n// ---- judge + write');
        if (!(a > 0 && b > a) || src.split('\nlet crashed = 0;\n').length !== 2) return false;
        const loop = src.slice(a, b);
        return loop.split('const j = acceptRun(r, buildWant(row, PINS, CFG));').length === 2 &&
            loop.includes('if (j !== null) {') && loop.split('const gcExit = acceptGc(g, gcMdExists);').length === 2 &&
            loop.split('acceptGc(').length === 2 && loop.split('acceptRun(').length === 2 &&
            !loop.includes('JSON.parse') && !loop.includes('acceptProbe(') && !loop.includes('ranClean(') &&
            !/\.status === 0/.test(loop) && loop.split('.status === 2').length === 3 &&
            loop.split("if (r.status === 2 && r.timedOut === false) die('probe usage error (").length === 2 &&
            loop.split("\nif (g.status === 2 && g.timedOut === false) die('gc lane usage error: ").length === 2 &&
            src.split('\nconst exitAll = combineExit(J.exit, gcExit);\n').length === 2;
    }));
    // CLI (parseOpts, pure): exit 2 = { err }; every value checked before the --self-test exit; canonical integers only
    const po = (name, want, argv, pred) => c('opts ' + name + ' -> ' + want, want, () => { const r = parseOpts(argv); return { exit: r.err ? 2 : 0, r }; },
        pred ? (J) => pred(J.r) === true : undefined);
    const errHas = (s) => (r) => typeof r.err === 'string' && r.err.includes(s);
    po('no argument (defaults K 21, comp 3)', 0, [], (r) => r.cfg.K === '21' && r.cfg.comp === 3 && r.cfg.control === '' && r.cfg.smoke === false && r.cfg.out === undefined);
    po('--self-test alone', 0, ['--self-test'], (r) => r.opt['--self-test'] === true);
    po('--self-test --K 4 names --K', 2, ['--self-test', '--K', '4'], errHas('--K: want a canonical integer 5..1001'));
    po('--self-test --comp 0 names --comp', 2, ['--self-test', '--comp', '0'], errHas('--comp: want'));
    po('--self-test --control bogus names --control', 2, ['--self-test', '--control', 'bogus'], errHas('--control: box, aa or slow'));
    po('--self-test --K 21 (valid, run-only)', 2, ['--self-test', '--K', '21'], errHas('--self-test takes no other argument'));
    po('--self-test --smoke', 2, ['--self-test', '--smoke'], errHas('--self-test takes no other argument'));
    po('--self-test --out /x', 2, ['--self-test', '--out', '/x'], errHas('--self-test takes no other argument'));
    for (const k of ['21', '5', '1001', '100']) po('--K ' + k, 0, ['--K', k], (r) => r.cfg.K === k);
    for (const k of ['0021', '05', '021', '4', '1002', '0', '-5', '+5', '5.0', '5.', '1e3', ' 21', '21 ', '0x15', '21a', '\u0661\u0662']) {
        po('--K ' + JSON.stringify(k), 2, ['--K', k], errHas('--K: want'));
    }
    for (const k of ['1', '3', '10']) po('--comp ' + k, 0, ['--comp', k], (r) => r.cfg.comp === Number(k));
    for (const k of ['01', '010', '0', '11', '-1', '1.0', '1e1']) po('--comp ' + JSON.stringify(k), 2, ['--comp', k], errHas('--comp: want'));
    for (const k of ['box', 'aa', 'slow']) po('--control ' + k, 0, ['--control', k], (r) => r.cfg.control === k);
    for (const k of ['BOX', 'none', '__proto__', 'toString']) po('--control ' + k, 2, ['--control', k], errHas('--control: box'));
    po('--smoke -> K 5 comp 1', 0, ['--smoke'], (r) => r.cfg.K === '5' && r.cfg.comp === 1 && r.cfg.smoke === true);
    po('--smoke --K 5', 2, ['--smoke', '--K', '5'], errHas('--smoke fixes K 5'));
    po('--smoke --comp 1', 2, ['--smoke', '--comp', '1'], errHas('--smoke fixes K 5'));
    po('--smoke --K 0021 names --K', 2, ['--smoke', '--K', '0021'], errHas('--K: want'));
    po('--K 21 --comp 2 --control aa --keep --out /x', 0, ['--K', '21', '--comp', '2', '--control', 'aa', '--keep', '--out', '/x'],
        (r) => r.cfg.K === '21' && r.cfg.comp === 2 && r.cfg.control === 'aa' && r.cfg.keep === true && r.cfg.out === '/x');
    po('unknown --kk did-you-mean --K', 2, ['--kk', '5'], errHas('did you mean --K?'));
    po('--K twice', 2, ['--K', '21', '--K', '21'], errHas('--K given twice'));
    po('--K needs a value', 2, ['--K'], errHas('--K needs a value'));
    po('--K value is an option', 2, ['--K', '--smoke'], errHas('--K needs a value'));
    po('--K empty', 2, ['--K', ''], errHas('--K needs a value'));
    // signals (signalPlan, pure): forward the same signal, SIGKILL fallback after a finite grace, 130 / 143
    c('signalPlan SIGINT -> forward SIGINT, exit 130', 0, () => ({ exit: 0 }), () => {
        const p = signalPlan('SIGINT');
        return p !== null && p.forward === 'SIGINT' && p.exit === 130 && p.fallback === 'SIGKILL' && Number.isFinite(p.graceMs) && p.graceMs > 0;
    });
    c('signalPlan SIGTERM -> forward SIGTERM, exit 143', 0, () => ({ exit: 0 }), () => {
        const p = signalPlan('SIGTERM');
        return p !== null && p.forward === 'SIGTERM' && p.exit === 143 && p.fallback === 'SIGKILL' && Number.isFinite(p.graceMs) && p.graceMs > 0;
    });
    c('signalPlan never forwards SIGKILL first', 0, () => ({ exit: 0 }), () => ['SIGINT', 'SIGTERM'].every((sg) => signalPlan(sg).forward !== 'SIGKILL'));
    c('signalPlan other / bad -> null', 0, () => ({ exit: 0 }), () => [undefined, null, '', 'SIGHUP', 'SIGKILL', 'sigterm', 15].every((sg) => signalPlan(sg) === null));
    // probe / gc lane timeout (timeoutPlan, pure): the SIGTERM path's forward / grace / fallback, never SIGKILL first
    c('timeoutPlan = signalPlan(SIGTERM) forward, SIGKILL fallback, finite grace', 0, () => ({ exit: 0 }), () => {
        const p = timeoutPlan(), s = signalPlan('SIGTERM');
        return p !== null && typeof p === 'object' && p.forward === s.forward && p.forward !== 'SIGKILL' &&
            p.fallback === 'SIGKILL' && p.fallback === s.fallback && Number.isFinite(p.graceMs) && p.graceMs > 0 &&
            p.graceMs === s.graceMs;
    });
    c('runProbe source: timer via timeoutPlan, no SIGKILL literal, both timers cleared in fin', 0, () => ({ exit: 0 }),
        () => {
            const src = String(runProbe);
            return src.includes('timeoutPlan()') && !src.includes("'SIGKILL'") && !src.includes('"SIGKILL"') &&
                /clearTimeout\(timer\)/.test(src) && /clearTimeout\(graceTimer\)/.test(src) &&
                src.includes('if (ch.exitCode === null && ch.signalCode === null) ch.kill(tp.fallback);') &&
                src.split('ch.kill(').length === 3 &&
                src.indexOf('}, tp.graceMs);') < src.indexOf('ch.kill(tp.forward);') &&
                src.split('timedOut = true;').length === 2 &&
                src.indexOf('timedOut = true;') < src.indexOf('ch.kill(tp.forward);') &&
                src.includes('res({ status, signal, stdout: out, stderr: err, error, timedOut });') &&
                src.includes("ch.on('error', (e) => fin(null, null, e));") &&
                src.includes("ch.on('close', (status, signal) => fin(status, signal, null));");
        });
    // --K is one canonical-integer rule in compare (parseOpts, echoOf) and the probe (CANON_INT, same text)
    const echoK = (k) => echoOf(buildArgs('push', PINS, { K: k, control: '', smoke: false }));
    for (const k of ['0021', '05', '021', '+5']) {
        c('echoOf --K ' + JSON.stringify(k) + ' -> null', 0, ok0(() => echoK(k) === null));
    }
    for (const k of ['5', '21', '1001']) {
        c('echoOf --K ' + k + ' -> K ' + k, 0, ok0(() => {
            const e = echoK(k);
            return e !== null && e.K === Number(k);
        }));
    }
    c('echoOf uses CANON_INT, no /^[0-9]+$/', 0,
        ok0(() => String(echoOf).includes('CANON_INT.test(ks)') && !String(echoOf).includes('[0-9]+$')));
    c('compare-probe.mjs --K: same CANON_INT line, CANON_INT.test on --K, no /^[0-9]+$/', 0, ok0(() => {
        const src = readFileSync(PROBE, 'utf8');
        const line = 'const CANON_INT = /' + CANON_INT.source + '/;';
        return CANON_INT.source === '^(?:0|[1-9][0-9]*)$' && src.split('\n').filter((l) => l === line).length === 1 &&
            src.includes("CANON_INT.test(opt['--K'] ?? '21')") && !src.includes('/^[0-9]+$/');
    }));
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
// canonical decimal integer: no sign, no leading zero, no exponent, no fraction ('0021', '+5', '5.0', '1e3' -> false)
const CANON_INT = /^(?:0|[1-9][0-9]*)$/;
const intIn = (s, lo, hi) => typeof s === 'string' && CANON_INT.test(s) && Number(s) >= lo && Number(s) <= hi;
// option parser (pure): argv -> { err } or { opt, cfg: { K, comp, control, smoke, keep, out } }. Every given value is
// validated before the --self-test exclusivity check, so a bad value is named even next to --self-test.
function parseOpts(argv) {
    const opt = Object.create(null);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!VALUE_OPTS.includes(a) && !FLAG_OPTS.includes(a)) {
            let best = VALUE_OPTS[0];
            for (const o of VALUE_OPTS.concat(FLAG_OPTS)) if (lev(String(a), o) < lev(String(a), best)) best = o;
            return { err: 'unknown argument ' + JSON.stringify(a) + ' (did you mean ' + best + '?)' };
        }
        if (a in opt) return { err: a + ' given twice' };
        if (FLAG_OPTS.includes(a)) { opt[a] = true; continue; }
        const v = argv[i + 1];
        if (v === undefined || v === '' || v.startsWith('--')) return { err: a + ' needs a value' };
        opt[a] = v;
        i++;
    }
    if ('--K' in opt && !intIn(opt['--K'], 5, 1001)) return { err: '--K: want a canonical integer 5..1001 (no sign, no leading zero), got ' + JSON.stringify(opt['--K']) };
    if ('--comp' in opt && !intIn(opt['--comp'], 1, 10)) return { err: '--comp: want a canonical integer 1..10 (no sign, no leading zero), got ' + JSON.stringify(opt['--comp']) };
    if ('--control' in opt && !['box', 'aa', 'slow'].includes(opt['--control'])) return { err: '--control: box, aa or slow, got ' + JSON.stringify(opt['--control']) };
    const SMOKE = opt['--smoke'] === true;
    if (SMOKE && ('--K' in opt || '--comp' in opt)) return { err: '--smoke fixes K 5 x 1 compilation; drop --K / --comp' };
    if (opt['--self-test'] === true && Object.keys(opt).length !== 1) return { err: '--self-test takes no other argument' };
    const K = SMOKE ? '5' : (opt['--K'] ?? '21');
    const comp = SMOKE ? '1' : (opt['--comp'] ?? '3');
    // defence in depth: the defaults pass the same check
    if (!intIn(K, 5, 1001) || !intIn(comp, 1, 10)) return { err: 'internal: default K / comp not canonical' };
    return { opt, cfg: { K, comp: Number(comp), control: opt['--control'] ?? '', smoke: SMOKE, keep: opt['--keep'] === true, out: opt['--out'] } };
}
// signal plan (pure): SIGINT / SIGTERM -> forward the SAME signal to the running child, wait up to graceMs for its
// exit, then SIGKILL it (fallback), exit 130 / 143. Any other signal -> null (no handler is installed for it).
const SIGNAL_GRACE_MS = 10000;
function signalPlan(sig) {
    if (sig === 'SIGINT') return { forward: 'SIGINT', exit: 130, graceMs: SIGNAL_GRACE_MS, fallback: 'SIGKILL' };
    if (sig === 'SIGTERM') return { forward: 'SIGTERM', exit: 143, graceMs: SIGNAL_GRACE_MS, fallback: 'SIGKILL' };
    return null;
}
// timeout plan (pure): a probe / gc lane past PROBE_TIMEOUT_MS takes the SIGTERM path (one source of truth): forward
// SIGTERM (the gc lane's handler kills ITS child), wait graceMs, then SIGKILL if it has not exited. No exit code.
function timeoutPlan() {
    const p = signalPlan('SIGTERM');
    return { forward: p.forward, graceMs: p.graceMs, fallback: p.fallback };
}
const PA = parseOpts(process.argv.slice(2));
if (PA.err) die(PA.err);
const opt = PA.opt;

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

const SMOKE = PA.cfg.smoke;
const K = PA.cfg.K;
const COMP = PA.cfg.comp;
const CONTROL = PA.cfg.control;
const KEEP = PA.cfg.keep;
const T0 = new Date();
const OUT = resolve(PA.cfg.out ?? join(ROOT, '.handoff', 'bench-compare', 'compare-' + T0.toISOString().replace(/[:.]/g, '-')));
if (existsSync(OUT) && (!statSync(OUT).isDirectory() || readdirSync(OUT).length > 0)) die('--out must be a new or empty dir: ' + OUT);
if (!isFile(PROBE)) die('probe missing: ' + PROBE);
if (!isFile(GC)) die('gc lane missing: ' + GC);

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

// mnemonist: resolve (never require: subpaths are require-only CJS), then pin version + combined digest
let mnPath;
try { mnPath = createRequire(join(ROOT, 'package.json')).resolve('mnemonist/circular-buffer.js'); } catch (e) { die('cannot resolve mnemonist/circular-buffer.js (npm install): ' + e.message); }
const MN_NM = join(ROOT, 'node_modules');
let mnReal, mnWantReal;
try { mnReal = realpathSync(mnPath); mnWantReal = realpathSync(join(MN_NM, 'mnemonist', 'circular-buffer.js')); } catch (e) { die('mnemonist circular-buffer.js unreadable: ' + e.message); }
if (mnReal !== mnWantReal || !isFile(mnReal)) die('mnemonist resolved outside ' + MN_NM + ': ' + mnPath);
const mnPin = mnCheck(MN_NM);
if (mnPin.ok !== true) {
    die('mnemonist pin (want ' + MN_VERSION + ', obliterator ' + OBLITERATOR_VERSION + ', MN_SHA256 ' + MN_SHA256 + '): ' + mnPin.why +
        (Array.isArray(mnPin.perFile) ? '; per-file sha256: ' + mnPin.perFile.map((p) => p.file + ' ' + p.sha256).join(', ') : ''));
}
const mnSha8 = MN_SHA256.slice(0, 8);

// ---- stage (removed on exit, SIGINT, SIGTERM unless --keep) -------------------------------------------
const work = mkdtempSync(join(os.tmpdir(), 'lrb-compare-'));
if (!KEEP) process.on('exit', () => { rmSync(work, { recursive: true, force: true }); });
let child = null;
// SIGINT / SIGTERM: signalPlan (pure). Forward, then exit when the child exits (its 'exit' fires before the 'close'
// that would resume the run loop, so no next probe / gc lane is spawned); SIGKILL after graceMs or on a second signal.
// A probe / gc lane past PROBE_TIMEOUT_MS takes the same forward / wait / SIGKILL path (timeoutPlan, in runProbe).
let stopping = null;
function onSignal(sig) {
    const plan = signalPlan(sig);
    if (stopping !== null) {
        // a second signal while waiting: no more grace
        if (stopping.ch) stopping.ch.kill(stopping.plan.fallback);
        process.exit(stopping.plan.exit);
    }
    const ch = child;
    stopping = { plan, ch };
    if (!ch || ch.exitCode !== null || ch.signalCode !== null) process.exit(plan.exit);
    ch.once('exit', () => process.exit(plan.exit));
    setTimeout(() => { ch.kill(plan.fallback); setTimeout(() => process.exit(plan.exit), 2000); }, plan.graceMs);
    ch.kill(plan.forward);
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));
// async spawn: the event loop turns while a probe runs, so a signal is handled at once
function runProbe(args) {
    return new Promise((res) => {
        if (stopping !== null) return; // stopping: never spawn again (the signal path exits the process)
        let out = '', err = '', done = false, timedOut = false, graceTimer = null;
        const fin = (status, signal, error) => {
            if (done) return;
            done = true; clearTimeout(timer); clearTimeout(graceTimer); child = null;
            if (stopping === null) res({ status, signal, stdout: out, stderr: err, error, timedOut });
        };
        const ch = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        child = ch;
        // timeout: forward, wait graceMs, then the fallback only if the child has not exited (fin clears both timers)
        const tp = timeoutPlan();
        const timer = setTimeout(() => {
            timedOut = true;
            graceTimer = setTimeout(() => {
                if (ch.exitCode === null && ch.signalCode === null) ch.kill(tp.fallback);
            }, tp.graceMs);
            ch.kill(tp.forward);
        }, PROBE_TIMEOUT_MS);
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
process.stdout.write('mnemonist    sha256/8 ' + mnSha8 + '  ' + MN_VERSION + ' (obliterator ' + mnPin.obliterator + ', ' + mnPin.perFile.length + ' files, MN_SHA256) ' + mnPath + '\n');
process.stdout.write('work ' + work + (KEEP ? ' (kept)' : ' (removed on exit; --keep keeps it)') + '\n');
// the argv / want / accept wiring, on the real pins, before any probe spawn
const PINS = { rbPath, rbSha8, o1Path, o1Sha8, mnPath, mnSha8 };
const CFG = { K, control: CONTROL, smoke: SMOKE };
const wireBad = wiringFails(PINS, CFG);
if (wireBad.length) die('probe argv / accept wiring: ' + wireBad.join('; '));
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
const probeFlags = PROBE_FLAGS;
const probeExtra = ['--K', K].concat(CONTROL ? ['--control', CONTROL] : [], SMOKE ? ['--smoke'] : []);
const runs = ROW_LIST.map(() => []);
let crashed = 0;
for (let cpi = 0; cpi < COMP; cpi++) {
    for (let i = 0; i < ROW_LIST.length; i++) {
        const row = ROW_LIST[i];
        const r = await runProbe(buildArgs(row, PINS, CFG));
        const tag = row + ' comp ' + (cpi + 1);
        if (r.status === 2 && r.timedOut === false) die('probe usage error (' + tag + '): ' + String(r.stderr).trim());
        const j = acceptRun(r, buildWant(row, PINS, CFG));
        if (j !== null) {
            runs[i].push(j);
            process.stdout.write('ran ' + tag + '\n');
        } else {
            crashed++;
            const tmo = r.timedOut ? ' (timed out after ' + PROBE_TIMEOUT_MS + ' ms)' : '';
            process.stderr.write('probe crashed: ' + tag + tmo + ' status ' + r.status + ' signal ' + r.signal + ' ' +
                String(r.stderr || r.error || '').slice(0, 400) + '\n');
        }
    }
}
// GC lane (HOOK H): same staged RB / pins, OUT = this run's dir (created empty above)
const gcArgs = [GC, '--out', OUT, '--rb', rbPath, '--rb-sha8', rbSha8, '--o1', o1Path, '--o1-sha8', o1Sha8, '--mn', mnPath, '--mn-sha8', mnSha8].concat(SMOKE ? ['--smoke'] : []);
const g = await runProbe(gcArgs);
if (g.status === 2 && g.timedOut === false) die('gc lane usage error: ' + String(g.stderr).trim());
const GC_MD = join(OUT, 'compare-gc.md');
const gcMdExists = isFile(GC_MD);
const gcExit = acceptGc(g, gcMdExists);
process.stdout.write('ran gc lane: status ' + g.status + ' signal ' + g.signal + (gcMdExists ? '' : ' (no compare-gc.md)') + '\n');
if (gcExit !== 0) {
    const tmo = g.timedOut ? ' (timed out after ' + PROBE_TIMEOUT_MS + ' ms)' : '';
    process.stderr.write('gc lane VOID' + tmo + ': ' + String(g.stderr || g.error || '').slice(0, 400) + '\n');
}
const loadEnd = os.loadavg();
const busyEnd = busyNodes();
const T1 = new Date();

// ---- judge + write ------------------------------------------------------------------------------------
const J = judge({ rows: ROW_LIST, runs, comp: COMP, smoke: SMOKE, host, crashed });
const exitAll = combineExit(J.exit, gcExit);
if (gcExit !== 0) {
    J.why.push('VOID gc-lane: exit ' + g.status + (g.signal ? ' signal ' + g.signal : '') +
        (gcMdExists ? '' : '; compare-gc.md missing') +
        (g.timedOut ? '; timed out after ' + PROBE_TIMEOUT_MS + ' ms' : ''));
}
const tier = SMOKE ? 'SMOKE: not quotable' : exitAll === 0 ? 'REPORTED (QUIET host, every row VALID, gc lane VALID)' : exitAll === 2 ? 'PRELIMINARY / NO VERDICT (host not quiet)' :
    J.exit === 1 ? 'VOID rows present' : 'gc lane VOID';
const p0 = runs.find((r) => r.length)?.[0] || {};
const cpus = os.cpus();
const l3 = (l) => l.map((x) => f(x)).join(' / ');
let md = '### compare -- ' + tier + ' -- exit ' + exitAll + '\n\n';
md += '- Run: ' + T0.toISOString() + ' .. ' + T1.toISOString() + ' (' + f((T1 - T0) / 1000, 1) + ' s wall)\n';
md += '- Host: ' + os.type() + ' ' + os.release() + ' ' + os.arch() + '; ' + (cpus[0] ? cpus[0].model : '?') + ' x ' + cpus.length + ' cores\n';
md += '- Load1/5/15: start ' + l3(loadStart) + ', end ' + l3(loadEnd) + '\n';
md += '- Other node >= 10% CPU: start ' + (busyStart.length ? busyStart.join('; ') : 'none') + '; end ' + (busyEnd.length ? busyEnd.join('; ') : 'none') + '\n';
md += '- Node ' + (p0.node || process.version) + ' / V8 ' + (p0.v8 || process.versions.v8) + '; K ' + K + ' x ' + COMP + ' compilation(s)' + (SMOKE ? ' (smoke: reps capped 1e5)' : '') + (CONTROL ? '; control ' + CONTROL : '') + '\n';
md += '- argv: ' + JSON.stringify(process.argv.slice(1)) + '; execArgv: ' + JSON.stringify(process.execArgv) + '; probe flags: ' + probeFlags.concat(probeExtra).join(' ') + '\n';
md += '- QUIET_LOCK_HOST ' + host + ' (host quiet at start: lock-time check; end load / busy nodes recorded, not judged); QUIET_LOCK_WHY ' + (hostWhy || '-') + '\n';
md += '- RingBuffer: HEAD ' + headFull.slice(0, 7) + ', RingBuffer.js sha256/8 ' + rbSha8 + ' (worktree ' + liveState + '); lite-o1 ' + o1Ver + ', O1.js sha256/8 ' + o1Sha8 + '\n';
md += '- mnemonist ' + MN_VERSION + ' (exact devDependency; obliterator ' + mnPin.obliterator + '), MN_SHA256/8 ' + mnSha8 + ' over ' + mnPin.perFile.length +
    ' files (' + mnPin.perFile.map((p) => p.file + ' ' + p.sha256.slice(0, 8)).join(', ') + '); ' + mnPath + '\n\n';
md += 'RingDeque (@zakkster/lite-o1) is a Float64 double-ended queue that throws when full or on NaN; it is measured here as a ' +
    'keep-last-N window (`if (size === capacity) popFront(); pushBack(v)`; bulk copy through `forEach` with a hoisted store ' +
    'callback). Columns marked * are such emulations. Ratios against hand-rolled columns include driver-inlining effects (D13).\n\n';
md += 'MN / MN_TA = mnemonist CircularBuffer through its own API (push; get(size - 1 - i); forEach with a hoisted store callback; ' +
    'toArray + set). MN / MN_TA B/op is reported, not gated. CHK = F32H plus RingBuffer\'s argument checks copied as text (D13 applies to RB - CHK).\n\n';
md += 'B/op = V8 heap bytes per op (v8 total_allocated_bytes); off-heap backing stores not counted. Resolution: < 8 = no per-call 16 B box; 0 B/op is proven only by `npm run alloc`. MODES = a column\'s per-compilation ns/op max/min >= ' + MODES_RATIO + ' (D17).\n\n';
for (const r of J.rows) md += renderRow(r);
md += gcMdExists ? readFileSync(GC_MD, 'utf8').replace(/\n*$/, '\n\n') : '### GC lane -- no compare-gc.md (status ' + g.status + ', signal ' + g.signal + ')\n\n';
const quotes = renderQuote(J.rows, OUT, SMOKE, host);
md += quotes.join('\n') + '\n\nJudge: exit ' + exitAll + (J.why.length ? '\n' + J.why.map((w) => '- ' + w).join('\n') : ' (no findings)') + '\n';
writeFileSync(join(OUT, 'compare.json'), JSON.stringify({ t0: T0, t1: T1, wallS: (T1 - T0) / 1000, host, hostWhy, loadStart, loadEnd, busyStart, busyEnd,
    os: { type: os.type(), release: os.release(), arch: os.arch(), cpu: cpus[0] ? cpus[0].model : '', cores: cpus.length },
    K: Number(K), comp: COMP, smoke: SMOKE, control: CONTROL, argv: process.argv.slice(1), execArgv: process.execArgv, probeFlags: probeFlags.concat(probeExtra),
    head: headFull, rbSha8, liveState, o1: { version: o1Ver, sha8: o1Sha8, path: o1Path },
    mn: { version: MN_VERSION, sha8: mnSha8, files: mnPin.perFile, obliterator: mnPin.obliterator },
    exit: exitAll, why: J.why, quotes, gc: { exit: g.status, file: gcMdExists ? GC_MD : null },
    rows: J.rows.map((r) => (r.verdict === 'VOID' ? { ...r, st: 'VOID', perComp: 'VOID', ns: 'VOID', perCompNs: 'VOID' } : r)), raw: runs }, null, 1));
writeFileSync(join(OUT, 'compare.md'), md);
process.stdout.write(md);
process.stdout.write('compare: exit ' + exitAll + (KEEP ? '; work dir kept: ' + work : '') + '\n');
process.exit(exitAll);
