import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

/**
 * The practice project for the optional sample goal (Onboarding 08-D8; Phase 2 C5): a tiny git repo under the
 * app's data folder, so the user can watch the hive plan, work, get checked and finish without touching their
 * own files. A marker file proves the folder is ours; anything else with that name is never used.
 */
export const PRACTICE_DIR_NAME = 'practice-project';
export const PRACTICE_MARKER = '.insectoids-practice';

/** The one small sample goal (08-D8). */
export const SAMPLE_GOAL_TEXT = 'Add a farewell function next to greet in greet.js, with a short doc comment.';

/** Commits in the practice repo use this identity, passed per command: the user's git config is never touched. */
const IDENTITY = ['-c', 'user.name=The Insectoids', '-c', 'user.email=practice@insectoids.invalid', '-c', 'commit.gpgsign=false'];

const README = `# Practice project

A small practice project made by The Insectoids for the sample goal. The hive works here instead of in your
own projects, so you can watch it plan, work, get checked and finish. You can delete this folder at any time.
`;

const GREET = `/** Returns a friendly greeting for \`name\`. */
export function greet(name) {
  return \`Hello, \${name}!\`;
}
`;

const MARKER = `This folder was made by The Insectoids as a practice project for the sample goal.
The app only reuses it while this file is here.
`;

export class PracticeProjectError extends Error {}

export type Git = (cwd: string, args: string[]) => Promise<string>;

const execFileP = promisify(execFile);
export const runGit: Git = async (cwd, args) => {
  // GIT_CONFIG_NOSYSTEM keeps machine-wide hooks and settings out; the user's global config is only read.
  const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  return stdout.trim();
};

const same = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    try {
      return realpathSync.native(p).replace(/\\/g, '/').toLowerCase();
    } catch {
      return resolve(p).replace(/\\/g, '/').toLowerCase();
    }
  };
  return norm(a) === norm(b);
};

/**
 * Create the practice project in `dir`, or reuse it when it is ours (marker file), a git repo of its own and
 * clean (no changes to tracked files). Throws a PracticeProjectError in plain words otherwise.
 */
export async function ensurePracticeProject(dir: string, git: Git = runGit): Promise<{ path: string; created: boolean }> {
  const path = resolve(dir);
  const exists = existsSync(path);
  if (exists && !statSync(path).isDirectory()) {
    throw new PracticeProjectError(`${path} is a file, not a folder. Remove or rename it to try the sample goal.`);
  }
  const empty = !exists || readdirSync(path).length === 0;
  if (!empty) {
    if (!existsSync(join(path, PRACTICE_MARKER))) {
      throw new PracticeProjectError(
        `A folder named ${PRACTICE_DIR_NAME} already exists in the app's data and wasn't made by The Insectoids, so it won't be used. Rename or remove it to try the sample goal.`,
      );
    }
    const top = await git(path, ['rev-parse', '--show-toplevel']).catch(() => '');
    if (!top || !same(top, path)) {
      throw new PracticeProjectError('The practice project is no longer a git repository of its own. Remove the folder and try again; it will be made fresh.');
    }
    const changes = await git(path, ['status', '--porcelain', '--untracked-files=no']);
    if (changes) {
      throw new PracticeProjectError('The practice project has changes that were never committed. Undo them or remove the folder, then try again.');
    }
    return { path, created: false };
  }

  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'README.md'), README);
  writeFileSync(join(path, 'greet.js'), GREET);
  writeFileSync(join(path, PRACTICE_MARKER), MARKER);
  await git(path, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  await git(path, ['add', '-A']);
  await git(path, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', 'Practice project for the sample goal']);
  return { path, created: true };
}
