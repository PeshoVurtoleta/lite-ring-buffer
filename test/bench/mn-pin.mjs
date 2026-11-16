// test/bench/mn-pin.mjs -- the ONE pin of the mnemonist devDependency used by the compare benches
// (compare.mjs, compare-probe.mjs, compare-gc.mjs, compare-gc-child.mjs import it; none keeps its own list).
//
// What it pins: mnemonist EXACT 0.40.8 (maintainer ruling Q-Q2-MNEMONIST, devDependency) and the bytes of
// every file `require('<node_modules>/mnemonist/circular-buffer.js')` loads (MN_FILES, the require.cache
// delta, package-relative, sorted), including obliterator's files at OBLITERATOR_VERSION.
// Why a full constant: package-lock.json is gitignored, so nothing in git records the installed integrity.
// MN_SHA256 covers fixed-deque.js, which holds get / forEach / toArray (CircularBuffer copies its prototype),
// so a pin on circular-buffer.js alone would leave the timed methods unpinned.
// MN_SHA256 = sha256 over `${pkgRel}\0${sha256hex(fileBytes)}\n` lines in MN_FILES order.
// Re-cut MN_FILES / MN_SHA256 only with review (a drifted install fails closed until then).
//
// Pure: no side effects at import, node: builtins only, never requires or executes mnemonist (bytes only).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MN_VERSION = '0.40.8';
export const OBLITERATOR_VERSION = '2.0.5';
export const MN_FILES = Object.freeze([
    'mnemonist/circular-buffer.js',
    'mnemonist/fixed-deque.js',
    'mnemonist/utils/iterables.js',
    'mnemonist/utils/typed-arrays.js',
    'obliterator/foreach.js',
    'obliterator/iterator.js',
    'obliterator/support.js',
]);
export const MN_SHA256 = '029daecdb3d2bb6eb4ab96d6886c3dfb435ef5529390bb219138224d81531baa';

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');

// Reads (never executes) every MN_FILES entry under nodeModulesDir. Throws on a bad argument or a read error;
// mnCheck is the fail-closed wrapper.
export function mnDigest(nodeModulesDir) {
    if (typeof nodeModulesDir !== 'string' || nodeModulesDir.length === 0) {
        throw new TypeError('mnDigest: nodeModulesDir must be a non-empty string');
    }
    const perFile = [];
    let lines = '';
    for (let i = 0; i < MN_FILES.length; i++) {
        const file = MN_FILES[i];
        const h = sha256hex(readFileSync(join(nodeModulesDir, file)));
        perFile.push({ file, sha256: h });
        lines += file + '\0' + h + '\n';
    }
    return { sha256: sha256hex(lines), perFile };
}

function readPkg(nodeModulesDir, name) {
    const j = JSON.parse(readFileSync(join(nodeModulesDir, name, 'package.json'), 'utf8'));
    if (j === null || typeof j !== 'object') throw new TypeError(name + '/package.json is not an object');
    return j;
}

// Fail closed: ok is true only when mnemonist/package.json says name 'mnemonist' version MN_VERSION,
// obliterator/package.json says name 'obliterator' version OBLITERATOR_VERSION, and mnDigest === MN_SHA256.
// Any read / parse error -> ok false with why.
export function mnCheck(nodeModulesDir) {
    const r = { ok: false, why: '', version: null, obliterator: null, sha256: null, perFile: null };
    try {
        const mp = readPkg(nodeModulesDir, 'mnemonist');
        r.version = typeof mp.version === 'string' ? mp.version : null;
        const op = readPkg(nodeModulesDir, 'obliterator');
        r.obliterator = typeof op.version === 'string' ? op.version : null;
        const d = mnDigest(nodeModulesDir);
        r.sha256 = d.sha256;
        r.perFile = d.perFile;
        if (mp.name !== 'mnemonist') r.why = 'mnemonist/package.json name is ' + String(mp.name);
        else if (r.version !== MN_VERSION) r.why = 'mnemonist ' + String(mp.version) + ' != ' + MN_VERSION;
        else if (op.name !== 'obliterator') r.why = 'obliterator/package.json name is ' + String(op.name);
        else if (r.obliterator !== OBLITERATOR_VERSION) r.why = 'obliterator ' + String(op.version) + ' != ' + OBLITERATOR_VERSION;
        else if (d.sha256 !== MN_SHA256) {
            r.why = 'mnemonist digest ' + d.sha256 + ' != MN_SHA256 ' + MN_SHA256 + '; per file: ' +
                d.perFile.map((p) => p.file + ' ' + p.sha256).join(', ');
        } else r.ok = true;
    } catch (e) {
        r.ok = false;
        r.why = 'mnCheck: ' + (e && e.message ? e.message : String(e));
    }
    return r;
}
