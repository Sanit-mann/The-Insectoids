/**
 * The hive inside the Brain host (Phase 1 Step 8): the single writer runs the Hive too, so brain.db has
 * exactly one writer. This module has no Electron imports, so it is unit-tested under plain Node.
 *
 * It owns the current project (Workspace + Hive + Foreman timer), the engine (Claude Code or the
 * scripted demo), Brain access for insects, and the UI read model (HiveSnapshot): goals, cards,
 * approvals, agent lanes with live output, and an activity log.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Brain, BoardCard, Goal } from '@insectoids/brain';
import {
  ClaudeEngine,
  type ClaudeEvent,
  type ClaudeInstall,
  type BrainAccess,
  type Engine,
  type EngineRequest,
  type EngineResult,
  type EngineRun,
  Hive,
  type HiveEvent,
  Library,
  type ModelTiers,
  type Plan,
  checkClaudeAuth,
  demoEngine,
  detectClaude,
} from '@insectoids/harness';
import type {
  ActivityView,
  AgentView,
  ApprovalView,
  CardView,
  ChangesView,
  CommandResult,
  EngineView,
  GoalView,
  HiveCommand,
  HivePush,
  HiveSnapshot,
  LaneStatus,
  ProjectView,
} from '@insectoids/shared';
import { Workspace } from '@insectoids/workspace';
import type { DoorPaths } from './messages';

const run = promisify(execFile);

const ACTIVITY_MAX = 300;
const LINES_MAX = 200;
const FINISHED_LANES_MAX = 20;
const PATCH_MAX = 400 * 1024;
const LINE_MAX = 300;
const ENGINE_RECHECK_MS = 60_000;
const MODELS: ModelTiers = { strongest: 'opus', standard: 'sonnet', light: 'haiku' };

/** Limits from the user's safety preset (Onboarding 08-D7). Default = Balanced. */
export interface HiveLimits {
  insectCap: number;
  goalBudgetTokens: number;
  approveEveryPlan: boolean;
}
export const DEFAULT_LIMITS: HiveLimits = { insectCap: 3, goalBudgetTokens: 2_000_000, approveEveryPlan: false };

export interface HiveManagerOptions {
  brain: Brain;
  /** Mints and revokes per-run agent tokens (the in-process Brain service). Null: no live Brain tools. */
  tokens: { endpoint: string; issue(g: { agentId: string; shelf: string; write: boolean }): string; revoke(token: string): void } | null;
  doors: (DoorPaths & { cliShimDir?: string; hookLauncher?: { command: string; args: string[] } }) | null;
  userDataDir: string;
  libraryDir: string;
  engine: 'claude' | 'fake';
  /** e2e: use this folder as the project (instead of settings.json). */
  project?: string;
  /** Safety preset limits. Default: Balanced. */
  limits?: HiveLimits;
  push: (p: HivePush) => void;
  log?: (line: string) => void;
  /** Foreman tick interval. Default 1000 ms (500 ms with the demo engine). */
  tickMs?: number;
  /** Tests: replace Claude detection. */
  detect?: () => Promise<ClaudeInstall>;
  auth?: (command: string) => Promise<{ loggedIn: boolean }>;
  /** Tests: a custom engine instead of the demo or Claude. */
  engineOverride?: Engine;
  now?: () => number;
}

interface ProjectState {
  view: ProjectView;
  workspace: Workspace;
  hive: Hive;
  timer: NodeJS.Timeout;
  /** Undo state per goal, refreshed on load and after each undo. */
  undo: Map<string, { cards: Set<string>; goalReset: boolean }>;
}

/** Brain shelf for a project folder: lowercase slug of its name (shelf rules in brain-service). */
export function shelfFor(path: string): string {
  // Split on both separators: path.basename only knows the current OS's, so a Windows path on macOS/Linux
  // (or a POSIX path on Windows) would otherwise give a different shelf for the same folder name.
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[-.]+$/, '');
  return !slug || slug === 'global' ? `project-${slug || 'x'}`.slice(0, 64) : slug;
}

const short = (s: string, n = LINE_MAX): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};
const local = (cardId: string): string => cardId.slice(cardId.indexOf('.') + 1);
const wsId = (card: BoardCard): string => `${local(card.id)}.a${card.attempts}`;
const isInsectRole = (r: EngineRequest['role']): boolean => r !== 'queen' && r !== 'inspector';

/** Engine output as display lines: text, tool calls and short results. */
export function engineLines(e: ClaudeEvent): string[] {
  switch (e.kind) {
    case 'text':
      return e.text.split('\n').map((l) => short(l)).filter(Boolean);
    case 'tool_use': {
      const input = e.input && typeof e.input === 'object' ? JSON.stringify(e.input) : '';
      return [short(`→ ${e.name} ${input}`)];
    }
    case 'tool_result':
      return [short(`${e.isError ? '✗ ' : '← '}${e.content.split('\n')[0] ?? ''}`)];
    default:
      return [];
  }
}

/** Engine that defers to whatever is ready right now; runs fail as "signed out" until then (the Hive pauses). */
class SwitchEngine implements Engine {
  current: Engine | null = null;
  run(req: EngineRequest): EngineRun {
    if (this.current) return this.current.run(req);
    const result: EngineResult = {
      ok: false, error: 'auth', model: req.route.model, models: [], sessionId: null, text: '', stderrTail: 'Claude Code is not ready.',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null,
    };
    return { done: Promise.resolve(result), stop: () => {} };
  }
}

export class HiveManager {
  readonly #o: HiveManagerOptions;
  readonly #now: () => number;
  readonly #engine = new SwitchEngine();
  #engineView: EngineView;
  #engineTimer: NodeJS.Timeout | null = null;
  #project: ProjectState | null = null;
  #paused = false;
  #pausedReason: string | null = null;
  readonly #activity: ActivityView[] = [];
  #activitySeq = 0;
  readonly #lanes = new Map<string, AgentView>();
  /** Card → latest run, so "card blocked" can mark the right lane. */
  readonly #laneByAgentCard = new Map<string, string>();
  #outBuf = new Map<string, string[]>();
  #outTimer: NodeJS.Timeout | null = null;
  #changedTimer: NodeJS.Timeout | null = null;
  #changedReason = '';
  #ticking = false;
  #disposed = false;
  #limits: HiveLimits;

  constructor(o: HiveManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#limits = { ...(o.limits ?? DEFAULT_LIMITS) };
    if (o.engineOverride) {
      this.#engine.current = o.engineOverride;
      this.#engineView = { state: 'fake', name: 'Test engine', version: null, message: 'A scripted test engine.' };
    } else if (o.engine === 'fake') {
      this.#engine.current = demoEngine();
      this.#engineView = { state: 'fake', name: 'Demo engine', version: null, message: 'Scripted demo: no AI calls and no tokens are used.' };
    } else {
      this.#engineView = { state: 'checking', name: 'Claude Code', version: null, message: 'Checking for Claude Code…' };
    }
  }

  /** Restore the project and start checking the engine. Never throws: problems become activity lines. */
  async init(): Promise<void> {
    if (this.#o.engine === 'claude' && !this.#o.engineOverride) void this.#checkEngine();
    const path = this.#o.project ?? this.#readSettings().projectPath;
    if (!path) return;
    try {
      await this.#openProject(path);
    } catch (err) {
      this.#note('error', `Could not open the project ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Apply a safety preset now: the current hive and every project opened later. */
  setLimits(limits: HiveLimits): void {
    if (!Number.isInteger(limits.insectCap) || limits.insectCap < 1) throw new Error('The insect limit must be at least 1.');
    this.#limits = { ...limits };
    this.#project?.hive.configure({ insectCap: limits.insectCap, defaultBudgetTokens: limits.goalBudgetTokens, approveEveryPlan: limits.approveEveryPlan });
    this.#changed('limits');
  }

  get limits(): HiveLimits {
    return { ...this.#limits };
  }

  get project(): ProjectView | null {
    return this.#project?.view ?? null;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#engineTimer) clearTimeout(this.#engineTimer);
    if (this.#outTimer) clearTimeout(this.#outTimer);
    if (this.#changedTimer) clearTimeout(this.#changedTimer);
    await this.#closeProject();
  }

  // ---- commands ------------------------------------------------------------------------------

  async command(cmd: HiveCommand): Promise<CommandResult> {
    try {
      await this.#command(cmd);
      this.#changed(cmd.type);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async #command(cmd: HiveCommand): Promise<void> {
    if (cmd.type === 'setProject') return this.#setProject(cmd.path);
    if (cmd.type === 'pause') return this.#pause(cmd.reason ?? 'Paused by you.');
    if (cmd.type === 'resume') return this.#resume();
    if (cmd.type === 'checkEngine') return this.#recheckEngine();
    const p = this.#mustProject();
    switch (cmd.type) {
      case 'submitGoal': {
        if (this.#engineView.state !== 'ready' && this.#engineView.state !== 'fake') {
          throw new Error(`${this.#engineView.name} is not ready: ${this.#engineView.message}`);
        }
        // Planning can take minutes with a real engine: start it and return. The goal shows up at once.
        void p.hive.submitGoal(cmd.text, cmd.budgetTokens ? { budgetTokens: cmd.budgetTokens } : {}).catch((err: unknown) => {
          this.#note('error', `The Queen could not plan: ${err instanceof Error ? err.message : String(err)}`);
          this.#changed('plan-failed');
        });
        // Let the synchronous part (goal created) run before the UI re-reads.
        await Promise.resolve();
        return;
      }
      case 'approve':
        return p.hive.approve(cmd.approvalId);
      case 'deny':
        return p.hive.deny(cmd.approvalId);
      case 'cancelGoal':
        return p.hive.cancelGoal(this.#ownGoal(cmd.goalId).id);
      case 'undoCard': {
        const card = this.#o.brain.taskboard.get(cmd.cardId);
        if (!card || card.goalId !== this.#ownGoal(cmd.goalId).id) throw new Error(`No card ${cmd.cardId} in this goal.`);
        await p.hive.undoCard(card.id);
        return this.#refreshUndo(p, card.goalId);
      }
      case 'undoGoal':
        await p.hive.undoGoal(this.#ownGoal(cmd.goalId).id);
        return this.#refreshUndo(p, cmd.goalId);
      case 'requestUndoMerge':
        return p.hive.requestUndoMerge(this.#ownGoal(cmd.goalId).id);
      case 'requestRedoMerge':
        return p.hive.requestRedoMerge(this.#ownGoal(cmd.goalId).id);
    }
  }

  #mustProject(): ProjectState {
    if (!this.#project) throw new Error('Pick a project folder first.');
    return this.#project;
  }

  #ownGoal(goalId: string): Goal {
    const g = this.#o.brain.goals.get(goalId);
    if (!g || g.shelf !== this.#project?.view.shelf) throw new Error(`No goal ${goalId} in this project.`);
    return g;
  }

  #pause(reason: string): void {
    this.#paused = true;
    this.#pausedReason = reason;
    this.#project?.hive.pause(reason);
  }

  #resume(): void {
    this.#paused = false;
    this.#pausedReason = null;
    this.#project?.hive.resume();
  }

  // ---- project ---------------------------------------------------------------------------------

  async #setProject(path: string): Promise<void> {
    if (this.#project && this.#working() > 0) throw new Error('Agents are working. Pause the hive and wait for them to stop before switching projects.');
    await this.#openProject(path);
    if (!this.#o.project) this.#writeSettings({ projectPath: this.#project!.view.path });
  }

  async #openProject(path: string): Promise<void> {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`The folder ${path} does not exist.`);
    let top: string;
    try {
      top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: path, windowsHide: true })).stdout.trim();
    } catch {
      throw new Error(`${path} is not a git repository. The hive works on git projects so every change can be reviewed and undone; run "git init" there first.`);
    }
    // Detached HEAD (no branch) is allowed; merges then need the user to check out a branch first.
    const branch = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: top, windowsHide: true }).then(
      (r) => r.stdout.trim() || null,
      () => null,
    );
    try {
      await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: top, windowsHide: true });
    } catch {
      throw new Error(`${top} has no commits yet. Make a first commit, then pick it again.`);
    }
    // git prints forward slashes on Windows; keep the user's own spelling when it is the same folder.
    const root = process.platform === 'win32' ? top.replace(/\//g, '\\') : top;
    const view: ProjectView = { path: root, name: basename(root), shelf: shelfFor(root), branch };

    await this.#closeProject();
    const data = join(this.#o.userDataDir, 'hive');
    const workspace = new Workspace({ repoDir: root, worktreesRoot: join(data, 'worktrees', view.shelf) });
    const hive = new Hive({
      brain: this.#o.brain,
      workspace,
      engine: this.#engine,
      library: new Library(this.#o.libraryDir),
      repoDir: root,
      dataDir: join(data, 'projects', view.shelf),
      shelf: view.shelf,
      home: homedir(),
      models: MODELS,
      insectCap: this.#limits.insectCap,
      defaultBudgetTokens: this.#limits.goalBudgetTokens,
      approveEveryPlan: this.#limits.approveEveryPlan,
      castes: ['coder', 'tester'],
      ...(this.#brainAccess() ? { brainAccess: this.#brainAccess()! } : {}),
      onEvent: (e) => this.#onHiveEvent(e),
    });
    if (this.#paused) hive.pause(this.#pausedReason ?? 'Paused.');
    const tickMs = this.#o.tickMs ?? (this.#o.engine === 'fake' ? 500 : 1_000);
    const timer = setInterval(() => void this.#tick(), tickMs);
    timer.unref?.();
    this.#project = { view, workspace, hive, timer, undo: new Map() };
    for (const g of this.#goals()) await this.#refreshUndo(this.#project, g.id);
    this.#note('project', `Project: ${view.name} (${view.branch ?? 'detached HEAD'}).`);
  }

  async #closeProject(): Promise<void> {
    const p = this.#project;
    if (!p) return;
    this.#project = null;
    clearInterval(p.timer);
    p.hive.pause('Switching project.');
    // Card worktrees stay on disk (they belong to goals in the Brain); nothing is deleted here.
  }

  async #tick(): Promise<void> {
    const p = this.#project;
    if (!p || this.#ticking || this.#disposed) return;
    this.#ticking = true;
    try {
      await p.hive.tick();
    } catch (err) {
      this.#o.log?.(`[hive] tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      this.#ticking = false;
    }
  }

  #brainAccess(): BrainAccess | null {
    const { tokens, doors } = this.#o;
    if (!tokens || !doors || !existsSync(doors.brainMcp)) return null;
    return {
      endpoint: tokens.endpoint,
      doors: { runtime: doors.runtime, mcpScript: doors.brainMcp, ...(doors.cliShimDir ? { cliShimDir: doors.cliShimDir } : {}) },
      grant: (g) => {
        const token = tokens.issue(g);
        return { token, revoke: () => tokens.revoke(token) };
      },
    };
  }

  async #refreshUndo(p: ProjectState, goalId: string): Promise<void> {
    try {
      const s = await p.workspace.undoState(goalId);
      p.undo.set(goalId, { cards: new Set(s.cards.map((c) => `${goalId}.${c.replace(/\.a\d+$/, '')}`)), goalReset: s.goalReset });
    } catch {
      p.undo.delete(goalId);
    }
  }

  // ---- engine ----------------------------------------------------------------------------------

  /** "Check again" (e.g. right after signing in): re-check Claude Code now instead of waiting a minute. */
  async #recheckEngine(): Promise<void> {
    // The demo and test engines are always ready.
    if (this.#o.engine === 'fake' || this.#o.engineOverride) return;
    if (this.#engineTimer) clearTimeout(this.#engineTimer);
    this.#engineTimer = null;
    await this.#checkEngine();
  }

  async #checkEngine(): Promise<void> {
    if (this.#disposed) return;
    const detect = this.#o.detect ?? (() => detectClaude());
    const auth = this.#o.auth ?? ((c: string) => checkClaudeAuth(c));
    let view: EngineView;
    try {
      const install = await detect();
      if (install.status === 'missing') {
        view = { state: 'missing', name: 'Claude Code', version: null, message: 'Claude Code is not installed. Install it from claude.com/claude-code; the hive checks again every minute.' };
      } else if (install.status === 'unsupported') {
        view = { state: 'missing', name: 'Claude Code', version: null, message: install.reason };
      } else if (install.status === 'outdated') {
        view = { state: 'outdated', name: 'Claude Code', version: install.version, message: `Claude Code ${install.version} is older than ${install.minimum}. Run "claude update" in a terminal.` };
      } else if (!(await auth(install.command)).loggedIn) {
        view = { state: 'signed-out', name: 'Claude Code', version: install.version, message: 'Claude Code is signed out. Run "claude auth login" in a terminal; the hive checks again every minute.' };
      } else {
        view = { state: 'ready', name: 'Claude Code', version: install.version, message: `Claude Code ${install.version} is ready.` };
        this.#engine.current = this.#claudeEngine(install.command);
      }
    } catch (err) {
      view = { state: 'missing', name: 'Claude Code', version: null, message: `Could not check Claude Code: ${err instanceof Error ? err.message : String(err)}` };
    }
    const was = this.#engineView.state;
    this.#engineView = view;
    if (view.state !== 'ready') this.#engine.current = null;
    if (was !== view.state) this.#changed('engine');
    if (view.state !== 'ready' && !this.#disposed) {
      this.#engineTimer = setTimeout(() => void this.#checkEngine(), ENGINE_RECHECK_MS);
      this.#engineTimer.unref?.();
    }
  }

  #claudeEngine(command: string): Engine {
    const doors = this.#o.doors;
    return new ClaudeEngine({
      claude: command,
      // The guard hook runs on the app's own executable as Node through a launcher that sets
      // ELECTRON_RUN_AS_NODE for the hook alone. It is never put in Claude's environment: shell
      // commands an insect runs would inherit it and any project that starts Electron would break.
      // (The MCP door gets it through its server env, the brain CLI through its shim.)
      hook: doors?.hookLauncher ?? { command: doors?.runtime.command ?? process.execPath, args: [doors?.guardHook ?? ''] },
      promptDir: join(this.#o.userDataDir, 'hive', 'prompts'),
    });
  }

  // ---- read model ------------------------------------------------------------------------------

  #goals(): Goal[] {
    const shelf = this.#project?.view.shelf;
    if (!shelf) return [];
    return this.#o.brain.goals
      .list()
      .filter((g) => g.shelf === shelf)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  #working(): number {
    let n = 0;
    for (const l of this.#lanes.values()) if (l.status === 'working') n++;
    return n;
  }

  snapshot(): HiveSnapshot {
    const p = this.#project;
    const { brain } = this.#o;
    const goals = this.#goals();
    const goalIds = new Set(goals.map((g) => g.id));
    const cards = goals.flatMap((g) => brain.taskboard.list({ goalId: g.id }).map((c) => this.#cardView(c)));
    const approvals = brain.approvals.list().filter((a) => a.goalId === null || goalIds.has(a.goalId));
    const waiting = approvals.filter((a) => a.status === 'waiting');
    const decided = approvals
      .filter((a) => a.status !== 'waiting')
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
      .slice(0, 30);
    const lanes = [...this.#lanes.values()];
    const running = lanes.filter((l) => l.status === 'working' || l.status === 'blocked');
    const finished = lanes.filter((l) => l.status !== 'working' && l.status !== 'blocked').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, FINISHED_LANES_MAX);
    return {
      project: p?.view ?? null,
      engine: this.#engineView,
      hive: { paused: this.#paused, pausedReason: this.#pausedReason, insectCap: this.#limits.insectCap, working: this.#working() },
      goals: goals.map((g) => this.#goalView(g)),
      cards,
      approvals: [...waiting, ...decided].map(
        (a): ApprovalView => ({
          id: a.id, goalId: a.goalId, kind: a.kind, title: a.title, from: a.from, whyItNeedsYou: a.whyItNeedsYou,
          ifYouSayYes: a.ifYouSayYes, destructive: a.destructive, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt,
        }),
      ),
      agents: [...running.sort((a, b) => a.startedAt - b.startedAt), ...finished],
      activity: [...this.#activity],
    };
  }

  #goalView(g: Goal): GoalView {
    const plan = g.plan as Plan | null;
    return {
      id: g.id,
      title: g.title,
      text: g.text,
      status: g.status,
      plan: plan
        ? {
            summary: plan.summary,
            waves: plan.waves.map((w, i) => ({ n: i + 1, cards: w.cards.map((c) => ({ id: `${g.id}.${c.id}`, title: c.title, caste: c.caste })) })),
          }
        : null,
      currentWave: g.currentWave,
      budgetTokens: g.budgetTokens,
      spentTokens: g.spentTokens,
      spentUsd: g.spentUsd,
      merge: this.#project?.hive.mergeState(g.id) ?? 'not-merged',
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }

  #cardView(c: BoardCard): CardView {
    const undo = this.#project?.undo.get(c.goalId);
    return {
      id: c.id, goalId: c.goalId, wave: c.wave, title: c.title, brief: c.brief, caste: c.caste, priority: c.priority,
      acceptance: c.acceptance, dependsOn: c.dependsOn, status: c.status, claimedBy: c.claimedBy ?? null,
      leaseExpiresAt: c.leaseExpiresAt ?? null, attempts: c.attempts, maxAttempts: c.maxAttempts, escalated: c.escalated,
      result: c.result ?? null,
      undone: c.status === 'done' && Boolean(undo && (undo.goalReset || undo.cards.has(c.id))),
      updatedAt: c.updatedAt,
    };
  }

  async changes(req: { goalId: string; cardId: string }): Promise<ChangesView> {
    const p = this.#mustProject();
    this.#ownGoal(req.goalId);
    const card = this.#o.brain.taskboard.get(req.cardId);
    if (!card || card.goalId !== req.goalId) throw new Error(`No card ${req.cardId} in this goal.`);
    let d: { files: ChangesView['files']; patch: string };
    try {
      d = await p.workspace.diffCard(req.goalId, wsId(card));
    } catch {
      // The card has no workspace yet (still open) or it was never committed.
      return { files: [], patch: '', truncated: false };
    }
    const truncated = Buffer.byteLength(d.patch) > PATCH_MAX;
    return { files: d.files, patch: truncated ? `${Buffer.from(d.patch).subarray(0, PATCH_MAX).toString()}\n… (diff truncated)` : d.patch, truncated };
  }

  /** Newest records on the project shelf (plus global), for the Brain screen without a query. */
  brainRecent(params: { kinds?: Parameters<Brain['recent']>[0]['kinds'] } = {}) {
    const shelf = this.#project?.view.shelf ?? 'global';
    return this.#o.brain.recent({ shelf, ...(params.kinds ? { kinds: params.kinds } : {}), limit: 50 }).map(({ score: _s, ...h }) => h);
  }

  // ---- events → read model ---------------------------------------------------------------------

  #onHiveEvent(e: HiveEvent): void {
    if (e.type === 'engine') {
      const run = e.run;
      if (!run || !e.engineEvent) return;
      const lane = this.#lanes.get(run.runId);
      if (!lane) return;
      if (e.engineEvent.kind === 'init' && e.engineEvent.model) lane.model = e.engineEvent.model;
      const lines = engineLines(e.engineEvent);
      if (lines.length) {
        lane.output = [...lane.output, ...lines].slice(-LINES_MAX);
        this.#queueOutput(run.runId, lines);
      }
      return;
    }
    if (e.type === 'run-started' && e.run) {
      const r = e.run;
      const lane: AgentView = {
        runId: r.runId,
        agentId: e.agentId ?? r.runId,
        role: r.role === 'queen' ? 'queen' : r.role === 'inspector' ? 'inspector' : 'insect',
        caste: isInsectRole(r.role) ? (r.role as AgentView['caste']) : null,
        goalId: e.goalId ?? null,
        cardId: e.cardId ?? null,
        title: r.title,
        model: r.model,
        effort: r.effort,
        status: 'working',
        tokens: 0,
        costUsd: 0,
        startedAt: this.#now(),
        endedAt: null,
        output: [],
      };
      this.#lanes.set(r.runId, lane);
      if (e.agentId && e.cardId) this.#laneByAgentCard.set(`${e.agentId}|${e.cardId}`, r.runId);
      this.#trimLanes();
      this.#changed('run-started');
      return;
    }
    if (e.type === 'run-ended' && e.run) {
      const lane = this.#lanes.get(e.run.runId);
      if (lane) {
        lane.status = e.run.ok ? 'done' : e.run.error === 'stopped' ? 'paused' : 'failed';
        lane.tokens = e.run.tokens ?? lane.tokens;
        lane.costUsd = e.run.costUsd ?? lane.costUsd;
        if (e.run.model) lane.model = e.run.model;
        lane.endedAt = this.#now();
      }
      this.#changed('run-ended');
      return;
    }
    if (e.type === 'card-blocked' && e.agentId && e.cardId) {
      const runId = this.#laneByAgentCard.get(`${e.agentId}|${e.cardId}`);
      const lane = runId ? this.#lanes.get(runId) : undefined;
      if (lane) lane.status = 'blocked';
    }
    if (e.type === 'paused') {
      this.#paused = true;
      this.#pausedReason = e.message;
    }
    if (e.type === 'resumed') {
      this.#paused = false;
      this.#pausedReason = null;
    }
    if (e.type === 'card-undone' || e.type === 'goal-undone') {
      const p = this.#project;
      if (p && e.goalId) void this.#refreshUndo(p, e.goalId).then(() => this.#changed(e.type));
    }
    this.#record(e.type, e.message, e);
    this.#changed(e.type);
  }

  #trimLanes(): void {
    const finished = [...this.#lanes.values()].filter((l) => l.endedAt !== null).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    while (finished.length > FINISHED_LANES_MAX) this.#lanes.delete(finished.shift()!.runId);
  }

  #note(type: string, message: string): void {
    this.#record(type, message, {});
    this.#changed(type);
  }

  #record(type: string, message: string, e: { goalId?: string; cardId?: string; agentId?: string }): void {
    this.#activity.push({
      id: `a${++this.#activitySeq}`,
      at: this.#now(),
      type,
      goalId: e.goalId ?? null,
      cardId: e.cardId ?? null,
      agentId: e.agentId ?? null,
      message: short(message, 500),
    });
    if (this.#activity.length > ACTIVITY_MAX) this.#activity.splice(0, this.#activity.length - ACTIVITY_MAX);
  }

  #queueOutput(runId: string, lines: string[]): void {
    this.#outBuf.set(runId, [...(this.#outBuf.get(runId) ?? []), ...lines]);
    if (this.#outTimer) return;
    this.#outTimer = setTimeout(() => {
      this.#outTimer = null;
      const buf = this.#outBuf;
      this.#outBuf = new Map();
      for (const [id, l] of buf) this.#o.push({ type: 'agent-output', runId: id, lines: l });
    }, 100);
  }

  #changed(reason: string): void {
    this.#changedReason = reason;
    if (this.#changedTimer) return;
    this.#changedTimer = setTimeout(() => {
      this.#changedTimer = null;
      this.#o.push({ type: 'changed', reason: this.#changedReason });
    }, 100);
  }

  // ---- settings --------------------------------------------------------------------------------

  #settingsPath(): string {
    return join(this.#o.userDataDir, 'settings.json');
  }

  #readSettings(): { projectPath?: string } {
    try {
      const raw = JSON.parse(readFileSync(this.#settingsPath(), 'utf8')) as { projectPath?: unknown };
      return typeof raw.projectPath === 'string' ? { projectPath: raw.projectPath } : {};
    } catch {
      return {};
    }
  }

  #writeSettings(next: { projectPath: string }): void {
    mkdirSync(this.#o.userDataDir, { recursive: true });
    writeFileSync(this.#settingsPath(), JSON.stringify({ ...this.#readSettings(), ...next }, null, 2));
  }
}

export type { LaneStatus };
