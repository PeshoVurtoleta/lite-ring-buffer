// InliningTool.test.js -- DETERMINISTIC gates for the repo-only inlining tooling (unit LU):
//   (A) the vendored test/tools/inlining-budget-diff.sh: sha256 pin + teeth, --self-test, script
//       mutants (temp copies, one exact edit each), fail-closed refusals, two real-V8 NO-VERDICT rows;
//   (B) test/tools/inline-diff.mjs: the B1 review MUST-COVER rows 1-13. Rows the real script cannot
//       produce run a STUB inlining-budget-diff.sh in a mkdtemp copy of the tree (inline-diff.mjs
//       finds the script, the driver and RingBuffer.js from its own directory, and git from
//       <tree>; the stub tree reads the real repo through GIT_DIR, read-only);
//   (C) the harness fails closed: a spawn that cannot start (status null / ENOENT) is RED, never a skip.
// No row here runs a real before/after VERDICT: that comparison follows tier-up timing, so it is
// REPORTED and run by hand (`npm run inline-diff`, ruling OQ-1), never inside npm test / verify.
// This file gates the inlining PRECONDITION tooling only; test/alloc.mjs stays the byte gate (LEDGER law 3).
// Every spawn is process-group SIGKILL-capped, every test has a timeout, every temp tree is removed
// in after(). No skip / todo: test/count.mjs fails the run on one (LEDGER law 11).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, chmodSync, existsSync,
    readdirSync, symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'test', 'tools');
const SCRIPT = join(TOOLS, 'inlining-budget-diff.sh');
const INLINE_DIFF = join(TOOLS, 'inline-diff.mjs');
const DRIVER = join(TOOLS, 'inl-driver.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const NODE = process.execPath;
const FNS = ['getOrDefault', 'peekNewest', 'peekOldest'];
const ANCHORS = {
    getOrDefault: '    getOrDefault(offset, defaultValue) {\n',
    peekNewest: '    peekNewest() {\n',
    peekOldest: '    peekOldest() {\n',
};
const T_FAST = 60000;    // per-test timeout, rows that spawn short runs
const T_SLOW = 300000;   // per-test timeout, rows that run --self-test or real V8

// The stub tree reads the real repo through GIT_DIR: resolved before any temp dir or spawn, so a
// tree without .git fails here, before anything is created or launched.
const GIT_DIR = realpathSync(join(ROOT, '.git'));

// ---- temp trees: every one is removed in after() --------------------------------------------------
// INL_TMP is the TMPDIR of every inline-diff spawned here (scoped, LEDGER law 12): the last row
// asserts it holds no lrb-inline-diff-* work dir, so another session's run can never read as a leak.
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'lrb-inltest-'));
const INL_TMP = mkdtempSync(join(tmpdir(), 'lrb-inltmp-'));
const SCRIPT_TMP = join(TEST_ROOT, 'tmp');   // TMPDIR for the vendored script's own temp files
mkdirSync(SCRIPT_TMP);
const PIDS = [];                                // grandchildren a row spawned (killed in after())
after(() => {
    for (const p of PIDS) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(TEST_ROOT, { recursive: true, force: true });
    rmSync(INL_TMP, { recursive: true, force: true });
    if (existsSync(TEST_ROOT) || existsSync(INL_TMP)) throw new Error('temp tree not removed: ' + TEST_ROOT + ' / ' + INL_TMP);
});
let seq = 0;
function scratch(name) { const d = join(TEST_ROOT, (seq++) + '-' + name); mkdirSync(d); return d; }
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }

// ---- spawning: detached, whole process group SIGKILLed past the cap ------------------------------
// Resolves { status, signal, error, out, ms }. A spawn that cannot start resolves status null with
// error set; expectExit() reads that as RED (fail closed), never as a pass or a skip.
function run(cmd, args, { cwd = ROOT, env = process.env, capMs = 240000 } = {}) {
    return new Promise((done) => {
        const t0 = Date.now();
        let settled = false;
        let child;
        const chunks = [];
        let timer = null;
        const fin = (status, signal, error) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            done({ status, signal, error, out: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 });
        };
        try {
            child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            fin(null, null, e);
            return;
        }
        child.stdout.on('data', (c) => chunks.push(c));
        child.stderr.on('data', (c) => chunks.push(c));
        timer = setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ }
            fin(null, 'SIGKILL', new Error('test cap ' + capMs + ' ms'));
        }, capMs);
        child.on('error', (e) => fin(null, null, e));
        child.on('close', (status, signal) => fin(status, signal, undefined));
    });
}
function gitSync(args) {
    const r = spawnSync('git', ['-C', ROOT, ...args], { timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 64 << 20 });
    assert.ok(r.error === undefined && r.status === 0 && r.signal === null, 'git ' + args.join(' ') + ' failed');
    return r.stdout;
}
function expectExit(r, code, what) {
    assert.ok(r.error === undefined && r.signal === null && r.status === code,
        what + ': want exit ' + code + ', got status ' + r.status + ' signal ' + r.signal +
        (r.error ? ' error ' + r.error.message : '') + '\n' + r.out.slice(-3000));
}
function okCount(out) { return (out.match(/^ok {3}/gm) || []).length; }
function lastLine(out) { const l = out.split('\n').filter((x) => x.trim() !== ''); return l[l.length - 1]; }
function cleanEnv(extra) {
    const e = { ...process.env, TMPDIR: INL_TMP, ...extra };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
        'GIT_CEILING_DIRECTORIES', 'NODE_OPTIONS']) if (!(extra && k in extra)) delete e[k];
    return e;
}
const SCRIPT_ENV = cleanEnv({ TMPDIR: SCRIPT_TMP });

// =================================================================================================
// (A) vendored inlining-budget-diff.sh
// =================================================================================================
// Provenance: LiteUtils commit 465881b, inlining-budget-diff.sh, 1530 lines, vendored byte-identical
// (unit LU TASK 0). Bump this pin on every re-vendor, never to make a local edit pass.
const SCRIPT_SHA256 = 'f13f33c2dfa8d5891313125d98d298260c019900989339bd751239c8eb9f19c1';   // prefix f13f33c2
function pinOk(buf) { return sha(buf) === SCRIPT_SHA256; }

// Script mutants (anchors at LiteUtils 465881b). Each must match exactly once in the pinned copy and
// turn --self-test red with the named FAIL line. Two PLAN mutants SURVIVE --self-test:
//   `die "driver exited non-zero:` -> `echo "driver exited non-zero:`  is caught by the real-V8
//     driver-exit row below (it matches die()'s "inlining-budget-diff: " line prefix);
//   `if [[ -z "$v" ]] && ! cmp -s` -> `if false && ! cmp -s`   (null-control compare) is caught by no
//     row: recorded as a LiteUtils FILLER in .handoff/LU/evidence/b2-mutants.log, never patched here.
const MUTANTS = [
    ['multiset-sort-u', 'multiset() { sort | uniq -c; }', 'multiset() { sort -u; }',
        'FAIL multiset keeps call-site multiplicity'],
    ['diff-never-wins', 'elif [[ $1 == DIFF || $2 == DIFF ]]', 'elif false',
        'FAIL driver mode (fake node): a real DIFF exits 1'],
    ['guard-off', 'if [[ $g == ok ]] && ! awk', 'if false && ! awk',
        'FAIL guard (fake node): only a Maglev compile of m0 is no turbo evidence: NO-VERDICT'],
    ['concurrent-blind', 'ConcurrencyMode::kConcurrent")) c = 1', 'ConcurrencyMode::kConcurrent")) c = 0',
        'FAIL driver mode: a kConcurrent compile line without --concurrent is NO-VERDICT'],
    ['always-same', 'if [[ -z "$shown" ]]; then v=SAME', 'if true; then v=SAME',
        'FAIL driver mode (fake node): a real DIFF exits 1'],
];
function variant(dir, name, from, to) {
    const src = readFileSync(SCRIPT, 'utf8');
    const n = src.split(from).length - 1;
    assert.ok(n === 1, 'mutant ' + name + ': anchor must match exactly once, matched ' + n);
    const p = join(dir, name + '.sh');
    writeFileSync(p, src.replace(from, () => to));
    chmodSync(p, 0o755);
    return p;
}

// Every --self-test starts now, in parallel (each one is ~9 s of bash); the rows await their own.
const SELF_DIR = scratch('selftest');
const COPY = join(SELF_DIR, 'copy.sh');
copyFileSync(SCRIPT, COPY);
const selfLive = run('bash', [SCRIPT, '--self-test'], { cwd: SELF_DIR, env: SCRIPT_ENV });
const selfCopy = run('bash', [COPY, '--self-test'], { cwd: SELF_DIR, env: SCRIPT_ENV });
const mutantRuns = MUTANTS.map(([name, from, to]) => {
    let p;
    try { p = variant(SELF_DIR, name, from, to); } catch (e) { return Promise.resolve({ anchorError: e }); }
    return run('bash', [p, '--self-test'], { cwd: SELF_DIR, env: SCRIPT_ENV });
});

test('inlining-budget-diff.sh sha256 pin (LiteUtils 465881b, 1530 lines; bump on every re-vendor)', { timeout: T_FAST }, () => {
    const buf = readFileSync(SCRIPT);
    assert.ok(pinOk(buf), 'test/tools/inlining-budget-diff.sh differs from the pinned LiteUtils 465881b copy');
    assert.equal(buf.toString('utf8').split('\n').length - 1, 1530);
});

test('sha256 pin has teeth: one flipped byte or an appended newline fails the compare', { timeout: T_FAST }, () => {
    const b = Buffer.from(readFileSync(SCRIPT));
    b[b.length >> 1] ^= 1;
    assert.equal(pinOk(b), false);
    assert.equal(pinOk(Buffer.concat([readFileSync(SCRIPT), Buffer.from('\n')])), false);
});

test('--self-test exits 0 with exactly 89 ok checks', { timeout: T_SLOW }, async () => {
    const r = await selfLive;
    expectExit(r, 0, '--self-test');
    assert.equal(lastLine(r.out), 'self-test: 89 check(s) ok');
    assert.equal(okCount(r.out), 89);
    assert.equal((r.out.match(/^FAIL/gm) || []).length, 0);
});

test('an unmodified temp copy passes --self-test (mutant baseline)', { timeout: T_SLOW }, async () => {
    const r = await selfCopy;
    expectExit(r, 0, 'copy --self-test');
    assert.equal(lastLine(r.out), 'self-test: 89 check(s) ok');
    assert.equal(okCount(r.out), 89);
});

MUTANTS.forEach(([name, from, to, failLine], i) => {
    test('script mutant ' + name + ' (' + JSON.stringify(from) + ' -> ' + JSON.stringify(to) + ') fails --self-test', { timeout: T_SLOW }, async () => {
        const r = await mutantRuns[i];
        if (r.anchorError) throw r.anchorError;
        expectExit(r, 1, 'mutant ' + name);
        assert.ok(r.out.split('\n').some((l) => l.startsWith(failLine)), 'mutant ' + name + ': no line starting ' + JSON.stringify(failLine) + '\n' + r.out.slice(-2000));
        assert.ok(!r.out.includes('self-test: 89 check(s) ok'));
        assert.ok(okCount(r.out) < 89);
    });
});

// Two sides of real staged drivers (copy of inl-driver.mjs beside a copy of the live RingBuffer.js).
function stageDrivers(name, mutateAfterDriver) {
    const d = scratch(name);
    for (const side of ['before', 'after']) {
        mkdirSync(join(d, side));
        copyFileSync(LIVE, join(d, side, 'RingBuffer.js'));
        const src = readFileSync(DRIVER, 'utf8');
        writeFileSync(join(d, side, 'driver.mjs'), side === 'after' && mutateAfterDriver ? mutateAfterDriver(src) : src);
    }
    return { dir: d, b: join(d, 'before', 'driver.mjs'), a: join(d, 'after', 'driver.mjs'), out: join(d, 'out') };
}

test('script fail-closed: --node /nonexistent and a missing DRIVER_AFTER exit 2', { timeout: T_FAST }, async () => {
    const s = stageDrivers('failclosed');
    const r1 = await run('bash', [SCRIPT, '--node', '/nonexistent/node', '--fn', 'peekNewest', '--tiers', 'turbo', '--out', s.out + '1', s.b, s.a], { cwd: s.dir, env: SCRIPT_ENV });
    expectExit(r1, 2, '--node /nonexistent');
    assert.match(r1.out, /node binary/);
    const r2 = await run('bash', [SCRIPT, '--node', NODE, '--fn', 'peekNewest', '--tiers', 'turbo', '--out', s.out + '2', s.b], { cwd: s.dir, env: SCRIPT_ENV });
    expectExit(r2, 2, 'DRIVER_AFTER omitted');
    assert.match(r2.out, /need DRIVER_BEFORE DRIVER_AFTER/);
    const r3 = await run('bash', [SCRIPT, '--node', NODE, '--fn', 'peekNewest', '--tiers', 'turbo', '--out', s.out + '3', s.b, join(s.dir, 'nope', 'driver.mjs')], { cwd: s.dir, env: SCRIPT_ENV });
    expectExit(r3, 2, 'DRIVER_AFTER not found');
    assert.match(r3.out, /driver not found/);
});

test('script real V8: a driver that exits 1 is NO-VERDICT, exit 2', { timeout: T_SLOW }, async () => {
    const s = stageDrivers('drvexit', (src) => 'process.exit(1);\n' + src);
    const r = await run('bash', [SCRIPT, '--node', NODE, '--fn', 'peekNewest', '--runs', '2', '--tiers', 'turbo', '--out', s.out, s.b, s.a], { cwd: s.dir, env: SCRIPT_ENV });
    expectExit(r, 2, 'driver exit 1');
    assert.match(r.out, /^inlining-budget-diff: driver exited non-zero/m);   // die()'s prefix: an echo of the text is not a die
});

test('script real V8: a never-called fn (reset) is NO-VERDICT -- no trace of, exit 2', { timeout: T_SLOW }, async () => {
    const s = stageDrivers('nevercalled');
    const r = await run('bash', [SCRIPT, '--node', NODE, '--fn', 'reset', '--runs', '2', '--tiers', 'turbo', '--out', s.out, s.b, s.a], { cwd: s.dir, env: SCRIPT_ENV });
    expectExit(r, 2, 'never-called fn');
    assert.match(r.out, /reset: NO-VERDICT -- no trace of reset/);
    assert.match(r.out, /^VERDICT NO-VERDICT$/m);
});

// =================================================================================================
// (B) inline-diff.mjs
// =================================================================================================
// Stub tree: <tree>/RingBuffer.js + <tree>/test/tools/{inline-diff.mjs, inl-driver.mjs} copies and a
// STUB inlining-budget-diff.sh that execs stub.mjs with the --node it was given. STUB_MODE picks the
// misbehaviour; the run is named by the after-side dir (after = the A/A run, ctl-<fn> = a control).
const STUB_SH = '#!/usr/bin/env bash\nn=""; p=""\nfor a in "$@"; do [[ $p == --node ]] && n=$a; p=$a; done\n' +
    'exec "$n" "${0%/*}/stub.mjs" "$@"\n';
const STUB_MJS = `import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const a = process.argv.slice(2);
const get = (k) => a[a.indexOf(k) + 1];
const out = get('--out');
const tiers = get('--tiers').split(',');
const label = path.basename(path.dirname(a[a.length - 1]));
const mode = process.env.STUB_MODE || 'ok';
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, label + ' --tiers ' + get('--tiers') + '\\n');
fs.mkdirSync(out, { recursive: true });
const say = (s) => fs.writeSync(1, s + '\\n');
const aa = label === 'after';
const fn = aa ? null : label.slice(4);
const victim = !aa && fn === 'getOrDefault';
if (mode === 'hang' && !fs.existsSync(process.env.STUB_PIDS + '.hung')) {
    // first invocation only (marker file): the pids are written before anything else
    const g = spawn('sleep', ['300'], { stdio: 'ignore' });
    fs.writeFileSync(process.env.STUB_PIDS, process.pid + ' ' + g.pid);
    fs.writeFileSync(process.env.STUB_PIDS + '.hung', label + '\\n');
    setInterval(() => {}, 100000);
} else {
    if (aa && mode === 'symlink') fs.symlinkSync(process.env.STUB_OUTSIDE, path.join(process.cwd(), 'escape'));
    if (!(victim && mode === 'no-report')) fs.writeFileSync(path.join(out, 'report.txt'), 'stub report\\n');
    for (const t of tiers) {
        if (victim && mode === 'missing-tier' && t === 'maglev') continue;
        let body = '';
        if (!aa) {
            if (!(victim && mode === 'one-tier' && t === 'maglev')) body += '< [x@TF] Inlining ' + fn + '\\n';
            if (victim && mode === 'other-fn') body += '> [x@TF] Inlining peekNewest\\n';
        } else if (mode === 'aa-diff') body = '< [x@TF] Inlining peekNewest\\n';
        fs.writeFileSync(path.join(out, 'all.' + t + '.diff.txt'), body);
    }
    if (aa && mode === 'mismatch') { say('VERDICT SAME'); process.exit(1); }
    if (aa && mode === 'sigkill') { say('VERDICT SAME'); process.kill(process.pid, 'SIGKILL'); }
    if (aa && mode !== 'aa-diff') { say('VERDICT SAME'); process.exit(0); }
    say('VERDICT DIFF');
    process.exit(1);
}
`;
function stubTree(name, { modify = false } = {}) {
    const t = scratch(name);
    mkdirSync(join(t, 'test', 'tools'), { recursive: true });
    copyFileSync(INLINE_DIFF, join(t, 'test', 'tools', 'inline-diff.mjs'));
    copyFileSync(DRIVER, join(t, 'test', 'tools', 'inl-driver.mjs'));
    writeFileSync(join(t, 'test', 'tools', 'inlining-budget-diff.sh'), STUB_SH);
    chmodSync(join(t, 'test', 'tools', 'inlining-budget-diff.sh'), 0o755);
    writeFileSync(join(t, 'test', 'tools', 'stub.mjs'), STUB_MJS);
    const live = readFileSync(LIVE);
    writeFileSync(join(t, 'RingBuffer.js'), modify ? Buffer.concat([live, Buffer.from('// modified by InliningTool.test.js\n')]) : live);
    return { tree: t, tool: join(t, 'test', 'tools', 'inline-diff.mjs') };
}
function stubRun(s, mode, args = [], extraEnv = {}, git = true) {
    const env = cleanEnv(git ? { GIT_DIR, STUB_MODE: mode, ...extraEnv }
        : { GIT_CEILING_DIRECTORIES: dirname(s.tree), STUB_MODE: mode, ...extraEnv });
    // inline-diff's own group kill (30 s) fires below the harness cap (120 s) for a stub that hangs
    const capArgs = args.includes('--cap-ms') ? args : [...args, '--cap-ms', '30000'];
    return run(NODE, [s.tool, ...capArgs], { cwd: s.tree, env, capMs: 120000 });
}
function workDirOf(out) { const m = out.match(/^work (\S+)/m); assert.ok(m !== null, 'no work line\n' + out); return m[1]; }

test('stub control: a well-behaved stub script reads as ok, exit 0 (the stub rows below are not blind)', { timeout: T_FAST }, async () => {
    const s = stubTree('stub-ok');
    const r = await stubRun(s, 'ok');
    expectExit(r, 0, 'stub ok');
    assert.match(r.out, /inline-diff: VERDICT ok/);
    assert.equal((r.out.match(/-> ok, diff names/g) || []).length, 3);
});

test('MUST-COVER 1: a VERDICT line that disagrees with the exit status is NO-VERDICT, exit 2', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc1'), 'mismatch');
    expectExit(r, 2, 'verdict/exit mismatch');
    assert.match(r.out, /run aa +exit 1 VERDICT SAME .*-> NO-VERDICT/);
});

test('MUST-COVER 2: a run SIGKILLed after printing VERDICT SAME is NO-VERDICT, exit 2', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc2'), 'sigkill');
    expectExit(r, 2, 'SIGKILL after SAME');
    assert.match(r.out, /run aa +exit null signal SIGKILL VERDICT SAME .*-> NO-VERDICT/);
});

test('MUST-COVER 3: a control DIFF that also names another fn is gate blind, exit 1', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc3'), 'other-fn');
    expectExit(r, 1, 'control names another fn');
    assert.match(r.out, /run ctl-getOrDefault .*-> gate blind: diff names \[.*peekNewest/);
});

test('MUST-COVER 4: a control DIFF with no report.txt is NO-VERDICT, exit 2', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc4'), 'no-report');
    expectExit(r, 2, 'no report.txt');
    assert.match(r.out, /run ctl-getOrDefault .*-> NO-VERDICT \(no report\.txt\)/);
});

test('MUST-COVER 5: A/A DIFF with clean controls is FAIL, exit 1', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc5'), 'aa-diff');
    expectExit(r, 1, 'A/A DIFF');
    assert.match(r.out, /run aa .*-> before vs after inline DIFFERENTLY/);
    assert.equal((r.out.match(/-> ok, diff names/g) || []).length, 3);
});

test('MUST-COVER 6: a control anchor matching 0x or 2x, or a missing --before, is exit 2', { timeout: T_FAST }, async () => {
    const d = scratch('mc6');
    const live = readFileSync(LIVE, 'utf8');
    const anc = ANCHORS.getOrDefault;
    assert.ok(live.split(anc).length === 2, 'live anchor must match once');
    writeFileSync(join(d, 'zero.js'), live.replace(anc, () => '    getOrDefault(offset, dflt) {\n'));
    writeFileSync(join(d, 'two.js'), live + '\nclass X {\n' + anc + '        return 0;\n    }\n}\n');
    const r0 = await run(NODE, [INLINE_DIFF, '--after', join(d, 'zero.js'), '--stage-only', join(d, 's0')], { env: cleanEnv() });
    expectExit(r0, 2, 'anchor 0x');
    assert.match(r0.out, /control getOrDefault: anchor .* matches 0 times/);
    const r2 = await run(NODE, [INLINE_DIFF, '--after', join(d, 'two.js'), '--stage-only', join(d, 's2')], { env: cleanEnv() });
    expectExit(r2, 2, 'anchor 2x');
    assert.match(r2.out, /control getOrDefault: anchor .* matches 2 times/);
    const rb = await run(NODE, [INLINE_DIFF, '--before', join(d, 'nope.js'), '--stage-only', join(d, 'sb')], { env: cleanEnv() });
    expectExit(rb, 2, 'missing --before');
    assert.match(rb.out, /--before not found/);
});

test('MUST-COVER 7: --stage-only on a MODIFIED live file stages before from git HEAD, not from the live file', { timeout: T_FAST }, async () => {
    const s = stubTree('mc7', { modify: true });
    const headBuf = gitSync(['show', 'HEAD:RingBuffer.js']);
    const modBuf = readFileSync(join(s.tree, 'RingBuffer.js'));
    assert.ok(sha(headBuf) !== sha(modBuf));
    const st = join(s.tree, 'stage');
    const r = await stubRun(s, 'ok', ['--stage-only', st]);
    expectExit(r, 0, 'stage-only modified');
    assert.ok(Buffer.compare(readFileSync(join(st, 'before', 'RingBuffer.js')), headBuf) === 0, 'before is not git show HEAD');
    assert.ok(Buffer.compare(readFileSync(join(st, 'after', 'RingBuffer.js')), modBuf) === 0, 'after is not the live file');
    assert.match(r.out, new RegExp('^side before +sha256/8 ' + sha(headBuf).slice(0, 8) + ' +git HEAD = commit ', 'm'));
    assert.match(r.out, new RegExp('^side after +sha256/8 ' + sha(modBuf).slice(0, 8) + ' +worktree RingBuffer\\.js \\(HEAD [0-9a-f]{7}, MODIFIED\\)', 'm'));
});

test('--stage-only (real tree): five sides; each control differs from after only by the pad at its anchor', { timeout: T_FAST }, async () => {
    const st = join(scratch('stage-real'), 'st');
    const r = await run(NODE, [INLINE_DIFF, '--stage-only', st], { env: cleanEnv() });
    expectExit(r, 0, 'stage-only');
    assert.deepEqual(readdirSync(st).sort(), ['after', 'before', 'ctl-getOrDefault', 'ctl-peekNewest', 'ctl-peekOldest']);
    const after = readFileSync(join(st, 'after', 'RingBuffer.js'), 'utf8');
    assert.ok(after === readFileSync(LIVE, 'utf8'));
    for (const fn of FNS) {
        const ctl = readFileSync(join(st, 'ctl-' + fn, 'RingBuffer.js'), 'utf8');
        const anc = ANCHORS[fn];
        assert.ok(after.split(anc).length === 2, fn + ' anchor must match once');
        const cut = after.indexOf(anc) + anc.length;
        const pad = ctl.slice(cut, ctl.length - (after.length - cut));
        assert.ok(ctl.startsWith(after.slice(0, cut)) && ctl.endsWith(after.slice(cut)), fn + ': control differs outside its anchor');
        assert.ok(pad.startsWith('        if (this.count < 0) { // inline-diff control: never taken, pads ' + fn + ' past 460 B\n'), fn + ': pad head');
        assert.ok(pad.endsWith('            return p;\n        }\n'), fn + ': pad tail');
        assert.ok(ctl.length - after.length === pad.length && pad.length > 1000);
        assert.ok(Buffer.compare(readFileSync(join(st, 'ctl-' + fn, 'driver.mjs')), readFileSync(DRIVER)) === 0);
    }
});

test('MUST-COVER 8: a control DIFF on only one tier is gate blind, exit 1', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc8'), 'one-tier');
    expectExit(r, 1, 'one-tier control');
    assert.match(r.out, /run ctl-getOrDefault .*-> gate blind: diff names \[turbo:getOrDefault\] \(want getOrDefault in every tier/);
});

test('MUST-COVER 8b: --tiers maglev scopes every run and the check to maglev, exit 0', { timeout: T_FAST }, async () => {
    const s = stubTree('mc8b');
    const log = join(s.tree, 'stub.log');
    const r = await stubRun(s, 'ok', ['--tiers', 'maglev'], { STUB_LOG: log });
    expectExit(r, 0, '--tiers maglev');
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 4);
    for (const l of lines) assert.match(l, / --tiers maglev$/);
    assert.equal((r.out.match(/-> ok, diff names \[maglev:\w+\]/g) || []).length, 3);
});

test('MUST-COVER 9: a missing tier diff file is NO-VERDICT, exit 2', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc9'), 'missing-tier');
    expectExit(r, 2, 'missing tier diff');
    assert.match(r.out, /run ctl-getOrDefault .*-> NO-VERDICT \(missing .*all\.maglev\.diff\.txt\)/);
});

// The stub hangs on its FIRST invocation only (the A/A run); the other runs are well-behaved. With a
// 3 s cap a missing pid file is a real fault ("stub did not start"), not host load. No lower time bound.
test('MUST-COVER 10: a hung run is killed with its whole process group within --cap-ms 3000, exit 2', { timeout: T_FAST }, async () => {
    const s = stubTree('mc10');
    const pidsFile = join(s.tree, 'pids');
    const r = await stubRun(s, 'hang', ['--cap-ms', '3000'], { STUB_PIDS: pidsFile });
    if (!existsSync(pidsFile)) assert.fail('stub did not start (no pid file)\n' + r.out.slice(-2000));
    const pids = readFileSync(pidsFile, 'utf8').trim().split(' ').map(Number);
    for (const p of pids) PIDS.push(p);
    expectExit(r, 2, 'hung run');
    assert.match(r.out, /^run aa +exit null signal SIGKILL VERDICT none \d+ ms \(killed after 3000 ms\) -> NO-VERDICT$/m);
    assert.ok(readFileSync(pidsFile + '.hung', 'utf8') === 'after\n', 'the hung run is not the A/A run');
    assert.ok(r.ms < 3000 + 20000, 'took ' + r.ms + ' ms');
    assert.ok(pids.length === 2 && pids.every((p) => Number.isInteger(p) && p > 1));
    let alive = pids.slice();
    for (let k = 0; k < 200 && alive.length > 0; k++) {
        alive = alive.filter((p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } });
        if (alive.length > 0) await new Promise((res) => setTimeout(res, 50));
    }
    assert.deepEqual(alive, [], 'process(es) of the killed group still alive: ' + alive.join(' '));
    PIDS.length = 0;   // all dead: after() must never SIGKILL a pid the OS has since reused
});

test('MUST-COVER 11: a tree with no git is NO-VERDICT, exit 2', { timeout: T_FAST }, async () => {
    const r = await stubRun(stubTree('mc11'), 'ok', [], {}, false);
    expectExit(r, 2, 'no git');
    assert.match(r.out, /inline-diff: git rev-parse .*HEAD/);
});

test('MUST-COVER 12: bad --cap-ms / --tiers values exit 2; valid edge values stage, exit 0', { timeout: T_FAST }, async () => {
    const d = scratch('mc12');
    const bad = [['--cap-ms', '999'], ['--cap-ms', '3600001'], ['--cap-ms', '1e4'], ['--cap-ms', '-1000'], ['--cap-ms', '10000000'],
        ['--tiers', 'turbo,turbo'], ['--tiers', 'turbo,'], ['--tiers', 'foo'], ['--tiers', 'TURBO'], ['--tiers', ',maglev']];
    let k = 0;
    for (const [o, v] of bad) {
        const r = await run(NODE, [INLINE_DIFF, o, v, '--stage-only', join(d, 'b' + (k++))], { env: cleanEnv() });
        expectExit(r, 2, o + ' ' + v);
        assert.ok(r.out.includes('inline-diff: ' + o + ':'), o + ' ' + v + ': no named refusal\n' + r.out);
    }
    for (const [cap, tiers] of [['1000', 'maglev'], ['3600000', 'maglev,turbo']]) {
        const r = await run(NODE, [INLINE_DIFF, '--cap-ms', cap, '--tiers', tiers, '--stage-only', join(d, 'g' + (k++))], { env: cleanEnv() });
        expectExit(r, 0, '--cap-ms ' + cap + ' --tiers ' + tiers);
        assert.match(r.out, new RegExp('\\| tiers ' + tiers + '$', 'm'));
    }
});

test('MUST-COVER 13: work dir removed by default, kept with --keep, --stage-only DIR kept, a symlink in it not followed', { timeout: T_FAST }, async () => {
    const outside = scratch('mc13-outside');
    writeFileSync(join(outside, 'sentinel'), 'keep me\n');
    const r1 = await stubRun(stubTree('mc13a'), 'symlink', [], { STUB_OUTSIDE: outside });
    expectExit(r1, 0, 'default run');
    const w1 = workDirOf(r1.out);
    assert.match(r1.out, /work dir removed \(--keep keeps it\)/);
    assert.ok(!existsSync(w1), 'work dir left behind: ' + w1);
    assert.ok(readFileSync(join(outside, 'sentinel'), 'utf8') === 'keep me\n', 'rm followed the symlink');
    const r2 = await stubRun(stubTree('mc13b'), 'ok', ['--keep']);
    const w2 = workDirOf(r2.out);
    try {
        expectExit(r2, 0, '--keep run');
        assert.ok(existsSync(join(w2, 'out-aa', 'report.txt')), '--keep did not keep ' + w2);
        assert.match(r2.out, /artifacts kept in /);
    } finally {
        if (/lrb-inline-diff-/.test(w2)) rmSync(w2, { recursive: true, force: true });
    }
    const st = join(scratch('mc13c'), 'st');
    const r3 = await run(NODE, [INLINE_DIFF, '--stage-only', st], { env: cleanEnv() });
    expectExit(r3, 0, '--stage-only');
    assert.match(r3.out, new RegExp('^work ' + st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
    assert.deepEqual(readdirSync(st).sort(), ['after', 'before', 'ctl-getOrDefault', 'ctl-peekNewest', 'ctl-peekOldest']);
});

// =================================================================================================
// (C) the harness fails closed
// =================================================================================================
test('fail closed: a bogus interpreter (spawn ENOENT, status null) is RED, never a pass', { timeout: T_FAST }, async () => {
    const r = await run(join(TEST_ROOT, 'no-such-bash'), [SCRIPT, '--self-test']);
    assert.ok(r.status === null, 'status ' + r.status);
    assert.ok(r.error !== undefined && r.error.code === 'ENOENT');
    assert.throws(() => expectExit(r, 0, 'bogus'), assert.AssertionError);
    assert.throws(() => expectExit(r, 2, 'bogus'), assert.AssertionError);
    assert.throws(() => expectExit({ status: null, signal: null, error: undefined, out: '' }, 0, 'null'), assert.AssertionError);
});

test('fail closed: inline-diff with no bash on PATH is NO-VERDICT, exit 2', { timeout: T_FAST }, async () => {
    const bin = scratch('nobash-bin');
    let git = null;
    for (const p of (process.env.PATH || '').split(delimiter)) {
        if (p !== '' && existsSync(join(p, 'git'))) { git = join(p, 'git'); break; }
    }
    assert.ok(git !== null, 'git not on PATH');
    symlinkSync(git, join(bin, 'git'));
    const r = await run(NODE, [INLINE_DIFF, '--tiers', 'turbo'], { env: cleanEnv({ PATH: bin }) });
    expectExit(r, 2, 'no bash');
    assert.match(r.out, /\(spawn bash ENOENT\) -> NO-VERDICT/);
    assert.ok(!existsSync(workDirOf(r.out)));
});

test('no lrb-inline-diff-* work dir leaked into this file\'s TMPDIR root', { timeout: T_FAST }, () => {
    assert.ok(existsSync(INL_TMP), 'TMPDIR root missing: ' + INL_TMP);
    const leaked = readdirSync(INL_TMP).filter((n) => n.startsWith('lrb-inline-diff-'));
    assert.deepEqual(leaked, []);
});
