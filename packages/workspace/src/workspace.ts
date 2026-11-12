import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Merging into the user's own branch needs their explicit approval (Workspace 06-D3). */
export class ApprovalRequiredError extends Error {
  constructor(action: string) {
    super(`${action} needs the user's approval.`);
    this.name = 'ApprovalRequiredError';
  }
}

export interface WorkspaceOptions {
  /** The user's project (their own checkout). The hive never edits it except for approved merges. */
  repoDir: string;
  /** Where card and goal worktrees live: outside the project, so they never show up in it. */
  worktreesRoot: string;
  now?: () => number;
}

export interface GoalInfo {
  goalId: string;
  branch: string;
  baseCommit: string;
  integrationPath: string;
}

export interface CardInfo {
  goalId: string;
  cardId: string;
  branch: string;
  path: string;
  baseCommit: string;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; conflicts: string[] };

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface Approval {
  /** Who approved; null means nobody did. */
  approvedBy: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HIVE_IDENTITY = ['-c', 'user.name=The Insectoids', '-c', 'user.email=hive@insectoids.local'];
const STATUS: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

function assertId(id: string): void {
  if (!ID.test(id) || id.includes('..')) throw new Error(`Invalid id "${id}"`);
}

/**
 * Isolated workspaces for the hive (Workspace & Safety 06).
 * - One git worktree and branch per card, created from the goal's hive branch.
 * - The harness is the single committer and the only one that merges.
 * - Cards merge into hive/<goal>; the user's branch changes only with approval.
 * - Undo by revert or reset to a checkpoint; old work is kept under archive refs, never deleted.
 */
export class Workspace {
  readonly #repo: string;
  readonly #root: string;
  readonly #now: () => number;

  constructor(opts: WorkspaceOptions) {
    this.#repo = opts.repoDir;
    this.#root = opts.worktreesRoot;
    this.#now = opts.now ?? Date.now;
  }

  #queue: Promise<unknown> = Promise.resolve();

  /**
   * Single committer (Workspace 06-D3): every git operation runs strictly one at a time,
   * so parallel insects and inspectors never collide in the same repository.
   */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  startGoal(goalId: string, baseRef = 'HEAD'): Promise<GoalInfo> {
    return this.#serial(() => this.#startGoalImpl(goalId, baseRef));
  }

  createCard(goalId: string, cardId: string, opts: { linkDependencies?: string[] } = {}): Promise<CardInfo> {
    return this.#serial(() => this.#createCardImpl(goalId, cardId, opts));
  }

  /** Commit everything the insect changed in its worktree. Returns null when nothing changed. */
  commitCard(goalId: string, cardId: string, c: { message: string; insect: string }): Promise<string | null> {
    return this.#serial(() => this.#commitCardImpl(goalId, cardId, c));
  }

  /** Merge a verified card into the goal's hive branch. Conflicts are reported, never forced. */
  mergeCard(goalId: string, cardId: string, title: string): Promise<MergeResult> {
    return this.#serial(() => this.#mergeCardImpl(goalId, cardId, title));
  }

  /** Undo one card: revert its merge if it was merged, otherwise just drop its workspace. */
  undoCard(goalId: string, cardId: string): Promise<void> {
    return this.#serial(() => this.#undoCardImpl(goalId, cardId));
  }

  /** Undo a whole goal: archive the hive branch tip, then return it to the goal's checkpoint. */
  undoGoal(goalId: string): Promise<string> {
    return this.#serial(() => this.#undoGoalImpl(goalId));
  }

  /** Merge the goal into the user's branch. Needs approval and a clean project folder. */
  mergeIntoMain(goalId: string, approval: Approval, target = 'main'): Promise<string> {
    return this.#serial(() => this.#mergeIntoMainImpl(goalId, approval, target));
  }

  /** Revert a goal's merge into the user's branch. Also needs approval. */
  undoMainMerge(goalId: string, approval: Approval, target = 'main'): Promise<void> {
    return this.#serial(() => this.#undoMainMergeImpl(goalId, approval, target));
  }

  diffCard(goalId: string, cardId: string): Promise<{ files: FileChange[]; patch: string }> {
    return this.#serial(() => this.#diffCardImpl(goalId, cardId));
  }

  /** Remove a card's worktree. Dependency links are unlinked first so their targets are never touched. */
  removeCard(goalId: string, cardId: string): Promise<void> {
    return this.#serial(() => this.#removeCardImpl(goalId, cardId));
  }

  /** Release every worktree this hive created (branches and refs stay as history). */
  dispose(): Promise<void> {
    return this.#serial(() => this.#disposeImpl());
  }

  async #startGoalImpl(goalId: string, baseRef = 'HEAD'): Promise<GoalInfo> {
    assertId(goalId);
    const base = await this.#git(this.#repo, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    const branch = `hive/${goalId}`;
    await this.#git(this.#repo, ['branch', branch, base]);
    await this.#git(this.#repo, ['update-ref', this.#ref(goalId, 'base'), base]);
    const integrationPath = join(this.#root, goalId, '_integration');
    mkdirSync(join(this.#root, goalId), { recursive: true });
    await this.#git(this.#repo, ['worktree', 'add', integrationPath, branch]);
    return { goalId, branch, baseCommit: base, integrationPath };
  }

  async goal(goalId: string): Promise<GoalInfo> {
    assertId(goalId);
    return {
      goalId,
      branch: `hive/${goalId}`,
      baseCommit: await this.#git(this.#repo, ['rev-parse', this.#ref(goalId, 'base')]),
      integrationPath: join(this.#root, goalId, '_integration'),
    };
  }

  async #createCardImpl(goalId: string, cardId: string, opts: { linkDependencies?: string[] } = {}): Promise<CardInfo> {
    assertId(goalId);
    assertId(cardId);
    const from = await this.#git(this.#repo, ['rev-parse', `hive/${goalId}`]);
    const branch = this.#cardBranch(goalId, cardId);
    const path = join(this.#root, goalId, cardId);
    await this.#git(this.#repo, ['worktree', 'add', '-b', branch, path, from]);
    await this.#git(this.#repo, ['update-ref', this.#ref(goalId, `cards/${cardId}/base`), from]);
    for (const name of opts.linkDependencies ?? []) {
      assertId(name);
      const src = join(this.#repo, name);
      if (existsSync(src) && !existsSync(join(path, name))) {
        symlinkSync(src, join(path, name), process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
    return { goalId, cardId, branch, path, baseCommit: from };
  }

  /** Commit everything the insect changed in its worktree. Returns null when nothing changed. */
  async #commitCardImpl(goalId: string, cardId: string, c: { message: string; insect: string }): Promise<string | null> {
    const path = this.#cardPath(goalId, cardId);
    const excludes = this.#links(path).map((name) => `:(exclude)${name}`);
    await this.#git(path, ['add', '-A', '--', '.', ...excludes]);
    const staged = await this.#git(path, ['diff', '--cached', '--name-only']);
    if (!staged) return null;
    const message = `${c.message}\n\nInsect: ${c.insect}\nCard: ${cardId}`;
    await this.#git(path, [...HIVE_IDENTITY, 'commit', '-q', '-m', message]);
    return this.#git(path, ['rev-parse', 'HEAD']);
  }

  /** Merge a verified card into the goal's hive branch. Conflicts are reported, never forced. */
  async #mergeCardImpl(goalId: string, cardId: string, title: string): Promise<MergeResult> {
    assertId(goalId);
    assertId(cardId);
    const integration = join(this.#root, goalId, '_integration');
    const msg = `Merge card ${cardId}: ${title}`;
    try {
      await this.#git(integration, [...HIVE_IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', msg, this.#cardBranch(goalId, cardId)]);
    } catch {
      const conflicts = (await this.#git(integration, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      await this.#git(integration, ['merge', '--abort']);
      return { ok: false, conflicts };
    }
    const sha = await this.#git(integration, ['rev-parse', 'HEAD']);
    await this.#git(this.#repo, ['update-ref', this.#ref(goalId, `cards/${cardId}/merge`), sha]);
    return { ok: true, sha };
  }

  /** Undo one card: revert its merge if it was merged, otherwise just drop its workspace. */
  async #undoCardImpl(goalId: string, cardId: string): Promise<void> {
    assertId(goalId);
    assertId(cardId);
    const mergeSha = await this.#tryGit(this.#repo, ['rev-parse', '--verify', '--quiet', this.#ref(goalId, `cards/${cardId}/merge`)]);
    if (!mergeSha) {
      await this.#removeCardImpl(goalId, cardId);
      return;
    }
    const integration = join(this.#root, goalId, '_integration');
    await this.#git(integration, [...HIVE_IDENTITY, 'revert', '-m', '1', '--no-edit', mergeSha]);
    await this.#git(this.#repo, ['update-ref', this.#ref(goalId, `cards/${cardId}/undone`), mergeSha]);
  }

  /** Undo a whole goal: archive the hive branch tip, then return it to the goal's checkpoint. */
  async #undoGoalImpl(goalId: string): Promise<string> {
    const goal = await this.goal(goalId);
    const tip = await this.#git(this.#repo, ['rev-parse', goal.branch]);
    const archive = `refs/insectoids/archive/${goalId}/${this.#now()}`;
    await this.#git(this.#repo, ['update-ref', archive, tip]);
    await this.#git(goal.integrationPath, ['reset', '-q', '--hard', goal.baseCommit]);
    return archive;
  }

  /** Merge the goal into the user's branch. Needs approval and a clean project folder. */
  async #mergeIntoMainImpl(goalId: string, approval: Approval, target = 'main'): Promise<string> {
    if (!approval.approvedBy) throw new ApprovalRequiredError(`Merging goal ${goalId} into ${target}`);
    await this.#assertUserCheckoutReady(target);
    const identity = await this.#userIdentityOrHive();
    try {
      await this.#git(this.#repo, [...identity, 'merge', '--no-ff', '--no-edit', '-m', `Merge hive goal ${goalId}`, `hive/${goalId}`]);
    } catch (err) {
      await this.#tryGit(this.#repo, ['merge', '--abort']);
      throw new Error(`Merging goal ${goalId} into ${target} hit conflicts; nothing was changed.`, { cause: err });
    }
    const sha = await this.#git(this.#repo, ['rev-parse', 'HEAD']);
    await this.#git(this.#repo, ['update-ref', this.#ref(goalId, 'main-merge'), sha]);
    return sha;
  }

  /** Revert a goal's merge into the user's branch. Also needs approval. */
  async #undoMainMergeImpl(goalId: string, approval: Approval, target = 'main'): Promise<void> {
    if (!approval.approvedBy) throw new ApprovalRequiredError(`Undoing goal ${goalId} in ${target}`);
    assertId(goalId);
    await this.#assertUserCheckoutReady(target);
    const sha = await this.#git(this.#repo, ['rev-parse', this.#ref(goalId, 'main-merge')]);
    const identity = await this.#userIdentityOrHive();
    await this.#git(this.#repo, [...identity, 'revert', '-m', '1', '--no-edit', sha]);
  }

  async #diffCardImpl(goalId: string, cardId: string): Promise<{ files: FileChange[]; patch: string }> {
    assertId(goalId);
    assertId(cardId);
    const base = await this.#git(this.#repo, ['rev-parse', this.#ref(goalId, `cards/${cardId}/base`)]);
    const branch = this.#cardBranch(goalId, cardId);
    const files = (await this.#git(this.#repo, ['diff', '--name-status', base, branch]))
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [code = '', ...paths] = line.split('\t');
        return { path: paths.at(-1) ?? '', status: STATUS[code[0] ?? ''] ?? 'modified' };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    const patch = await this.#git(this.#repo, ['diff', base, branch]);
    return { files, patch };
  }

  /** Remove a card's worktree. Dependency links are unlinked first so their targets are never touched. */
  async #removeCardImpl(goalId: string, cardId: string): Promise<void> {
    const path = this.#cardPath(goalId, cardId);
    if (!existsSync(path)) return;
    for (const name of this.#links(path)) {
      const link = join(path, name);
      try {
        unlinkSync(link);
      } catch {
        rmdirSync(link); // Windows directory junction
      }
    }
    await this.#git(this.#repo, ['worktree', 'remove', '--force', path]);
  }

  /** Release every worktree this hive created (branches and refs stay as history). */
  async #disposeImpl(): Promise<void> {
    if (!existsSync(this.#root)) return;
    for (const goal of readdirSync(this.#root)) {
      if (!ID.test(goal)) continue;
      for (const entry of readdirSync(join(this.#root, goal))) {
        if (entry === '_integration' || !ID.test(entry)) continue;
        await this.#removeCardImpl(goal, entry);
      }
      const integration = join(this.#root, goal, '_integration');
      if (existsSync(integration)) await this.#tryGit(this.#repo, ['worktree', 'remove', '--force', integration]);
    }
    await this.#tryGit(this.#repo, ['worktree', 'prune']);
  }

  #links(path: string): string[] {
    return readdirSync(path).filter((name) => lstatSync(join(path, name)).isSymbolicLink());
  }

  async #assertUserCheckoutReady(target: string): Promise<void> {
    const branch = await this.#tryGit(this.#repo, ['symbolic-ref', '--short', 'HEAD']);
    if (branch !== target) throw new Error(`Your project is on "${branch ?? 'a detached HEAD'}", not "${target}"; switch to ${target} first.`);
    const status = await this.#git(this.#repo, ['status', '--porcelain', '--untracked-files=no']);
    if (status) throw new Error(`Your project has uncommitted changes; commit or stash them first so nothing of yours is touched.`);
  }

  async #userIdentityOrHive(): Promise<string[]> {
    const email = await this.#tryGit(this.#repo, ['config', 'user.email']);
    return email ? [] : HIVE_IDENTITY;
  }

  /** Where a card's worktree lives (whether or not it exists yet). */
  cardPath(goalId: string, cardId: string): string {
    return this.#cardPath(goalId, cardId);
  }

  #cardPath(goalId: string, cardId: string): string {
    assertId(goalId);
    assertId(cardId);
    return join(this.#root, goalId, cardId);
  }

  #cardBranch(goalId: string, cardId: string): string {
    return `hive-card/${goalId}/${cardId}`;
  }

  #ref(goalId: string, name: string): string {
    return `refs/insectoids/goals/${goalId}/${name}`;
  }

  async #git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await run('git', ['-c', 'core.quotepath=off', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  }

  async #tryGit(cwd: string, args: string[]): Promise<string | null> {
    try {
      return await this.#git(cwd, args);
    } catch {
      return null;
    }
  }
}
