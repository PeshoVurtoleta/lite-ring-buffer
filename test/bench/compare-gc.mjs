// compare-gc.mjs -- the GC lane + memory per window of the comparison bench (Q2 group B). Tier: REPORTED
// (docs only, with provenance). Dev-only: never part of `npm test` / `npm run verify`; compare.mjs calls it
// once per real run (HOOK H) and appends DIR/compare-gc.md to its own report. Its self-test is a separate
// entry point (compare.mjs --self-test does not run it).
//
//   node test/bench/compare-gc.mjs --out DIR --rb F --rb-sha8 H --o1 F --o1-sha8 H --mn F --mn-sha8 H
//        [--smoke] [--control alloc|leak|mem]
//   node test/bench/compare-gc.mjs --self-test
//
// DIR must exist and must not hold compare-gc.json / compare-gc.md yet. --rb = a RingBuffer.js copy (never
// the live main file as a side), --o1 = the lite-o1 entry, --mn = <node_modules>/mnemonist/circular-buffer.js;
// each sha256/8 is recomputed here (--mn-sha8 = MN_SHA256/8 from mn-pin.mjs, the combined digest of every
// file circular-buffer.js loads) and mnCheck() must pass before any child is spawned.
// Cells: gc lane 7 libs x n {64, 1024} = 14 (RB, F32H, ARR, DEQ, MN_EACH, MN_ARR, CTL); memory per window
// 5 libs x n {64, 256, 1024} = 15 (RB, F32H, ARR, DEQ, MN). One fresh `node --expose-gc
// test/bench/compare-gc-child.mjs` per cell, sequential, async spawn, 120 s timeout, SIGINT / SIGTERM kill
// the running child. --control alloc goes to the gc RB cells, mem to the mem cells, leak to all (a control
// applies only where the child contract accepts it: alloc -> gc RB; every other cell runs uncontrolled).
// A cell is VOID on: missing / crashed / rejected child output (accept: mode, lib, n, control, three sha8s);
// a NaN or null numeric field; bpfWin not W finite numbers (window 0 included, never judged); mem M not the
// schedule's; oracle {before, after} not both true;
// leak.live != 0; RB not (major 0, minor 0, floor 0 <= baseBpf < 8 AND net B/frame = bpf - baseBpf < 8, all
// finite, noGc 'pass') (SPEC A10 + A12: baseBpf carries the counter-read floor; the floor test is rbFloorOk, pure and
// self-tested on its own, NaN / null / non-number / -0 / 8 / 7.99 rows, so it stays NaN-closed even behind the
// GC_NUM finiteness check); CTL not (minor >= 1 and RAW
// B/frame >= 128) at every n; perInstB < 4n (RB, F32H, MN) or < 8n (ARR, DEQ). MN_ARR and the other gc libs
// are REPORTED, no bound. A VOID cell prints VOID in every value column.
// B/frame is V8 heap bytes per frame (total_allocated_bytes): an off-heap typed-array backing store is NOT
// counted (SPEC A7); the GC-count columns are the allocation witness for off-heap stores, and abDelta is the
// retained off-heap gauge (after gc), never an allocation witness (A13). retainedB stays in the JSON, not the md.
// Exit 0 = every cell VALID; 1 = any VOID or a red self-test; 2 = usage (bad argv, DIR missing or not new,
// file missing, sha8 mismatch, mnCheck not ok, counter absent, child usage error).
// QUIET_LOCK_HOST is recorded, not judged. The judge, accept check, renderer and argv parser are pure and
// self-tested; every real run runs the self-test first, before any spawn.
// Test tooling only: not shipped.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MN_SHA256, MN_VERSION, mnCheck } from './mn-pin.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'compare-gc-child.mjs');
const CHILD_TIMEOUT_MS = 120000;
const CHILD_FLAGS = ['--expose-gc'];

// ---- judge constants ----------------------------------------------------------------------------------
const RB_BPF_MAX = 8;         // RB: half a 16 B box per frame, on the NET B/frame (bpf - baseBpf, A10) AND the floor itself (A12)
const CTL_MINOR_MIN = 1;      // CTL: must scavenge in windows 1..W-1
const CTL_BPF_MIN = 128;      // CTL: heap-side bytes of one escaping Float32Array (A7b), at every n
const PER_INST_F = { RB: 4, F32H: 4, MN: 4, ARR: 8, DEQ: 8 };
const GC_LIBS = ['RB', 'F32H', 'ARR', 'DEQ', 'MN_EACH', 'MN_ARR', 'CTL'];
const GC_NS = [64, 1024];
const MEM_LIBS = ['RB', 'F32H', 'ARR', 'DEQ', 'MN'];
const MEM_NS = [64, 256, 1024];
const CONTROLS = { alloc: ['gc RB'], leak: ['gc', 'mem'], mem: ['mem'] };   // 'mode' or 'mode lib'
// child schedule (owned by compare-gc-child.mjs, PLAN-B task 1-2; recorded in provenance, W / M checked)
const SCHED = (smoke) => ({ warm: 50000, window: 40000, W: smoke ? 3 : 5, M: smoke ? 64 : 512 });
const GC_NUM = ['major', 'minor', 'maxPauseMs', 'bpf', 'baseBpf', 'retainedB', 'abDelta', 'leak.live', 'leak.rounds'];
const MEM_NUM = ['M', 'perInstB', 'heapB', 'abB', 'leak.live', 'leak.rounds'];
const LIB_NOTE = {
    RB: 'RingBuffer push + copyTo', F32H: 'hand-rolled Float32Array ring', ARR: 'hand-rolled Array ring',
    DEQ: 'RingDeque, emulated (forEach)', MN_EACH: 'mnemonist push + forEach', MN_ARR: 'mnemonist push + toArray',
    CTL: 'control: RB + escaping Float32Array dst', MN: 'mnemonist CircularBuffer(Float32Array)',
};

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
// JSON turns NaN into null; a non-number is NaN here, so it fails every comparison below.
const num = (x) => (typeof x === 'number' ? x : NaN);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const at = (o, path) => {
    let v = o;
    for (const k of path.split('.')) v = v !== null && typeof v === 'object' ? v[k] : undefined;
    return v;
};
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const key = (mode, lib, n) => mode + ' ' + lib + ' n' + n;
const ctlFor = (control, mode, lib) => (Object.hasOwn(CONTROLS, control) && (CONTROLS[control].includes(mode) || CONTROLS[control].includes(mode + ' ' + lib)) ? control : '');
const expectedCells = () => GC_LIBS.flatMap((lib) => GC_NS.map((n) => ({ mode: 'gc', lib, n })))
    .concat(MEM_LIBS.flatMap((lib) => MEM_NS.map((n) => ({ mode: 'mem', lib, n }))));

// ---- argv (pure) --------------------------------------------------------------------------------------
const VALUE_OPTS = ['--out', '--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8', '--control'];
const FLAG_OPTS = ['--smoke', '--self-test'];
const REQUIRED = ['--out', '--rb', '--rb-sha8', '--o1', '--o1-sha8', '--mn', '--mn-sha8'];
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
// -> { opt } or { err }; opt values are strings, flags true
function parseArgs(argv) {
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
    if (opt['--self-test'] === true) {
        if (Object.keys(opt).length !== 1) return { err: '--self-test takes no other argument' };
        return { opt };
    }
    for (const k of REQUIRED) if (!(k in opt)) return { err: k + ' is required' };
    for (const k of ['--rb-sha8', '--o1-sha8', '--mn-sha8']) if (!/^[0-9a-f]{8}$/.test(opt[k])) return { err: k + ' must be 8 lowercase hex digits' };
    if ('--control' in opt && !Object.hasOwn(CONTROLS, opt['--control'])) return { err: '--control alloc|leak|mem' };
    return { opt };
}

// ---- child-output accept check (pure) -----------------------------------------------------------------
// want = { mode, lib, n (number), control ('' when absent or not this mode's), rb, o1, mn }
function accept(j, want) {
    return !!(isObj(j) && j.mode === want.mode && j.lib === want.lib && j.n === want.n && j.control === want.control &&
        isObj(j.sha8) && j.sha8.rb === want.rb && j.sha8.o1 === want.o1 && j.sha8.mn === want.mn);
}

// ---- the judge (pure) ---------------------------------------------------------------------------------
const oracleGc = (o) => isObj(o) && o.before === true && o.after === true;
// RB floor (A12, pure): 0 <= baseBpf < RB_BPF_MAX, NaN-closed (a non-number is NaN via num, so it fails)
const rbFloorOk = (x) => { const b = num(x); return b >= 0 && b < RB_BPF_MAX; };
function judgeCell(want, c, smoke) {
    const S = SCHED(smoke);
    const v = [];
    if (!c) v.push('cell missing');
    else if (!isObj(c.j)) v.push('child: ' + String(c.err || 'no output'));
    else {
        const j = c.j;
        const fields = want.mode === 'gc' ? GC_NUM : MEM_NUM;
        for (const k of fields) if (!Number.isFinite(num(at(j, k)))) v.push(k + ' ' + String(at(j, k)) + ' not a finite number');
        if (want.mode === 'gc') {
            const w = j.bpfWin;
            if (!Array.isArray(w) || w.length !== S.W || !w.every((x) => Number.isFinite(num(x)))) v.push('bpfWin not ' + S.W + ' finite numbers');
            if (!oracleGc(j.oracle)) v.push('oracle before / after not true');
            if (!(num(at(j, 'leak.live')) === 0)) v.push('leak.live ' + String(at(j, 'leak.live')) + ' != 0');
            if (want.lib === 'RB') {
                if (!(num(j.major) === 0)) v.push('RB major ' + String(j.major) + ' != 0');
                if (!(num(j.minor) === 0)) v.push('RB minor ' + String(j.minor) + ' != 0');
                const base = num(j.baseBpf), net = num(j.bpf) - base;
                if (!rbFloorOk(j.baseBpf)) v.push('RB floor B/frame ' + f(base) + ' not in [0, ' + RB_BPF_MAX + ')');
                if (!(net < RB_BPF_MAX)) v.push('RB net B/frame ' + f(net) + ' (raw ' + f(num(j.bpf)) + ' - floor ' + f(num(j.baseBpf)) + ') not < ' + RB_BPF_MAX);
                if (!(j.noGc === 'pass')) v.push('RB noGc ' + String(j.noGc) + ' != pass');
            }
            if (want.lib === 'CTL' && !(num(j.minor) >= CTL_MINOR_MIN && num(j.bpf) >= CTL_BPF_MIN)) {
                v.push('CTL teeth: minor ' + String(j.minor) + ' / B/frame ' + f(num(j.bpf)) + ' not (>= ' + CTL_MINOR_MIN + ', >= ' + CTL_BPF_MIN + ')');
            }
        } else {
            if (!(num(j.M) === S.M)) v.push('M ' + String(j.M) + ' != ' + S.M);
            if (!oracleGc(j.oracle)) v.push('oracle before / after not true');
            if (!(num(at(j, 'leak.live')) === 0)) v.push('leak.live ' + String(at(j, 'leak.live')) + ' != 0');
            const bound = PER_INST_F[want.lib] * want.n;
            if (!(num(j.perInstB) >= bound)) v.push('perInstB ' + f(num(j.perInstB), 1) + ' not >= ' + bound + ' (' + PER_INST_F[want.lib] + 'n)');
        }
    }
    return { mode: want.mode, lib: want.lib, n: want.n, verdict: v.length ? 'VOID' : 'VALID', why: v, j: c && isObj(c.j) ? c.j : null };
}
// cells: [{ mode, lib, n, j (accepted child JSON or null), err }]
function judge(cells, smoke) {
    const list = Array.isArray(cells) ? cells : [];
    const rows = expectedCells().map((w) => judgeCell(w, list.find((c) => c && c.mode === w.mode && c.lib === w.lib && c.n === w.n), smoke === true));
    const why = [];
    for (const r of rows) for (const w of r.why) why.push('VOID ' + key(r.mode, r.lib, r.n) + ': ' + w);
    return { exit: why.length ? 1 : 0, rows, why };
}
function tierOf(exit, smoke, host) {
    if (smoke) return 'SMOKE: not quotable';
    if (exit !== 0) return 'VOID cells present';
    return host === 'quiet' ? 'REPORTED (QUIET host, every cell VALID)' : 'PRELIMINARY (host ' + String(host) + '), every cell VALID';
}

// ---- report rendering (pure) --------------------------------------------------------------------------
const BPF_LABEL = 'V8 heap B/frame (off-heap backing stores not counted)';
const GC_HEAD = ['lib', 'n', 'verdict', 'major', 'minor', 'maxPauseMs', 'noGc', BPF_LABEL, 'B/frame per window (0..W-1, 0 not judged)', 'floor B/frame (empty driver)',
    'net B/frame (raw - floor; RB bound)',
    'abDelta', 'leak live / rounds', 'oracle'];
const MEM_HEAD = ['lib', 'n', 'verdict', 'M', 'perInstB', 'bound', 'heapB / inst', 'abB / inst', 'leak live / rounds', 'oracle'];
const tr = (cells) => '| ' + cells.join(' | ') + ' |\n';
const sep = (k) => '|' + '---|'.repeat(k) + '\n';
function renderMd(J, P) {
    const S = SCHED(P.smoke === true);
    let md = '### GC lane and memory per window -- ' + tierOf(J.exit, P.smoke === true, P.host) + ' -- exit ' + J.exit + '\n\n';
    md += '- Run: ' + P.t0 + ' .. ' + P.t1 + ' (' + f(P.wallS, 1) + ' s wall); host ' + P.os + '\n';
    md += '- Load1/5/15: start ' + P.loadStart + ', end ' + P.loadEnd + '; other node >= 10% CPU: start ' + P.busyStart + '; end ' + P.busyEnd + '\n';
    md += '- Node ' + P.node + ' / V8 ' + P.v8 + '; child flags ' + CHILD_FLAGS.join(' ') + '; ' + (P.smoke === true ? 'smoke; ' : '') + 'control ' + (P.control || 'none') + '\n';
    md += '- Schedule (child): warm ' + S.warm + ' frames, gc + sleep, W ' + S.W + ' windows x ' + S.window + ' frames, judged windows 1..' + (S.W - 1) +
        '; memory M ' + S.M + ' instances per cell\n';
    md += '- RingBuffer sha256/8 ' + P.rb.sha8 + ' (' + P.rb.path + '); lite-o1 ' + P.o1.version + ' sha256/8 ' + P.o1.sha8 + ' (' + P.o1.path + '); mnemonist ' +
        P.mn.version + ' MN_SHA256/8 ' + P.mn.sha8 + ' (' + P.mn.path + ')\n';
    md += '- Scope (LEDGER law 12): exactly the three files above (+ the mn-pin MN_FILES), child ' + P.child + ', out ' + P.out + '; no glob\n';
    md += '- argv: ' + P.argv + '; self-test ' + P.selfTest + '\n';
    md += '- QUIET_LOCK_HOST ' + String(P.host) + ' (recorded, not judged); QUIET_LOCK_WHY ' + (P.hostWhy || '-') + '\n\n';
    md += 'B/frame = min over windows 1..' + (S.W - 1) + ' of the V8 `total_allocated_bytes` delta / frames: V8 heap only, an off-heap typed-array ' +
        'backing store is NOT counted (a B/frame figure is never "total bytes"). The GC-count columns (major / minor) are the ' +
        'allocation witness for off-heap stores. abDelta = retained off-heap (gauge after gc): memoryUsage().arrayBuffers after the ' +
        'last window minus after warmup, both after gc, instance alive; it is not an allocation witness. ' +
        'floor = the empty driver\'s B/frame (the counter-read floor, run just before each lib window); net = raw - floor. ' +
        'Gated: RB major 0, minor 0, 0 <= floor < ' + RB_BPF_MAX + ' and net B/frame < ' + RB_BPF_MAX + ', checkNoGc pass; CTL minor >= ' + CTL_MINOR_MIN + ' and raw B/frame >= ' + CTL_BPF_MIN +
        ' at every n (must-fail control); leak.live 0. Every other number is REPORTED, no bound (MN_ARR included).\n\n';
    md += '#### GC lane\n\n' + tr(GC_HEAD) + sep(GC_HEAD.length);
    for (const r of J.rows.filter((x) => x.mode === 'gc')) {
        const j = r.j || {};
        const V = r.verdict === 'VOID';
        const vals = V ? GC_HEAD.slice(3).map(() => 'VOID') : [
            f(num(j.major), 0), f(num(j.minor), 0), f(num(j.maxPauseMs), 3), String(j.noGc ?? '-'), f(num(j.bpf), 2),
            (Array.isArray(j.bpfWin) ? j.bpfWin : []).map((x) => f(num(x), 2)).join(' / '), f(num(j.baseBpf), 2), f(num(j.bpf) - num(j.baseBpf), 2),
            f(num(j.abDelta), 0), f(num(at(j, 'leak.live')), 0) + ' / ' + f(num(at(j, 'leak.rounds')), 0), 'ok',
        ];
        md += tr([r.lib, String(r.n), r.verdict].concat(vals));
    }
    md += '\n#### Memory per window (used_heap_size + arrayBuffers, per instance)\n\n' + tr(MEM_HEAD) + sep(MEM_HEAD.length);
    for (const r of J.rows.filter((x) => x.mode === 'mem')) {
        const j = r.j || {};
        const V = r.verdict === 'VOID';
        const vals = V ? MEM_HEAD.slice(3).map(() => 'VOID') : [
            f(num(j.M), 0), f(num(j.perInstB), 1), '>= ' + (PER_INST_F[r.lib] * r.n), f(num(j.heapB), 1), f(num(j.abB), 1),
            f(num(at(j, 'leak.live')), 0) + ' / ' + f(num(at(j, 'leak.rounds')), 0), 'ok',
        ];
        md += tr([r.lib, String(r.n), r.verdict].concat(vals));
    }
    md += '\nLibs: ' + Object.keys(LIB_NOTE).map((k) => k + ' = ' + LIB_NOTE[k]).join('; ') + '.\n';
    md += '\nJudge: exit ' + J.exit + (J.why.length ? '\n' + J.why.map((w) => '- ' + w).join('\n') : ' (no findings)') + '\n';
    return md;
}

// ---- self-test: every VOID rule tripped and passed, every accept clause flipped ---------------------------
const SHA = { rb: 'aaaa1111', o1: 'bbbb2222', mn: 'cccc3333' };
function synth(mode, lib, n, smoke) {
    const S = SCHED(smoke);
    const base = { mode, lib, n, control: '', node: 'v0', v8: '0', sha8: { ...SHA }, oracle: { before: true, after: true }, leak: { live: 0, rounds: 2 } };
    if (mode === 'mem') return { ...base, M: S.M, perInstB: PER_INST_F[lib] * n + 100, heapB: 100, abB: PER_INST_F[lib] * n, oracle: { before: true, after: true } };
    const ctl = lib === 'CTL';
    const bpf = ctl ? 200 : lib === 'RB' ? 0.5 : 1;
    return { ...base, major: 0, minor: ctl ? 3 : 0, maxPauseMs: 0.25, noGc: ctl ? 'fail' : 'pass', bpf,
        bpfWin: Array.from({ length: S.W }, (_, i) => bpf + (i === 0 ? 50 : i - 1)), baseBpf: 0.1, retainedB: 0, abDelta: ctl ? 4096 : 0 };
}
const setAt = (o, path, val) => {
    const p = path.split('.');
    let x = o;
    for (let i = 0; i < p.length - 1; i++) x = x[p[i]];
    x[p[p.length - 1]] = val;
};
// cells for a full VALID run; mut(get) edits them, get(mode, lib, n) -> that cell
function synthCells(smoke, mut) {
    const cells = expectedCells().map((w) => ({ ...w, j: synth(w.mode, w.lib, w.n, smoke), err: '' }));
    const get = (mode, lib, n) => cells.find((c) => c.mode === mode && c.lib === lib && c.n === n);
    if (mut) mut(get, cells);
    return cells;
}
function selfTest() {
    const cases = [];
    const c = (name, want, fn, pred) => cases.push([name, want, fn, pred]);
    const has = (J, s) => J.why.some((w) => w.includes(s));
    const run = (mut, smoke = false) => judge(synthCells(smoke, mut), smoke);
    const one = (mode, lib, n, path, val, smoke = false) => run((g) => setAt(g(mode, lib, n).j, path, val), smoke);
    c('baseline full -> 0', 0, () => run(), (J) => J.rows.length === 29 && J.rows.every((r) => r.verdict === 'VALID'));
    c('baseline smoke -> 0', 0, () => run(null, true));
    c('expected cells 14 gc + 15 mem', 0, () => ({ exit: 0 }), () => expectedCells().filter((x) => x.mode === 'gc').length === 14 &&
        expectedCells().filter((x) => x.mode === 'mem').length === 15);
    // missing / crashed / not a JSON object
    c('cell missing -> 1', 1, () => run((g, cells) => cells.splice(cells.indexOf(g('gc', 'DEQ', 64)), 1)), (J) => has(J, 'gc DEQ n64: cell missing'));
    c('mem cell missing -> 1', 1, () => run((g, cells) => cells.splice(cells.indexOf(g('mem', 'MN', 256)), 1)), (J) => has(J, 'mem MN n256: cell missing'));
    c('child crashed -> 1', 1, () => run((g) => { const x = g('gc', 'F32H', 1024); x.j = null; x.err = 'status 1 signal null'; }), (J) => has(J, 'child: status 1'));
    c('bad JSON (string) -> 1', 1, () => run((g) => { g('mem', 'ARR', 64).j = 'not json'; }));
    c('JSON array -> 1', 1, () => run((g) => { g('gc', 'RB', 64).j = []; }));
    c('cells not an array -> 1', 1, () => judge(null, false), (J) => J.rows.length === 29 && J.rows.every((r) => r.verdict === 'VOID'));
    c('duplicate cells: first wins, still 29 rows -> 0', 0, () => run((g, cells) => cells.push({ ...g('gc', 'RB', 64) })), (J) => J.rows.length === 29);
    // NaN / null / string on every numeric field
    for (const k of GC_NUM) {
        c('gc ' + k + ' NaN -> 1', 1, () => one('gc', 'MN_EACH', 64, k, NaN), (J) => has(J, k + ' NaN not a finite'));
        c('gc ' + k + ' null -> 1', 1, () => one('gc', 'ARR', 1024, k, null));
    }
    for (const k of MEM_NUM) {
        c('mem ' + k + ' NaN -> 1', 1, () => one('mem', 'DEQ', 256, k, NaN), (J) => has(J, k + ' NaN not a finite'));
        c('mem ' + k + ' null -> 1', 1, () => one('mem', 'F32H', 64, k, null));
    }
    c('gc major string "0" -> 1', 1, () => one('gc', 'RB', 64, 'major', '0'));
    c('gc bpf Infinity -> 1', 1, () => one('gc', 'MN_ARR', 64, 'bpf', Infinity));
    c('leak object missing -> 1', 1, () => one('gc', 'DEQ', 1024, 'leak', undefined));
    // bpfWin
    c('bpfWin null element -> 1', 1, () => run((g) => { g('gc', 'F32H', 64).j.bpfWin[1] = null; }), (J) => has(J, 'bpfWin'));
    c('bpfWin W-1 entries (window 0 dropped) -> 1', 1, () => run((g) => { g('gc', 'F32H', 64).j.bpfWin.shift(); }));
    c('bpfWin W+1 entries -> 1', 1, () => run((g) => { g('gc', 'F32H', 64).j.bpfWin.push(1); }));
    c('bpfWin missing -> 1', 1, () => one('gc', 'MN_EACH', 1024, 'bpfWin', undefined));
    c('bpfWin smoke 3 entries -> 0', 0, () => run(null, true), (J) => J.rows[0].j.bpfWin.length === 3);
    c('bpfWin full-length under smoke -> 1', 1, () => run((g) => { g('gc', 'ARR', 64).j.bpfWin = [1, 1, 1, 1, 1]; }, true));
    // M
    c('mem M 511 -> 1', 1, () => one('mem', 'RB', 64, 'M', 511), (J) => has(J, 'M 511 != 512'));
    c('mem M 512 under smoke -> 1', 1, () => one('mem', 'RB', 64, 'M', 512, true), (J) => has(J, 'M 512 != 64'));
    // oracle
    c('gc oracle.before false -> 1', 1, () => one('gc', 'DEQ', 64, 'oracle.before', false), (J) => has(J, 'oracle'));
    c('gc oracle.after false -> 1', 1, () => one('gc', 'MN_ARR', 1024, 'oracle.after', false));
    c('gc oracle.after missing -> 1', 1, () => one('gc', 'RB', 1024, 'oracle.after', undefined));
    c('gc oracle true (not before/after) -> 1', 1, () => one('gc', 'CTL', 64, 'oracle', true));
    c('gc oracle null -> 1', 1, () => one('gc', 'F32H', 64, 'oracle', null));
    c('mem oracle.after false -> 1', 1, () => one('mem', 'MN', 1024, 'oracle.after', false), (J) => has(J, 'VOID mem MN n1024: oracle before / after not true'));
    c('mem oracle.before false -> 1', 1, () => one('mem', 'RB', 64, 'oracle.before', false));
    c('mem oracle {} -> 1', 1, () => one('mem', 'ARR', 256, 'oracle', {}));
    c('mem oracle "true" -> 1', 1, () => one('mem', 'RB', 1024, 'oracle', 'true'));
    c('mem oracle true (not before/after) -> 1', 1, () => one('mem', 'RB', 1024, 'oracle', true));
    // leak.live == 0 everywhere
    for (const [mode, lib, n] of [['gc', 'RB', 64], ['gc', 'MN_ARR', 1024], ['gc', 'CTL', 64], ['mem', 'DEQ', 1024], ['mem', 'F32H', 256]]) {
        c(mode + ' ' + lib + ' n' + n + ' leak.live 1 -> 1', 1, () => one(mode, lib, n, 'leak.live', 1), (J) => has(J, 'leak.live 1 != 0'));
    }
    c('leak.live -0 counts as 0 -> 0', 0, () => one('gc', 'ARR', 64, 'leak.live', -0));
    c('leak.rounds 20 reported -> 0', 0, () => one('mem', 'MN', 64, 'leak.rounds', 20));
    // RB: major 0 / minor 0 / B/frame < 8 / noGc pass, both n
    for (const n of GC_NS) {
        c('RB n' + n + ' major 1 -> 1', 1, () => one('gc', 'RB', n, 'major', 1), (J) => has(J, 'RB major 1'));
        c('RB n' + n + ' minor 1 -> 1', 1, () => one('gc', 'RB', n, 'minor', 1), (J) => has(J, 'RB minor 1'));
        const rbb = (bpf, base) => run((g) => { const j = g('gc', 'RB', n).j; j.bpf = bpf; j.baseBpf = base; });
        c('RB n' + n + ' net 7.99 (13.99 - 6) -> 0', 0, () => rbb(13.99, 6));
        c('RB n' + n + ' net 8 (14 - 6) -> 1', 1, () => rbb(14, 6), (J) => has(J, 'RB net B/frame 8.00 (raw 14.00 - floor 6.00) not < 8'));
        c('RB n' + n + ' net 8 (8 - 0) -> 1', 1, () => rbb(8, 0));
        c('RB n' + n + ' raw 13.9 base 6 -> 0', 0, () => rbb(13.9, 6));
        c('RB n' + n + ' baseBpf NaN -> 1', 1, () => rbb(5, NaN), (J) => has(J, 'RB net B/frame NaN'));
        c('RB n' + n + ' baseBpf null -> 1', 1, () => rbb(5, null), (J) => has(J, 'RB net B/frame NaN'));
        c('RB n' + n + ' bpf null -> 1', 1, () => rbb(null, 6), (J) => has(J, 'RB net B/frame NaN'));
        c('RB n' + n + ' noGc fail -> 1', 1, () => one('gc', 'RB', n, 'noGc', 'fail'), (J) => has(J, 'RB noGc fail'));
        c('RB n' + n + ' noGc true -> 1', 1, () => one('gc', 'RB', n, 'noGc', true));
        c('RB n' + n + ' noGc inconclusive -> 1', 1, () => one('gc', 'RB', n, 'noGc', 'inconclusive'), (J) => has(J, 'RB noGc inconclusive'));
        c('RB n' + n + ' noGc missing -> 1', 1, () => one('gc', 'RB', n, 'noGc', undefined));
    }
    // CTL teeth (A7b): minor >= 1 AND B/frame >= 128, at every n
    for (const n of GC_NS) {
        c('CTL n' + n + ' minor 0 -> 1', 1, () => one('gc', 'CTL', n, 'minor', 0), (J) => has(J, 'CTL teeth'));
        c('CTL n' + n + ' minor 1 -> 0', 0, () => one('gc', 'CTL', n, 'minor', 1));
        c('CTL n' + n + ' B/frame 127.99 -> 1', 1, () => one('gc', 'CTL', n, 'bpf', 127.99), (J) => has(J, 'CTL teeth'));
        c('CTL n' + n + ' B/frame 128 -> 0', 0, () => one('gc', 'CTL', n, 'bpf', 128));
    }
    c('CTL minor 0 at one n only -> 1', 1, () => one('gc', 'CTL', 1024, 'minor', 0), (J) => has(J, 'gc CTL n1024: CTL teeth') && !has(J, 'gc CTL n64'));
    // REPORTED only: other gc libs carry no GC / B/frame bound
    for (const lib of ['F32H', 'ARR', 'DEQ', 'MN_EACH', 'MN_ARR']) {
        c(lib + ' minor 9 + major 2 + B/frame 5000 reported -> 0', 0, () => run((g) => { const j = g('gc', lib, 1024).j; j.minor = 9; j.major = 2; j.bpf = 5000; j.noGc = 'fail'; }));
    }
    c('RB retainedB / abDelta large, floor 7.99 in bound -> 0', 0, () => run((g) => { const j = g('gc', 'RB', 64).j; j.retainedB = -1e6; j.abDelta = 1e6; j.baseBpf = 7.99; }));
    for (const n of GC_NS) {
        const rbf = (bpf, base) => run((g) => { const j = g('gc', 'RB', n).j; j.bpf = bpf; j.baseBpf = base; });
        c('RB n' + n + ' floor 99 (bpf 50) -> 1', 1, () => rbf(50, 99), (J) => has(J, 'RB floor B/frame 99.00 not in [0, 8)'));
        c('RB n' + n + ' floor 8 (bpf 8) -> 1', 1, () => rbf(8, 8), (J) => has(J, 'RB floor B/frame 8.00 not in [0, 8)'));
        c('RB n' + n + ' floor -0.5 (bpf 0) -> 1', 1, () => rbf(0, -0.5), (J) => has(J, 'RB floor B/frame -0.50'));
        c('RB n' + n + ' bpf 20 floor 14 (net 6) -> 1', 1, () => rbf(20, 14), (J) => has(J, 'RB floor B/frame 14.00') && !has(J, 'RB net'));
        c('RB n' + n + ' floor 0 net 7.99 -> 0', 0, () => rbf(7.99, 0));
        c('RB n' + n + ' floor 7.99 net 7.99 -> 0', 0, () => rbf(15.98, 7.99));
    }
    // the floor line itself (rbFloorOk), with no finiteness gate in front of it: a NaN-open rewrite
    // (`base < 0 || base >= RB_BPF_MAX`) passes NaN / null / undefined / a string, and only these rows see it
    for (const [x, want] of [[NaN, false], [null, false], [undefined, false], ['0', false], ['7', false], [true, false], [Infinity, false],
        [-Infinity, false], [-0.5, false], [8, false], [8.01, false], [-0, true], [0, true], [0.1, true], [7.99, true]]) {
        const nm = typeof x === 'string' ? JSON.stringify(x) : Object.is(x, -0) ? '-0' : String(x);
        c('rbFloorOk ' + nm + ' -> ' + want, 0, () => ({ exit: 0 }), () => rbFloorOk(x) === want);
    }
    // perInstB >= 4n (RB, F32H, MN) / >= 8n (ARR, DEQ)
    for (const lib of MEM_LIBS) {
        for (const n of MEM_NS) {
            const b = PER_INST_F[lib] * n;
            c('mem ' + lib + ' n' + n + ' perInstB ' + b + ' -> 0', 0, () => one('mem', lib, n, 'perInstB', b));
            c('mem ' + lib + ' n' + n + ' perInstB ' + (b - 0.5) + ' -> 1', 1, () => one('mem', lib, n, 'perInstB', b - 0.5), (J) => has(J, 'perInstB'));
        }
    }
    c('mem ARR n256 at 4n (RB bound) -> 1', 1, () => one('mem', 'ARR', 256, 'perInstB', 1024), (J) => has(J, 'not >= 2048 (8n)'));
    c('mem DEQ n64 at 4n -> 1', 1, () => one('mem', 'DEQ', 64, 'perInstB', 256));
    // must-fail control logic: what each --control makes the children report
    c('control alloc: RB looks like CTL -> 1', 1, () => run((g) => {
        for (const n of GC_NS) { const j = g('gc', 'RB', n).j; j.minor = 7; j.bpf = 215; j.noGc = 'fail'; }
    }), (J) => has(J, 'VOID gc RB n64: RB minor 7') && has(J, 'VOID gc RB n1024: RB net B/frame 214.90') && J.rows.filter((r) => r.verdict === 'VOID').length === 2);
    c('control leak: live 1 on every cell -> 1', 1, () => run((g, cells) => { for (const x of cells) x.j.leak.live = 1; }),
        (J) => J.rows.every((r) => r.verdict === 'VOID' && r.why.some((w) => w.includes('leak.live 1'))));
    c('control mem: F32H n1024 perInstB 300 -> 1', 1, () => one('mem', 'F32H', 1024, 'perInstB', 300), (J) => has(J, 'VOID mem F32H n1024: perInstB 300.0 not >= 4096'));
    c('a broken CTL (no teeth) is VOID, not a pass -> 1', 1, () => run((g) => { for (const n of GC_NS) { const j = g('gc', 'CTL', n).j; j.minor = 0; j.bpf = 0; } }));
    // control routing (a control applies to the mode it breaks)
    c('ctlFor routing', 0, () => ({ exit: 0 }), () => ctlFor('alloc', 'gc', 'RB') === 'alloc' && ctlFor('alloc', 'gc', 'CTL') === '' && ctlFor('alloc', 'gc', 'F32H') === '' &&
        ctlFor('alloc', 'mem', 'RB') === '' && ctlFor('leak', 'gc', 'MN_ARR') === 'leak' && ctlFor('leak', 'mem', 'MN') === 'leak' && ctlFor('mem', 'mem', 'ARR') === 'mem' &&
        ctlFor('mem', 'gc', 'RB') === '' && ctlFor('', 'gc', 'RB') === '' && ctlFor('bogus', 'gc', 'RB') === '' && ctlFor('__proto__', 'gc', 'RB') === '' && ctlFor('toString', 'mem', 'RB') === '');
    // tier
    c('tierOf', 0, () => ({ exit: 0 }), () => tierOf(0, false, 'quiet') === 'REPORTED (QUIET host, every cell VALID)' &&
        tierOf(0, false, 'preliminary') === 'PRELIMINARY (host preliminary), every cell VALID' && tierOf(0, false, undefined).includes('host undefined') &&
        tierOf(1, false, 'quiet') === 'VOID cells present' && tierOf(0, true, 'quiet') === 'SMOKE: not quotable' && tierOf(1, true, 'quiet') === 'SMOKE: not quotable');
    // accept: one baseline, one reject per clause
    const W0 = { mode: 'gc', lib: 'RB', n: 64, control: '', ...SHA };
    const aj = (o = {}) => Object.assign(synth('gc', 'RB', 64, false), o);
    const acc = (name, want, j, w = W0) => c('accept ' + name + ' -> ' + want, want, () => ({ exit: accept(j, w) === true ? 0 : 1 }));
    acc('baseline', 0, aj());
    acc('mode mem', 1, aj({ mode: 'mem' }));
    acc('mode missing', 1, (() => { const j = aj(); delete j.mode; return j; })());
    acc('lib F32H', 1, aj({ lib: 'F32H' }));
    acc('lib rb (case)', 1, aj({ lib: 'rb' }));
    acc('n 1024', 1, aj({ n: 1024 }));
    acc('n "64" string', 1, aj({ n: '64' }));
    acc('control alloc', 1, aj({ control: 'alloc' }));
    acc('control null', 1, aj({ control: null }));
    acc('control missing', 1, (() => { const j = aj(); delete j.control; return j; })());
    acc('sha8.rb flip', 1, aj({ sha8: { ...SHA, rb: 'aaaa1112' } }));
    acc('sha8.o1 flip', 1, aj({ sha8: { ...SHA, o1: 'bbbb2223' } }));
    acc('sha8.mn flip', 1, aj({ sha8: { ...SHA, mn: 'cccc3334' } }));
    acc('sha8.mn missing', 1, aj({ sha8: { rb: SHA.rb, o1: SHA.o1 } }));
    acc('sha8 missing', 1, (() => { const j = aj(); delete j.sha8; return j; })());
    acc('sha8 array', 1, aj({ sha8: [SHA.rb, SHA.o1, SHA.mn] }));
    acc('j null', 1, null);
    acc('j array', 1, []);
    acc('mem baseline', 0, synth('mem', 'MN', 256, false), { ...W0, mode: 'mem', lib: 'MN', n: 256 });
    acc('control alloc both', 0, aj({ control: 'alloc' }), { ...W0, control: 'alloc' });
    // argv
    const pa = (name, want, argv, pred) => c('argv ' + name + ' -> ' + want, want, () => { const r = parseArgs(argv); return { exit: r.err ? 2 : 0, r }; }, pred ? (J) => pred(J.r) : undefined);
    const GOOD = ['--out', '/x', '--rb', '/r.js', '--rb-sha8', 'aaaa1111', '--o1', '/o.js', '--o1-sha8', 'bbbb2222', '--mn', '/m.js', '--mn-sha8', 'cccc3333'];
    pa('baseline', 0, GOOD, (r) => r.opt['--out'] === '/x' && !('--smoke' in r.opt));
    pa('smoke + control leak', 0, GOOD.concat(['--smoke', '--control', 'leak']), (r) => r.opt['--smoke'] === true && r.opt['--control'] === 'leak');
    pa('self-test alone', 0, ['--self-test']);
    pa('self-test + --out', 2, ['--self-test', '--out', '/x']);
    pa('missing --out', 2, GOOD.slice(2), (r) => r.err === '--out is required');
    pa('missing --mn-sha8', 2, GOOD.slice(0, -2), (r) => r.err === '--mn-sha8 is required');
    pa('unknown --contrl did-you-mean', 2, GOOD.concat(['--contrl', 'leak']), (r) => r.err.includes('did you mean --control?'));
    pa('--out twice', 2, GOOD.concat(['--out', '/y']), (r) => r.err === '--out given twice');
    pa('--out needs value', 2, ['--out'], (r) => r.err === '--out needs a value');
    pa('--rb value is a flag', 2, ['--rb', '--smoke']);
    pa('bad sha8 short', 2, GOOD.map((x) => (x === 'aaaa1111' ? 'aaaa111' : x)), (r) => r.err.startsWith('--rb-sha8'));
    pa('bad sha8 upper', 2, GOOD.map((x) => (x === 'cccc3333' ? 'CCCC3333' : x)), (r) => r.err.startsWith('--mn-sha8'));
    pa('control box', 2, GOOD.concat(['--control', 'box']));
    pa('control __proto__', 2, GOOD.concat(['--control', '__proto__']));
    // renderMd shape
    const PV = { smoke: false, host: 'quiet', hostWhy: '', t0: 'T0', t1: 'T1', wallS: 1, os: 'os', loadStart: '0', loadEnd: '0', busyStart: 'none', busyEnd: 'none',
        node: 'v0', v8: '0', control: '', rb: { sha8: SHA.rb, path: '/r' }, o1: { sha8: SHA.o1, path: '/o', version: '1' }, mn: { sha8: SHA.mn, path: '/m', version: MN_VERSION },
        child: '/c', out: '/x', argv: '[]', selfTest: 'n/n' };
    const rowsOf = (md, head) => {
        const part = md.split(head)[1].split('\n\n')[1] || '';
        return part.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| lib '));
    };
    c('render VALID: heading, 14 + 15 rows, labels, no VOID', 0, () => run(), (J) => {
        const md = renderMd(J, PV);
        const g = rowsOf(md, '#### GC lane'), m = rowsOf(md, '#### Memory per window');
        return md.startsWith('### GC lane and memory per window -- REPORTED (QUIET host, every cell VALID) -- exit 0\n') &&
            g.length === 14 && m.length === 15 && md.includes('| ' + BPF_LABEL + ' |') && md.includes('| abDelta |') && md.includes('| net B/frame (raw - floor; RB bound) |') && md.includes('| floor B/frame (empty driver) |') &&
            md.includes('abDelta = retained off-heap (gauge after gc)') && md.includes('allocation witness for off-heap stores') && !md.includes('off-heap witness') &&
            !md.includes('retainedB') && md.includes('Scope (LEDGER law 12)') && !md.includes('VOID') &&
            g.every((l) => l.split(' | ').length === GC_HEAD.length) && m.every((l) => l.split(' | ').length === MEM_HEAD.length);
    });
    c('render VOID cell: VOID in every value column', 1, () => run((g) => { g('gc', 'RB', 64).j.bpf = 16; g('mem', 'ARR', 1024).j.perInstB = 1; }), (J) => {
        const md = renderMd(J, PV);
        const gl = rowsOf(md, '#### GC lane').find((l) => l.startsWith('| RB | 64 |'));
        const ml = rowsOf(md, '#### Memory per window').find((l) => l.startsWith('| ARR | 1024 |'));
        const allVoid = (l, k) => { const p = l.slice(2, -2).split(' | '); return p.length === k && p.slice(2).every((x) => x === 'VOID'); };
        return md.startsWith('### GC lane and memory per window -- VOID cells present -- exit 1\n') && allVoid(gl, GC_HEAD.length) && allVoid(ml, MEM_HEAD.length) &&
            !gl.includes('16.00') && md.includes('- VOID gc RB n64: RB net B/frame 15.90 (raw 16.00 - floor 0.10) not < 8');
    });
    c('render smoke tier', 0, () => run(null, true), (J) => renderMd(J, { ...PV, smoke: true }).startsWith('### GC lane and memory per window -- SMOKE: not quotable -- exit 0\n'));
    c('render preliminary host', 0, () => run(), (J) => renderMd(J, { ...PV, host: 'unlocked' }).startsWith('### GC lane and memory per window -- PRELIMINARY (host unlocked), every cell VALID -- exit 0'));
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
    return { ok: pass === cases.length, pass, total: cases.length, lines };
}

// ---- entry ------------------------------------------------------------------------------------------------
function die(msg) {
    process.stderr.write('compare-gc: ' + msg + '\ncompare-gc: exit 2 (usage)\n');
    process.exit(2);
}
const PA = parseArgs(process.argv.slice(2));
if (PA.err) die(PA.err);
const opt = PA.opt;

// self-test first, always, before any spawn
const ST = selfTest();
if (opt['--self-test'] === true) {
    for (const l of ST.lines) process.stdout.write(l + '\n');
    process.stdout.write('compare-gc self-test: ' + ST.pass + '/' + ST.total + ' checks ' + (ST.ok ? 'ok' : 'FAILED') + '\n');
    process.exit(ST.ok ? 0 : 1);
}
if (!ST.ok) {
    for (const l of ST.lines) if (l.startsWith('FAIL')) process.stderr.write(l + '\n');
    process.stderr.write('compare-gc: self-test red (' + ST.pass + '/' + ST.total + '): exit 1\n');
    process.exit(1);
}
process.stdout.write('compare-gc self-test: ' + ST.pass + '/' + ST.total + ' checks ok\n');

// ---- preconditions (exit 2) -------------------------------------------------------------------------------
const SMOKE = opt['--smoke'] === true;
const CONTROL = opt['--control'] ?? '';
const OUT = resolve(opt['--out']);
const OUT_JSON = join(OUT, 'compare-gc.json');
const OUT_MD = join(OUT, 'compare-gc.md');
if (!isDir(OUT)) die('--out must be an existing directory: ' + OUT);
if (existsSync(OUT_JSON) || existsSync(OUT_MD)) die('--out already holds compare-gc.json / compare-gc.md: ' + OUT);
const rbPath = resolve(opt['--rb']);
const o1Path = resolve(opt['--o1']);
const mnPath = resolve(opt['--mn']);
for (const [k, p] of [['--rb', rbPath], ['--o1', o1Path], ['--mn', mnPath]]) if (!isFile(p)) die(k + ' is not a file: ' + p);
const rbSha8 = sha(readFileSync(rbPath)).slice(0, 8);
if (rbSha8 !== opt['--rb-sha8']) die('--rb-sha8 ' + opt['--rb-sha8'] + ' != recomputed ' + rbSha8 + ' (' + rbPath + ')');
const o1Sha8 = sha(readFileSync(o1Path)).slice(0, 8);
if (o1Sha8 !== opt['--o1-sha8']) die('--o1-sha8 ' + opt['--o1-sha8'] + ' != recomputed ' + o1Sha8 + ' (' + o1Path + ')');
let o1Ver = null;
try { const pj = JSON.parse(readFileSync(join(dirname(o1Path), 'package.json'), 'utf8')); o1Ver = pj && pj.name === '@zakkster/lite-o1' ? String(pj.version) : null; } catch { o1Ver = null; }
if (basename(mnPath) !== 'circular-buffer.js' || basename(dirname(mnPath)) !== 'mnemonist') die('--mn must be <node_modules>/mnemonist/circular-buffer.js: ' + mnPath);
const NM = dirname(dirname(mnPath));
const MC = mnCheck(NM);
if (!MC.ok) die('mnCheck(' + NM + ') not ok: ' + MC.why);
const mnSha8 = MN_SHA256.slice(0, 8);
if (String(MC.sha256).slice(0, 8) !== mnSha8 || opt['--mn-sha8'] !== mnSha8) die('--mn-sha8 ' + opt['--mn-sha8'] + ' != MN_SHA256/8 ' + mnSha8 + ' (recomputed ' + String(MC.sha256).slice(0, 8) + ')');
const tab = v8.getHeapStatistics().total_allocated_bytes;
if (!(typeof tab === 'number' && Number.isFinite(tab))) die('v8.getHeapStatistics().total_allocated_bytes absent on ' + process.version);
if (!isFile(CHILD)) die('child missing: ' + CHILD);

// ---- spawn (sequential; SIGINT / SIGTERM kill the running child) -----------------------------------------
let child = null;
const onSignal = (code) => () => { if (child) child.kill('SIGKILL'); process.exit(code); };
process.on('SIGINT', onSignal(130));
process.on('SIGTERM', onSignal(143));
// async spawn: the event loop turns while a child runs, so a signal is handled at once
function runChild(args) {
    return new Promise((res) => {
        let out = '', err = '', done = false;
        const fin = (status, signal, error) => { if (done) return; done = true; clearTimeout(timer); child = null; res({ status, signal, stdout: out, stderr: err, error }); };
        const ch = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        child = ch;
        const timer = setTimeout(() => ch.kill('SIGKILL'), CHILD_TIMEOUT_MS);
        ch.stdout.setEncoding('utf8');
        ch.stderr.setEncoding('utf8');
        ch.stdout.on('data', (d) => { out += d; });
        ch.stderr.on('data', (d) => { err += d; });
        ch.on('error', (e) => fin(null, null, e));
        ch.on('close', (status, signal) => fin(status, signal, null));
    });
}
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

const host = process.env.QUIET_LOCK_HOST || 'unlocked';
const hostWhy = process.env.QUIET_LOCK_WHY || '';
const T0 = new Date();
const loadStart = os.loadavg();
const busyStart = busyNodes();
process.stdout.write('RingBuffer sha256/8 ' + rbSha8 + ' ' + rbPath + '\nlite-o1 ' + o1Ver + ' sha256/8 ' + o1Sha8 + ' ' + o1Path +
    '\nmnemonist ' + MC.version + ' MN_SHA256/8 ' + mnSha8 + ' ' + mnPath + '\n');
const cells = [];
for (const w of expectedCells()) {
    const control = ctlFor(CONTROL, w.mode, w.lib);
    const args = CHILD_FLAGS.concat([CHILD, '--mode', w.mode, '--lib', w.lib, '--n', String(w.n), '--rb', rbPath, '--rb-sha8', rbSha8,
        '--o1', o1Path, '--o1-sha8', o1Sha8, '--mn', mnPath, '--mn-sha8', mnSha8], control ? ['--control', control] : [], SMOKE ? ['--smoke'] : []);
    const r = await runChild(args);
    const tag = key(w.mode, w.lib, w.n);
    if (r.status === 2) die('child usage error (' + tag + '): ' + String(r.stderr).trim());
    let j = null;
    if (r.status === 0 && r.signal === null) {
        try { j = JSON.parse(r.stdout); } catch { j = null; }
    }
    if (accept(j, { mode: w.mode, lib: w.lib, n: w.n, control, rb: rbSha8, o1: o1Sha8, mn: mnSha8 })) {
        cells.push({ ...w, j, err: '' });
        process.stdout.write('ran ' + tag + '\n');
    } else {
        const err = 'status ' + r.status + ' signal ' + r.signal + (r.signal === 'SIGKILL' ? ' (timeout ' + CHILD_TIMEOUT_MS + ' ms?)' : '') +
            (j === null && r.status === 0 ? ' (stdout not one JSON object)' : j !== null ? ' (output rejected: mode / lib / n / control / sha8)' : '') +
            ' ' + String(r.stderr || r.error || '').trim().slice(0, 300);
        cells.push({ ...w, j: null, err });
        process.stderr.write('child failed: ' + tag + ' ' + err + '\n');
    }
}
const loadEnd = os.loadavg();
const busyEnd = busyNodes();
const T1 = new Date();

// ---- judge + write ----------------------------------------------------------------------------------------
const J = judge(cells, SMOKE);
const p0 = cells.find((x) => x.j)?.j || {};
const cpus = os.cpus();
const l3 = (l) => l.map((x) => f(x)).join(' / ');
const P = {
    smoke: SMOKE, host, hostWhy, t0: T0.toISOString(), t1: T1.toISOString(), wallS: (T1 - T0) / 1000,
    os: os.type() + ' ' + os.release() + ' ' + os.arch() + '; ' + (cpus[0] ? cpus[0].model : '?') + ' x ' + cpus.length + ' cores',
    loadStart: l3(loadStart), loadEnd: l3(loadEnd), busyStart: busyStart.length ? busyStart.join('; ') : 'none', busyEnd: busyEnd.length ? busyEnd.join('; ') : 'none',
    node: String(p0.node || process.version), v8: String(p0.v8 || process.versions.v8), control: CONTROL,
    rb: { sha8: rbSha8, path: rbPath }, o1: { sha8: o1Sha8, path: o1Path, version: String(o1Ver) },
    mn: { sha8: mnSha8, path: mnPath, version: String(MC.version) }, child: CHILD, out: OUT,
    argv: JSON.stringify(process.argv.slice(1)) + '; execArgv ' + JSON.stringify(process.execArgv), selfTest: ST.pass + '/' + ST.total,
};
const md = renderMd(J, P);
writeFileSync(OUT_JSON, JSON.stringify({ t0: T0, t1: T1, wallS: P.wallS, host, hostWhy, loadStart, loadEnd, busyStart, busyEnd,
    os: { type: os.type(), release: os.release(), arch: os.arch(), cpu: cpus[0] ? cpus[0].model : '', cores: cpus.length },
    node: P.node, v8: P.v8, smoke: SMOKE, control: CONTROL, schedule: SCHED(SMOKE), childFlags: CHILD_FLAGS,
    argv: process.argv.slice(1), execArgv: process.execArgv, selfTest: { pass: ST.pass, total: ST.total },
    rb: P.rb, o1: P.o1, mn: { ...P.mn, sha256: MC.sha256, obliterator: MC.obliterator },
    exit: J.exit, tier: tierOf(J.exit, SMOKE, host), why: J.why,
    cells: J.rows.map((r) => ({ mode: r.mode, lib: r.lib, n: r.n, verdict: r.verdict, why: r.why })), raw: cells }, null, 1));
writeFileSync(OUT_MD, md);
process.stdout.write(md);
process.stdout.write('compare-gc: exit ' + J.exit + '\n');
process.exit(J.exit);
