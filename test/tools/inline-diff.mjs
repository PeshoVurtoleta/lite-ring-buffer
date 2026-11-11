// inline-diff.mjs -- `npm run inline-diff`: the inlining PRECONDITION of the 0 B/op claim for
// getOrDefault / peekNewest / peekOldest (they return non-integer doubles and box when NOT
// inlined; test/alloc.mjs stays the byte gate). Tier: REPORTED. Inlining follows tier-up
// timing, so this is never part of `npm test` / `npm run verify`; run it by hand under the
// host quiet lock:
//   node ~/.claude/hooks/quiet-lock.mjs run "lite-ring-buffer inline-diff" -- npm run inline-diff
//
//   node test/tools/inline-diff.mjs [--before-ref REF | --before FILE] [--after FILE]
//                                   [--stage-only DIR] [--tiers LIST] [--cap-ms N] [--keep]
//
//   --tiers LIST  comma-separated, each turbo or maglev, no duplicates (default turbo,maglev)
//   --cap-ms N    per-spawn cap, integer 1000..3600000 (default 300000); past it the whole
//                 process group of that run is SIGKILLed and the run is NO-VERDICT
//   --keep        keep the temp work dir (artifacts); by default it is removed on exit
//
// Sides (each printed with commit + sha256/8):
//   before   git show REF:RingBuffer.js (default REF = HEAD), or a frozen --before FILE
//   after    a copy of the live RingBuffer.js, or --after FILE
//   ctl-<fn> a copy of after with ONE exact edit: a never-taken branch that pads <fn> past
//            V8's max-inlined-bytecode-size (460), so <fn> can no longer be inlined.
// Runs the vendored test/tools/inlining-budget-diff.sh (driver mode, test/tools/inl-driver.mjs)
// --fn getOrDefault,peekNewest,peekOldest on (before, after) and on each (after, ctl-<fn>).
//
// Exit 0: before vs after SAME and every control DIFF naming its own fn (and no other).
// Exit 1: before vs after DIFF, or a control that is not such a DIFF in EVERY tier ("gate blind").
// Exit 2: fail closed -- a bad option, a missing bash / script / driver / git ref / file, an
//   anchor that does not match exactly once, a run that exits 2 / is killed / exits with no
//   matching VERDICT line, a missing diff file or report.txt. --stage-only DIR stages the five sides into a
//   new or empty DIR, prints them and exits 0 without running anything.
// Test tooling only: not shipped.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'inlining-budget-diff.sh');
const DRIVER = join(HERE, 'inl-driver.mjs');
const LIVE = join(ROOT, 'RingBuffer.js');
const FNS = ['getOrDefault', 'peekNewest', 'peekOldest'];
const ANCHORS = {
    getOrDefault: '    getOrDefault(offset, defaultValue) {\n',
    peekNewest: '    peekNewest() {\n',
    peekOldest: '    peekOldest() {\n',
};
const DEFAULT_TIERS = 'turbo,maglev';
const DEFAULT_CAP_MS = 300000; // per spawn; the whole process group is SIGKILLed past it
const PAD_LINES = 64;

function die(msg) {
    process.stderr.write('inline-diff: ' + msg + '\ninline-diff: VERDICT NO-VERDICT\n');
    process.exit(2);
}
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }
function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

// ---- options ------------------------------------------------------------------------------
const VALUE_OPTS = ['--before-ref', '--before', '--after', '--stage-only', '--tiers', '--cap-ms'];
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
if ('--before-ref' in opt && '--before' in opt) die('--before-ref and --before are exclusive');
const TIERS = opt['--tiers'] ?? DEFAULT_TIERS;
const TIER_LIST = TIERS.split(',');
for (let k = 0; k < TIER_LIST.length; k++) {
    const t = TIER_LIST[k];
    if (t !== 'turbo' && t !== 'maglev') die('--tiers: ' + JSON.stringify(t) + ' is not turbo or maglev (comma-separated, no blanks)');
    if (TIER_LIST.indexOf(t) !== k) die('--tiers: ' + t + ' given twice');
}
let CAP_MS = DEFAULT_CAP_MS;
if ('--cap-ms' in opt) {
    const c = opt['--cap-ms'];
    if (!/^[0-9]{4,7}$/.test(c) || !(Number(c) >= 1000 && Number(c) <= 3600000)) die('--cap-ms: want an integer 1000..3600000, got ' + JSON.stringify(c));
    CAP_MS = Number(c);
}
const KEEP = opt['--keep'] === true;

// ---- preflight ----------------------------------------------------------------------------
if (!isFile(SCRIPT)) die('vendored script missing: ' + SCRIPT);
if (!isFile(DRIVER)) die('driver missing: ' + DRIVER);

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
let beforeSrc;
let beforeName;
if ('--before' in opt) {
    const p = resolve(opt['--before']);
    if (!isFile(p)) die('--before not found: ' + p);
    beforeSrc = readFileSync(p);
    beforeName = 'file ' + p;
} else {
    const ref = opt['--before-ref'] ?? 'HEAD';
    const c = String(git(['rev-parse', '--verify', '--quiet', ref + '^{commit}'])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(c)) die('cannot resolve --before-ref ' + ref);
    beforeSrc = git(['show', c + ':RingBuffer.js']);
    beforeName = 'git ' + ref + ' = commit ' + c.slice(0, 7) + ':RingBuffer.js';
}
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
    const headSha = sha(git(['show', headFull + ':RingBuffer.js']));
    afterName = 'worktree RingBuffer.js (HEAD ' + headFull.slice(0, 7) + ', ' +
        (sha(afterSrc) === headSha ? 'clean' : 'MODIFIED') + ')';
}
if (beforeSrc.length === 0) die('before side is empty');
if (afterSrc.length === 0) die('after side is empty');

function pad(fn) {
    let s = '        if (this.count < 0) { // inline-diff control: never taken, pads ' + fn + ' past 460 B\n' +
        '            let p = this.count;\n';
    for (let k = 1; k <= PAD_LINES; k++) s += '            p = (p * 31 + ' + k + ') | 0;\n';
    return s + '            return p;\n        }\n';
}
const text = afterSrc.toString('utf8');
const sides = [
    { key: 'before', name: beforeName, src: beforeSrc },
    { key: 'after', name: afterName, src: afterSrc },
];
for (const fn of FNS) {
    const anchor = ANCHORS[fn];
    const parts = text.split(anchor);
    if (parts.length !== 2) die('control ' + fn + ': anchor ' + JSON.stringify(anchor) + ' matches ' + (parts.length - 1) + ' times in the after side (need exactly 1)');
    sides.push({ key: 'ctl-' + fn, name: 'after + never-taken pad in ' + fn, src: Buffer.from(parts[0] + anchor + pad(fn) + parts[1], 'utf8'), fn });
}

// ---- stage --------------------------------------------------------------------------------
let work;
if ('--stage-only' in opt) {
    work = resolve(opt['--stage-only']);
    if (existsSync(work) && (!statSync(work).isDirectory() || readdirSync(work).length > 0)) die('--stage-only DIR must be new or empty: ' + work);
    mkdirSync(work, { recursive: true });
} else {
    work = mkdtempSync(join(tmpdir(), 'lrb-inline-diff-'));
    const tmpWork = work;
    if (!KEEP) process.on('exit', () => { rmSync(tmpWork, { recursive: true, force: true }); });
}
const drvSha = sha(readFileSync(DRIVER)).slice(0, 8);
for (const s of sides) {
    const d = join(work, s.key);
    mkdirSync(d);
    writeFileSync(join(d, 'RingBuffer.js'), s.src);
    copyFileSync(DRIVER, join(d, 'driver.mjs'));
    s.drv = join(d, 'driver.mjs');
    if (sha(readFileSync(join(d, 'RingBuffer.js'))) !== sha(s.src)) die('staging ' + s.key + ' did not round-trip');
    process.stdout.write('side ' + s.key.padEnd(17) + ' sha256/8 ' + sha(s.src).slice(0, 8) + '  ' + s.name + '\n');
}
process.stdout.write('driver test/tools/inl-driver.mjs sha256/8 ' + drvSha + ' | script sha256/8 ' +
    sha(readFileSync(SCRIPT)).slice(0, 8) + ' | node ' + process.version + ' | tiers ' + TIERS + '\n');
process.stdout.write('work ' + work + ('--stage-only' in opt || KEEP ? '' : ' (removed on exit; --keep keeps it)') + '\n');
if ('--stage-only' in opt) process.exit(0);
const WHERE = KEEP ? 'artifacts kept in ' + work : 'work dir removed (--keep keeps it)';

// ---- run ----------------------------------------------------------------------------------
function runScript(label, b, a, out) {
    return new Promise((done) => {
        const t0 = Date.now();
        const args = [SCRIPT, '--node', process.execPath, '--fn', FNS.join(','), '--tiers', TIERS, '--out', out, b.drv, a.drv];
        let child;
        try {
            child = spawn('bash', args, { cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            done({ label, status: null, signal: null, err: e.message, text: '', ms: Date.now() - t0 });
            return;
        }
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
            const textOut = Buffer.concat(chunks).toString('utf8');
            writeFileSync(join(work, label + '.log'), textOut);
            done({ label, status, signal, err, text: textOut, ms: Date.now() - t0 });
        });
    });
}

// A control's DIFF must name its padded fn in EVERY tier's diff file, and no other target in any.
function namesOnly(out, fn) {
    const found = [];
    for (const tier of TIER_LIST) {
        const f = join(out, 'all.' + tier + '.diff.txt');
        if (!isFile(f)) return { ok: false, missing: true, why: 'missing ' + f };
        const body = readFileSync(f, 'utf8');
        for (const g of FNS) if (body.includes(g) && !found.includes(tier + ':' + g)) found.push(tier + ':' + g);
    }
    const own = TIER_LIST.every((t) => found.includes(t + ':' + fn));
    const other = found.filter((x) => !x.endsWith(':' + fn));
    return { ok: own && other.length === 0, why: 'diff names [' + found.join(' ') + ']' };
}

const before = sides[0];
const after = sides[1];
const results = [];
results.push(await runScript('aa', before, after, join(work, 'out-aa')));
for (const s of sides.slice(2)) results.push(await runScript(s.key, after, s, join(work, 'out-' + s.key)));

let noVerdict = 0;
let red = 0;
for (const r of results) {
    const m = r.text.match(/^VERDICT (SAME|DIFF|NO-VERDICT)$/m);
    const v = m ? m[1] : 'none';
    const consistent = (r.status === 0 && v === 'SAME') || (r.status === 1 && v === 'DIFF');
    let line = 'run ' + r.label.padEnd(17) + ' exit ' + r.status + (r.signal ? ' signal ' + r.signal : '') +
        ' VERDICT ' + v + ' ' + r.ms + ' ms';
    if (r.err) line += ' (' + r.err + ')';
    if (!consistent || r.signal !== null || r.err) {
        noVerdict++;
        line += ' -> NO-VERDICT';
        const why = r.text.split('\n').filter((l) => /NO-VERDICT|inlining-budget-diff:/.test(l)).slice(0, 4);
        for (const w of why) line += '\n    ' + w;
    } else if (r.label === 'aa') {
        if (v === 'DIFF') { red++; line += ' -> before vs after inline DIFFERENTLY'; }
    } else {
        const fn = r.label.slice(4);
        if (v !== 'DIFF') {
            red++;
            line += ' -> gate blind: the ' + fn + ' control reads SAME';
        } else {
            const n = namesOnly(join(work, 'out-' + r.label), fn);
            if (n.missing || !isFile(join(work, 'out-' + r.label, 'report.txt'))) { noVerdict++; line += ' -> NO-VERDICT (' + (n.missing ? n.why : 'no report.txt') + ')'; }
            else if (!n.ok) { red++; line += ' -> gate blind: ' + n.why + ' (want ' + fn + ' in every tier, no other)'; }
            else line += ' -> ok, ' + n.why;
        }
    }
    process.stdout.write(line + '\n');
}
if (noVerdict > 0) {
    process.stdout.write('inline-diff: VERDICT NO-VERDICT (' + noVerdict + ' run(s)); ' + WHERE + '\n');
    process.exit(2);
}
if (red > 0) {
    process.stdout.write('inline-diff: VERDICT FAIL (' + red + ' run(s)); ' + WHERE + '\n');
    process.exit(1);
}
process.stdout.write('inline-diff: VERDICT ok (before vs after SAME, 3/3 controls DIFF on their own fn); ' + WHERE + '\n');
