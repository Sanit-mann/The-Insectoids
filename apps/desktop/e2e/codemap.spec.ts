import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { CodeLookupResult, CommandResult, HiveCommand, HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp, makeRepo, repoGit } from './support/launch';

/**
 * The code map backend (Phase 2 B4) through the real app (no AI): TypeScript and Python files in the project
 * are mapped when it opens, `codeLookup` finds a function and its callers, and after a file changes,
 * `rebuildCodeMap` picks up the new symbol. The map only reads the project.
 */
let t: LaunchedApp;
let repo: string;
let launchedAt = 0;

const write = (rel: string, lines: string[]): void => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), lines.join('\n'));
};

test.beforeAll(async () => {
  repo = makeRepo();
  write('src/text.ts', [
    '/** Turns text into a slug. Lowercases it. */',
    'export function slugify(text: string): string {',
    '  return clean(text).toLowerCase();',
    '}',
    '',
    'function clean(text: string): string {',
    '  return text.trim();',
    '}',
    '',
  ]);
  write('src/app.ts', ["import { slugify } from './text.js';", '', 'export class App {', '  title(): string {', "    return slugify(' Hello ');", '  }', '}', '']);
  write('tools/report.py', ['import json', '', 'def report(data):', '    """Prints a report."""', '    return json.dumps(data)', '']);
  repoGit(repo, 'add', '-A');
  repoGit(repo, 'commit', '-q', '-m', 'Add code for the map');
  launchedAt = Date.now();
  t = await launchApp({ repo });
});

test.afterAll(async () => {
  await t?.close();
  if (repo) rmSync(join(repo, '..'), { recursive: true, force: true, maxRetries: 3 });
});

const snapshot = (): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (cmd: HiveCommand): Promise<CommandResult> => t.win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);
const lookup = (query: string, mode: 'symbol' | 'file' | 'callers' | 'callees'): Promise<CodeLookupResult> =>
  t.win.evaluate((r) => (globalThis as unknown as AppWindow).insectoids.hive.codeLookup(r), { query, mode });

async function until<T>(what: string, read: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('the project is mapped when it opens, with counts per language', async () => {
  const map = await until('the code map', async () => {
    const s = await snapshot();
    return s.codeMap.state === 'ready' && s.codeMap.files === 3 ? s.codeMap : null;
  });
  console.log(`[codemap e2e] ready ${Date.now() - launchedAt} ms after launch: ${map.message}`);
  expect(map.languages).toEqual([
    { language: 'typescript', files: 2 },
    { language: 'python', files: 1 },
  ]);
  expect(map.symbols).toBe(5); // slugify, clean, App, App.title, report
  expect(map.skipped).toBe(1); // README.md
  expect(map.lastBuiltAt).toEqual(expect.any(Number));
  expect(map.progress).toBeNull();
});

test('codeLookup finds a function, its file outline and its callers', async () => {
  const found = await lookup('slug', 'symbol');
  expect(found.hits[0]).toMatchObject({
    path: 'src/text.ts',
    name: 'slugify',
    kind: 'function',
    line: 2,
    endLine: 4,
    signature: 'export function slugify(text: string): string {',
    doc: 'Turns text into a slug.',
    parent: null,
  });
  const callers = await lookup('slugify', 'callers');
  expect(callers.hits.map((h) => `${h.path}:${h.parent ?? ''}.${h.name}`)).toEqual(['src/app.ts:App.title']);
  const outline = await lookup('app.ts', 'file');
  expect(outline.imports).toEqual(['./text.js']);
  expect(outline.hits.map((h) => h.name)).toEqual(['App', 'title']);
  expect((await lookup('report', 'symbol')).hits[0]).toMatchObject({ path: 'tools/report.py', doc: 'Prints a report.' });
  expect((await lookup('slugify', 'callees')).hits.map((h) => h.name)).toEqual(['clean']);
});

test('after a file changes, rebuildCodeMap picks up the new symbol', async () => {
  write('src/text.ts', [
    'export function slugify(text: string): string {',
    '  return text.toLowerCase();',
    '}',
    '',
    '/** Joins words with dashes. */',
    'export function kebab(words: string[]): string {',
    "  return words.join('-');",
    '}',
    '',
  ]);
  expect((await lookup('kebab', 'symbol')).hits).toEqual([]);
  expect(await command({ type: 'rebuildCodeMap' })).toEqual({ ok: true });
  const hit = await until('kebab in the map', async () => (await lookup('kebab', 'symbol')).hits[0]);
  expect(hit).toMatchObject({ path: 'src/text.ts', line: 6, doc: 'Joins words with dashes.' });
  // clean() is gone from the file, so it's gone from the map.
  await until('ready again', async () => (await snapshot()).codeMap.state === 'ready');
  expect((await lookup('clean', 'symbol')).hits).toEqual([]);
  // The map only reads the project: nothing new appeared in git.
  expect(repoGit(repo, 'status', '--porcelain').trim()).toBe('M src/text.ts');
});
