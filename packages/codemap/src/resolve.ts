import { posix } from 'node:path';

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * The project file an import points at, when it's a relative import we can find (no node_modules, no
 * tsconfig paths): `./x` from `src/a.ts` → `src/x.ts`, `src/x/index.ts`, …; Python `.mod` / `..pkg.mod`
 * and absolute dotted names that are files in the project. Paths use forward slashes, relative to the
 * project root.
 */
export function resolveImport(fromPath: string, spec: string, files: ReadonlySet<string>): string | null {
  const dir = posix.dirname(fromPath);
  if (fromPath.endsWith('.py')) return resolvePython(dir, spec, files);
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(dir, spec));
  if (base.startsWith('..')) return null;
  // TS sources often import "./x.js" for "./x.ts".
  const stem = base.replace(/\.(m|c)?js$/, '');
  const candidates = [base, ...JS_EXTS.map((e) => stem + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => files.has(c)) ?? null;
}

function resolvePython(dir: string, spec: string, files: ReadonlySet<string>): string | null {
  const dots = /^\.*/.exec(spec)![0].length;
  const rest = spec.slice(dots).replace(/\./g, '/');
  let base: string;
  if (dots > 0) {
    let up = dir;
    for (let i = 1; i < dots; i++) up = posix.dirname(up);
    base = posix.normalize(rest ? posix.join(up, rest) : up);
  } else {
    base = rest;
  }
  if (base.startsWith('..')) return null;
  const candidates = [`${base}.py`, `${base}/__init__.py`];
  return candidates.find((c) => files.has(c.replace(/^\.\//, ''))) ?? null;
}
