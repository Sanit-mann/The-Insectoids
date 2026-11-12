import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "tiny-text": the Phase 1 demo's sample project. A small, dependency-free Node library with one
 * function and passing tests, so a real goal can add a feature, test it, and be verified by running
 * `node --test` (no installs, no network).
 */
export const DEMO_GOAL = [
  'Add a slugify(text) function to tiny-text.',
  'It lowercases, trims, removes accents (é becomes e), turns every run of spaces and punctuation into a single dash, and never starts or ends with a dash.',
  'Export it from src/index.js, add tests with node:test in test/, and document it in the README.',
  'Keep the library dependency-free; `node --test` must pass.',
].join(' ');

const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    { name: 'tiny-text', version: '0.1.0', private: true, type: 'module', description: 'Tiny text helpers.', scripts: { test: 'node --test' } },
    null,
    2,
  )}\n`,
  'src/index.js': `/** Number of words in a text (runs of non-space characters). */
export function wordCount(text) {
  const words = String(text).trim().split(/\\s+/).filter(Boolean);
  return words.length;
}
`,
  'test/word-count.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wordCount } from '../src/index.js';

test('counts words', () => {
  assert.equal(wordCount('one two  three'), 3);
});

test('empty text has no words', () => {
  assert.equal(wordCount('   '), 0);
});
`,
  'README.md': `# tiny-text

Tiny, dependency-free text helpers.

## Usage

\`\`\`js
import { wordCount } from './src/index.js';

wordCount('one two three'); // 3
\`\`\`

## Tests

\`\`\`sh
node --test
\`\`\`
`,
  '.gitignore': 'node_modules/\n',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Creates the sample project as a git repo with one commit on `main`; returns its path. */
export function makeSampleProject(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.name', 'Demo');
  git(dir, 'config', 'user.email', 'demo@insectoids.local');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'tiny-text: wordCount');
  return dir;
}

export const sampleGit = git;

/** Runs the sample project's tests; returns { ok, output }. */
export function runSampleTests(dir: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message };
  }
}
