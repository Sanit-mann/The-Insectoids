import type { CodeLanguage } from './types';

const BY_EXT: Record<string, CodeLanguage> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
};

/** The language for a path, or null when the code map doesn't read it. `.d.ts` files are types only: skipped. */
export function languageOf(path: string): CodeLanguage | null {
  const lower = path.toLowerCase();
  if (/\.d\.[cm]?ts$/.test(lower)) return null;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXT[lower.slice(dot)] ?? null;
}

/** The grammar file for a language inside the @vscode/tree-sitter-wasm `wasm` folder. */
export const GRAMMAR_FILE: Record<CodeLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
};
