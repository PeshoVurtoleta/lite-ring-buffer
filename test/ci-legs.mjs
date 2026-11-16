// CI leg check for .github/workflows/ci.yml (Q1 QA F2). Dependency-free, Node 18 safe, no YAML library:
// a strict line parser for THIS workflow's shape (block mappings, block sequences of mappings, flow lists,
// `|` block scalars, full-line comments). A tab, a CR, a trailing comment, an anchor, an unknown key, an
// unknown action, an unknown one-line run command or an unknown if: grammar is a finding (fail closed), never
// a skip. Run bodies are not shell-parsed; they are held to two exact shapes (skipLineProblem /
// blockLineProblem, each a finding naming the line): every non-blank line of a SKIP step is exactly ONE
// echo "<content>" with nothing after the closing quote, the first line's content starting "SKIP ", the
// content free of ", backtick, \ and $ except the whole substitutions in SKIP_SUBST; every line of any other
// `|` block run step is one of the exact (trimmed) lines in BLOCK_LINES (the provenance block) or blank.
// ciLegsSelfTest() pins both rules with string rows (one per BLOCK_LINES and per SKIP_SUBST entry, so the
// row count pins both lists) plus four end-to-end mutations of the live ci.yml, and runs inside ciLegsAt(),
// so a red row fails every `npm run test:core` and the CLI.
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
//     SKIP step ("<lane> SKIPPED (...)"; every line one plain echo "...", the first echo "SKIP ..."):
//     no leg skips a lane silently, no SKIP fires on a leg that runs the lane.
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
const VERIFY_PART = { 'npm test': 'test', 'npm run alloc': 'alloc', 'npm run torture': 'torture',
  'npm run ascii': 'ascii' };
// The only command substitutions a SKIP echo may contain (removed whole before the content check).
export const SKIP_SUBST = [
  '$(node --version)',
  '$(node -p \'"total_allocated_bytes" in require("v8").getHeapStatistics()\')',
];
// The only lines a non-SKIP `|` block run step may contain (exact, trimmed): the ci.yml provenance block.
export const BLOCK_LINES = [
  'node --version',
  'npm --version',
  'git --version',
  'uname -a',
  'echo "commit: $(git rev-parse HEAD)"',
  'echo "shallow: $(git rev-parse --is-shallow-repository)"',
  'echo "CI=${CI:-unset}"',
  'echo "cpus: $(node -p \'require("os").cpus().length\')  load: $(node -p \'require("os").loadavg()' +
    '.map(x => x.toFixed(2)).join(" ")\')"',
  'node -p \'"v8 " + process.versions.v8 + "  arch " + process.arch\'',
  'node -p \'"features: transfer=" + (typeof ArrayBuffer.prototype.transfer === "function") + " resize=" + ' +
    '(typeof ArrayBuffer.prototype.resize === "function") + " grow=" + (typeof SharedArrayBuffer === "function" && ' +
    'typeof SharedArrayBuffer.prototype.grow === "function") + " total_allocated_bytes=" + ("total_allocated_bytes" ' +
    'in require("v8").getHeapStatistics())\'',
];

// skipLineProblem(line, first) -> null | reason. One non-blank line of a SKIP step's run body.
export function skipLineProblem(line, first) {
  const s = String(line);
  const m = /^echo "(.*)"$/.exec(s);
  if (!m) return 'a SKIP step line must be exactly one echo "..." with nothing after the closing quote (got ' + s + ')';
  let c = m[1];
  for (const sub of SKIP_SUBST) c = c.split(sub).join('');
  if (/["`\\$]/.test(c)) {
    return 'a SKIP step echo may hold no ", backtick, \\ or $ but the whole substitutions ' + SKIP_SUBST.join(' / ') +
      ' (got ' + s + ')';
  }
  if (first && !m[1].startsWith('SKIP ')) return 'a SKIP step must start with echo "SKIP ... (got ' + s + ')';
  return null;
}

// blockLineProblem(line) -> null | reason. One line of a non-SKIP `|` block run step.
export function blockLineProblem(line) {
  const t = String(line).trim();
  if (t === '' || BLOCK_LINES.includes(t)) return null;
  return 'unrecognised command in a run block: ' + t;
}

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
    if (!m) throw new Error('unsupported if: expression term "' + t
      + '" (only matrix.node == / != \'<v>\' joined by ||)');
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
  problems.push(where + ': node value ' + raw + ' is not a single-quoted version string (write \''
    + raw.replace(/['"]/g, '') + '\')');
  return raw.replace(/['"]/g, '');
}

function keysOnly(map, allowed, what) {
  for (const k of map.m.keys()) if (!allowed.includes(k)) throw new Error(what + ': unknown key "' + k + '" (line '
    + map.m.get(k).n + ')');
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
      if (!trig.m.has(k) || trig.m.get(k).kind !== 'null') problems.push('on.' + k
        + ' missing or filtered (want a bare trigger)');
    }
    const jobs = want(top, 'jobs', 'map', 'top level');
    if (jobs.m.size !== 1 || !jobs.m.has('test')) throw new Error('jobs: want exactly one job "test", got '
      + Array.from(jobs.m.keys()).join(', '));
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
    const nodes = listOf(matrix.m.get('node'), 'matrix.node').map((r) => nodeValue(r, 'matrix.node (line '
      + matrix.m.get('node').n + ')', problems));
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
        const nv = nodeValue(want(it, 'node', 'scalar', 'include entry (line ' + it.n + ')').v, 'include (line ' + it.n
          + ')', problems);
        if (!oses.includes(o)) problems.push('include (line ' + it.n + '): os ' + o + ' is not in matrix.os');
        if (nodes.includes(nv)) problems.push('include (line ' + it.n + '): node \'' + nv
          + '\' is in matrix.node, so GitHub merges it into an existing leg instead of adding one');
        else if (!allNodes.includes(nv)) allNodes.push(nv);
        addLeg(o, nv, 'include (line ' + it.n + ')');
      }
    }
    const ALL = new Set(legs.map((l) => l.key));
    const missingLegs = LEGS.filter((k) => !ALL.has(k));
    const extraLegs = Array.from(ALL).filter((k) => !LEGS.includes(k));
    if (missingLegs.length || extraLegs.length || legs.length !== LEGS.length) {
      problems.push('legs: ' + legs.length + ' expanded (want ' + LEGS.length + '); missing: '
        + (missingLegs.join(', ') || 'none') + '; extra: ' + (extraLegs.join(', ') || 'none'));
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
        if (wi) for (const v of wi.m.values()) if (v.kind !== 'scalar') throw new Error(w
          + ': with: values must be scalars');
        if (m[1] === 'checkout') {
          if (wi) keysOnly(wi, ['fetch-depth', 'persist-credentials'], w + ' with');
        } else {
          if (!wi) throw new Error(w + ': setup-node without with: node-version');
          keysOnly(wi, ['node-version'], w + ' with');
          if (!wi.m.has('node-version') || wi.m.get('node-version').v !== '${{ matrix.node }}') problems.push(w
            + ': node-version is not ${{ matrix.node }}');
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
        if (run.kind !== 'scalar' && run.kind !== 'block') throw new Error(w + ': run: is not a string');
        const lines = run.v.split('\n').filter((l) => !/^ *$/.test(l));
        if (!lines.length) problems.push(w + ': a SKIP step with an empty run body');
        for (let j = 0; j < lines.length; j++) {
          const p = skipLineProblem(lines[j], j === 0);
          if (p !== null) problems.push(w + ': ' + p);
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
          const p = blockLineProblem(l);
          if (p !== null) problems.push(w + ': ' + p);
        }
        continue;
      }
      problems.push(w + ': unrecognised run command: ' + run.v);
    }
    if (!setupSeen) problems.push('no actions/setup-node step');

    const legsOf = (lane) => {
      const s = new Set();
      if (runs[lane].length !== 1) problems.push('lane ' + lane + ': ' + runs[lane].length
        + ' run steps (want exactly 1)');
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
    if (vOff.length || vExtra.length) problems.push('npm run verify must run on exactly the ' + PINNED
      + ' legs: missing ' + (vOff.join(', ') || 'none') + '; extra ' + (vExtra.join(', ') || 'none'));

    const parts = new Set();
    if (typeof verifyScript !== 'string') problems.push('package.json scripts.verify missing');
    else {
      for (const p of verifyScript.split(' && ')) {
        if (!Object.prototype.hasOwnProperty.call(VERIFY_PART,
          p)) problems.push('package.json scripts.verify: unrecognised part "' + p + '"');
        else parts.add(VERIFY_PART[p]);
      }
      for (const p of ['test', 'alloc',
        'torture']) if (!parts.has(p)) problems.push('package.json scripts.verify lacks ' + p);
    }
    const sum = ['test:core ' + core.size, 'test:types ' + types.size];
    for (const lane of ['verify', 'alloc', 'torture']) {
      const on = lane === 'verify' ? verify : legsOf(lane);
      if (lane !== 'verify' && parts.has(lane)) for (const k of verify) on.add(k);
      const skipWant = new Set(LEGS.filter((k) => !on.has(k)));
      if (skips[lane].length > 1) problems.push('lane ' + lane + ': ' + skips[lane].length
        + ' SKIP steps (want at most 1)');
      const got = new Set();
      for (const s of skips[lane]) for (const k of s.on) got.add(k);
      const silent = new Set(Array.from(skipWant).filter((k) => !got.has(k)));
      const wrong = new Set(Array.from(got).filter((k) => !skipWant.has(k)));
      if (silent.size) problems.push('lane ' + lane + ' is skipped SILENTLY (no SKIP step fires) on: '
        + setStr(silent));
      if (wrong.size) problems.push('lane ' + lane + ': its SKIP step fires on legs that run it: ' + setStr(wrong));
      sum.push(lane + ' ' + on.size + ' + SKIP ' + got.size);
    }
    return { ok: problems.length === 0, problems, summary: legs.length + ' legs (' + sum.join(', ') + ')' };
  } catch (e) {
    problems.push(e.message);
    return { ok: false, problems, summary: 'unparsed' };
  }
}

// ---- the self-test -----------------------------------------------------------------------------------
// The live SKIP lines (ci.yml torture / alloc x2 / verify), which must pass; [line, first].
const ST_SKIP_OK = [
  ['echo "SKIP torture on node $(node --version) -- @zakkster/lite-leak (devDependency) declares engines.node >=20;' +
    ' the library keeps engines >=18; test:core + test:types ran above."', true],
  ['echo "SKIP alloc on node $(node --version) -- needs v8.getHeapStatistics().total_allocated_bytes, absent through' +
    ' Node 24.22.3; the B/op gate runs on the node 26 legs."', true],
  ['echo "total_allocated_bytes present on this engine: $(node -p \'"total_allocated_bytes" in' +
    ' require("v8").getHeapStatistics()\') (printed, not gated)"', false],
  ['echo "SKIP npm test, npm run verify on node $(node --version) -- test/chainsize.test.js fails closed off Node' +
    ' v26.8.2 / V8 14.6.202.34-node.28 (Q-M1-GATE A); InliningTool / DeoptTool need bash, git and the pinned' +
    ' @zakkster/lite-utils 1.0.0; the 26.8.2 legs run the full verify; this leg ran test:core."', true],
];
// Each must be a finding from skipLineProblem (first true and false) AND from blockLineProblem.
const ST_BAD = [
  'echo "SKIP x"; npm run torture',
  'echo "SKIP x" && npm run torture',
  'echo "SKIP x" || npm run torture',
  'echo "SKIP x" | sh',
  'echo "SKIP $(node --expose-gc test/torture.mjs)"',
  'echo "SKIP x" > f',
  'echo "SKIP `npm run torture`"',
  'echo "SKIP x\\"; npm run torture; echo \\""',
  'echo "SKIP $HOME"',
  'echo "SKIP x \\"',
  'echo "SKIP x"$(node --version)',
  'echo "SKIP x"$(node --version)""',
  'npm run torture',
  'nvm use 18',
  'node test/torture.mjs',
  'echo "commit: $(git rev-parse HEAD)"; npm test',
];
// Rows: ST_SKIP_OK + BLOCK_LINES (pass) + SKIP_SUBST (used by a live SKIP line, passes as a first line) +
// 2 first-line rows + ST_BAD; + 4 end-to-end rows on a live ci.yml. 34 pure rows; 38 with a live ci.yml.
const ST_PURE_ROWS = 4 + 10 + 2 + 2 + 16;
const ST_E2E_ROWS = 4;

function stOnce(text, from, to) {
  if (text.split(from).length !== 2) return null;
  return text.replace(from, () => to);
}

// ciLegsSelfTest(liveText, verifyScript) -> { ok, rows, problems }. Pure: no fs. The end-to-end rows run only
// when liveText is a string that checkCiLegs passes.
export function ciLegsSelfTest(liveText, verifyScript) {
  const problems = [];
  let rows = 0;
  const row = (name, bad) => { rows++; if (bad) problems.push('ci-legs self-test: FAIL [' + name + '] ' + bad); };
  for (const [l, first] of ST_SKIP_OK) {
    const p = skipLineProblem(l, first);
    row('live SKIP line passes: ' + l.slice(0, 40), p);
  }
  for (const l of BLOCK_LINES) row('provenance line passes: ' + l.slice(0, 40), blockLineProblem('  ' + l + ' '));
  // One row per SKIP_SUBST entry: an entry no live SKIP line uses is an unused widening of the echo grammar.
  for (const sub of SKIP_SUBST) {
    const used = ST_SKIP_OK.some(([l]) => l.indexOf(sub) !== -1);
    row('SKIP_SUBST entry used + passes: ' + sub.slice(0, 40), used ? skipLineProblem('echo "SKIP x ' + sub + ' y"',
      true) : 'no live SKIP line (ST_SKIP_OK) uses it');
  }
  row('first line without SKIP', skipLineProblem('echo "total: x"', true) === null ? 'passed (want a finding)' : null);
  row('second line without SKIP', skipLineProblem('echo "total: x"', false));
  for (const b of ST_BAD) {
    const miss = [];
    if (skipLineProblem(b, true) === null) miss.push('skipLineProblem(first)');
    if (skipLineProblem(b, false) === null) miss.push('skipLineProblem');
    if (blockLineProblem(b) === null) miss.push('blockLineProblem');
    row('finding for ' + b, miss.length ? miss.join(', ') + ' passed it (want a finding)' : null);
  }
  let want = ST_PURE_ROWS;
  if (typeof liveText === 'string' && checkCiLegs(liveText, verifyScript).ok) {
    want += ST_E2E_ROWS;
    const e2e = (name, mut, needle) => {
      if (mut === null) { row(name, 'mutation anchor not found exactly once'); return; }
      const r = checkCiLegs(mut, verifyScript);
      const hit = r.problems.some((p) => p.indexOf(needle) !== -1);
      const why = r.ok ? 'passed' : 'did not name ' + needle;
      row(name, !r.ok && hit ? null : 'checkCiLegs ' + why + ' (want a finding)');
    };
    const tAnchor = 'test:core + test:types ran above."';
    e2e('torture SKIP echo + "; npm run torture"', stOnce(liveText, tAnchor, tAnchor + '; npm run torture'),
      'ran above."; npm run torture');
    const aAnchor = ' (printed, not gated)"\n';
    e2e('alloc SKIP block + a 2nd-line "npm run alloc"',
      stOnce(liveText, aAnchor, aAnchor + '          npm run alloc\n'), '(got npm run alloc)');
    const u = liveText.split('\n').filter((l) => l.trim() === 'uname -a');
    const uLine = u.length === 1 ? u[0] + '\n' : '\u0000';
    e2e('provenance block + "nvm use 18"',
      stOnce(liveText, uLine, uLine + uLine.replace('uname -a', 'nvm use 18')), 'run block: nvm use 18');
    // `run:  ` (two spaces) parses as the scalar ' ', so the body reaches the empty-SKIP-body check (a `|`
    // block of blank lines is refused earlier by the parser as an empty block scalar).
    const t = liveText.split('\n').filter((l) => l.trim().startsWith('run: echo "SKIP torture '));
    const tLine = t.length === 1 ? t[0] + '\n' : '\u0000';
    const tBlank = t.length === 1 ? t[0].slice(0, t[0].indexOf('run: ')) + 'run:  \n' : '';
    e2e('torture SKIP run body -> blank scalar', stOnce(liveText, tLine, tBlank), 'a SKIP step with an empty run body');
  }
  if (rows !== want) problems.push('ci-legs self-test: FAIL [row count] ran ' + rows + ' rows (want ' + want + ')');
  return { ok: problems.length === 0, rows, problems };
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return false; }
}

// ciLegsAt(root) -> { ok, skip, line, problems }. ciLegsSelfTest runs on every path (its end-to-end rows need
// a ci.yml that passes); a red row is a finding, so the printed line is FAIL.
const failed = (problems) => ({ ok: false, skip: false, line: 'FAIL (' + problems.length + ' finding(s))', problems });
export function ciLegsAt(root) {
  const ci = path.join(root, '.github', 'workflows', 'ci.yml');
  if (!exists(ci)) {
    const st = ciLegsSelfTest(null, undefined);
    if (exists(path.join(root, '.git'))) {
      const miss = '.github/workflows/ci.yml is missing inside a git checkout (' + path.join(root, '.git') + ' exists)';
      return { ok: false, skip: false, line: 'FAIL', problems: st.problems.concat([miss]) };
    }
    if (!st.ok) return failed(st.problems);
    const skipLine = 'SKIP -- no .github/workflows/ci.yml and no .git (not a checkout, e.g. an npm tarball)';
    return { ok: true, skip: true, line: skipLine, problems: [] };
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
  const st = ciLegsSelfTest(text, verify);
  if (!r.ok || !st.ok) return failed(r.problems.concat(st.problems));
  return { ok: true, skip: false, line: r.summary + ' ok', problems: [] };
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
