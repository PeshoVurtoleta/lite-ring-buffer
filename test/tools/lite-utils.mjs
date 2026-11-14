// lite-utils.mjs -- locate a script of the exact-pinned devDependency @zakkster/lite-utils for the
// repo-only V8 tooling (inline-diff.mjs, deopt-diff.mjs). Test tooling only: not shipped.
//
//   import { LITE_UTILS_VERSION, liteUtilsScript } from './lite-utils.mjs';
//   const s = liteUtilsScript(ROOT, 'inlining-budget-diff.sh');
//   if (!s.ok) die(s.why);              // the caller fails closed (exit 2)
//   spawn('bash', [s.path, ...]);
//
// The package is read at <root>/node_modules/@zakkster/lite-utils ONLY: no module resolution and
// no walk-up, so a suite-level hoisted copy never satisfies it. Its package.json must name
// @zakkster/lite-utils at EXACTLY LITE_UTILS_VERSION, and the script must be a file in that dir.
// An npm-link symlink is followed (the sha256 pin in test/InliningTool.test.js catches its bytes).
// The tools do not check sha256 themselves: they print `lite-utils <version> <file> sha256/8 X`
// as provenance and the test pins the bytes (one pin site).
//
// liteUtilsScript(root, file) never throws and never coerces: root must be an absolute path string
// and file a string (anything else is refused, never resolved against the cwd). It returns
// { ok: true, path } or { ok: false, why }, where why is one of:
//   lite-utils missing: DIR             (or: lite-utils missing: root R is not an absolute path)
//   lite-utils package.json unreadable: P
//   lite-utils package.json names X, want @zakkster/lite-utils
//   lite-utils version V at DIR, want exactly 1.0.0
//   lite-utils script missing: P       (or: lite-utils script missing: file is a T)
// lite-utils 1.0.0 declares engines node >= 22 (this package's engines says >= 18): the
// tooling is dev-only and runs on the maintainer's Node.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const LITE_UTILS_VERSION = '1.0.0';
export const LITE_UTILS_NAME = '@zakkster/lite-utils';

// <root>/node_modules/@zakkster/lite-utils (no resolution, no walk-up). root: a path string.
export function liteUtilsDir(root) {
    return join(root, 'node_modules', '@zakkster', 'lite-utils');
}

function kind(p) {
    try {
        const st = statSync(p);
        return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    } catch {
        return 'none';
    }
}
function shown(v) { return typeof v === 'string' ? v : String(JSON.stringify(v)); }

export function liteUtilsScript(root, file) {
    if (typeof root !== 'string' || !isAbsolute(root)) return { ok: false, why: 'lite-utils missing: root ' + (typeof root === 'string' ? JSON.stringify(root) : typeof root) + ' is not an absolute path' };
    if (typeof file !== 'string') return { ok: false, why: 'lite-utils script missing: file is a ' + typeof file };
    let dir = '';
    try {
        dir = liteUtilsDir(root);
        if (kind(dir) !== 'dir') return { ok: false, why: 'lite-utils missing: ' + dir };
        const pj = join(dir, 'package.json');
        let meta;
        try {
            meta = JSON.parse(readFileSync(pj, 'utf8'));
        } catch {
            return { ok: false, why: 'lite-utils package.json unreadable: ' + pj };
        }
        if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
            return { ok: false, why: 'lite-utils package.json unreadable: ' + pj };
        }
        if (meta.name !== LITE_UTILS_NAME) {
            return { ok: false, why: 'lite-utils package.json names ' + shown(meta.name) + ', want ' + LITE_UTILS_NAME };
        }
        if (meta.version !== LITE_UTILS_VERSION) {
            return { ok: false, why: 'lite-utils version ' + shown(meta.version) + ' at ' + dir + ', want exactly ' + LITE_UTILS_VERSION };
        }
        // a bare file name only: never a path that leaves the package dir
        const name = file;
        const p = join(dir, name);
        if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name) || kind(p) !== 'file') {
            return { ok: false, why: 'lite-utils script missing: ' + p };
        }
        return { ok: true, path: p };
    } catch {
        // root and file are strings here; nothing in this branch can throw
        return { ok: false, why: 'lite-utils missing: ' + (dir === '' ? root : dir) };
    }
}
