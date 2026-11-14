import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRACTICE_MARKER, PracticeProjectError, SAMPLE_GOAL_TEXT, ensurePracticeProject } from './practice-project';

/** The practice project for the sample goal (Onboarding 08-D8; Phase 2 C5). Real git, in a temp folder. */
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-practice-'));
  dir = join(root, 'practice-project');
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('the practice project', () => {
  it('is created as a small git repo with one commit, made with its own identity', async () => {
    const r = await ensurePracticeProject(dir);
    expect(r).toEqual({ path: dir, created: true });
    for (const f of ['README.md', 'greet.js', PRACTICE_MARKER]) expect(existsSync(join(dir, f))).toBe(true);
    expect(readFileSync(join(dir, 'greet.js'), 'utf8')).toContain('export function greet(name)');
    expect(git(dir, 'log', '--format=%an <%ae>|%s')).toBe('The Insectoids <practice@insectoids.invalid>|Practice project for the sample goal');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // The identity went in per command: nothing was written to the repo's (or anyone's) config.
    expect(() => git(dir, 'config', '--local', 'user.name')).toThrow();
    expect(SAMPLE_GOAL_TEXT).toMatch(/farewell function/i);
  });

  it('is reused when it is ours and clean', async () => {
    await ensurePracticeProject(dir);
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(await ensurePracticeProject(dir)).toEqual({ path: dir, created: false });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('is made in an empty folder that already exists', async () => {
    mkdirSync(dir);
    expect((await ensurePracticeProject(dir)).created).toBe(true);
  });

  it('never uses a folder that is not ours (no marker), and changes nothing in it', async () => {
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    await expect(ensurePracticeProject(dir)).rejects.toThrow(PracticeProjectError);
    await expect(ensurePracticeProject(dir)).rejects.toThrow(/wasn't made by The Insectoids/);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, PRACTICE_MARKER))).toBe(false);
  });

  it('refuses a file where the folder should be', async () => {
    writeFileSync(dir, 'x');
    await expect(ensurePracticeProject(dir)).rejects.toThrow(/is a file, not a folder/);
  });

  it('refuses ours when it has uncommitted changes, or is no longer its own repo', async () => {
    await ensurePracticeProject(dir);
    writeFileSync(join(dir, 'greet.js'), '// edited\n');
    await expect(ensurePracticeProject(dir)).rejects.toThrow(/changes that were never committed/);
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    await expect(ensurePracticeProject(dir)).rejects.toThrow(/no longer a git repository/);
  });
});
