// DeoptTool.test.js -- DETERMINISTIC gates for the repo-only deopt tooling (unit LU2):
//   T1  deopt-diff.sh of the exact-pinned devDependency @zakkster/lite-utils 1.0.0, read at
//       node_modules/@zakkster/lite-utils/: sha256 pin + line count + teeth;
//   T2  test/tools/deopt-diff.mjs --stage-only on the real tree (layout, sides, driver variants);
//   T3-T6  deopt-diff.mjs preflight, arguments, anchors and its exit contract (PLAN LU2 (d)), against a
//       STUB deopt-diff.sh in a mkdtemp copy of the tree (deopt-diff.mjs finds deopt-driver.mjs,
//       lite-utils.mjs and RingBuffer.js from its own directory, the script at
//       <tree>/node_modules/@zakkster/lite-utils/, and git through GIT_DIR = the real repo, read-only);
//   T7  no lrb-deopt-diff-* work dir left in this file's scoped TMPDIR.
// No row here runs a real deopt-diff.sh VERDICT: deopts follow tier-up timing, so that comparison is REPORTED
// and run by hand (`npm run deopt-diff`, under the quiet lock), never inside npm test / verify. T2 is
// --stage-only, which spawns no deopt-diff.sh run. Every failing-path row carries its passing control.
// Every spawn is process-group SIGKILL-capped, every test has a timeout, every temp tree is removed in
// after(). No skip / todo: test/count.mjs fails the run on one (LEDGER law 11).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, chmodSync, existsSync,
    readdirSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'test', 'tools');
const LU_DIR = join(ROOT, 'node_modules', '@zakkster', 'lite-utils');
const SCRIPT = join(LU_DIR, 'deopt-diff.sh');
const LITE_UTILS = join(TOOLS, 'lite-utils.mjs');
const DEOPT_DIFF = join(TOOLS, 'deopt-diff.mjs');
const DRIVER = join(TOOLS, 'deopt-driver.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const NODE = process.execPath;
const ANCHOR_DST = 'const DST = Float32Array;\n';
const ANCHOR_SWITCH = 'const SWITCH = false;\n';
const T_FAST = 60000;    // per-test timeout, rows that spawn short runs
const T_STUB = 180000;   // per-test timeout, rows that spawn several stub runs

// The stub tree reads the real repo through GIT_DIR: resolved before any temp dir or spawn.
const GIT_DIR = realpathSync(join(ROOT, '.git'));

// ---- temp trees: every one is removed in after() --------------------------------------------------
// DEO_TMP is the TMPDIR of every deopt-diff.mjs spawned here (scoped, LEDGER law 12): T7 asserts it holds
// no lrb-deopt-diff-* work dir, so another session's run can never read as a leak.
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'lrb-deotest-'));
const DEO_TMP = realpathSync(mkdtempSync(join(tmpdir(), 'lrb-deotmp-')));
after(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    rmSync(DEO_TMP, { recursive: true, force: true });
    if (existsSync(TEST_ROOT) || existsSync(DEO_TMP)) throw new Error('temp tree not removed: ' + TEST_ROOT + ' / ' + DEO_TMP);
});
let seq = 0;
function scratch(name) { const d = join(TEST_ROOT, (seq++) + '-' + name); mkdirSync(d); return d; }
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }
let fullRuns = 0;   // deopt-diff.mjs runs that got past staging without --stage-only / --keep (T7 is not vacuous)

// ---- spawning: detached, whole process group SIGKILLed past the cap ------------------------------
// Resolves { status, signal, error, out, ms }. A spawn that cannot start resolves status null with
// error set; expectExit() reads that as RED (fail closed), never as a pass or a skip.
function run(cmd, args, { cwd = ROOT, env = process.env, capMs = 120000 } = {}) {
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
    const r = spawnSync('git', ['-C', ROOT, ...args], { timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 64 << 20, env: cleanEnv() });
    assert.ok(r.error === undefined && r.status === 0 && r.signal === null, 'git ' + args.join(' ') + ' failed');
    return r.stdout;
}
function expectExit(r, code, what) {
    assert.ok(r.error === undefined && r.signal === null && r.status === code,
        what + ': want exit ' + code + ', got status ' + r.status + ' signal ' + r.signal +
        (r.error ? ' error ' + r.error.message : '') + '\n' + r.out.slice(-3000));
}
function cleanEnv(extra) {
    const e = { ...process.env, TMPDIR: DEO_TMP, ...extra };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
        'GIT_CEILING_DIRECTORIES', 'NODE_OPTIONS']) if (!(extra && k in extra)) delete e[k];
    return e;
}
function reEsc(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
// The hung stub writes STUB_PID.stub (its own pid) and then STUB_PID (its grandchild's pid). Polls both up to
// 2 s, then SIGKILLs whatever is left, so no row (and no mutant run) ever leaks a process. Returns which of
// the two were still alive when the poll ended.
async function reapStub(pidf) {
    if (!existsSync(pidf)) return { started: false, g: false, s: false };
    const gpid = Number(readFileSync(pidf, 'utf8'));
    const spid = existsSync(pidf + '.stub') ? Number(readFileSync(pidf + '.stub', 'utf8')) : NaN;
    const pids = [gpid, spid].filter((x) => Number.isInteger(x) && x > 1);
    for (let k = 0; k < 40 && pids.some(isAlive); k++) await sleep(50);
    const g = pids.includes(gpid) && isAlive(gpid);
    const st = pids.includes(spid) && isAlive(spid);
    for (const x of pids) if (isAlive(x)) { try { process.kill(x, 'SIGKILL'); } catch { /* gone */ } }
    assert.ok(pids.length === 2, 'bad pid files: ' + gpid + ' / ' + spid);
    return { started: true, g, s: st };
}
function workDirOf(out) { const m = out.match(/^work (\S+)/m); assert.ok(m !== null, 'no work line\n' + out); return m[1]; }
// a refusal names its reason on the die() line and stages nothing
function refused(r, why, what) {
    expectExit(r, 2, what);
    assert.ok(r.out.includes('deopt-diff: ' + why), what + ': want refusal ' + JSON.stringify(why) + '\n' + r.out);
    assert.match(r.out, /^deopt-diff: VERDICT NO-VERDICT$/m, what);
    assert.ok(!/^(side|driver|work|run) /m.test(r.out), what + ': staged or ran before the refusal\n' + r.out);
}

// =================================================================================================
// T1 deopt-diff.sh from @zakkster/lite-utils 1.0.0 (node_modules, exact devDependency)
// =================================================================================================
// Provenance: @zakkster/lite-utils 1.0.0, deopt-diff.sh, 1857 lines, as installed by
// `npm install --save-dev --save-exact @zakkster/lite-utils@1.0.0` (unit LU2; its --self-test reads
// 107 ok on node v26.8.2). Bump this pin together with the exact devDependency, never to make a local
// edit pass.
const SCRIPT_SHA256 = '95e12a28e55c3c353a3d8f9be5bb07c89a2ac4260e6e97311de7a2f39155400f';   // prefix 95e12a28
function pinOk(buf) { return sha(buf) === SCRIPT_SHA256; }

test('T1 deopt-diff.sh sha256 pin (lite-utils 1.0.0, 1857 lines) has teeth: a flipped byte or an appended newline fails', { timeout: T_FAST }, async () => {
    const buf = readFileSync(SCRIPT);
    assert.ok(pinOk(buf), SCRIPT + ' differs from the pinned @zakkster/lite-utils 1.0.0 deopt-diff.sh');
    assert.equal(buf.toString('utf8').split('\n').length - 1, 1857);
    const lu = await import(pathToFileURL(LITE_UTILS).href);
    assert.deepEqual(lu.liteUtilsScript(ROOT, 'deopt-diff.sh'), { ok: true, path: SCRIPT });
    const b = Buffer.from(buf);
    b[b.length >> 1] ^= 1;
    assert.equal(pinOk(b), false, 'a flipped byte still matches the pin');
    assert.equal(pinOk(Buffer.concat([buf, Buffer.from('\n')])), false, 'an appended newline still matches the pin');
});

// =================================================================================================
// T2 --stage-only on the real tree
// =================================================================================================
// `variant` = the driver with its one anchor replaced; the staged copy must be exactly that, so it
// differs from deopt-driver.mjs only at the anchor.
function onlyAt(staged, drv, anchor, to, what) {
    assert.equal(drv.split(anchor).length, 2, what + ': anchor must match exactly once in deopt-driver.mjs');
    const i = drv.indexOf(anchor);
    assert.ok(staged.slice(0, i) === drv.slice(0, i), what + ': differs before the anchor');
    assert.ok(staged.slice(i) === to + drv.slice(i + anchor.length), what + ': differs at / after the anchor');
    assert.ok(staged !== drv, what + ': not edited');
}

test('T2 --stage-only (real tree): layout, before = git show HEAD, after = live, drivers differ only at their anchor', { timeout: T_FAST }, async () => {
    const st = join(scratch('stage-real'), 'st');
    const r = await run(NODE, [DEOPT_DIFF, '--stage-only', st], { env: cleanEnv() });
    expectExit(r, 0, 'stage-only');
    assert.deepEqual(readdirSync(st).sort(), ['after', 'before', 'ctl-after', 'ctl-before', 'f32', 'f64', 'package.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(st, 'package.json'), 'utf8')), { type: 'module' });
    const headBuf = gitSync(['show', 'HEAD:RingBuffer.js']);
    const live = readFileSync(LIVE);
    assert.deepEqual(readdirSync(join(st, 'before')), ['RingBuffer.js']);
    assert.deepEqual(readdirSync(join(st, 'after')), ['RingBuffer.js']);
    assert.ok(Buffer.compare(readFileSync(join(st, 'before', 'RingBuffer.js')), headBuf) === 0, 'before is not git show HEAD:RingBuffer.js');
    assert.ok(Buffer.compare(readFileSync(join(st, 'after', 'RingBuffer.js')), live) === 0, 'after is not the live file');
    for (const k of ['ctl-before', 'ctl-after']) {
        assert.deepEqual(readdirSync(join(st, k)).sort(), ['RingBuffer.js', 'driver.mjs']);
        assert.ok(Buffer.compare(readFileSync(join(st, k, 'RingBuffer.js')), live) === 0, k + ' does not hold the after module');
    }
    for (const k of ['f32', 'f64']) assert.deepEqual(readdirSync(join(st, k)), ['driver.mjs']);
    const drv = readFileSync(DRIVER, 'utf8');
    assert.ok(readFileSync(join(st, 'f32', 'driver.mjs'), 'utf8') === drv, 'f32 driver is not deopt-driver.mjs');
    assert.ok(readFileSync(join(st, 'ctl-before', 'driver.mjs'), 'utf8') === drv, 'ctl-before driver is not deopt-driver.mjs');
    onlyAt(readFileSync(join(st, 'f64', 'driver.mjs'), 'utf8'), drv, ANCHOR_DST, 'const DST = Float64Array;\n', 'f64');
    onlyAt(readFileSync(join(st, 'ctl-after', 'driver.mjs'), 'utf8'), drv, ANCHOR_SWITCH, 'const SWITCH = true;\n', 'ctl-after');
    assert.match(r.out, new RegExp('^side before +sha256/8 ' + sha(headBuf).slice(0, 8) + ' +git HEAD = commit [0-9a-f]{7}:RingBuffer\\.js \\(git dir ' + reEsc(gitSync(['rev-parse', '--absolute-git-dir']).toString().trim()) + '\\)$', 'm'));
    assert.match(r.out, new RegExp('^side after +sha256/8 ' + sha(live).slice(0, 8) + ' +worktree RingBuffer\\.js \\(HEAD [0-9a-f]{7}, (clean|MODIFIED)\\)$', 'm'));
    assert.match(r.out, new RegExp('\\| lite-utils 1\\.0\\.0 deopt-diff\\.sh sha256/8 ' + SCRIPT_SHA256.slice(0, 8) + ' \\| node ' + process.version.replace(/\./g, '\\.') + ' \\| fn copyTo \\| control copyTo \\| runs 3$', 'm'));
    assert.ok(r.out.split('\n').includes('work ' + st), 'work line is not the --stage-only DIR\n' + r.out);
    assert.doesNotMatch(r.out, /^run /m);
});

// =================================================================================================
// T3-T6 stub tree
// =================================================================================================
// <tree>/RingBuffer.js + <tree>/test/tools/{deopt-diff.mjs, deopt-driver.mjs, lite-utils.mjs} copies and,
// in <tree>/node_modules/@zakkster/lite-utils/, a package.json + a STUB deopt-diff.sh that execs stub.mjs
// (beside it) with the --node it was given. The run is named by its --out dir (out-f32, out-f64, out-ctl);
// STUB_MODE picks the misbehaviour (hang: the control run never ends and spawns a grandchild that
// holds its stdout, pids in STUB_PID / STUB_PID.stub), STUB_LOG records each run's argv, cwd and which of the six GIT_* variables deopt-diff.sh refuses are set.
const STUB_SH = '#!/usr/bin/env bash\nn=""; p=""\nfor a in "$@"; do [[ $p == --node ]] && n=$a; p=$a; done\n' +
    'exec "$n" "${0%/*}/stub.mjs" "$@"\n';
const STUB_MJS = `import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const out = a[a.indexOf('--out') + 1];
const label = path.basename(out).slice(4);
const mode = process.env.STUB_MODE || 'ok';
const git = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']
    .filter((k) => k in process.env);
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ label, argv: a, cwd: process.cwd(), git }) + '\\n');
const say = (s) => fs.writeSync(1, s + '\\n');
if (mode === 'hang' && label === 'ctl') {
    const g = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { stdio: 'inherit' });
    if (process.env.STUB_PID) { fs.writeFileSync(process.env.STUB_PID + '.stub', String(process.pid)); fs.writeFileSync(process.env.STUB_PID, String(g.pid)); }
    setInterval(() => {}, 100000);
} else {
    fs.mkdirSync(out, { recursive: true });
    let v = label === 'ctl' ? 'DIFF' : 'SAME';
    if (mode === 'real-diff' && label === 'f64') v = 'DIFF';
    if (mode === 'ctl-same' && label === 'ctl') v = 'SAME';
    if (mode === 'nv' && label === 'f32') v = 'NO-VERDICT';
    if (mode === 'ctl-nv' && label === 'ctl') v = 'NO-VERDICT';
    if (mode === 'nv-blind') v = label === 'f32' ? 'NO-VERDICT' : label === 'ctl' ? 'SAME' : v;
    if (!(mode === 'no-report' && label === 'f64')) {
        fs.writeFileSync(path.join(out, 'report.txt'), 'stub report ' + label + '\\n  copyTo: ' + v + ' -- stub\\n\\nVERDICT ' + v + '\\n');
    }
    let code = v === 'SAME' ? 0 : v === 'DIFF' ? 1 : 2;
    if (mode === 'mismatch' && label === 'f32') code = 1;
    if (v === 'NO-VERDICT') say('deopt-diff: stub reason');
    if (!(mode === 'no-verdict-line' && label === 'f64')) say('VERDICT ' + v);
    if (mode === 'two-verdicts' && label === 'ctl') say('VERDICT DIFF');
    process.exit(code);
}
`;
const STUB_PKGS = {
    ok: { name: '@zakkster/lite-utils', version: '1.0.0' },
    'no-script': { name: '@zakkster/lite-utils', version: '1.0.0' },
    '1.0.1': { name: '@zakkster/lite-utils', version: '1.0.1' },
    badname: { name: '@zakkster/lite-utilz', version: '1.0.0' },
};
function stubTree(name, { pkg = 'ok', driver = null } = {}) {
    assert.ok(pkg === 'none' || pkg in STUB_PKGS, 'stubTree: unknown pkg ' + pkg);
    const t = scratch(name);
    mkdirSync(join(t, 'test', 'tools'), { recursive: true });
    copyFileSync(DEOPT_DIFF, join(t, 'test', 'tools', 'deopt-diff.mjs'));
    copyFileSync(LITE_UTILS, join(t, 'test', 'tools', 'lite-utils.mjs'));
    const drv = readFileSync(DRIVER, 'utf8');
    writeFileSync(join(t, 'test', 'tools', 'deopt-driver.mjs'), driver ? driver(drv) : drv);
    const lu = join(t, 'node_modules', '@zakkster', 'lite-utils');
    if (pkg !== 'none') {
        mkdirSync(lu, { recursive: true });
        writeFileSync(join(lu, 'package.json'), JSON.stringify(STUB_PKGS[pkg]) + '\n');
        writeFileSync(join(lu, 'stub.mjs'), STUB_MJS);
        if (pkg !== 'no-script') {
            writeFileSync(join(lu, 'deopt-diff.sh'), STUB_SH);
            chmodSync(join(lu, 'deopt-diff.sh'), 0o755);
        }
    }
    copyFileSync(LIVE, join(t, 'RingBuffer.js'));
    return { tree: t, tool: join(t, 'test', 'tools', 'deopt-diff.mjs'), lu: join(realpathSync(t), 'node_modules', '@zakkster', 'lite-utils') };
}
function stubRun(s, mode, args = [], extraEnv = {}) {
    const env = cleanEnv({ GIT_DIR, STUB_MODE: mode, ...extraEnv });
    // deopt-diff's own group kill (30 s) fires below the harness cap (120 s) for a stub that hangs
    const capArgs = args.includes('--cap-ms') ? args : [...args, '--cap-ms', '30000'];
    const full = !args.includes('--stage-only') && !args.includes('--keep');
    return run(NODE, [s.tool, ...capArgs], { cwd: s.tree, env, capMs: 120000 }).then((r) => {
        if (full && /^work /m.test(r.out)) fullRuns++;
        return r;
    });
}

test('T3 lite-utils missing / no deopt-diff.sh / misnamed / 1.0.1 exits 2 named; the same tree at 1.0.0 exits 0 (control)', { timeout: T_STUB }, async () => {
    const n = stubTree('lu-none', { pkg: 'none' });
    refused(await stubRun(n, 'ok'), 'lite-utils missing: ' + n.lu + '\n', 'pkg none');
    const s = stubTree('lu-noscript', { pkg: 'no-script' });
    refused(await stubRun(s, 'ok'), 'lite-utils script missing: ' + join(s.lu, 'deopt-diff.sh') + '\n', 'pkg no-script');
    const b = stubTree('lu-badname', { pkg: 'badname' });
    refused(await stubRun(b, 'ok'), 'lite-utils package.json names @zakkster/lite-utilz, want @zakkster/lite-utils\n', 'pkg badname');
    const v = stubTree('lu-101', { pkg: '1.0.1' });
    refused(await stubRun(v, 'ok'), 'lite-utils version 1.0.1 at ' + v.lu + ', want exactly 1.0.0\n', 'pkg 1.0.1');
    // control: the SAME tree, its package.json set to 1.0.0, runs to ok
    writeFileSync(join(v.lu, 'package.json'), JSON.stringify(STUB_PKGS.ok) + '\n');
    const r = await stubRun(v, 'ok');
    expectExit(r, 0, 'same tree at 1.0.0');
    assert.match(r.out, /^deopt-diff: VERDICT ok \(control DIFF; REPORTED f32 SAME, f64 SAME\); work dir removed/m);
});

test('T4 bad arguments and a driver anchor matching 0x / 2x exit 2 named; valid edge values and the unmodified driver stage, exit 0', { timeout: T_STUB }, async () => {
    const d = scratch('args');
    mkdirSync(join(d, 'full'));
    writeFileSync(join(d, 'full', 'x'), 'x\n');
    const bad = [
        [['--fn', 'copyTo,copyTo'], '--fn: copyTo given twice'],
        [['--fn', 'copyTo,'], '--fn: "" is not a fn name'],
        [['--fn', 'Store.add'], '--fn: "Store.add" is not a fn name'],
        [['--fn', 'get value'], '--fn: "get value" is not a fn name'],
        [['--fn', '1x'], '--fn: "1x" is not a fn name'],
        [['--cap-ms', '999'], '--cap-ms: want an integer 1000..3600000'],
        [['--cap-ms', '3600001'], '--cap-ms: want an integer 1000..3600000'],
        [['--cap-ms', '1e4'], '--cap-ms: want an integer 1000..3600000'],
        [['--fnn', 'x'], 'unknown argument "--fnn" (did you mean --fn?)'],
        [['--before', 'x'], 'unknown argument "--before" (did you mean --after?)'],
        [['--keep', '--keep'], '--keep given twice'],
        [['--fn'], '--fn needs a value'],
        [['--fn', '--keep'], '--fn needs a value'],
        [['--after', join(d, 'nope.js')], '--after not found: ' + join(d, 'nope.js')],
        [['--stage-only', join(d, 'full')], '--stage-only DIR must be new or empty: ' + join(d, 'full')],
    ];
    let k = 0;
    for (const [args, why] of bad) {
        const extra = args.includes('--stage-only') ? [] : ['--stage-only', join(d, 'b' + (k++))];
        refused(await run(NODE, [DEOPT_DIFF, ...args, ...extra], { env: cleanEnv() }), why, args.join(' '));
    }
    for (const [fn, cap] of [['copyTo,push,$x_1', '1000'], ['_', '3600000']]) {
        const r = await run(NODE, [DEOPT_DIFF, '--fn', fn, '--cap-ms', cap, '--stage-only', join(d, 'g' + (k++))], { env: cleanEnv() });
        expectExit(r, 0, '--fn ' + fn + ' --cap-ms ' + cap);
        assert.ok(r.out.includes(' | fn ' + fn + ' | control copyTo | runs 3\n'), '--fn ' + fn + ': not in provenance\n' + r.out);
    }
    const zero = stubTree('anchor-0x', { driver: (s) => s.replace(ANCHOR_DST, () => 'const DST = Float32Array; // edited\n') });
    refused(await stubRun(zero, 'ok', ['--stage-only', join(d, 'z')]), 'driver f64: anchor ' + JSON.stringify(ANCHOR_DST) + ' matches 0 times', 'DST anchor 0x');
    const two = stubTree('anchor-2x', { driver: (s) => s + '// ' + ANCHOR_SWITCH });
    refused(await stubRun(two, 'ok', ['--stage-only', join(d, 't')]), 'driver ctl-after: anchor ' + JSON.stringify(ANCHOR_SWITCH) + ' matches 2 times', 'SWITCH anchor 2x');
    // control: the unmodified driver in a stub tree stages
    const ok = stubTree('anchor-ok');
    const r = await stubRun(ok, 'ok', ['--stage-only', join(d, 'o')]);
    expectExit(r, 0, 'unmodified driver');
    assert.deepEqual(readdirSync(join(d, 'o')).sort(), ['after', 'before', 'ctl-after', 'ctl-before', 'f32', 'f64', 'package.json']);
    // an internal error (mkdtemp under a TMPDIR that does not exist) is NO-VERDICT, exit 2 -- never exit 1 (blind)
    refused(await stubRun(stubTree('tmpdir-nope'), 'ok', [], { TMPDIR: join(d, 'nope') }), 'internal error: ENOENT', 'missing TMPDIR');
});

test('T5 stub SAME + control DIFF exits 0; a real-run DIFF is REPORTED, still 0; argv contract, GIT_* stripped, --keep keeps', { timeout: T_STUB }, async () => {
    const s = stubTree('ok');
    const log = join(s.tree, 'stub.log');
    const r = await stubRun(s, 'ok', ['--fn', 'copyTo,push'], { STUB_LOG: log });
    expectExit(r, 0, 'stub ok');
    assert.match(r.out, /^run f32  exit 0 VERDICT SAME \d+ ms -> REPORTED SAME \(/m);
    assert.match(r.out, /^run f64  exit 0 VERDICT SAME \d+ ms -> REPORTED SAME \(/m);
    assert.match(r.out, /^run ctl  exit 1 VERDICT DIFF \d+ ms -> ok, the control reads DIFF$/m);
    assert.match(r.out, /^ {4}\| stub report f64$/m);
    assert.match(r.out, /^deopt-diff: VERDICT ok \(control DIFF; REPORTED f32 SAME, f64 SAME\); work dir removed \(--keep keeps it\)$/m);
    assert.ok(r.out.includes(':RingBuffer.js (git dir ' + GIT_DIR + ')\n'), 'side before does not name the GIT_DIR it read\n' + r.out);
    const w = workDirOf(r.out);
    assert.ok(w.startsWith(DEO_TMP + '/lrb-deopt-diff-'), 'work dir not in the scoped TMPDIR: ' + w);
    assert.ok(!existsSync(w), 'work dir left behind: ' + w);
    const runs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(runs.map((x) => x.label), ['f32', 'f64', 'ctl']);
    for (const k of ['f32', 'f64']) {
        assert.deepEqual(runs.find((x) => x.label === k).argv, ['--node', NODE, '--fn', 'copyTo,push', '--runs', '3',
            '--out', join(w, 'out-' + k), '--driver', join(w, k, 'driver.mjs'),
            '--before', join(w, 'before', 'RingBuffer.js'), '--after', join(w, 'after', 'RingBuffer.js')], k + ' argv');
    }
    assert.deepEqual(runs[2].argv, ['--node', NODE, '--fn', 'copyTo', '--runs', '3', '--out', join(w, 'out-ctl'),
        join(w, 'ctl-before', 'driver.mjs'), join(w, 'ctl-after', 'driver.mjs')], 'ctl argv (driver mode, always copyTo)');
    for (const x of runs) {
        assert.equal(x.cwd, w, x.label + ' cwd');
        assert.deepEqual(x.git, [], x.label + ': a GIT_* variable deopt-diff.sh refuses reached it');
    }
    // a real-run DIFF is a measurement, not a failure
    const d = await stubRun(stubTree('real-diff'), 'real-diff');
    expectExit(d, 0, 'f64 DIFF');
    assert.match(d.out, /^run f64  exit 1 VERDICT DIFF \d+ ms -> REPORTED DIFF \(/m);
    assert.match(d.out, /^deopt-diff: VERDICT ok \(control DIFF; REPORTED f32 SAME, f64 DIFF\)/m);
    // --keep keeps the work dir and its reports
    const k = await stubRun(stubTree('keep'), 'ok', ['--keep']);
    const wk = workDirOf(k.out);
    try {
        expectExit(k, 0, '--keep');
        assert.ok(wk.startsWith(DEO_TMP + '/lrb-deopt-diff-'), 'work dir not in the scoped TMPDIR: ' + wk);
        for (const o of ['out-f32', 'out-f64', 'out-ctl']) assert.ok(existsSync(join(wk, o, 'report.txt')), '--keep lost ' + o);
        assert.match(k.out, /; artifacts kept in /);
    } finally {
        if (/lrb-deopt-diff-/.test(wk)) rmSync(wk, { recursive: true, force: true });
    }
});

test('T6 control SAME exits 1 (blind); NO-VERDICT (also with a blind control), exit/VERDICT mismatch, no report.txt, no / two VERDICT lines, a hung run, SIGTERM exit 2; ok stub exits 0 (control)', { timeout: T_STUB }, async () => {
    const ok = await stubRun(stubTree('t6-ok'), 'ok');
    expectExit(ok, 0, 'control: ok stub');
    const blind = await stubRun(stubTree('t6-blind'), 'ctl-same');
    expectExit(blind, 1, 'control SAME');
    assert.match(blind.out, /^run ctl  exit 0 VERDICT SAME \d+ ms -> gate blind: the control reads SAME$/m);
    assert.match(blind.out, /^deopt-diff: VERDICT FAIL \(gate blind: the control reads SAME\)/m);
    const cases = [
        ['nv', /^run f32  exit 2 VERDICT NO-VERDICT \d+ ms -> NO-VERDICT\n {4}deopt-diff: stub reason$/m],
        ['ctl-nv', /^run ctl  exit 2 VERDICT NO-VERDICT \d+ ms -> NO-VERDICT$/m],
        ['mismatch', /^run f32  exit 1 VERDICT SAME \d+ ms -> NO-VERDICT$/m],
        ['no-report', /^run f64  exit 0 VERDICT SAME \d+ ms -> NO-VERDICT \(no report\.txt\)$/m],
        ['no-verdict-line', /^run f64  exit 0 VERDICT none \d+ ms -> NO-VERDICT$/m],
        ['two-verdicts', /^run ctl  exit 1 VERDICT repeated\(2\) \d+ ms -> NO-VERDICT$/m],
        ['nv-blind', /^run ctl  exit 0 VERDICT SAME \d+ ms -> gate blind: the control reads SAME$/m],
    ];
    for (const [mode, re] of cases) {
        const r = await stubRun(stubTree('t6-' + mode), mode);
        expectExit(r, 2, mode);
        assert.match(r.out, re, mode);
        assert.match(r.out, /^deopt-diff: VERDICT NO-VERDICT \(1 run\(s\)\); work dir removed/m, mode);
    }
    const pidf = join(scratch('pid'), 'pid');
    const h = await stubRun(stubTree('t6-hang'), 'hang', ['--cap-ms', '3000'], { STUB_PID: pidf });
    const hr = await reapStub(pidf);   // reaps first, asserts after: a red row never leaks the grandchild
    assert.ok(hr.started, 'stub did not start (no pid file)\n' + h.out.slice(-2000));
    expectExit(h, 2, 'hung control');
    assert.match(h.out, /^run ctl  exit null signal SIGKILL VERDICT none \d+ ms \(killed after 3000 ms\) -> NO-VERDICT$/m);
    assert.ok(h.ms < 3000 + 30000, 'took ' + h.ms + ' ms');
    assert.equal(hr.g, false, 'grandchild outlived the cap kill');
    // SIGTERM to the wrapper while the control hangs: exit 2 naming it, the stub's process group SIGKILLed,
    // the temp work dir removed. Spawned directly (not run()): the row signals the wrapper itself.
    const sig = stubTree('t6-sigterm');
    const spf = join(scratch('pid-sig'), 'pid');
    const w = spawn(NODE, [sig.tool, '--cap-ms', '60000'], { cwd: sig.tree, env: cleanEnv({ GIT_DIR, STUB_MODE: 'hang', STUB_PID: spf }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const wChunks = [];
    w.stdout.on('data', (c) => wChunks.push(c));
    w.stderr.on('data', (c) => wChunks.push(c));
    const wClosed = new Promise((res) => { w.on('error', (e) => res({ status: null, signal: null, error: e })); w.on('close', (status, signal) => res({ status, signal })); });
    for (let k = 0; k < 600 && !existsSync(spf); k++) await sleep(50);   // the control starts after f32 + f64
    const started = existsSync(spf);
    if (started) w.kill('SIGTERM');
    else { try { process.kill(-w.pid, 'SIGKILL'); } catch { /* gone */ } }
    const wCap = setTimeout(() => { try { process.kill(-w.pid, 'SIGKILL'); } catch { /* gone */ } }, 30000);
    const wr = await wClosed;
    clearTimeout(wCap);
    const sr = await reapStub(spf);
    const wOut = Buffer.concat(wChunks).toString('utf8');
    assert.ok(started && sr.started, 'stub did not start (no pid file)\n' + wOut.slice(-2000));
    assert.ok(wr.status === 2 && wr.signal === null, 'SIGTERM: want exit 2, got status ' + wr.status + ' signal ' + wr.signal + '\n' + wOut.slice(-2000));
    assert.ok(wOut.includes('deopt-diff: interrupted by SIGTERM\ndeopt-diff: VERDICT NO-VERDICT\n'), 'no named interrupt\n' + wOut.slice(-2000));
    assert.equal(sr.s, false, 'the stub outlived SIGTERM (its process group was not killed)');
    assert.equal(sr.g, false, 'the grandchild outlived SIGTERM');
    const wd = workDirOf(wOut);
    assert.ok(wd.startsWith(DEO_TMP + '/lrb-deopt-diff-'), 'work dir not in the scoped TMPDIR: ' + wd);
    assert.ok(!existsSync(wd), 'work dir left behind after SIGTERM: ' + wd);
});

test('T7 no lrb-deopt-diff-* work dir leaked into this file\'s TMPDIR root', { timeout: T_FAST }, () => {
    assert.ok(existsSync(DEO_TMP), 'TMPDIR root missing: ' + DEO_TMP);
    assert.ok(fullRuns >= 10, 'only ' + fullRuns + ' default (removing) runs reached staging: the leak check would be vacuous');
    const leaked = readdirSync(DEO_TMP).filter((n) => n.startsWith('lrb-deopt-diff-'));
    assert.deepEqual(leaked, []);
});
