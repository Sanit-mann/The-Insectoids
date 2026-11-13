import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeParser, firstSentence, languageOf, resolveImport } from './index';
import type { FileMap } from './types';

let parser: CodeParser;
beforeAll(async () => {
  parser = await CodeParser.create();
});
afterAll(() => parser.dispose());

const map = async (path: string, src: string): Promise<FileMap> => {
  const m = await parser.parse(path, src);
  if (!m) throw new Error(`not mapped: ${path}`);
  return m;
};
const names = (m: FileMap) => m.symbols.map((s) => `${s.kind}:${s.qualified}`);

describe('which files are read', () => {
  it('maps TS, TSX, JS and Python by extension; skips type declarations and others', () => {
    expect(['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.py'].map(languageOf)).toEqual([
      'typescript', 'typescript', 'typescript', 'tsx', 'javascript', 'javascript', 'javascript', 'javascript', 'python',
    ]);
    expect([languageOf('types.d.ts'), languageOf('README.md'), languageOf('Makefile')]).toEqual([null, null, null]);
  });
});

describe('TypeScript', () => {
  const src = `import { helper as h } from './util.js';
import * as fs from 'node:fs';
export { thing } from './things';

/**
 * Turns text into a slug. Lowercases first.
 * @param text the input
 */
export function slugify(text: string): string {
  return h(text).toLowerCase();
}

// Adds two numbers.
export const add = (a: number, b: number) => a + b;
const config = { a: 1 };

export interface Shape { area(): number }
export type Id = string;
export enum Color { Red, Green }

namespace Outer {
  export class Inner {
    /** Runs it. */
    run(): void { slugify('x'); fs.readFileSync('y'); }
    handler = () => add(1, 2);
  }
}

class Box {
  static make() { return new Box(); }
}
`;

  it('finds functions, arrow consts, interfaces, types, enums, namespaces, nested classes and methods', async () => {
    const m = await map('src/text.ts', src);
    expect(names(m)).toEqual([
      'function:slugify',
      'function:add',
      'interface:Shape',
      'type:Id',
      'enum:Color',
      'module:Outer',
      'class:Outer.Inner',
      'method:Outer.Inner.run',
      'method:Outer.Inner.handler',
      'class:Box',
      'method:Box.make',
    ]);
    // A const with a non-function value is not a symbol.
    expect(names(m)).not.toContain('function:config');
  });

  it('keeps lines, the signature line and the first sentence of the doc', async () => {
    const m = await map('src/text.ts', src);
    const slug = m.symbols.find((s) => s.name === 'slugify')!;
    expect(slug).toMatchObject({ line: 9, endLine: 11, signature: 'export function slugify(text: string): string {', doc: 'Turns text into a slug.', parent: null });
    expect(m.symbols.find((s) => s.name === 'add')!.doc).toBe('Adds two numbers.');
    expect(m.symbols.find((s) => s.name === 'run')).toMatchObject({ doc: 'Runs it.', parent: 'Inner' });
  });

  it('lists imports and re-exports, and calls with their caller and the module they came from', async () => {
    const m = await map('src/text.ts', src);
    expect(m.imports).toEqual(['./util.js', 'node:fs', './things']);
    const calls = m.calls.map((c) => `${c.from || '<module>'}→${c.callee}${c.module ? `@${c.module}` : ''}`);
    expect(calls).toEqual(
      expect.arrayContaining([
        'slugify→h@./util.js',
        'slugify→toLowerCase',
        'Outer.Inner.run→slugify',
        'Outer.Inner.run→readFileSync@node:fs',
        'Outer.Inner.handler→add',
        'Box.make→Box',
      ]),
    );
  });

  it('reads TSX components', async () => {
    const m = await map('src/App.tsx', `export function App() { return <div onClick={() => go()}>hi</div>; }\nfunction go() {}\n`);
    expect(names(m)).toEqual(['function:App', 'function:go']);
    expect(m.calls.map((c) => `${c.from}→${c.callee}`)).toContain('App→go');
  });
});

describe('JavaScript', () => {
  it('reads CommonJS requires, classes and arrow functions', async () => {
    const m = await map('lib/a.cjs', `const path = require('path');\nconst run = function () { return path.join('a'); };\nclass Job { start() { run(); } }\nmodule.exports = { run };\n`);
    expect(m.imports).toEqual(['path']);
    expect(names(m)).toEqual(['function:run', 'class:Job', 'method:Job.start']);
    expect(m.calls.map((c) => `${c.from}→${c.callee}${c.module ? `@${c.module}` : ''}`)).toEqual(['run→join@path', 'Job.start→run']);
  });
});

describe('Python', () => {
  const src = `"""Text tools."""
import os
import json as j
from .util import helper, other as o

# A plain helper.
def slugify(text):
    """Turns text into a slug. Lowercases."""
    return helper(text).lower()

class Box:
    """A box."""

    @staticmethod
    def make():
        return Box()

    class Inner:
        def run(self):
            os.path.join("a")
            j.dumps({})
            slugify("x")
`;

  it('finds functions, classes, decorated and nested methods with docstrings', async () => {
    const m = await map('pkg/text.py', src);
    expect(names(m)).toEqual(['function:slugify', 'class:Box', 'method:Box.make', 'class:Box.Inner', 'method:Box.Inner.run']);
    expect(m.symbols.find((s) => s.name === 'slugify')).toMatchObject({ doc: 'Turns text into a slug.', line: 7, signature: 'def slugify(text):' });
    expect(m.symbols.find((s) => s.name === 'Box')!.doc).toBe('A box.');
    expect(m.symbols.find((s) => s.name === 'make')).toMatchObject({ signature: 'def make():', parent: 'Box' });
  });

  it('lists imports and calls with the module they came from', async () => {
    const m = await map('pkg/text.py', src);
    expect(m.imports).toEqual(['os', 'json', '.util']);
    const calls = m.calls.map((c) => `${c.from}→${c.callee}${c.module ? `@${c.module}` : ''}`);
    expect(calls).toEqual(expect.arrayContaining(['slugify→helper@.util', 'slugify→lower', 'Box.make→Box', 'Box.Inner.run→dumps@json', 'Box.Inner.run→slugify']));
  });
});

describe('resolving relative imports to project files', () => {
  const files = new Set(['src/util.ts', 'src/lib/index.ts', 'src/a.ts', 'pkg/util.py', 'pkg/sub/__init__.py', 'pkg/text.py']);
  it('TS: ./x, ./x.js for x.ts, folder index; bare and escaping specifiers stay unresolved', () => {
    expect(resolveImport('src/a.ts', './util', files)).toBe('src/util.ts');
    expect(resolveImport('src/a.ts', './util.js', files)).toBe('src/util.ts');
    expect(resolveImport('src/a.ts', './lib', files)).toBe('src/lib/index.ts');
    expect(resolveImport('src/a.ts', 'react', files)).toBeNull();
    expect(resolveImport('src/a.ts', '../../outside', files)).toBeNull();
  });
  it('Python: relative and package imports', () => {
    expect(resolveImport('pkg/text.py', '.util', files)).toBe('pkg/util.py');
    expect(resolveImport('pkg/text.py', '.sub', files)).toBe('pkg/sub/__init__.py');
    expect(resolveImport('pkg/text.py', 'pkg.util', files)).toBe('pkg/util.py');
  });
});

describe('first sentence', () => {
  it('takes the first sentence, collapses space and caps the length', () => {
    expect(firstSentence('  Does a thing.  Then more. ')).toBe('Does a thing.');
    expect(firstSentence('No full stop here')).toBe('No full stop here');
    expect(firstSentence('')).toBeNull();
    expect(firstSentence('x'.repeat(300))!.length).toBe(200);
  });
});
