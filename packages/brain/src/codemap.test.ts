import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, type CodeFileInput, openBrain } from './index';

let brain: Brain;
let clock: number;

beforeEach(() => {
  clock = 1_000_000;
  brain = openBrain(':memory:', { now: () => clock });
});
afterEach(() => brain.close());

const sym = (name: string, line: number, o: Partial<CodeFileInput['symbols'][number]> = {}): CodeFileInput['symbols'][number] => ({
  name,
  qualified: name,
  kind: 'function',
  line,
  endLine: line + 2,
  signature: `function ${name}()`,
  doc: null,
  parent: null,
  ...o,
});

const util: CodeFileInput = {
  path: 'src/util.ts',
  language: 'typescript',
  contentHash: 'h-util',
  size: 100,
  imports: [],
  symbols: [sym('slugify', 1, { doc: 'Turns text into a slug.' }), sym('slug', 5), sym('makeSlugger', 9), sym('helper', 13)],
  edges: [{ from: 'slugify', callee: 'helper', toPath: null, line: 2 }],
};
const app: CodeFileInput = {
  path: 'src/app.ts',
  language: 'typescript',
  contentHash: 'h-app',
  size: 80,
  imports: ['./util.js', 'node:fs'],
  symbols: [sym('main', 3), sym('Runner', 8, { kind: 'class', signature: 'class Runner {' }), sym('run', 9, { kind: 'method', qualified: 'Runner.run', parent: 'Runner' })],
  edges: [
    { from: 'main', callee: 'slugify', toPath: 'src/util.ts', line: 4 },
    { from: 'main', callee: 'readFileSync', toPath: null, line: 5 },
    { from: 'Runner.run', callee: 'slugify', toPath: 'src/util.ts', line: 10 },
    { from: '', callee: 'main', toPath: null, line: 20 },
  ],
};

describe('code map storage', () => {
  it('stores files per shelf, with hashes and stats, and replaces a file whole', () => {
    brain.code.putFile('p1', util);
    brain.code.putFile('p1', app);
    brain.code.setBuilt('p1', { skipped: 3 });
    expect(brain.code.hashes('p1')).toEqual(new Map([['src/util.ts', 'h-util'], ['src/app.ts', 'h-app']]));
    expect(brain.code.stats('p1')).toEqual({ files: 2, symbols: 7, languages: [{ language: 'typescript', files: 2 }], skipped: 3, lastBuiltAt: 1_000_000 });

    brain.code.putFile('p1', { ...util, contentHash: 'h2', symbols: [sym('slugify', 1)], edges: [] });
    expect(brain.code.stats('p1').symbols).toBe(4);
    expect(brain.code.hashes('p1').get('src/util.ts')).toBe('h2');
  });

  it('keeps shelves apart', () => {
    brain.code.putFile('p1', util);
    expect(brain.code.findSymbols('p2', 'slugify').hits).toEqual([]);
    expect(brain.code.stats('p2').files).toBe(0);
  });

  it('removes deleted files with their symbols and calls', () => {
    brain.code.putFile('p1', util);
    brain.code.putFile('p1', app);
    brain.code.removeFiles('p1', ['src/app.ts']);
    expect(brain.code.stats('p1')).toMatchObject({ files: 1, symbols: 4 });
    expect(brain.code.callers('p1', 'slugify').hits).toEqual([]);
  });

  it('finds symbols case-insensitively: exact, then prefix, then contains', () => {
    brain.code.putFile('p1', util);
    brain.code.putFile('p1', app);
    expect(brain.code.findSymbols('p1', 'SLUG').hits.map((h) => h.name)).toEqual(['slug', 'slugify', 'makeSlugger']);
    expect(brain.code.findSymbols('p1', 'runner.run').hits.map((h) => `${h.parent}.${h.name}`)).toEqual(['Runner.run']);
    const one = brain.code.findSymbols('p1', 'slug', 1);
    expect(one).toMatchObject({ truncated: true });
    expect(one.hits).toHaveLength(1);
    expect(brain.code.findSymbols('p1', 'nothing_like_it').message).toMatch(/No symbol/);
    // LIKE wildcards in the query are literal.
    expect(brain.code.findSymbols('p1', '%').hits).toEqual([]);
  });

  it('outlines a file by full path or unique ending, with its imports', () => {
    brain.code.putFile('p1', util);
    brain.code.putFile('p1', app);
    const o = brain.code.outline('p1', 'app.ts');
    expect(o.hits.map((h) => h.name)).toEqual(['main', 'Runner', 'run']);
    expect(o.imports).toEqual(['./util.js', 'node:fs']);
    expect(brain.code.outline('p1', './src/util.ts').hits).toHaveLength(4);
    expect(brain.code.outline('p1', 'missing.ts').message).toMatch(/No mapped file/);
  });

  it('lists callers (resolved or same-name) and callees among project symbols', () => {
    brain.code.putFile('p1', util);
    brain.code.putFile('p1', app);
    const callers = brain.code.callers('p1', 'slugify');
    expect(callers.hits.map((h) => `${h.path}:${h.name}`)).toEqual(['src/app.ts:main', 'src/app.ts:run']);
    // A module-level call shows as "(module)".
    expect(brain.code.callers('p1', 'main').hits.map((h) => h.name)).toEqual(['(module)']);
    const callees = brain.code.callees('p1', 'main');
    expect(callees.hits.map((h) => `${h.path}:${h.name}`)).toEqual(['src/util.ts:slugify']);
    expect(callees.message).toMatch(/1 call\(s\) go to libraries/);
    // Unresolved call to a unique project name still resolves.
    expect(brain.code.callees('p1', 'slugify').hits.map((h) => h.name)).toEqual(['helper']);
    expect(brain.code.callers('p1', 'Runner.run').message).toMatch(/Nothing in the map calls/);
  });
});
