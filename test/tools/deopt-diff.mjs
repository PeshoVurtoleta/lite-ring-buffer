// deopt-diff.mjs -- `npm run deopt-diff`: the DEOPTIMIZATIONS of RingBuffer#copyTo (or --fn LIST), git HEAD vs
// the live file, read by deopt-diff.sh of the exact-pinned devDependency @zakkster/lite-utils 1.0.0. Tier:
// REPORTED. Deopts follow tier-up timing, so this is never part of `npm test` / `npm run verify`; run it by
// hand under the host quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run "lite-ring-buffer deopt-diff" -- npm run deopt-diff
//
//   node test/tools/deopt-diff.mjs [--after FILE] [--fn LIST] [--stage-only DIR] [--cap-ms N] [--keep]
//
//   --after FILE  the after module (default: a copy of the live RingBuffer.js)
//   --fn LIST     comma-separated fn names, each ^[A-Za-z_$][A-Za-z0-9_$]*$, no duplicates (default copyTo);
//                 the real runs only (the control is always copyTo)
//   --cap-ms N    per-spawn cap, integer 1000..3600000 (default 600000); past it the whole process group of
//                 that run is SIGKILLed and the run is NO-VERDICT
//   --keep        keep the temp work dir (artifacts); by default it is removed on exit
//
// Sides (each printed with commit + sha256/8), staged in a work dir whose package.json says "type":"module":
//   before   git show HEAD:RingBuffer.js (the line names the git dir it was read from)
//   after    a copy of the live RingBuffer.js, or --after FILE
// Drivers: test/tools/deopt-driver.mjs, each variant by ONE exact edit of an anchor that must match exactly once:
//   f32 = the driver as is; f64 = `const DST = Float32Array;\n` -> Float64Array;
//   ctl-before = the driver as is; ctl-after = `const SWITCH = false;\n` -> true.
// Runs (deopt-diff.sh --node <this node> --runs 3 --out W/out-<k>):
//   f32, f64  file mode, --fn LIST --driver W/<k>/driver.mjs --before W/before/RingBuffer.js
//             --after W/after/RingBuffer.js. A run that is consistent (exit 0 + VERDICT SAME, or exit 1 + VERDICT
//             DIFF) with a report.txt is printed as REPORTED: SAME and DIFF are both measurements, never judged.
//   ctl       the blind control, driver mode, --fn copyTo, W/ctl-before/driver.mjs vs W/ctl-after/driver.mjs, both
//             dirs holding the after module: it must read DIFF (a consistent SAME = the tool is blind).
// The script's bytes are pinned by test/DeoptTool.test.js; this tool prints them as provenance
// (lite-utils <version> deopt-diff.sh sha256/8 X). GIT_DIR and the other GIT_* variables deopt-diff.sh refuses
// are removed from its env (each repo is found from its path; the work dir is in no repo).
//
// Exit 2: fail closed -- a bad option, a missing driver / git / file, a lite-utils that is missing, unreadable,
//   misnamed, not exactly 1.0.0 or lacks deopt-diff.sh, a driver anchor that does not match exactly once, or any
//   run that is NO-VERDICT: exit 2, killed, a VERDICT line missing / repeated / disagreeing with the exit status,
//   or no report.txt; an internal error (uncaught exception); SIGINT / SIGTERM / SIGHUP. On every exit 2 the
//   process group of a running deopt-diff.sh is SIGKILLed and the temp work dir removed (unless --keep).
//   --stage-only DIR stages into a new or empty DIR, prints it and exits 0 without running.
// Exit 1: no NO-VERDICT, and the control is not DIFF (gate blind).
// Exit 0: no NO-VERDICT and the control reads DIFF (whatever f32 / f64 read).
// Test tooling only: not shipped.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LITE_UTILS_VERSION, liteUtilsScript } from './lite-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DRIVER = join(HERE, 'deopt-driver.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const DEFAULT_FN = 'copyTo';
const CTL_FN = 'copyTo';
const RUNS = '3';
const DEFAULT_CAP_MS = 600000; // per spawn; the whole process group is SIGKILLed past it
const ANCHOR_DST = 'const DST = Float32Array;\n';
const ANCHOR_SWITCH = 'const SWITCH = false;\n';
const GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES'];

const GROUPS = new Set();   // process groups of running deopt-diff.sh spawns: die() SIGKILLs each
function die(msg) {
    for (const pid of GROUPS) { try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ } }
    process.stderr.write('deopt-diff: ' + msg + '\ndeopt-diff: VERDICT NO-VERDICT\n');
    process.exit(2);   // the 'exit' listener removes the temp work dir (unless --keep)
}
process.on('uncaughtException', (e) => die('internal error: ' + (e instanceof Error ? e.message : String(e))));
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => die('interrupted by ' + s));
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }
function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

// ---- options ------------------------------------------------------------------------------
const VALUE_OPTS = ['--after', '--fn', '--stage-only', '--cap-ms'];
const FLAG_OPTS = ['--keep'];
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
const FN = opt['--fn'] ?? DEFAULT_FN;
const FN_LIST = FN.split(',');
for (let k = 0; k < FN_LIST.length; k++) {
    const f = FN_LIST[k];
    if (!/^[A-Za-z_$][\w$]*$/.test(f)) die('--fn: ' + JSON.stringify(f) + ' is not a fn name (comma-separated, ^[A-Za-z_$][A-Za-z0-9_$]*$)');
    if (FN_LIST.indexOf(f) !== k) die('--fn: ' + f + ' given twice');
}
let CAP_MS = DEFAULT_CAP_MS;
if ('--cap-ms' in opt) {
    const c = opt['--cap-ms'];
    if (!/^[0-9]{4,7}$/.test(c) || !(Number(c) >= 1000 && Number(c) <= 3600000)) die('--cap-ms: want an integer 1000..3600000, got ' + JSON.stringify(c));
    CAP_MS = Number(c);
}
const KEEP = opt['--keep'] === true;

// ---- preflight ----------------------------------------------------------------------------
const LU = liteUtilsScript(ROOT, 'deopt-diff.sh');
if (!LU.ok) die(LU.why);
const SCRIPT = LU.path;
if (!isFile(DRIVER)) die('driver missing: ' + DRIVER);
const drvBuf = readFileSync(DRIVER);
const drvSrc = drvBuf.toString('utf8');
function variant(name, from, to) {
    const parts = drvSrc.split(from);
    if (parts.length !== 2) die('driver ' + name + ': anchor ' + JSON.stringify(from) + ' matches ' + (parts.length - 1) + ' times in ' + DRIVER + ' (need exactly 1)');
    return Buffer.from(parts[0] + to + parts[1], 'utf8');
}
const drvF64 = variant('f64', ANCHOR_DST, 'const DST = Float64Array;\n');
const drvCtlAfter = variant('ctl-after', ANCHOR_SWITCH, 'const SWITCH = true;\n');

function git(args) {
    const r = spawnSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 << 20, timeout: 60000, killSignal: 'SIGKILL' });
    if (r.error) die('git ' + args.join(' ') + ': ' + r.error.message);
    if (r.status !== 0 || r.signal !== null) {
        die('git ' + args.join(' ') + ' exited ' + r.status + (r.signal ? ' signal ' + r.signal : '') + ': ' +
            String(r.stderr).trim());
    }
    return r.stdout;
}
const headFull = String(git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
if (!/^[0-9a-f]{40,64}$/.test(headFull)) die('cannot resolve HEAD: ' + JSON.stringify(headFull));

// ---- sides --------------------------------------------------------------------------------
const beforeSrc = git(['show', headFull + ':RingBuffer.js']);
const gitDir = String(git(['rev-parse', '--absolute-git-dir'])).trim();
const beforeName = 'git HEAD = commit ' + headFull.slice(0, 7) + ':RingBuffer.js (git dir ' + gitDir + ')';
let afterSrc;
let afterName;
if ('--after' in opt) {
    const p = resolve(opt['--after']);
    if (!isFile(p)) die('--after not found: ' + p);
    afterSrc = readFileSync(p);
    afterName = 'file ' + p;
} else {
    if (!isFile(LIVE)) die('live RingBuffer.js missing: ' + LIVE);
    afterSrc = readFileSync(LIVE);
    afterName = 'worktree RingBuffer.js (HEAD ' + headFull.slice(0, 7) + ', ' +
        (sha(afterSrc) === sha(beforeSrc) ? 'clean' : 'MODIFIED') + ')';
}
if (beforeSrc.length === 0) die('before side is empty');
if (afterSrc.length === 0) die('after side is empty');

// ---- stage --------------------------------------------------------------------------------
let work;
if ('--stage-only' in opt) {
    work = resolve(opt['--stage-only']);
    if (existsSync(work) && (!statSync(work).isDirectory() || readdirSync(work).length > 0)) die('--stage-only DIR must be new or empty: ' + work);
    mkdirSync(work, { recursive: true });
} else {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'lrb-deopt-diff-')));
    const tmpWork = work;
    if (!KEEP) process.on('exit', () => { rmSync(tmpWork, { recursive: true, force: true }); });
}
function put(rel, buf) {
    const p = join(work, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
    if (sha(readFileSync(p)) !== sha(buf)) die('staging ' + rel + ' did not round-trip');
    return p;
}
put('package.json', '{"type":"module"}\n');
const B = put(join('before', 'RingBuffer.js'), beforeSrc);
const A = put(join('after', 'RingBuffer.js'), afterSrc);
put(join('ctl-before', 'RingBuffer.js'), afterSrc);
put(join('ctl-after', 'RingBuffer.js'), afterSrc);
const drivers = [
    { key: 'f32', buf: drvBuf, name: 'deopt-driver.mjs as is (dst Float32Array)' },
    { key: 'f64', buf: drvF64, name: 'deopt-driver.mjs, DST -> Float64Array' },
    { key: 'ctl-before', buf: drvBuf, name: 'deopt-driver.mjs as is (control, SWITCH false)' },
    { key: 'ctl-after', buf: drvCtlAfter, name: 'deopt-driver.mjs, SWITCH -> true (control)' },
];
const DRV = Object.create(null);
for (const d of drivers) DRV[d.key] = put(join(d.key, 'driver.mjs'), d.buf);
process.stdout.write('side before         sha256/8 ' + sha(beforeSrc).slice(0, 8) + '  ' + beforeName + '\n');
process.stdout.write('side after          sha256/8 ' + sha(afterSrc).slice(0, 8) + '  ' + afterName + '\n');
for (const d of drivers) process.stdout.write('driver ' + d.key.padEnd(12) + ' sha256/8 ' + sha(d.buf).slice(0, 8) + '  ' + d.name + '\n');
process.stdout.write('tool test/tools/deopt-driver.mjs sha256/8 ' + sha(drvBuf).slice(0, 8) + ' | lite-utils ' + LITE_UTILS_VERSION +
    ' deopt-diff.sh sha256/8 ' + sha(readFileSync(SCRIPT)).slice(0, 8) + ' | node ' + process.version +
    ' | fn ' + FN + ' | control ' + CTL_FN + ' | runs ' + RUNS + '\n');
process.stdout.write('work ' + work + ('--stage-only' in opt || KEEP ? '' : ' (removed on exit; --keep keeps it)') + '\n');
if ('--stage-only' in opt) process.exit(0);
const WHERE = KEEP ? 'artifacts kept in ' + work : 'work dir removed (--keep keeps it)';

// ---- run ----------------------------------------------------------------------------------
const ENV = { ...process.env };
for (const k of GIT_ENV) delete ENV[k];
function runScript(label, args) {
    return new Promise((done) => {
        const t0 = Date.now();
        let child;
        try {
            child = spawn('bash', [SCRIPT, '--node', process.execPath, ...args], { cwd: work, env: ENV, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            done({ label, status: null, signal: null, err: e.message, text: '', ms: Date.now() - t0 });
            return;
        }
        if (child.pid !== undefined) GROUPS.add(child.pid);
        const chunks = [];
        child.stdout.on('data', (c) => chunks.push(c));
        child.stderr.on('data', (c) => chunks.push(c));
        let err = '';
        child.on('error', (e) => { err = e.message; });
        const timer = setTimeout(() => {
            err = 'killed after ' + CAP_MS + ' ms';
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
        }, CAP_MS);
        child.on('close', (status, signal) => {
            clearTimeout(timer);
            GROUPS.delete(child.pid);
            const textOut = Buffer.concat(chunks).toString('utf8');
            writeFileSync(join(work, label + '.log'), textOut);
            done({ label, status, signal, err, text: textOut, ms: Date.now() - t0 });
        });
    });
}

const out = (k) => join(work, 'out-' + k);
const fileMode = (k) => ['--fn', FN, '--runs', RUNS, '--out', out(k), '--driver', DRV[k], '--before', B, '--after', A];
const results = [];
results.push(await runScript('f32', fileMode('f32')));
results.push(await runScript('f64', fileMode('f64')));
results.push(await runScript('ctl', ['--fn', CTL_FN, '--runs', RUNS, '--out', out('ctl'), DRV['ctl-before'], DRV['ctl-after']]));

let noVerdict = 0;
let blind = 0;
const reported = [];
for (const r of results) {
    const all = r.text.match(/^VERDICT (SAME|DIFF|NO-VERDICT)$/gm) || [];
    const v = all.length === 1 ? all[0].slice(8) : all.length === 0 ? 'none' : 'repeated(' + all.length + ')';
    const consistent = (r.status === 0 && v === 'SAME') || (r.status === 1 && v === 'DIFF');
    const report = join(out(r.label), 'report.txt');
    const hasReport = isFile(report);
    let line = 'run ' + r.label.padEnd(4) + ' exit ' + r.status + (r.signal ? ' signal ' + r.signal : '') +
        ' VERDICT ' + v + ' ' + r.ms + ' ms';
    if (r.err) line += ' (' + r.err + ')';
    if (!consistent || r.signal !== null || r.err || !hasReport) {
        noVerdict++;
        line += ' -> NO-VERDICT' + (consistent && !r.signal && !r.err ? ' (no report.txt)' : '');
        const why = r.text.split('\n').filter((l) => /NO-VERDICT|deopt-diff:/.test(l)).slice(0, 4);
        for (const w of why) line += '\n    ' + w;
    } else if (r.label === 'ctl') {
        if (v === 'DIFF') line += ' -> ok, the control reads DIFF';
        else { blind++; line += ' -> gate blind: the control reads SAME'; }
    } else {
        reported.push(r.label + ' ' + v);
        line += ' -> REPORTED ' + v + ' (' + report + ')';
        for (const l of readFileSync(report, 'utf8').replace(/\n$/, '').split('\n')) line += '\n    | ' + l;
    }
    process.stdout.write(line + '\n');
}
if (noVerdict > 0) {
    process.stdout.write('deopt-diff: VERDICT NO-VERDICT (' + noVerdict + ' run(s)); ' + WHERE + '\n');
    process.exit(2);
}
if (blind > 0) {
    process.stdout.write('deopt-diff: VERDICT FAIL (gate blind: the control reads SAME); ' + WHERE + '\n');
    process.exit(1);
}
process.stdout.write('deopt-diff: VERDICT ok (control DIFF; REPORTED ' + reported.join(', ') + '); ' + WHERE + '\n');
