// Count gate for `npm test`: runs the test files through node:test run(), shows
// the spec reporter on stdout, then fails unless the run was EXACTLY the
// expected suite -- EXPECTED tests passed, 0 failed, 0 skipped / todo.
// A plain `node --test` exits 0 on a file that defines no tests at all, or on
// one whose tests were skipped: this gate does not.
//
// Usage: node test/count.mjs [file ...]   (default: FILES; argv files are for
// mutant / revert checks and are resolved from the current directory)
// Exit 0 ok, 1 a count or the run failed (fail closed: a missing summary, a
// stream error or an unexpected event is a failure), 2 node:test run() missing.
//
// A test file added or removed here updates FILES and EXPECTED together.
// EXPECTED is pinned to the "tests N" line of a plain
// `node --expose-gc --test test/RingBuffer.test.js test/InliningTool.test.js test/copyto.test.js`
// (60 + 31 + 30 = 121), not to this file's tally.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['test/RingBuffer.test.js', 'test/InliningTool.test.js', 'test/copyto.test.js'];
const EXPECTED = 121;

process.exitCode = 1;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const files = argv.length ? argv.map((f) => path.resolve(f)) : FILES.map((f) => path.join(ROOT, f));

let run, Spec;
try {
  ({ run } = await import('node:test'));
  ({ spec: Spec } = await import('node:test/reporters'));
} catch (e) {
  run = undefined;
}
if (typeof run !== 'function' || typeof Spec !== 'function') {
  console.error('count: node:test run() / spec reporter not available on ' + process.version);
  process.exit(2);
}

let pass = 0;          // test:pass, details.type 'test', not skip / todo, not a file wrapper
let fail = 0;          // test:fail, any type but 'suite' (tests and file wrappers)
let skip = 0;          // skip or todo, on any pass / fail event
let suiteFail = 0;     // test:fail of a suite (hook failure, or a failed child)
let wrapper = 0;       // a file reported as one test: it defined no tests
let unexpected = 0;    // a pass of a details.type neither 'test' nor 'suite'
let summary = null;    // the run-level test:summary (no file field)
let summaries = 0;
let fileSummaries = 0; // per-file test:summary (a child that exits early never sends one)

const stream = run({ files, execArgv: ['--expose-gc'] });

stream.on('test:pass', (d) => {
  const type = d.details && d.details.type;
  if (d.skip || d.todo) { skip++; return; }
  if (type === 'suite') return;
  if (type !== 'test') { unexpected++; return; }
  if (d.nesting === 0 && d.name === d.file) { wrapper++; return; }
  pass++;
});
stream.on('test:fail', (d) => {
  if (d.skip || d.todo) skip++;
  if (d.details && d.details.type === 'suite') suiteFail++;
  else fail++;
});
stream.on('test:summary', (d) => {
  if (d.file === undefined) { summary = d; summaries++; } else fileSummaries++;
});

let streamError = null;
try {
  for await (const chunk of stream.compose(new Spec())) process.stdout.write(chunk);
} catch (e) {
  streamError = e;
}

const reasons = [];
if (streamError) reasons.push('stream error: ' + (streamError && streamError.message));
if (summaries !== 1) reasons.push('run summary events: ' + summaries + ' (want 1)');
if (summary) {
  const c = summary.counts || {};
  if (summary.success !== true) reasons.push('run summary success=' + summary.success);
  if (c.failed !== 0 || c.cancelled !== 0) reasons.push('run summary failed=' + c.failed + ' cancelled=' + c.cancelled);
  if (c.passed !== pass + wrapper) reasons.push('run summary passed=' + c.passed + ' but counted ' + (pass + wrapper));
}
if (fileSummaries !== files.length) reasons.push('file summary events: ' + fileSummaries + ' (want ' + files.length + ')');
if (suiteFail) reasons.push(suiteFail + ' suite(s) failed');
if (wrapper) reasons.push(wrapper + ' file(s) defined no tests');
if (unexpected) reasons.push(unexpected + ' pass event(s) of an unknown type');

const ok = pass === EXPECTED && fail === 0 && skip === 0 && reasons.length === 0;
console.log('count: pass ' + pass + '/' + EXPECTED + ' fail ' + fail + ' skip ' + skip + (ok ? '' : ' FAIL'));
for (const r of reasons) console.error('  count: ' + r);
process.exitCode = ok ? 0 : 1;
