import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRequiredError, Workspace } from './workspace';

let root: string;
let repo: string;
let ws: Workspace;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
// Git may convert line endings on checkout (core.autocrlf on Windows); compare text, not line endings.
const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-ws-'));
  repo = join(root, 'my project');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'user@example.com');
  writeFileSync(join(repo, 'app.txt'), 'v1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'hive-worktrees'), now: () => 1_700_000_000_000 });
});

afterEach(async () => {
  await ws.dispose();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('goals and cards get their own workspaces (Workspace 06-D2)', () => {
  it('starting a goal creates its hive branch at the base and records the checkpoint', async () => {
    const goal = await ws.startGoal('G-1');
    expect(goal.branch).toBe('hive/G-1');
    expect(git(repo, 'rev-parse', 'hive/G-1')).toBe(git(repo, 'rev-parse', 'main'));
    expect(goal.baseCommit).toBe(git(repo, 'rev-parse', 'main'));
  });

  it('each card gets its own worktree; edits there never touch your project folder', async () => {
    await ws.startGoal('G-1');
    const card = await ws.createCard('G-1', 'C-01');
    expect(card.branch).toBe('hive-card/G-1/C-01');
    writeFileSync(join(card.path, 'app.txt'), 'v2 from card\n');
    expect(read(repo, 'app.txt')).toBe('v1\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('two cards work in parallel without seeing each other', async () => {
    await ws.startGoal('G-1');
    const a = await ws.createCard('G-1', 'C-01');
    const b = await ws.createCard('G-1', 'C-02');
    writeFileSync(join(a.path, 'a.txt'), 'from a\n');
    expect(existsSync(join(b.path, 'a.txt'))).toBe(false);
  });

  it('links the project dependencies into a card instead of reinstalling', async () => {
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    await ws.startGoal('G-1');
    const card = await ws.createCard('G-1', 'C-01', { linkDependencies: ['node_modules'] });
    expect(read(card.path, join('node_modules', 'left-pad', 'index.js'))).toContain('module.exports');
  });

  it('removing a card workspace never deletes your real dependencies through the link', async () => {
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    await ws.startGoal('G-1');
    const card = await ws.createCard('G-1', 'C-01', { linkDependencies: ['node_modules'] });
    await ws.removeCard('G-1', 'C-01');
    expect(existsSync(card.path)).toBe(false);
    expect(read(repo, join('node_modules', 'left-pad', 'index.js'))).toContain('module.exports');
  });

  it('a linked dependency folder is never committed', async () => {
    mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    await ws.startGoal('G-1');
    const card = await ws.createCard('G-1', 'C-01', { linkDependencies: ['node_modules'] });
    writeFileSync(join(card.path, 'app.txt'), 'v2\n');
    await ws.commitCard('G-1', 'C-01', { message: 'x', insect: 'Ant-1' });
    expect(git(card.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('app.txt');
  });

  it('refuses ids that could escape into git arguments or paths', async () => {
    await expect(ws.startGoal('../evil')).rejects.toThrow(/invalid id/i);
    await ws.startGoal('G-1');
    await expect(ws.createCard('G-1', '--force')).rejects.toThrow(/invalid id/i);
  });
});

describe('the harness is the single committer (Workspace 06-D3)', () => {
  it('commits a card with the hive identity and the insect named in a trailer', async () => {
    await ws.startGoal('G-1');
    const card = await ws.createCard('G-1', 'C-01');
    writeFileSync(join(card.path, 'app.txt'), 'v2\n');
    const sha = await ws.commitCard('G-1', 'C-01', { message: 'Update app', insect: 'Ant-07' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(card.path, 'log', '-1', '--format=%an|%ae')).toBe('The Insectoids|hive@insectoids.local');
    expect(git(card.path, 'log', '-1', '--format=%B')).toContain('Insect: Ant-07');
  });

  it('returns null when a card changed nothing', async () => {
    await ws.startGoal('G-1');
    await ws.createCard('G-1', 'C-01');
    expect(await ws.commitCard('G-1', 'C-01', { message: 'noop', insect: 'Ant-07' })).toBeNull();
  });

  it('merges a verified card into the hive branch and leaves main alone', async () => {
    await ws.startGoal('G-1');
    const card = await ws.createCard('G-1', 'C-01');
    writeFileSync(join(card.path, 'pricing.txt'), 'three plans\n');
    await ws.commitCard('G-1', 'C-01', { message: 'Pricing page', insect: 'Ant-07' });
    const res = await ws.mergeCard('G-1', 'C-01', 'Pricing page');
    expect(res.ok).toBe(true);
    expect(git(repo, 'show', 'hive/G-1:pricing.txt')).toBe('three plans');
    expect(git(repo, 'rev-parse', 'main')).toBe((await ws.goal('G-1')).baseCommit);
  });

  it('a later card starts from the hive branch, so it sees earlier merged cards', async () => {
    await ws.startGoal('G-1');
    const a = await ws.createCard('G-1', 'C-01');
    writeFileSync(join(a.path, 'pricing.txt'), 'three plans\n');
    await ws.commitCard('G-1', 'C-01', { message: 'Pricing', insect: 'Ant-07' });
    await ws.mergeCard('G-1', 'C-01', 'Pricing');
    const b = await ws.createCard('G-1', 'C-02');
    expect(read(b.path, 'pricing.txt')).toBe('three plans\n');
  });

  it('a conflicting card is reported, not forced in, and the hive branch stays clean', async () => {
    await ws.startGoal('G-1');
    const a = await ws.createCard('G-1', 'C-01');
    const b = await ws.createCard('G-1', 'C-02');
    writeFileSync(join(a.path, 'app.txt'), 'from a\n');
    writeFileSync(join(b.path, 'app.txt'), 'from b\n');
    await ws.commitCard('G-1', 'C-01', { message: 'A', insect: 'Ant-1' });
    await ws.commitCard('G-1', 'C-02', { message: 'B', insect: 'Ant-2' });
    expect((await ws.mergeCard('G-1', 'C-01', 'A')).ok).toBe(true);
    const res = await ws.mergeCard('G-1', 'C-02', 'B');
    expect(res).toEqual({ ok: false, conflicts: ['app.txt'] });
    expect(git(repo, 'show', 'hive/G-1:app.txt')).toBe('from a');
  });
});

describe('undo at card, wave and goal level (Workspace 06-D6)', () => {
  const doCard = async (id: string, file: string, text: string) => {
    const c = await ws.createCard('G-1', id);
    writeFileSync(join(c.path, file), text);
    await ws.commitCard('G-1', id, { message: id, insect: 'Ant-1' });
    await ws.mergeCard('G-1', id, id);
  };

  it('undoing a merged card reverts it and keeps the history', async () => {
    await ws.startGoal('G-1');
    await doCard('C-01', 'pricing.txt', 'three plans\n');
    await doCard('C-02', 'blog.txt', 'posts\n');
    await ws.undoCard('G-1', 'C-01');
    expect(() => git(repo, 'show', 'hive/G-1:pricing.txt')).toThrow();
    expect(git(repo, 'show', 'hive/G-1:blog.txt')).toBe('posts');
    expect(git(repo, 'log', '--format=%s', 'hive/G-1')).toContain('Merge card C-01');
  });

  it('undoing a whole goal returns the hive branch to its checkpoint and archives the work', async () => {
    const goal = await ws.startGoal('G-1');
    await doCard('C-01', 'pricing.txt', 'three plans\n');
    const tip = git(repo, 'rev-parse', 'hive/G-1');
    const archive = await ws.undoGoal('G-1');
    expect(git(repo, 'rev-parse', 'hive/G-1')).toBe(goal.baseCommit);
    expect(git(repo, 'rev-parse', archive)).toBe(tip);
  });
});

describe('merging into your main branch needs your approval (Workspace 06-D3)', () => {
  beforeEach(async () => {
    await ws.startGoal('G-1');
    const c = await ws.createCard('G-1', 'C-01');
    writeFileSync(join(c.path, 'pricing.txt'), 'three plans\n');
    await ws.commitCard('G-1', 'C-01', { message: 'Pricing', insect: 'Ant-1' });
    await ws.mergeCard('G-1', 'C-01', 'Pricing');
  });

  it('refuses without approval', async () => {
    await expect(ws.mergeIntoMain('G-1', { approvedBy: null })).rejects.toThrow(ApprovalRequiredError);
    expect(existsSync(join(repo, 'pricing.txt'))).toBe(false);
  });

  it('merges with approval', async () => {
    const sha = await ws.mergeIntoMain('G-1', { approvedBy: 'user' });
    expect(git(repo, 'rev-parse', 'main')).toBe(sha);
    expect(read(repo, 'pricing.txt')).toBe('three plans\n');
  });

  it('refuses when you have uncommitted work in your project, so nothing of yours is touched', async () => {
    writeFileSync(join(repo, 'app.txt'), 'my unsaved edit\n');
    await expect(ws.mergeIntoMain('G-1', { approvedBy: 'user' })).rejects.toThrow(/uncommitted/);
    expect(read(repo, 'app.txt')).toBe('my unsaved edit\n');
  });

  it('a merge into main can itself be undone (with approval)', async () => {
    await ws.mergeIntoMain('G-1', { approvedBy: 'user' });
    await ws.undoMainMerge('G-1', { approvedBy: 'user' });
    expect(existsSync(join(repo, 'pricing.txt'))).toBe(false);
  });
});

describe('changes view', () => {
  it('lists what a card changed against its checkpoint', async () => {
    await ws.startGoal('G-1');
    const c = await ws.createCard('G-1', 'C-01');
    writeFileSync(join(c.path, 'app.txt'), 'v2\n');
    writeFileSync(join(c.path, 'new.txt'), 'hello\n');
    await ws.commitCard('G-1', 'C-01', { message: 'x', insect: 'Ant-1' });
    const d = await ws.diffCard('G-1', 'C-01');
    expect(d.files).toEqual([
      { path: 'app.txt', status: 'modified' },
      { path: 'new.txt', status: 'added' },
    ]);
    expect(d.patch).toContain('+v2');
  });
});
