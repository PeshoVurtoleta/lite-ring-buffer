// ASCII gate: any code point > 0x7F except U+00D7 and U+00B5 is a finding.
// Scans package.json, every files[] entry (dirs recursively) and test/**.
// Usage: node test/ascii.mjs [rootDir]   (default: the package root)
// Exit 0 clean, 1 findings, 2 self-control broken or unreadable input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED = new Set([0xD7, 0xB5]);

function scanText(text, onHit) {
  let line = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 10) line++;
    else if (cp > 0x7F && !ALLOWED.has(cp)) onHit(line, cp);
  }
}

// Self-control, written with escapes so this file stays ASCII.
{
  const hits = [];
  scanText('a\u2014b\u00A9\u0080\u{1F600}', (l, c) => hits.push(c));
  const ok = hits.length === 4 && hits[0] === 0x2014 && hits[1] === 0xA9 && hits[2] === 0x80 && hits[3] === 0x1F600;
  const hits2 = [];
  scanText('\u00D7\u00B5', (l, c) => hits2.push(c));
  if (!ok || hits2.length !== 0) {
    console.error('ascii: self-control FAILED (must flag U+2014, U+00A9, U+0080, U+1F600 as 4 code points; must pass U+00D7 and U+00B5)');
    process.exit(2);
  }
}

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const files = new Set();

function addPath(rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) { console.error('ascii: missing path (globs are not expanded): ' + rel); process.exit(2); }
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      if (e === 'node_modules' || e === '.handoff' || e === '.git') continue;
      addPath(path.join(rel, e));
    }
  } else files.add(rel);
}

let pkg;
try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
catch (e) { console.error('ascii: cannot read package.json in ' + root); process.exit(2); }
if (!Array.isArray(pkg.files)) { console.error('ascii: package.json has no files[] array'); process.exit(2); }
addPath('package.json');
for (const f of pkg.files) addPath(String(f).replace(/\/$/, ''));
addPath('test');

let n = 0;
for (const rel of [...files].sort()) {
  let txt;
  try { txt = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { console.error('ascii: cannot read ' + rel); process.exit(2); }
  scanText(txt, (line, cp) => {
    n++;
    console.log(rel + ':' + line + ':U+' + cp.toString(16).toUpperCase().padStart(4, '0'));
  });
}
console.log('ascii: ' + files.size + ' files, ' + n + ' findings');
process.exit(n ? 1 : 0);
