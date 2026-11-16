// Core lane for `npm run test:core`: the portable subset of `npm test` that runs on
// every Node in the CI matrix (18 / 20 / 22 / 24 / 26), count-gated and fail-closed.
// Runs on Node 18: no import.meta.dirname, no node:test import (each file runs in its
// own `node --expose-gc --test --test-reporter=tap <file>` child, the TAP summary is
// parsed here).
//
// Source of truth for the per-file counts is test/count.mjs: this file parses its
// FILES, EXPECTED and the header sum line ("// (60 + 35 + ... = 294, ..."), one term
// per FILES entry in FILES order. test/core-tiers.json owns only the tier split below
// and the two tier totals (base, feature, excluded {file: reason}, baseTotal,
// featureTotal; any other key, a non test/*.test.js entry or a non-integer total is
// exit 2); a drift between the two files is a failure, never a re-count. Every BASE
// and FEATURE term must be >= 2 (MIN_TERM): an emptied test file reads "tests 1 pass 1"
// on Node 18..26, so a term of 1 cannot tell a real file from an empty one; a
// term < 2 is a drift (exit 1).
//
// Tiers (ROADMAP Q1 ruling Q-Q1-FEATURES "Tiered, named SKIP"):
//   BASE     runs on every engine; its counts must sum to BASE_TOTAL.
//   FEATURE  runs iff ArrayBuffer.prototype.transfer, ArrayBuffer.prototype.resize and
//            SharedArrayBuffer.prototype.grow are all functions (Node 22+; Node 18 has
//            none, Node 20 lacks transfer); else a named SKIP line with the missing
//            names. Fail closed: a Node major >= 22 missing any of them exits 1.
//   EXCLUDED never runs here; each entry names its reason. `npm test` / `npm run
//            verify` on the pinned Node v26.8.2 run them.
//
// Per file the child must exit 0 with no signal / spawn error, its TAP must carry
// each column-0 summary key (tests suites pass fail cancelled skipped todo
// duration_ms) exactly once, and tests === pass === the count.mjs term (> 0) with
// fail / cancelled / skipped / todo all 0. A missing file, an empty file, a
// test.skip / todo, a top-level throw or a count change fails.
//
// Before the real lane, always, in this order (Q1 QA F1 / F2):
//   1. core self-test: byte-identical copies of this file, test/ci-legs.mjs and
//      package.json run in temp package roots (os.tmpdir(), removed when green) holding
//      tiny fixture test files, a fixture test/count.mjs and a fixture
//      test/core-tiers.json (nothing is substituted in the copies). Cases: green control
//      (exit 0), an argument (2), a reformatted header sum line (2), an unknown
//      core-tiers.json key (2), an unclassified FILES entry (1), test.skip (1), todo (1),
//      a failing test (1), a term-1 empty file (1), the feature guard with
//      ArrayBuffer.prototype.transfer deleted by an --import data: preload (1; Node major
//      >= 22 only, else reported n/a by name), the ci-legs wiring (unquoted node value in
//      a checkout: 1; no ci.yml in a checkout: 1; no ci.yml and no .git: 0 + SKIP), and
//      in-process ci-legs checks on the live ci.yml (live: pass; unquoted value, a leg
//      dropped from a SKIP if, verify widened to '26', test:core gated, an unknown step
//      key, defaults.run.shell neutered, on: reduced to workflow_dispatch, a
//      defaults.run.working-directory: fail), plus a bad LRB_CORE_SELFTEST value (2) and
//      LRB_CORE_SELFTEST=child outside a self-test temp root (2; the bad-value fixture has
//      no package.json, so a copy whose guard check is broken fails its own self-test at
//      once instead of recursing). ST_CASES pins the case
//      total (24, n/a cases included): a deleted case turns the self-test red. Prints
//      "core self-test: N/N ok"; a red case prints its name and exits 1 before any real
//      file runs. The copies run with LRB_CORE_SELFTEST=child, which skips their own
//      self-test (a named SKIP line) and nothing else; it is honoured only when the
//      package root's parent dir is named lrb-core-selftest-* (a self-test temp root),
//      else exit 2; any other value of LRB_CORE_SELFTEST is exit 2. An argument is exit 2
//      before the guard.
//   2. core ci-legs: test/ci-legs.mjs checks .github/workflows/ci.yml (see its header);
//      a finding exits 1. A missing ci.yml is a named SKIP when the root has no .git
//      (not a checkout, e.g. an npm tarball), a failure (exit 1) inside a git checkout.
//
// Usage: node test/core.mjs   (no arguments; it runs from its own package root)
// Exit 0 ok, 1 a file failed, a count drifted (a term < 2 included), the feature guard
// fired, the self-test went red or ci-legs found a problem, 2 test/count.mjs or
// test/core-tiers.json unparseable, an argument was given, LRB_CORE_SELFTEST set to
// anything but "child" (or to "child" outside a self-test temp root), or no Node major
// >= 18 could be read (a spawn error is a file FAIL, exit 1).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ciLegsAt, checkCiLegs } from './ci-legs.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), '..');
const COUNT_FILE = path.join(ROOT, 'test', 'count.mjs');
const TIERS_FILE = path.join(ROOT, 'test', 'core-tiers.json');
const V = process.version;
const GUARD = 'LRB_CORE_SELFTEST';
const MIN_TERM = 2;
const ST_PREFIX = 'lrb-core-selftest-';
const ST_CASES = 24;
const FEATURE_NAMES = ['ArrayBuffer.prototype.transfer', 'ArrayBuffer.prototype.resize',
  'SharedArrayBuffer.prototype.grow'];
const KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
const ZERO_KEYS = ['fail', 'cancelled', 'skipped', 'todo'];
const TAIL_LINES = 40;

function die(code, msg) {
  console.error('core: ' + msg);
  console.log('core: FAIL on ' + V);
  process.exit(code);
}

if (process.argv.length > 2) die(2, 'takes no arguments (got ' + process.argv.slice(2).join(' ') + ')');
const GUARD_VALUE = process.env[GUARD];
if (GUARD_VALUE !== undefined && GUARD_VALUE !== 'child') {
  die(2, GUARD + ' is "' + GUARD_VALUE + '": unset it (only the self-test fixture copies set it, to "child")');
}
if (GUARD_VALUE === 'child' && !path.basename(path.dirname(ROOT)).startsWith(ST_PREFIX)) {
  die(2, GUARD + '=child is honoured only inside a self-test temp root (' + ST_PREFIX + '*), not ' + ROOT);
}

// ---- self-test (always first; red -> exit 1 before any real file) ----------
const ST_MAJOR = Number((/^v(\d+)\./.exec(V) || [])[1]);
const ST_TIMEOUT = 120000;
const ST_TAIL = 15;
const ST_NO_RUN = /^core: (ok|FAIL) +test\//m;
const ST_HEAD = "import test from 'node:test';\nimport assert from 'node:assert';\n";
const ST_BODY = {
  ok: ST_HEAD + "test('a', () => { assert.equal(1, 1); });\ntest('b', () => { assert.equal(2, 2); });\n",
  skip: ST_HEAD + "test('a', () => { assert.equal(1, 1); });\ntest('b', { skip: true }, () => {});\n",
  todo: ST_HEAD + "test('a', () => { assert.equal(1, 1); });\ntest('b', { todo: true }, () => {});\n",
  fail: ST_HEAD + "test('a', () => { assert.equal(1, 1); });\ntest('b', () => { assert.equal(1, 2); });\n",
  empty: '',
  never: "throw new Error('core self-test: an excluded fixture file ran');\n",
};

function stRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

function stSpec() {
  return {
    files: [
      { rel: 'test/b1.test.js', term: 2, body: 'ok' },
      { rel: 'test/f1.test.js', term: 2, body: 'ok' },
      { rel: 'test/x1.test.js', term: 2, body: 'never' },
    ],
    tiers: {
      base: ['test/b1.test.js'], feature: ['test/f1.test.js'],
      excluded: { 'test/x1.test.js': 'self-test fixture: never runs' }, baseTotal: 2, featureTotal: 2,
    },
    header: null, git: true, ci: 'live', args: [], execArgv: [], guard: 'child', nest: false, pkg: true,
  };
}

function stCount(spec) {
  let total = 0;
  for (const f of spec.files) total += f.term;
  let header = '// (' + spec.files.map((f) => f.term).join(' + ') + ' = ' + total
    + ', one number per file, in FILES order)';
  if (spec.header) header = spec.header(header);
  return '// core self-test fixture: the test/count.mjs shape test/core.mjs parses (never executed)\n' + header + '\n' +
    'const FILES = [' + spec.files.map((f) => "'" + f.rel + "'").join(', ') + '];\nconst EXPECTED = ' + total + ';\n';
}

function stMut(text, from, to) {
  if (typeof text !== 'string'
    || text.split(from).length !== 2) throw new Error('mutation anchor not found exactly once: '
    + JSON.stringify(from));
  return text.replace(from, to);
}

function stBuild(base, name, spec, src) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  if (spec.pkg) fs.writeFileSync(path.join(root, 'package.json'), src.pkg);
  fs.writeFileSync(path.join(root, 'test', 'core.mjs'), src.self);
  fs.writeFileSync(path.join(root, 'test', 'ci-legs.mjs'), src.legs);
  fs.writeFileSync(path.join(root, 'test', 'core-tiers.json'), JSON.stringify(spec.tiers, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'test', 'count.mjs'), stCount(spec));
  for (const f of spec.files) fs.writeFileSync(path.join(root, f.rel), ST_BODY[f.body]);
  if (spec.git) fs.mkdirSync(path.join(root, '.git'));
  const ci = spec.ci === 'live' ? src.ci : spec.ci;
  if (ci !== null) {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), ci);
  }
  return root;
}

function stSpawn(root, spec) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const env = Object.assign({}, process.env);
    env[GUARD] = spec.guard;
    const cp = spawn(process.execPath, spec.execArgv.concat([path.join(root, 'test', 'core.mjs')], spec.args), {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fin = (code, signal, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, error, out });
    };
    const timer = setTimeout(() => cp.kill('SIGKILL'), ST_TIMEOUT);
    cp.stdout.setEncoding('utf8');
    cp.stderr.setEncoding('utf8');
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { out += d; });
    cp.on('error', (e) => fin(null, null, e));
    cp.on('close', (c, s) => fin(c, s, null));
  });
}

async function selfTest() {
  const src = {
    self: fs.readFileSync(SELF),
    legs: fs.readFileSync(path.join(ROOT, 'test', 'ci-legs.mjs')),
    pkg: fs.readFileSync(path.join(ROOT, 'package.json')),
    ci: stRead(path.join(ROOT, '.github', 'workflows', 'ci.yml')),
  };
  let verifyScript;
  try { verifyScript = JSON.parse(String(src.pkg)).scripts.verify; } catch (e) { verifyScript = undefined; }
  const noCi = src.ci === null ? 'no live .github/workflows/ci.yml' : '';
  const greenRe = ST_MAJOR >= 22 ? /^core: base 2\/2 \| feature 2\/2 \| total 4\/4 on \S+ ok$/m
    : /^core: base 2\/2 \| feature (2\/2|SKIP) \| total (4\/4|2\/2) on \S+ ok$/m;
  const cases = [
    { name: 'green control', code: 0, has: [greenRe, src.ci === null ? /^core ci-legs: SKIP/m
      : /^core ci-legs: 12 legs .* ok$/m],
      not: [/excluded fixture file ran/], spec: (s) => { if (src.ci === null) { s.git = false; s.ci = null; } } },
    { name: 'argument', code: 2, has: [/takes no arguments/], not: [ST_NO_RUN], spec: (s) => { s.args = ['--x']; } },
    { name: 'header sum line reformatted', code: 2, has: [/the header sum line found 0 times/], not: [ST_NO_RUN],
      spec: (s) => { s.header = (h) => h.replace(/ \+ /g, '+'); } },
    { name: 'core-tiers.json unknown key', code: 2, has: [/core-tiers\.json: unknown key "bases"/], not: [ST_NO_RUN],
      spec: (s) => { s.tiers.bases = []; } },
    { name: 'unclassified FILES entry', code: 1, has: [/FILES entry test\/u1\.test\.js is in no tier/],
      not: [ST_NO_RUN],
      spec: (s) => { s.files.push({ rel: 'test/u1.test.js', term: 2, body: 'ok' }); } },
    { name: 'injected test.skip', code: 1, has: [/FAIL test\/b1\.test\.js .*skipped 1 \(want 0\)/], not: [],
      spec: (s) => { s.files[0].body = 'skip'; } },
    { name: 'injected todo', code: 1, has: [/FAIL test\/b1\.test\.js .*todo 1 \(want 0\)/], not: [],
      spec: (s) => { s.files[0].body = 'todo'; } },
    { name: 'injected failing test', code: 1, has: [/FAIL test\/b1\.test\.js .*fail 1 \(want 0\)/], not: [],
      spec: (s) => { s.files[0].body = 'fail'; } },
    { name: 'term-1 empty file', code: 1, has: [/core term test\/b1\.test\.js = 1 \(< 2\)/], not: [ST_NO_RUN],
      spec: (s) => { s.files[0].body = 'empty'; s.files[0].term = 1; s.tiers.baseTotal = 1; } },
    { name: 'feature guard (transfer deleted)', code: 1, na: ST_MAJOR >= 22 ? '' : 'Node ' + V + ' < 22',
      has: [/feature guard: Node \S+ \(major >= 22\) lacks ArrayBuffer\.prototype\.transfer/], not: [ST_NO_RUN],
      spec: (s) => { s.execArgv = ['--import=data:text/javascript,delete%20ArrayBuffer.prototype.transfer']; } },
    { name: 'ci-legs wired: unquoted node value', code: 1, na: noCi, has: [/not a single-quoted version string/],
      not: [ST_NO_RUN],
      spec: (s) => { s.ci = stMut(src.ci, "node: ['18', ", 'node: [18, '); } },
    { name: 'ci-legs wired: no ci.yml in a checkout', code: 1, has: [/ci\.yml is missing inside a git checkout/],
      not: [ST_NO_RUN],
      spec: (s) => { s.ci = null; } },
    { name: 'guard: bad LRB_CORE_SELFTEST value', code: 2, has: [/LRB_CORE_SELFTEST is "yes": unset it/],
      not: [ST_NO_RUN],
      spec: (s) => { s.guard = 'yes'; s.pkg = false; } },
    { name: 'guard: child outside a self-test temp root', code: 2,
      has: [/is honoured only inside a self-test temp root/],
      not: [ST_NO_RUN, /core self-test: SKIP/], spec: (s) => { s.nest = true; } },
    { name: 'ci-legs wired: no ci.yml, no .git', code: 0, has: [/^core ci-legs: SKIP -- no \.github/m],
      not: [], spec: (s) => { s.ci = null; s.git = false; } },
  ];
  const inproc = [
    { name: 'ci-legs: live ci.yml', ok: true, mut: (t) => t },
    { name: 'ci-legs: quoted node value removed', re: /node value 18 is not a single-quoted/, mut: (t) => stMut(t,
      "node: ['18', ", 'node: [18, ') },
    { name: 'ci-legs: leg dropped from a SKIP if', re: /lane alloc is skipped SILENTLY .*node 24/,
      mut: (t) => stMut(t, " || matrix.node == '24'\n        run: |", '\n        run: |') },
    { name: 'ci-legs: verify widened to 26', re: /npm run verify must run on exactly the 26\.8\.2 legs/,
      mut: (t) => stMut(t, "if: matrix.node == '26.8.2'\n        run: npm run verify",
        "if: matrix.node == '26.8.2' || matrix.node == '26'\n        run: npm run verify") },
    { name: 'ci-legs: test:core gated by if', re: /test:core does not run on: .*node 18/,
      mut: (t) => stMut(t, '      - name: test:core\n', "      - name: test:core\n        if: matrix.node != '18'\n") },
    { name: 'ci-legs: unknown step key', re: /unknown key "continue-on-error"/,
      mut: (t) => stMut(t, '      - name: test:types\n',
        '      - name: test:types\n        continue-on-error: true\n') },
    { name: 'ci-legs: defaults shell neutered', re: /defaults\.run\.shell is not bash/,
      mut: (t) => stMut(t, '    shell: bash\n', '    shell: true {0}\n') },
    { name: 'ci-legs: on reduced to workflow_dispatch', re: /^on: unknown key "workflow_dispatch"/,
      mut: (t) => stMut(t, 'on:\n  push:\n  pull_request:\n', 'on:\n  workflow_dispatch:\n') },
    { name: 'ci-legs: defaults working-directory', re: /^defaults\.run: unknown key "working-directory"/,
      mut: (t) => stMut(t, '    shell: bash\n', '    shell: bash\n    working-directory: /tmp\n') },
  ];
  const lines = [];
  const na = [];
  let pass = 0;
  let total = 0;
  for (const c of inproc) {
    if (src.ci === null) { na.push(c.name + ' (' + noCi + ')'); continue; }
    total++;
    let why = '';
    try {
      const r = checkCiLegs(c.mut(src.ci), verifyScript);
      if (c.ok && !r.ok) why = 'want pass, got: ' + r.problems.join(' | ');
      if (!c.ok && r.ok) why = 'want a finding, got pass';
      if (!c.ok && !r.ok && !r.problems.some((p) => c.re.test(p))) why = 'want a finding matching ' + c.re + ', got: '
        + r.problems.join(' | ');
    } catch (e) {
      why = e.message;
    }
    if (why) lines.push('core self-test: FAIL [' + c.name + '] ' + why); else pass++;
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), ST_PREFIX));
  const jobs = [];
  for (let k = 0; k < cases.length; k++) {
    const c = cases[k];
    if (c.na) { na.push(c.name + ' (' + c.na + ')'); continue; }
    total++;
    jobs.push((async () => {
      let why = '';
      let out = '';
      try {
        const spec = stSpec();
        c.spec(spec);
        const root = stBuild(base, spec.nest ? path.join('case' + k, 'pkg') : 'case' + k, spec, src);
        const r = await stSpawn(root, spec);
        out = r.out;
        if (r.error) why = 'spawn error: ' + r.error.message;
        else if (r.signal) why = 'killed by ' + r.signal;
        else if (r.code !== c.code) why = 'exit ' + r.code + ' (want ' + c.code + ')';
        for (const re of c.has) if (!why && !re.test(out)) why = 'output lacks ' + re;
        for (const re of c.not) if (!why && re.test(out)) why = 'output has ' + re;
      } catch (e) {
        why = e.message;
      }
      if (why) {
        const tl = out.split('\n');
        lines.push('core self-test: FAIL [' + c.name + '] ' + why + (out ? '\n' + tl.slice(Math.max(0,
          tl.length - ST_TAIL)).join('\n') : ''));
        return false;
      }
      return true;
    })());
  }
  for (const ok of await Promise.all(jobs)) if (ok) pass++;
  if (total + na.length !== ST_CASES) lines.push('core self-test: FAIL [case count] ' + (total + na.length)
    + ' cases incl. n/a (want ST_CASES ' + ST_CASES + ')');
  const ok = pass === total && lines.length === 0;
  if (ok) fs.rmSync(base, { recursive: true, force: true });
  else lines.push('core self-test: fixtures kept in ' + base);
  return { ok, pass, total, lines, na };
}

if (GUARD_VALUE === 'child') {
  console.log('core self-test: SKIP (' + GUARD + '=child: this is a self-test fixture copy)');
} else {
  const st = await selfTest();
  const naText = st.na.length ? ' (n/a: ' + st.na.join('; ') + ')' : '';
  if (!st.ok) {
    for (const l of st.lines) console.error(l);
    console.log('core self-test: ' + st.pass + '/' + st.total + ' ok' + naText + ' -- RED');
    die(1, 'self-test red: no real test file ran');
  }
  console.log('core self-test: ' + st.pass + '/' + st.total + ' ok' + naText);
}

// ---- ci-legs (after the self-test, before the real lane; exit 1) ------------
const CI_LEGS = ciLegsAt(ROOT);
if (!CI_LEGS.ok) {
  for (const p of CI_LEGS.problems) console.error('core ci-legs: ' + p);
  console.log('core ci-legs: ' + CI_LEGS.line);
  die(1, 'ci-legs: .github/workflows/ci.yml check failed');
}
console.log('core ci-legs: ' + CI_LEGS.line);

// ---- tiers: test/core-tiers.json (unparseable -> exit 2) --------------------
const TIER_KEYS = ['base', 'feature', 'excluded', 'baseTotal', 'featureTotal'];
const TIER_FILE_RE = /^test\/[A-Za-z0-9._-]+\.test\.js$/;
let tiers;
try { tiers = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8')); } catch (e) { die(2,
  'cannot read / parse test/core-tiers.json: ' + e.message); }
if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) die(2,
  'test/core-tiers.json: want a plain JSON object');
for (const k of Object.keys(tiers)) if (!TIER_KEYS.includes(k)) die(2, 'test/core-tiers.json: unknown key "' + k
  + '" (want ' + TIER_KEYS.join(', ') + ')');
for (const k of TIER_KEYS) if (!Object.prototype.hasOwnProperty.call(tiers, k)) die(2,
  'test/core-tiers.json: missing key "' + k + '"');
function tierList(k) {
  const a = tiers[k];
  if (!Array.isArray(a)) die(2, 'test/core-tiers.json: ' + k + ' is not an array');
  for (const f of a) if (typeof f !== 'string' || !TIER_FILE_RE.test(f)) die(2, 'test/core-tiers.json: ' + k
    + ' entry not a plain test/*.test.js string: ' + JSON.stringify(f));
  return a;
}
const BASE = tierList('base');
const FEATURE = tierList('feature');
const EXCLUDED = tiers.excluded;
if (!EXCLUDED || typeof EXCLUDED !== 'object' || Array.isArray(EXCLUDED)) die(2,
  'test/core-tiers.json: excluded is not an object');
for (const f of Object.keys(EXCLUDED)) {
  if (!TIER_FILE_RE.test(f)) die(2, 'test/core-tiers.json: excluded key not a plain test/*.test.js string: '
    + JSON.stringify(f));
  if (typeof EXCLUDED[f] !== 'string' || EXCLUDED[f] === '') die(2, 'test/core-tiers.json: excluded ' + f
    + ' needs a non-empty reason string');
}
for (const k of ['baseTotal', 'featureTotal']) {
  if (!Number.isInteger(tiers[k]) || tiers[k] < 0) die(2, 'test/core-tiers.json: ' + k
    + ' is not a non-negative integer: ' + JSON.stringify(tiers[k]));
}
const BASE_TOTAL = tiers.baseTotal;
const FEATURE_TOTAL = tiers.featureTotal;

// ---- parse test/count.mjs (unparseable -> exit 2) --------------------------
let src;
try { src = fs.readFileSync(COUNT_FILE, 'utf8'); } catch (e) { die(2, 'cannot read test/count.mjs: ' + e.message); }

function only(re, what) {
  const all = src.match(new RegExp(re.source, 'gm'));
  if (!all || all.length !== 1) die(2, 'test/count.mjs: ' + what + ' found ' + (all ? all.length : 0)
    + ' times (want 1)');
  return re.exec(src);
}
const mFiles = only(/^const FILES = \[([^\]\n]*)\];$/m, 'the FILES line');
const mExpected = only(/^const EXPECTED = (\d+);$/m, 'the EXPECTED line');
const mHeader = only(/^\/\/ \((\d+(?: \+ \d+)*) = (\d+), /m, 'the header sum line');

const fileItems = mFiles[1].split(', ');
const FILES = [];
for (const it of fileItems) {
  const m = /^'(test\/[A-Za-z0-9._-]+\.test\.js)'$/.exec(it);
  if (!m) die(2, 'test/count.mjs: FILES entry not a plain test/*.test.js string: ' + it);
  FILES.push(m[1]);
}
const EXPECTED = Number(mExpected[1]);
const TERMS = mHeader[1].split(' + ').map(Number);
const HEADER_TOTAL = Number(mHeader[2]);
function want0(f) {
  const k = FILES.indexOf(f);
  return k >= 0 && k < TERMS.length ? TERMS[k] : undefined;
}

// ---- drift checks (exit 1) -------------------------------------------------
const drift = [];
for (const f of BASE.concat(FEATURE)) {
  if (want0(f) !== undefined && !(want0(f) >= MIN_TERM)) {
    drift.push('core term ' + f + ' = ' + want0(f) + ' (< ' + MIN_TERM
      + '): an emptied test file reads "tests 1 pass 1", so a term below ' + MIN_TERM
      + ' cannot tell a real file from an empty one');
  }
}
const seen = new Set();
for (const f of FILES) {
  if (seen.has(f)) drift.push('FILES lists ' + f + ' twice');
  seen.add(f);
}
const tierOf = new Map();
for (const f of BASE) tierOf.set(f, 'base');
for (const f of FEATURE) {
  if (tierOf.has(f)) drift.push(f + ' is in two tiers');
  tierOf.set(f, 'feature');
}
for (const f of Object.keys(EXCLUDED)) {
  if (tierOf.has(f)) drift.push(f + ' is in two tiers');
  tierOf.set(f, 'excluded');
}
for (const f of FILES) if (!tierOf.has(f)) drift.push('FILES entry ' + f
  + ' is in no tier (base, feature or excluded): classify it in test/core-tiers.json');
for (const f of tierOf.keys()) if (!seen.has(f)) drift.push('tier entry ' + f + ' is not in test/count.mjs FILES');
if (TERMS.length !== FILES.length) drift.push('header has ' + TERMS.length + ' terms, FILES has ' + FILES.length
  + ' entries');
let termSum = 0;
for (const t of TERMS) termSum += t;
if (termSum !== HEADER_TOTAL) drift.push('header terms sum to ' + termSum + ' but the header says ' + HEADER_TOTAL);
if (HEADER_TOTAL !== EXPECTED) drift.push('header total ' + HEADER_TOTAL + ' !== EXPECTED ' + EXPECTED);
const want = new Map();
for (let i = 0; i < FILES.length && i < TERMS.length; i++) want.set(FILES[i], TERMS[i]);
function tierSum(list) {
  let s = 0;
  for (const f of list) s += want.has(f) ? want.get(f) : NaN;
  return s;
}
const baseSum = tierSum(BASE);
const featureSum = tierSum(FEATURE);
if (baseSum !== BASE_TOTAL) drift.push('base tier sums to ' + baseSum + ' (want BASE_TOTAL ' + BASE_TOTAL + ')');
if (featureSum !== FEATURE_TOTAL) drift.push('feature tier sums to ' + featureSum + ' (want FEATURE_TOTAL '
  + FEATURE_TOTAL + ')');
if (drift.length) {
  for (const d of drift) console.error('core: drift: ' + d);
  die(1, 'test/count.mjs and test/core-tiers.json disagree (' + drift.length + ' finding(s))');
}

// ---- feature detection + fail-closed guard ---------------------------------
const AB = typeof ArrayBuffer === 'function' ? ArrayBuffer.prototype : undefined;
const SAB = typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer.prototype : undefined;
const present = [
  !!AB && typeof AB.transfer === 'function',
  !!AB && typeof AB.resize === 'function',
  !!SAB && typeof SAB.grow === 'function',
];
const missing = [];
for (let i = 0; i < FEATURE_NAMES.length; i++) if (!present[i]) missing.push(FEATURE_NAMES[i]);
const major = Number(/^v(\d+)\./.exec(V) ? /^v(\d+)\./.exec(V)[1] : NaN);
if (!(major >= 18)) die(2, 'cannot read a Node major >= 18 from ' + V);
if (major >= 22 && missing.length) die(1, 'feature guard: Node ' + V + ' (major >= 22) lacks ' + missing.join(', ')
  + ' -- the feature tier must run here');
const runFeature = missing.length === 0;

// ---- run -------------------------------------------------------------------
function tail(text) {
  const lines = String(text || '').split('\n');
  return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join('\n');
}

function runFile(rel) {
  const n = want.get(rel);
  const abs = path.join(ROOT, rel);
  const why = [];
  try {
    if (!fs.statSync(abs).isFile()) why.push('not a file');
  } catch (e) {
    why.push('missing: ' + e.code);
  }
  let r = null;
  if (!why.length) {
    r = spawnSync(process.execPath, ['--expose-gc', '--test', '--test-reporter=tap', abs], {
      cwd: ROOT, encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) why.push('spawn error: ' + r.error.message);
    if (r.signal) why.push('killed by ' + r.signal);
    if (r.status !== 0) why.push('exit status ' + r.status);
    const got = {};
    for (const k of KEYS) {
      const all = String(r.stdout || '').match(new RegExp('^# ' + k + ' (\\S+)$', 'gm'));
      if (!all) { why.push('TAP key "# ' + k + '" missing'); continue; }
      if (all.length !== 1) { why.push('TAP key "# ' + k + '" appears ' + all.length + ' times'); continue; }
      const v = all[0].slice(k.length + 3);
      if (k !== 'duration_ms' && !/^\d+$/.test(v)) { why.push('TAP key "# ' + k + '" not an integer: ' + v); continue; }
      got[k] = Number(v);
    }
    if ('tests' in got && 'pass' in got) {
      if (got.tests === 0) why.push('tests 0 (the file defined no tests)');
      if (got.tests !== n || got.pass !== n) why.push('tests ' + got.tests + ' pass ' + got.pass + ' (want ' + n
        + ' / ' + n + ' from test/count.mjs)');
    }
    for (const k of ZERO_KEYS) if (k in got && got[k] !== 0) why.push(k + ' ' + got[k] + ' (want 0)');
    if (why.length === 0) {
      console.log('core: ok   ' + rel + ' ' + got.pass + '/' + n);
      return n;
    }
  }
  console.log('core: FAIL ' + rel + ' (want ' + n + '): ' + why.join('; '));
  if (r) {
    console.log('---- TAP tail (' + rel + ', last ' + TAIL_LINES + ' lines) ----');
    console.log(tail(r.stdout));
    if (r.stderr) {
      console.log('---- stderr tail (' + rel + ') ----');
      console.log(tail(r.stderr));
    }
    console.log('---- end ' + rel + ' ----');
  }
  return -1;
}

let failed = 0;
let basePass = 0;
for (const f of BASE) {
  const p = runFile(f);
  if (p < 0) failed++; else basePass += p;
}
let featurePass = 0;
if (runFeature) {
  for (const f of FEATURE) {
    const p = runFile(f);
    if (p < 0) failed++; else featurePass += p;
  }
} else {
  console.log('core: SKIP feature tier (' + FEATURE.join(', ') + ': ' + FEATURE_TOTAL + ' tests) on ' + V
    + ' -- missing: ' + missing.join(', '));
}
for (const f of Object.keys(EXCLUDED)) console.log('core: excluded ' + f + ' (' + want.get(f) + ') -- ' + EXCLUDED[f]);

const ok = failed === 0;
const totalWant = BASE_TOTAL + (runFeature ? FEATURE_TOTAL : 0);
console.log('core: base ' + basePass + '/' + BASE_TOTAL +
  ' | feature ' + (runFeature ? featurePass + '/' + FEATURE_TOTAL : 'SKIP') +
  ' | total ' + (basePass + featurePass) + '/' + totalWant + ' on ' + V + ' ' + (ok ? 'ok' : 'FAIL'));
process.exitCode = ok ? 0 : 1;
