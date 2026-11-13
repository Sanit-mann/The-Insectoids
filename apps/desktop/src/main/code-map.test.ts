import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Brain, openBrain } from '@insectoids/brain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodeMapBuilder, MAX_FILE_BYTES, listProjectFiles } from '../brain-host/code-map';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let builder: CodeMapBuilder;
let changes: number;

const write = (rel: string, text: string | Buffer): void => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-codemap-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'core.autocrlf', 'false');
  write('.gitignore', 'build/\n');
  write('src/util.ts', '/** Turns text into a slug. */\nexport function slugify(text: string): string {\n  return text.toLowerCase();\n}\n');
  write('src/app.ts', "import { slugify } from './util.js';\n\nexport function main(): void {\n  slugify('Hello');\n}\n");
  write('tools/report.py', 'import json\n\ndef report(data):\n    """Prints a report."""\n    return json.dumps(data)\n');
  write('README.md', '# Demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // Untracked but not ignored: mapped. Ignored: never read.
  write('src/extra.ts', 'export const extra = () => 1;\n');
  write('build/out.js', 'function shouldNotAppear() {}\n');
  write('src/big.ts', `export function huge() {}\n${'// filler\n'.repeat(MAX_FILE_BYTES / 10 + 10)}`);
  write('src/blob.js', Buffer.from([0x66, 0x00, 0x01, 0x02]));
  brain = openBrain(':memory:');
  changes = 0;
  builder = new CodeMapBuilder({ brain, onChange: () => changes++, refreshEveryMs: 0 });
});

afterEach(async () => {
  await builder.dispose();
  brain.close();
  rmSync(root, { recursive: true, force: true });
});

const names = (shelf: string, q: string) => brain.code.findSymbols(shelf, q).hits.map((h) => `${h.path}:${h.name}`);

describe('the code map builder', () => {
  it('lists tracked and untracked files, never ignored ones', async () => {
    const files = await listProjectFiles(repo);
    expect(files).toEqual(expect.arrayContaining(['src/util.ts', 'src/extra.ts', 'tools/report.py', 'README.md']));
    expect(files).not.toContain('build/out.js');
  });

  it('maps TS and Python, skips large, binary and other files, and reports ready', async () => {
    builder.setProject(repo, 'demo');
    expect(builder.view().state).toBe('building');
    await builder.refresh();
    const view = builder.view();
    expect(view).toMatchObject({ state: 'ready', files: 4, progress: null });
    expect(view.languages).toEqual([{ language: 'typescript', files: 3 }, { language: 'python', files: 1 }]);
    // .gitignore, README.md, src/big.ts (too large), src/blob.js (binary).
    expect(view.skipped).toBe(4);
    expect(view.lastBuiltAt).not.toBeNull();
    expect(view.message).toMatch(/4 files and \d+ symbols mapped/);
    expect(changes).toBeGreaterThan(0);

    expect(names('demo', 'slugify')).toEqual(['src/util.ts:slugify']);
    expect(names('demo', 'report')).toEqual(['tools/report.py:report']);
    expect(names('demo', 'shouldNotAppear')).toEqual([]);
    expect(names('demo', 'huge')).toEqual([]);
    expect(builder.lookup({ query: 'slugify', mode: 'symbol' }).hits[0]).toMatchObject({ doc: 'Turns text into a slug.', line: 2 });
    // The import resolved across files: main calls util's slugify.
    expect(builder.lookup({ query: 'slugify', mode: 'callers' }).hits.map((h) => `${h.path}:${h.name}`)).toEqual(['src/app.ts:main']);
    expect(builder.lookup({ query: 'main', mode: 'callees' }).hits.map((h) => h.name)).toEqual(['slugify']);
    expect(builder.lookup({ query: 'app.ts', mode: 'file' })).toMatchObject({ imports: ['./util.js'] });
  });

  it('refreshes by content hash: unchanged files skipped, changed re-read, deleted removed', async () => {
    builder.setProject(repo, 'demo');
    await builder.settled();
    expect(builder.lastReport).toMatchObject({ parsed: 4, unchanged: 0 });

    await builder.refresh();
    expect(builder.lastReport).toMatchObject({ parsed: 0, unchanged: 4, removed: 0 });

    write('src/util.ts', 'export function slugify(text: string): string { return text; }\nexport function kebab(s: string) { return s; }\n');
    unlinkSync(join(repo, 'src/extra.ts'));
    await builder.refresh();
    expect(builder.lastReport).toMatchObject({ parsed: 1, unchanged: 2, removed: 1 });
    expect(names('demo', 'kebab')).toEqual(['src/util.ts:kebab']);
    expect(names('demo', 'extra')).toEqual([]);

    // The user's rebuild reads every file again.
    await builder.refresh({ force: true });
    expect(builder.lastReport).toMatchObject({ parsed: 3, unchanged: 0 });
  });

  it('keeps each project on its own shelf and says "off" without one', async () => {
    builder.setProject(repo, 'demo');
    await builder.settled();
    expect(brain.code.stats('other').files).toBe(0);
    builder.setProject(null, null);
    expect(builder.view().state).toBe('off');
    expect(builder.lookup({ query: 'slugify', mode: 'symbol' }).message).toMatch(/Pick a project/);
    // The map stays in the Brain for when the project opens again.
    expect(brain.code.stats('demo').files).toBe(4);
  });

  it('a folder that is not a git repo is an error state, not a crash', async () => {
    const bad = new CodeMapBuilder({ brain, onChange: () => {}, refreshEveryMs: 0 });
    bad.setProject(root, 'nope');
    await bad.settled();
    expect(bad.view()).toMatchObject({ state: 'error' });
    expect(bad.view().message).toMatch(/could not be built/);
    await bad.dispose();
  });
});
