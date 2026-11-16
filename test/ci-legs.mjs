// CI leg check for .github/workflows/ci.yml (Q1 QA F2). Dependency-free, Node 18 safe, no YAML library:
// a strict line parser for THIS workflow's shape (block mappings, block sequences of mappings, flow lists,
// `|` block scalars, full-line comments). A tab, a CR, a trailing comment, an anchor, an unknown key, an
// unknown action, an unknown one-line run command or an unknown if: grammar is a finding (fail closed), never
// a skip. NOT fully parsed: the body of a SKIP step (each line must start with echo " and the first with
// echo "SKIP ", and no $(...npm...); `echo "SKIP x"; npm run torture` passes) and `|` block run steps (only a
// deny-list: a line with npm other than `npm --version`, or with test/, .mjs or --test, is a finding; other
// commands, e.g. `nvm use 18`, pass).
//
// Asserts:
//   - defaults is exactly run.shell: bash, and on is exactly bare push: + pull_request: triggers (no
//     filters, no other trigger, no other defaults key such as working-directory);
//   - every matrix node value (the node list and each include entry) is a single-quoted string ('18', not
//     18), so 20 / 26.8.2 never become numbers;
//   - the expanded legs (os x node, plus each include entry as a NEW combination) are exactly LEGS (12);
//   - runs-on is ${{ matrix.os }} and setup-node takes node-version ${{ matrix.node }}, before any lane;
//   - test:core and test:types run on every leg; npm run verify runs on exactly the 26.8.2 legs;
//   - for each lane (verify = npm test + the rest of package.json scripts.verify, alloc, torture; alloc and
//     torture also run inside verify) the legs that do not run it are exactly the legs of its ONE named
//     SKIP step ("<lane> SKIPPED (...)"; lines start with echo ", the first echo "SKIP ", no $(...npm...)): no leg skips a lane silently, no SKIP fires on a leg
//     that runs the lane.
// Each `if:` is evaluated per leg by a tiny evaluator that accepts only `matrix.node == '<v>'` /
// `matrix.node != '<v>'` terms joined by ` || `, <v> one of the declared node values; any other
// expression is a finding.
//
// ciLegsAt(root): a missing ci.yml is a named SKIP (ok) when root has no .git (not a checkout, e.g. an
// npm tarball, which ships no .github), and a failure inside a git checkout (root/.git exists).
// Used by test/core.mjs (`core ci-legs: ...`) and runnable alone:
//   node test/ci-legs.mjs [rootDir]   (default: the package root)
// Exit 0 ok or SKIP, 1 a finding, 2 bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED = '26.8.2';
export const LEGS = [
  'ubuntu-latest node 18', 'ubuntu-latest node 20', 'ubuntu-latest node 22', 'ubuntu-latest node 24',
  'ubuntu-latest node 26', 'ubuntu-latest node 26.8.2',
  'macos-latest node 18', 'macos-latest node 20', 'macos-latest node 22', 'macos-latest node 24',
  'macos-latest node 26', 'macos-latest node 26.8.2',
];
const TOP_KEYS = ['name', 'on', 'permissions', 'concurrency', 'defaults', 'jobs'];
const JOB_KEYS = ['name', 'runs-on', 'timeout-minutes', 'strategy', 'steps'];
const STEP_KEYS = ['name', 'if', 'uses', 'with', 'run'];
const LANE_RUN = {
  'npm run test:core': 'core', 'npm run test:types': 'types', 'npm run verify': 'verify',
  'npm run alloc': 'alloc', 'npm run torture': 'torture',
};
const PLAIN_RUN = ['npm install --no-audit --no-fund', 'npm ls --depth=0 || true'];
const SKIP_LANE = { 'npm test + npm run verify': 'verify', 'alloc': 'alloc', 'torture': 'torture' };
const VERIFY_PART = { 'npm test': 'test', 'npm run alloc': 'alloc', 'npm run torture': 'torture', 'npm run ascii': 'ascii' };

// ---- the line parser ---------------------------------------------------------------------------------
// Node: { kind: 'map', n, m: Map<key, node> } | { kind: 'seq', n, items } | { kind: 'scalar', n, v } |
// { kind: 'block', n, v }. n = 1-based line number.
function parse(text) {
  if (text.indexOf('\t') !== -1) throw new Error('a tab character (not this file\'s shape)');
  if (text.indexOf('\r') !== -1) throw new Error('a CR character (not this file\'s shape)');
  const raw = text.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  let i = 0;
  const fail = (m) => { throw new Error('line ' + (i + 1) + ': ' + m); };
  const blankOrComment = (s) => /^ *$/.test(s) || /^ *#/.test(s);
  const indentOf = (s) => s.length - s.replace(/^ +/, '').length;
  function skip() { while (i < raw.length && blankOrComment(raw[i])) i++; }
  function value(keyInd) {
    skip();
    if (i >= raw.length || !(indentOf(raw[i]) > keyInd)) return { kind: 'null', n: i };
    const d = indentOf(raw[i]);
    return raw[i].slice(d).startsWith('- ') ? seq(d) : map(d);
  }
  function map(ind) {
    const node = { kind: 'map', n: i + 1, m: new Map() };
    for (;;) {
      skip();
      if (i >= raw.length) break;
      const d = indentOf(raw[i]);
      if (d < ind) break;
      if (d > ind) fail('unexpected indent ' + d + ' (want ' + ind + ')');
      const body = raw[i].slice(d);
      const k = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/.exec(body);
      if (!k) fail('not a "key: value" line: ' + body);
      if (node.m.has(k[1])) fail('duplicate key ' + k[1]);
      const n = i + 1;
      const v = k[2];
      i++;
      if (v === undefined || v === '') node.m.set(k[1], value(ind));
      else if (v === '|') {
        const lines = [];
        while (i < raw.length && (/^ *$/.test(raw[i]) || indentOf(raw[i]) > ind)) lines.push(raw[i++]);
        while (lines.length && /^ *$/.test(lines[lines.length - 1])) lines.pop();
        if (!lines.length) fail('empty block scalar');
        let cut = Infinity;
        for (const l of lines) if (!/^ *$/.test(l)) cut = Math.min(cut, indentOf(l));
        node.m.set(k[1], { kind: 'block', n, v: lines.map((l) => l.slice(cut)).join('\n') });
      } else {
        if (/^[&*!>|]/.test(v) || / #/.test(v)) fail('anchor / alias / tag / folded scalar / trailing comment: ' + v);
        node.m.set(k[1], { kind: 'scalar', n, v });
      }
    }
    return node;
  }
  function seq(ind) {
    const node = { kind: 'seq', n: i + 1, items: [] };
    for (;;) {
      skip();
      if (i >= raw.length) break;
      const d = indentOf(raw[i]);
      if (d < ind) break;
      if (d > ind) fail('unexpected indent ' + d + ' (want ' + ind + ')');
      const body = raw[i].slice(d);
      if (!body.startsWith('- ')) fail('a sequence item must be "- key: value": ' + body);
      raw[i] = ' '.repeat(ind + 2) + body.slice(2);
      node.items.push(map(ind + 2));
    }
    return node;
  }
  skip();
  const top = map(0);
  skip();
  if (i < raw.length) fail('unparsed trailing content');
  return top;
}

// ---- the if: evaluator -------------------------------------------------------------------------------
function evalIf(expr, legs, nodes) {
  const terms = expr.split(' || ');
  const parsed = [];
  for (const t of terms) {
    const m = /^matrix\.node (==|!=) '([^']*)'$/.exec(t);
    if (!m) throw new Error('unsupported if: expression term "' + t + '" (only matrix.node == / != \'<v>\' joined by ||)');
    if (!nodes.includes(m[2])) throw new Error('if: compares matrix.node to \'' + m[2] + '\', which no leg has');
    parsed.push(m);
  }
  const out = new Set();
  for (const leg of legs) {
    for (const m of parsed) {
      if ((m[1] === '==') === (leg.node === m[2])) { out.add(leg.key); break; }
    }
  }
  return out;
}

function listOf(sc, what) {
  if (!sc || sc.kind !== 'scalar') throw new Error(what + ': want a flow list [..] on one line');
  const m = /^\[(.*)\]$/.exec(sc.v);
  if (!m || m[1] === '') throw new Error(what + ': want a non-empty flow list [..], got ' + sc.v);
  return m[1].split(', ');
}

function nodeValue(raw, where, problems) {
  const m = /^'([0-9]+(?:\.[0-9]+){0,2})'$/.exec(raw);
  if (m) return m[1];
  problems.push(where + ': node value ' + raw + ' is not a single-quoted version string (write \'' + raw.replace(/['"]/g, '') + '\')');
  return raw.replace(/['"]/g, '');
}

function keysOnly(map, allowed, what) {
  for (const k of map.m.keys()) if (!allowed.includes(k)) throw new Error(what + ': unknown key "' + k + '" (line ' + map.m.get(k).n + ')');
}

function want(map, key, kind, what) {
  const v = map.m.get(key);
  if (!v || v.kind !== kind) throw new Error(what + ': "' + key + '" missing or not a ' + kind);
  return v;
}

const setStr = (s) => (s.size ? Array.from(s).sort().join(', ') : 'none');

// checkCiLegs(ciText, verifyScript) -> { ok, problems: string[], summary }
export function checkCiLegs(text, verifyScript) {
  const problems = [];
  try {
    const top = parse(String(text));
    keysOnly(top, TOP_KEYS, 'top level');
    const dflt = want(top, 'defaults', 'map', 'top level');
    keysOnly(dflt, ['run'], 'defaults');
    const drun = want(dflt, 'run', 'map', 'defaults');
    keysOnly(drun, ['shell'], 'defaults.run');
    if (want(drun, 'shell', 'scalar', 'defaults.run').v !== 'bash') problems.push('defaults.run.shell is not bash');
    const trig = want(top, 'on', 'map', 'top level');
    keysOnly(trig, ['push', 'pull_request'], 'on');
    for (const k of ['push', 'pull_request']) {
      if (!trig.m.has(k) || trig.m.get(k).kind !== 'null') problems.push('on.' + k + ' missing or filtered (want a bare trigger)');
    }
    const jobs = want(top, 'jobs', 'map', 'top level');
    if (jobs.m.size !== 1 || !jobs.m.has('test')) throw new Error('jobs: want exactly one job "test", got ' + Array.from(jobs.m.keys()).join(', '));
    const job = want(jobs, 'test', 'map', 'jobs');
    keysOnly(job, JOB_KEYS, 'jobs.test');
    const runsOn = want(job, 'runs-on', 'scalar', 'jobs.test');
    if (runsOn.v !== '${{ matrix.os }}') problems.push('jobs.test.runs-on is ' + runsOn.v + ' (want ${{ matrix.os }})');
    const strategy = want(job, 'strategy', 'map', 'jobs.test');
    keysOnly(strategy, ['fail-fast', 'matrix'], 'strategy');
    const matrix = want(strategy, 'matrix', 'map', 'strategy');
    keysOnly(matrix, ['os', 'node', 'include'], 'strategy.matrix');
    const oses = listOf(matrix.m.get('os'), 'matrix.os');
    for (const o of oses) if (!/^[a-z0-9.-]+$/.test(o)) throw new Error('matrix.os: unrecognised value ' + o);
    const nodes = listOf(matrix.m.get('node'), 'matrix.node').map((r) => nodeValue(r, 'matrix.node (line ' + matrix.m.get('node').n + ')', problems));
    const legs = [];
    const keys = new Set();
    const addLeg = (os, node, where) => {
      const key = os + ' node ' + node;
      if (keys.has(key)) problems.push(where + ': leg ' + key + ' listed twice');
      keys.add(key);
      legs.push({ os, node, key });
    };
    for (const o of oses) for (const nv of nodes) addLeg(o, nv, 'matrix');
    const allNodes = nodes.slice();
    if (matrix.m.has('include')) {
      const inc = want(matrix, 'include', 'seq', 'strategy.matrix');
      for (const it of inc.items) {
        keysOnly(it, ['os', 'node'], 'include entry (line ' + it.n + ')');
        const o = want(it, 'os', 'scalar', 'include entry (line ' + it.n + ')').v;
        const nv = nodeValue(want(it, 'node', 'scalar', 'include entry (line ' + it.n + ')').v, 'include (line ' + it.n + ')', problems);
        if (!oses.includes(o)) problems.push('include (line ' + it.n + '): os ' + o + ' is not in matrix.os');
        if (nodes.includes(nv)) problems.push('include (line ' + it.n + '): node \'' + nv + '\' is in matrix.node, so GitHub merges it into an existing leg instead of adding one');
        else if (!allNodes.includes(nv)) allNodes.push(nv);
        addLeg(o, nv, 'include (line ' + it.n + ')');
      }
    }
    const ALL = new Set(legs.map((l) => l.key));
    const missingLegs = LEGS.filter((k) => !ALL.has(k));
    const extraLegs = Array.from(ALL).filter((k) => !LEGS.includes(k));
    if (missingLegs.length || extraLegs.length || legs.length !== LEGS.length) {
      problems.push('legs: ' + legs.length + ' expanded (want ' + LEGS.length + '); missing: ' + (missingLegs.join(', ') || 'none') + '; extra: ' + (extraLegs.join(', ') || 'none'));
    }

    const steps = want(job, 'steps', 'seq', 'jobs.test');
    const runs = { core: [], types: [], verify: [], alloc: [], torture: [] };
    const skips = { verify: [], alloc: [], torture: [] };
    let setupSeen = false;
    for (const st of steps.items) {
      const where = 'step (line ' + st.n + ')';
      keysOnly(st, STEP_KEYS, where);
      const name = want(st, 'name', 'scalar', where).v;
      const w = where.replace('step', 'step "' + name + '"');
      if (st.m.has('uses') === st.m.has('run')) throw new Error(w + ': want exactly one of uses / run');
      let on = ALL;
      if (st.m.has('if')) on = evalIf(want(st, 'if', 'scalar', w).v, legs, allNodes);
      if (st.m.has('uses')) {
        const u = st.m.get('uses');
        const m = u.kind === 'scalar' ? /^actions\/(checkout|setup-node)@v[0-9]+$/.exec(u.v) : null;
        if (!m) throw new Error(w + ': unrecognised action ' + (u.v || u.kind));
        const wi = st.m.has('with') ? want(st, 'with', 'map', w) : null;
        if (wi) for (const v of wi.m.values()) if (v.kind !== 'scalar') throw new Error(w + ': with: values must be scalars');
        if (m[1] === 'checkout') {
          if (wi) keysOnly(wi, ['fetch-depth', 'persist-credentials'], w + ' with');
        } else {
          if (!wi) throw new Error(w + ': setup-node without with: node-version');
          keysOnly(wi, ['node-version'], w + ' with');
          if (!wi.m.has('node-version') || wi.m.get('node-version').v !== '${{ matrix.node }}') problems.push(w + ': node-version is not ${{ matrix.node }}');
          if (on.size !== ALL.size) problems.push(w + ': setup-node must run on every leg');
          setupSeen = true;
        }
        continue;
      }
      if (st.m.has('with')) throw new Error(w + ': with: on a run step');
      const run = st.m.get('run');
      const sk = /^(.+) SKIPPED \((.+)\)$/.exec(name);
      if (sk) {
        const lane = SKIP_LANE[sk[1]];
        if (!lane) throw new Error(w + ': SKIP step for an unknown lane "' + sk[1] + '"');
        const lines = run.v.split('\n').filter((l) => !/^ *$/.test(l));
        if (!/^echo "SKIP /.test(lines[0] || '')) problems.push(w + ': a SKIP step must start with echo "SKIP ...');
        for (const l of lines) {
          if (!/^echo "/.test(l) || /\$\([^)]*\bnpm\b/.test(l)) problems.push(w + ': a SKIP step may only echo (got ' + l + ')');
        }
        skips[lane].push({ w, on });
        continue;
      }
      if (run.kind === 'scalar' && Object.prototype.hasOwnProperty.call(LANE_RUN, run.v)) {
        if (!setupSeen) problems.push(w + ': runs before setup-node');
        runs[LANE_RUN[run.v]].push({ w, on });
        continue;
      }
      if (run.kind === 'scalar' && PLAIN_RUN.includes(run.v)) continue;
      if (run.kind === 'block') {
        for (const l of run.v.split('\n')) {
          if ((/\bnpm\b/.test(l) && l.trim() !== 'npm --version') || /test\/|\.mjs\b|--test\b/.test(l)) {
            problems.push(w + ': unrecognised command in a run block: ' + l.trim());
          }
        }
        continue;
      }
      problems.push(w + ': unrecognised run command: ' + run.v);
    }
    if (!setupSeen) problems.push('no actions/setup-node step');

    const legsOf = (lane) => {
      const s = new Set();
      if (runs[lane].length !== 1) problems.push('lane ' + lane + ': ' + runs[lane].length + ' run steps (want exactly 1)');
      for (const r of runs[lane]) for (const k of r.on) s.add(k);
      return s;
    };
    const core = legsOf('core');
    const types = legsOf('types');
    const verify = legsOf('verify');
    for (const [lane, s] of [['test:core', core], ['test:types', types]]) {
      const off = LEGS.filter((k) => !s.has(k));
      if (off.length) problems.push(lane + ' does not run on: ' + off.join(', ') + ' (it must run on every leg)');
    }
    const pinned = new Set(LEGS.filter((k) => k.endsWith(' node ' + PINNED)));
    const vOff = Array.from(pinned).filter((k) => !verify.has(k));
    const vExtra = Array.from(verify).filter((k) => !pinned.has(k));
    if (vOff.length || vExtra.length) problems.push('npm run verify must run on exactly the ' + PINNED + ' legs: missing ' + (vOff.join(', ') || 'none') + '; extra ' + (vExtra.join(', ') || 'none'));

    const parts = new Set();
    if (typeof verifyScript !== 'string') problems.push('package.json scripts.verify missing');
    else {
      for (const p of verifyScript.split(' && ')) {
        if (!Object.prototype.hasOwnProperty.call(VERIFY_PART, p)) problems.push('package.json scripts.verify: unrecognised part "' + p + '"');
        else parts.add(VERIFY_PART[p]);
      }
      for (const p of ['test', 'alloc', 'torture']) if (!parts.has(p)) problems.push('package.json scripts.verify lacks ' + p);
    }
    const sum = ['test:core ' + core.size, 'test:types ' + types.size];
    for (const lane of ['verify', 'alloc', 'torture']) {
      const on = lane === 'verify' ? verify : legsOf(lane);
      if (lane !== 'verify' && parts.has(lane)) for (const k of verify) on.add(k);
      const skipWant = new Set(LEGS.filter((k) => !on.has(k)));
      if (skips[lane].length > 1) problems.push('lane ' + lane + ': ' + skips[lane].length + ' SKIP steps (want at most 1)');
      const got = new Set();
      for (const s of skips[lane]) for (const k of s.on) got.add(k);
      const silent = new Set(Array.from(skipWant).filter((k) => !got.has(k)));
      const wrong = new Set(Array.from(got).filter((k) => !skipWant.has(k)));
      if (silent.size) problems.push('lane ' + lane + ' is skipped SILENTLY (no SKIP step fires) on: ' + setStr(silent));
      if (wrong.size) problems.push('lane ' + lane + ': its SKIP step fires on legs that run it: ' + setStr(wrong));
      sum.push(lane + ' ' + on.size + ' + SKIP ' + got.size);
    }
    return { ok: problems.length === 0, problems, summary: legs.length + ' legs (' + sum.join(', ') + ')' };
  } catch (e) {
    problems.push(e.message);
    return { ok: false, problems, summary: 'unparsed' };
  }
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return false; }
}

// ciLegsAt(root) -> { ok, skip, line, problems }
export function ciLegsAt(root) {
  const ci = path.join(root, '.github', 'workflows', 'ci.yml');
  if (!exists(ci)) {
    if (exists(path.join(root, '.git'))) {
      return { ok: false, skip: false, line: 'FAIL', problems: ['.github/workflows/ci.yml is missing inside a git checkout (' + path.join(root, '.git') + ' exists)'] };
    }
    return { ok: true, skip: true, line: 'SKIP -- no .github/workflows/ci.yml and no .git (not a checkout, e.g. an npm tarball)', problems: [] };
  }
  let text;
  let verify;
  try {
    text = fs.readFileSync(ci, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    verify = pkg && pkg.scripts && typeof pkg.scripts.verify === 'string' ? pkg.scripts.verify : undefined;
  } catch (e) {
    return { ok: false, skip: false, line: 'FAIL', problems: ['cannot read ci.yml / package.json: ' + e.message] };
  }
  const r = checkCiLegs(text, verify);
  return { ok: r.ok, skip: false, line: r.ok ? r.summary + ' ok' : 'FAIL (' + r.problems.length + ' finding(s))', problems: r.problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) {
    console.error('ci-legs: usage: node test/ci-legs.mjs [rootDir]');
    process.exit(2);
  }
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const r = ciLegsAt(root);
  for (const p of r.problems) console.error('ci-legs: ' + p);
  console.log('ci-legs: ' + r.line);
  process.exitCode = r.ok ? 0 : 1;
}
