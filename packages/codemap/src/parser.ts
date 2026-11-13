import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as TreeSitter from '@vscode/tree-sitter-wasm';
import { extract } from './extract';
import { GRAMMAR_FILE, languageOf } from './languages';
import type { CodeLanguage, FileMap } from './types';

/**
 * The folder holding `tree-sitter.js`, `tree-sitter.wasm` and the grammars (from @vscode/tree-sitter-wasm).
 * Resolved from this package in Node; the app passes it explicitly, because the bundled Brain host can't
 * resolve the package itself.
 */
export function treeSitterWasmDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('@vscode/tree-sitter-wasm'));
}

/**
 * Parses source files into code maps with tree-sitter grammars run in WebAssembly: no AI, no native code,
 * no network. Grammars load lazily, the first time a language is seen.
 */
export class CodeParser {
  readonly #ts: typeof TreeSitter;
  readonly #dir: string;
  readonly #languages = new Map<CodeLanguage, Promise<TreeSitter.Language>>();
  readonly #parser: TreeSitter.Parser;

  private constructor(ts: typeof TreeSitter, dir: string) {
    this.#ts = ts;
    this.#dir = dir;
    this.#parser = new ts.Parser();
  }

  static async create(o: { wasmDir?: string } = {}): Promise<CodeParser> {
    const dir = o.wasmDir ?? treeSitterWasmDir();
    // The runtime is a UMD script: load it with require from its own folder (no import of the package name).
    const ts = createRequire(join(dir, 'tree-sitter.js'))(join(dir, 'tree-sitter.js')) as typeof TreeSitter;
    await ts.Parser.init({ locateFile: (file: string) => join(dir, file) });
    return new CodeParser(ts, dir);
  }

  /** Map one file. Returns null for languages the code map doesn't read. */
  async parse(path: string, source: string): Promise<FileMap | null> {
    const language = languageOf(path);
    if (!language) return null;
    this.#parser.setLanguage(await this.#language(language));
    const tree = this.#parser.parse(source);
    if (!tree) return null;
    try {
      return extract(tree.rootNode, source, language);
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    this.#parser.delete();
  }

  #language(lang: CodeLanguage): Promise<TreeSitter.Language> {
    let p = this.#languages.get(lang);
    if (!p) {
      p = this.#ts.Language.load(new Uint8Array(readFileSync(join(this.#dir, GRAMMAR_FILE[lang]))));
      this.#languages.set(lang, p);
    }
    return p;
  }
}
