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
  type ClaudeEvent,
  type ClaudeInstall,
  type BrainAccess,
  type Engine,
  type EngineAdapter,
  type GeminiAuth,
  type GeminiInstall,
  EngineRegistry,
  type EngineRequest,
  Hive,
  type HiveEvent,
  Library,
  type ModelTiers,
  type Plan,
  type ServiceAccess,
  claudeAdapter,
  demoEngine,
  fakeAdapter,
  geminiAdapter,
  opencodeAdapter,
  type LlmAccess,
  type OpenCodeInstall,
  type ReadyProvider,
  headlineFrom,
  plannedAdapters,
  routeCard,
  type LimitState,
  LIMIT_PAUSE,
  DEFAULT_LIMIT_WAIT_MS,
  formatClock,
  seededRng,
} from '@insectoids/harness';
import {
  type ActivityView,
  type AgentView,
  type ApprovalView,
  type CardView,
  type ChangesView,
  type CommandResult,
  type EngineView,
  type GoalView,
  type HiveCommand,
  type HivePush,
  type HiveSnapshot,
  type LaneStatus,
  type ProjectView,
  type EngineId,
  EngineIdSchema,
  type EngineCard,
  type EngineUsage,
} from '@insectoids/shared';
import { Workspace } from '@insectoids/workspace';
import type { DoorPaths } from './messages';

const run = promisify(execFile);

/** Without main's broker (tests without it): OpenCode can't get a pass, so its runs refuse. */
const NO_LLM: LlmAccess = {
  issue: async () => {
    throw new Error('No model-provider broker here.');
  },
  usage: async () => null,
  revoke: async () => {},
};

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
  /** Outside services through the secret broker in main (Phase 2 A3). Absent: cards run without services. */
  services?: ServiceAccess;
  /** OpenCode's model providers (Phase 2 A4): per-run broker passes and the ready providers, both from main. */
  llm?: LlmAccess;
  providers?: () => Promise<ReadyProvider[]>;
  push: (p: HivePush) => void;
  log?: (line: string) => void;
  /** Foreman tick interval. Default 1000 ms (500 ms with the demo engine). */
  tickMs?: number;
  /** Tests: replace Claude detection (and the sign-in check, with `auth`). */
  detect?: () => Promise<ClaudeInstall>;
  auth?: (command: string) => Promise<{ loggedIn: boolean }>;
  /** Tests: replace Gemini CLI detection and its sign-in check. Without them a test machine's own install would be checked. */
  geminiDetect?: () => Promise<GeminiInstall>;
  geminiAuth?: () => GeminiAuth;
  /** Tests: replace OpenCode detection and the machine-wide config check. */
  opencodeDetect?: () => Promise<OpenCodeInstall>;
  opencodeSystemConfig?: () => string | null;
  /** Tests: a custom engine instead of the demo or Claude. */
  engineOverride?: Engine;
  now?: () => number;
  /** Seed for the Treasurer's learning router (tests). Default: the clock. */
  seed?: number;
}

const HOUR = 3600_000;
/** Share of a cap at which an engine counts as "near" (the Treasurer uses it less). */
const NEAR_SHARE = 0.8;

/** The user's own spending limits for one engine's subscription (04-D7). */
interface EngineLimits {
  cap5hUsd: number | null;
  cap7dUsd: number | null;
}

/** The host's own settings file (the project and engine choices); app-wide settings live in main's app.json. */
interface HostSettings {
  projectPath?: string;
  engines?: { order: EngineId[]; disabled: EngineId[] };
  /** Soft caps per engine (Treasurer v2, Phase 2 A5). */
  limits?: Partial<Record<EngineId, EngineLimits>>;
  /** Vendor limits hit: engine -> when the hive may use it again (epoch ms). */
  limitHits?: Partial<Record<EngineId, number>>;
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

export class HiveManager {
  readonly #o: HiveManagerOptions;
  readonly #now: () => number;
  readonly #engines: EngineRegistry;
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
  /** User caps per engine and vendor limit hits (persisted in the host settings). */
  #engineLimits: Partial<Record<EngineId, EngineLimits>>;
  #limitHits: Partial<Record<EngineId, number>>;

  constructor(o: HiveManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#limits = { ...(o.limits ?? DEFAULT_LIMITS) };
    const settings = this.#readSettings();
    this.#engines = new EngineRegistry(this.#adapters(), settings.engines ?? {});
    this.#engineLimits = settings.limits ?? {};
    this.#limitHits = settings.limitHits ?? {};
    // The Treasurer (Phase 2 A5): limits steer the router, outcomes teach it.
    this.#engines.setLimitState((id) => this.#limitState(id));
    this.#engines.setLearning({ stats: (role) => o.brain.outcomes.stats(role), rng: seededRng(o.seed ?? this.#now()) });
  }

  /**
   * The engines this hive knows. With the scripted engine (tests, e2e, demos) it is the only one that can
   * run: Claude Code is listed but never checked or run there, so a test can never spend real tokens.
   */
  #adapters(): EngineAdapter[] {
    const scripted = this.#o.engineOverride
      ? fakeAdapter(this.#o.engineOverride, { name: 'Test engine', message: 'A scripted test engine.' })
      : this.#o.engine === 'fake'
        ? fakeAdapter(demoEngine())
        : null;
    const doors = this.#o.doors;
    const claude = claudeAdapter({
      // The guard hook runs on the app's own executable as Node through a launcher that sets
      // ELECTRON_RUN_AS_NODE for the hook alone. It is never put in Claude's environment: shell
      // commands an insect runs would inherit it and any project that starts Electron would break.
      // (The MCP door gets it through its server env, the brain CLI through its shim.)
      hook: doors?.hookLauncher ?? { command: doors?.runtime.command ?? process.execPath, args: [doors?.guardHook ?? ''] },
      promptDir: join(this.#o.userDataDir, 'hive', 'prompts'),
      ...(this.#o.detect ? { detect: this.#o.detect } : {}),
      ...(this.#o.auth ? { auth: this.#o.auth } : {}),
    });
    const gemini = geminiAdapter({
      // Guarded tools over MCP: Gemini CLI's own hooks fail open, so its built-in tools are denied by policy
      // and every change goes through these. Without the bundle Gemini only gets read-only work.
      hiveTools: doors?.hiveTools ?? null,
      runBase: join(this.#o.userDataDir, 'hive', 'gemini-runs'),
      ...(this.#o.geminiDetect ? { detect: this.#o.geminiDetect } : {}),
      ...(this.#o.geminiAuth ? { auth: this.#o.geminiAuth } : {}),
    });
    const opencode = opencodeAdapter({
      // Built-in tools off by config; file and shell work through the guarded hive tools; the provider key
      // stays in main (OpenCode talks to the broker with a per-run pass).
      hiveTools: doors?.hiveTools ?? null,
      runtime: doors?.runtime ?? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
      runBase: join(this.#o.userDataDir, 'hive', 'opencode-runs'),
      providers: this.#o.providers ?? (async () => []),
      llm: this.#o.llm ?? NO_LLM,
      ...(this.#o.opencodeDetect ? { detect: this.#o.opencodeDetect } : {}),
      ...(this.#o.opencodeSystemConfig ? { systemConfig: this.#o.opencodeSystemConfig } : {}),
    });
    if (!scripted) return [claude, gemini, ...plannedAdapters(), opencode];
    const listedOnly = (a: EngineAdapter): EngineAdapter => ({
      id: a.id,
      name: a.name,
      vendor: a.vendor,
      capabilities: a.capabilities,
      models: a.models,
      availableIn: a.availableIn,
      install: a.install,
      signIn: a.signIn,
      privacyNote: a.privacyNote,
      detect: async () => ({ state: 'missing', version: null, message: 'Not checked: the scripted engine runs everything here.' }),
    });
    // In tests, OpenCode is real only when the test gave it its own detection (a stand-in binary).
    return [scripted, listedOnly(claude), listedOnly(gemini), ...plannedAdapters(), this.#o.opencodeDetect ? opencode : listedOnly(opencode)];
  }

  /** Restore the project and start checking the engine. Never throws: problems become activity lines. */
  async init(): Promise<void> {
    void this.#checkEngines();
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
    if (cmd.type === 'checkEngine') return this.#recheckEngines();
    if (cmd.type === 'setEngineEnabled') return this.#setEngineEnabled(cmd.engineId, cmd.enabled);
    if (cmd.type === 'setEngineOrder') {
      this.#engines.setOrder(cmd.order);
      return this.#saveEnginePrefs();
    }
    if (cmd.type === 'setEngineLimits') {
      if (!this.#engines.adapter(cmd.engineId)) throw new Error(`Unknown engine ${cmd.engineId}.`);
      this.#engineLimits = { ...this.#engineLimits, [cmd.engineId]: { cap5hUsd: cmd.cap5hUsd, cap7dUsd: cmd.cap7dUsd } };
      this.#writeSettings({ limits: this.#engineLimits });
      return;
    }
    if (cmd.type === 'clearEngineLimitHit') {
      const rest = { ...this.#limitHits };
      delete rest[cmd.engineId];
      this.#limitHits = rest;
      this.#writeSettings({ limitHits: this.#limitHits });
      this.#maybeResumeAfterLimit();
      return;
    }
    const p = this.#mustProject();
    switch (cmd.type) {
      case 'submitGoal': {
        if (!this.#engines.defaultEngine()) {
          const view = this.#engineView();
          throw new Error(`${view.name} is not ready: ${view.message}`);
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
      engine: this.#engines.engine(),
      route: (input) => this.#engines.route(input, routeCard),
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
      ...(this.#o.services ? { services: this.#o.services } : {}),
      limits: {
        hit: (engine, resetAt) => this.#limitHit(engine, resetAt),
        canRoute: (role) => this.#engines.canRoute(role),
        cap: () => this.#treasurerCap(),
      },
      now: this.#now,
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
      this.#maybeResumeAfterLimit();
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

  /** "Check again" (e.g. right after signing in): re-check every engine now instead of waiting a minute. */
  async #recheckEngines(): Promise<void> {
    if (this.#engineTimer) clearTimeout(this.#engineTimer);
    this.#engineTimer = null;
    await this.#checkEngines();
  }

  async #checkEngines(): Promise<void> {
    if (this.#disposed) return;
    if (await this.#engines.detectAll()) this.#changed('engine');
    if (this.#engines.anyEnabledNotReady && !this.#disposed) {
      if (this.#engineTimer) clearTimeout(this.#engineTimer);
      this.#engineTimer = setTimeout(() => void this.#checkEngines(), ENGINE_RECHECK_MS);
      this.#engineTimer.unref?.();
    }
  }

  #setEngineEnabled(id: EngineId, enabled: boolean): void {
    if (!enabled && this.#engines.isEnabled(id) && this.#engines.isReady(id)) {
      const otherReady = this.#engines.order.some((e) => e !== id && this.#engines.isEnabled(e) && this.#engines.isReady(e));
      const busy = this.#goals().some((g) => g.status === 'running' || g.status === 'planning');
      if (!otherReady && busy) {
        throw new Error(`${this.#engines.adapter(id)?.name ?? id} is the only engine ready and a goal is running. Pause or finish the goal first, or switch on another engine.`);
      }
    }
    this.#engines.setEnabled(id, enabled);
    this.#saveEnginePrefs();
    if (enabled) void this.#checkEngines();
  }

  #saveEnginePrefs(): void {
    this.#writeSettings({ engines: this.#engines.prefs() });
  }

  /** The default engine as the Queen and setup screens show it (the first enabled, ready one, or why none is). */
  #engineView(): EngineView {
    const cards = this.#engines.cards();
    const ready = this.#engines.defaultEngine();
    const card = ready ? cards.find((c) => c.id === ready.id) : cards.find((c) => c.enabled && c.state !== 'unsupported');
    if (!card) {
      return { state: 'missing', name: 'No AI engine', version: null, message: 'Every AI engine is switched off. Switch one on in Connections.' };
    }
    return { state: card.state === 'unsupported' ? 'missing' : card.state, name: card.name, version: card.version, message: card.message };
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
      engine: this.#engineView(),
      engines: this.#engines.cards().map((c): EngineCard => ({ ...c, usage: this.#usage(c.id) })),
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
    // Plans saved before headlines existed have none; derive one.
    const plan = g.plan as (Omit<Plan, 'headline'> & { headline?: string }) | null;
    return {
      id: g.id,
      title: g.title,
      text: g.text,
      status: g.status,
      plan: plan
        ? {
            headline: plan.headline ?? headlineFrom(plan.summary),
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

  /** Integrations live in the goal's plan (the taskboard doesn't store them). */
  #cardIntegrations(c: BoardCard): string[] {
    const plan = this.#o.brain.goals.get(c.goalId)?.plan as { waves?: Array<{ cards?: Array<{ id?: string; integrations?: unknown }> }> } | null | undefined;
    const card = plan?.waves?.flatMap((w) => w.cards ?? []).find((p) => `${c.goalId}.${p.id}` === c.id);
    return Array.isArray(card?.integrations) ? card.integrations.filter((x): x is string => typeof x === 'string') : [];
  }

  #cardView(c: BoardCard): CardView {
    const undo = this.#project?.undo.get(c.goalId);
    return {
      id: c.id, goalId: c.goalId, wave: c.wave, title: c.title, brief: c.brief, caste: c.caste, priority: c.priority,
      acceptance: c.acceptance, dependsOn: c.dependsOn, integrations: this.#cardIntegrations(c), status: c.status, claimedBy: c.claimedBy ?? null,
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
        engine: EngineIdSchema.safeParse(r.engine).success ? (r.engine as EngineId) : null,
        model: r.model,
        effort: r.effort,
        routeReason: r.reason ?? null,
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
        lane.status = e.run.ok ? 'done' : e.run.error === 'stopped' || e.run.error === 'quota' ? 'paused' : 'failed';
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

  // ---- the Treasurer: usage windows and limits (Phase 2 A5) -----------------------------------

  #usage(id: EngineId): EngineUsage {
    const now = this.#now();
    const w5 = this.#o.brain.outcomes.usageSince(id, now - 5 * HOUR);
    const w7 = this.#o.brain.outcomes.usageSince(id, now - 7 * 24 * HOUR);
    const caps = this.#engineLimits[id] ?? { cap5hUsd: null, cap7dUsd: null };
    const state = this.#limitState(id, { w5: w5.costUsd, w7: w7.costUsd });
    const until = this.#limitHits[id];
    return {
      window5h: w5,
      window7d: w7,
      cap5hUsd: caps.cap5hUsd,
      cap7dUsd: caps.cap7dUsd,
      state: state.exhausted ? 'exhausted' : state.near ? 'near' : 'ok',
      exhaustedUntil: until && until > now ? until : null,
      message: state.message,
    };
  }

  /** The engine's subscription as the router sees it: exhausted (vendor limit or a cap reached) or near a cap. */
  #limitState(id: EngineId, spent?: { w5: number; w7: number }): LimitState {
    const now = this.#now();
    const name = this.#engines.adapter(id)?.name ?? id;
    const until = this.#limitHits[id];
    if (until && until > now) return { exhausted: true, near: false, message: `${name} is at its usage limit until ${formatClock(until)}.` };
    const caps = this.#engineLimits[id];
    if (!caps || (caps.cap5hUsd === null && caps.cap7dUsd === null)) return { exhausted: false, near: false, message: 'No limits set.' };
    const w5 = spent?.w5 ?? this.#o.brain.outcomes.usageSince(id, now - 5 * HOUR).costUsd;
    const w7 = spent?.w7 ?? this.#o.brain.outcomes.usageSince(id, now - 7 * 24 * HOUR).costUsd;
    const money = (n: number) => `$${n.toFixed(2)}`;
    const checks = [
      { used: w5, cap: caps.cap5hUsd, label: '5 hours' },
      { used: w7, cap: caps.cap7dUsd, label: '7 days' },
    ];
    for (const c of checks) {
      if (c.cap !== null && c.used >= c.cap) {
        return { exhausted: true, near: false, message: `${name} reached your limit of ${money(c.cap)} per ${c.label} (${money(c.used)} used). It frees up as older runs leave the window.` };
      }
    }
    for (const c of checks) {
      if (c.cap !== null && c.used >= c.cap * NEAR_SHARE) {
        return { exhausted: false, near: true, message: `${name} has used ${money(c.used)} of your ${money(c.cap)} limit per ${c.label}; the hive uses it less until the window frees up.` };
      }
    }
    return { exhausted: false, near: false, message: 'Within your limits.' };
  }

  /** An engine's vendor stopped a run at its limit: rest it until the reset time (or an hour). */
  #limitHit(engine: EngineId, resetAt: number | null): void {
    const until = resetAt && resetAt > this.#now() ? resetAt : this.#now() + DEFAULT_LIMIT_WAIT_MS;
    this.#limitHits = { ...this.#limitHits, [engine]: until };
    this.#writeSettings({ limitHits: this.#limitHits });
    const name = this.#engines.adapter(engine)?.name ?? engine;
    this.#note('limit', `${name} hit its usage limit; the hive leaves it alone until ${formatClock(until)}${resetAt ? '' : ' (no reset time given, so an hour)'}.`);
  }

  /**
   * How many insects may work now: the user's cap, or one when every engine that can still take work is near
   * its cap (so the hive doesn't burn through the rest). Null = the user's cap.
   */
  #treasurerCap(): number | null {
    const usable = this.#engines.candidates().filter((c) => c.enabled && c.ready && c.guard && !c.exhausted);
    return usable.length && usable.every((c) => c.near) ? 1 : null;
  }

  /** The hive rested because every engine was at a limit, and one is free again: carry on. */
  #maybeResumeAfterLimit(): void {
    if (!this.#paused || !this.#pausedReason?.startsWith(LIMIT_PAUSE)) return;
    if (!this.#engines.canRoute('coder') && !this.#engines.canRoute('queen')) return;
    this.#resume();
    this.#note('resumed', 'An AI engine is free again; the hive carries on.');
  }

  // ---- settings --------------------------------------------------------------------------------

  #settingsPath(): string {
    return join(this.#o.userDataDir, 'settings.json');
  }

  #readSettings(): HostSettings {
    try {
      const raw = JSON.parse(readFileSync(this.#settingsPath(), 'utf8')) as {
        projectPath?: unknown;
        engines?: { order?: unknown; disabled?: unknown };
        limits?: unknown;
        limitHits?: unknown;
      };
      const ids = (v: unknown): EngineId[] =>
        Array.isArray(v) ? v.flatMap((x) => (EngineIdSchema.safeParse(x).success ? [x as EngineId] : [])) : [];
      return {
        ...(typeof raw.projectPath === 'string' ? { projectPath: raw.projectPath } : {}),
        ...(raw.engines && typeof raw.engines === 'object' ? { engines: { order: ids(raw.engines.order), disabled: ids(raw.engines.disabled) } } : {}),
        limits: readLimits(raw.limits),
        limitHits: readHits(raw.limitHits),
      };
    } catch {
      return {};
    }
  }

  #writeSettings(next: Partial<HostSettings>): void {
    mkdirSync(this.#o.userDataDir, { recursive: true });
    writeFileSync(this.#settingsPath(), JSON.stringify({ ...this.#readSettings(), ...next }, null, 2));
  }
}

/** Engine caps from the settings file; anything malformed is dropped. */
function readLimits(v: unknown): Partial<Record<EngineId, EngineLimits>> {
  const out: Partial<Record<EngineId, EngineLimits>> = {};
  if (!v || typeof v !== 'object') return out;
  const cap = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!EngineIdSchema.safeParse(k).success || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    out[k as EngineId] = { cap5hUsd: cap(r['cap5hUsd']), cap7dUsd: cap(r['cap7dUsd']) };
  }
  return out;
}

function readHits(v: unknown): Partial<Record<EngineId, number>> {
  const out: Partial<Record<EngineId, number>> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    if (EngineIdSchema.safeParse(k).success && typeof t === 'number' && Number.isFinite(t)) out[k as EngineId] = t;
  }
  return out;
}

export type { LaneStatus };
