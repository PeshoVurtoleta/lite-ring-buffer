// Core lane for `npm run test:core`: the portable subset of `npm test` that runs on
// every Node in the CI matrix (18 / 20 / 22 / 24 / 26), count-gated and fail-closed.
// Runs on Node 18: no import.meta.dirname, no node:test import (each file runs in its
// own `node --expose-gc --test --test-reporter=tap <file>` child, the TAP summary is
// parsed here).
//
// Source of truth for the per-file counts is test/count.mjs: this file parses its
// FILES, EXPECTED and the header sum line ("// (60 + 35 + ... = 294, ..."), one term
// per FILES entry in FILES order. This file owns only the tier split below and the
// two tier totals; a drift between the two files is a failure, never a re-count.
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
// Usage: node test/core.mjs   (no arguments; it runs from its own package root)
// Exit 0 ok, 1 a file failed, a count drifted or the feature guard fired,
// 2 test/count.mjs unparseable, an argument was given, or no Node major >= 18 could be read (a spawn error is a file FAIL, exit 1).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUNT_FILE = path.join(ROOT, 'test', 'count.mjs');
const V = process.version;

const BASE = [
  'test/RingBuffer.test.js', 'test/copyto.test.js', 'test/copyto-r1b.test.js', 'test/audit-fix.test.js',
  'test/mutant-kills.test.js', 'test/pushbatch.test.js', 'test/qa-r2.test.js', 'test/copylast.test.js',
  'test/copylast-parity.test.js', 'test/copylast-hooks.test.js',
];
const FEATURE = ['test/qa-r1.test.js', 'test/qa-r3.test.js', 'test/qa-m1.test.js'];
const EXCLUDED = {
  'test/InliningTool.test.js': 'needs bash, git and the exact-pinned @zakkster/lite-utils 1.0.0 (Node >= 22)',
  'test/DeoptTool.test.js': 'needs bash, git and the exact-pinned @zakkster/lite-utils 1.0.0 (Node >= 22)',
  'test/chainsize.test.js': 'fails closed off Node v26.8.2 / V8 14.6.202.34-node.28 (Q-M1-GATE A)',
};
const BASE_TOTAL = 206;
const FEATURE_TOTAL = 41;
const FEATURE_NAMES = ['ArrayBuffer.prototype.transfer', 'ArrayBuffer.prototype.resize', 'SharedArrayBuffer.prototype.grow'];
const KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
const ZERO_KEYS = ['fail', 'cancelled', 'skipped', 'todo'];
const TAIL_LINES = 40;

function die(code, msg) {
  console.error('core: ' + msg);
  console.log('core: FAIL on ' + V);
  process.exit(code);
}

if (process.argv.length > 2) die(2, 'takes no arguments (got ' + process.argv.slice(2).join(' ') + ')');

// ---- parse test/count.mjs (unparseable -> exit 2) --------------------------
let src;
try { src = fs.readFileSync(COUNT_FILE, 'utf8'); } catch (e) { die(2, 'cannot read test/count.mjs: ' + e.message); }

function only(re, what) {
  const all = src.match(new RegExp(re.source, 'gm'));
  if (!all || all.length !== 1) die(2, 'test/count.mjs: ' + what + ' found ' + (all ? all.length : 0) + ' times (want 1)');
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

// ---- drift checks (exit 1) -------------------------------------------------
const drift = [];
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
for (const f of FILES) if (!tierOf.has(f)) drift.push('FILES entry ' + f + ' is in no tier (base, feature or excluded): classify it in test/core.mjs');
for (const f of tierOf.keys()) if (!seen.has(f)) drift.push('tier entry ' + f + ' is not in test/count.mjs FILES');
if (TERMS.length !== FILES.length) drift.push('header has ' + TERMS.length + ' terms, FILES has ' + FILES.length + ' entries');
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
if (featureSum !== FEATURE_TOTAL) drift.push('feature tier sums to ' + featureSum + ' (want FEATURE_TOTAL ' + FEATURE_TOTAL + ')');
if (drift.length) {
  for (const d of drift) console.error('core: drift: ' + d);
  die(1, 'test/count.mjs and test/core.mjs disagree (' + drift.length + ' finding(s))');
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
if (major >= 22 && missing.length) die(1, 'feature guard: Node ' + V + ' (major >= 22) lacks ' + missing.join(', ') + ' -- the feature tier must run here');
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
      if (got.tests !== n || got.pass !== n) why.push('tests ' + got.tests + ' pass ' + got.pass + ' (want ' + n + ' / ' + n + ' from test/count.mjs)');
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
  console.log('core: SKIP feature tier (' + FEATURE.join(', ') + ': ' + FEATURE_TOTAL + ' tests) on ' + V + ' -- missing: ' + missing.join(', '));
}
for (const f of Object.keys(EXCLUDED)) console.log('core: excluded ' + f + ' (' + want.get(f) + ') -- ' + EXCLUDED[f]);

const ok = failed === 0;
const totalWant = BASE_TOTAL + (runFeature ? FEATURE_TOTAL : 0);
console.log('core: base ' + basePass + '/' + BASE_TOTAL +
  ' | feature ' + (runFeature ? featurePass + '/' + FEATURE_TOTAL : 'SKIP') +
  ' | total ' + (basePass + featurePass) + '/' + totalWant + ' on ' + V + ' ' + (ok ? 'ok' : 'FAIL'));
process.exitCode = ok ? 0 : 1;
