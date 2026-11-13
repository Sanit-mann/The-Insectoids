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
import { type Brain, type BoardCard, type Goal, ConflictError, SecretError, brainHealth } from '@insectoids/brain';
import {
  approvalFor,
  auditSummary,
  isInsectRole,
  summaryIsEmpty,
  type ClaudeEvent,
  type ClaudeInstall,
  type BrainAccess,
  type Engine,
  type EngineAdapter,
  type GeminiAuth,
  type GeminiInstall,
  EngineRegistry,
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
  type BrainHealth,
  type BrainDashboardView,
  type BrainEditRequest,
  BrainEditRequestSchema,
  type BrainEditResult,
  type BrainGraphRequest,
  BrainGraphRequestSchema,
  type BrainGraphView,
  type LessonView,
  type LibrarianView,
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
import { meaningSearchOffView } from './meaning-search';
import { CodeMapBuilder, codeMapOffView } from './code-map';
import type { CodeLookupResult } from '@insectoids/shared';
import type { DoorPaths } from './messages';

/** Longest wait for running agents to wrap up when the project closes. */
const SETTLE_TIMEOUT_MS = 30_000;
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
  tokens: { endpoint: string; issue(g: { agentId: string; shelf: string; write: boolean; readKey?: string }): string; revoke(token: string): void } | null;
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
  /**
   * Meaning search (Phase 2 B1): its view for the snapshot, the user's switch, and query vectors for the
   * Queen's related-records lookup. Absent: words only (the snapshot says "off").
   */
  meaning?: {
    view(): HiveSnapshot['meaningSearch'];
    setEnabled(on: boolean): Promise<void>;
    embedQuery(text: string): Promise<{ vector: Float32Array; model: string } | null>;
  };
  push: (p: HivePush) => void;
  log?: (line: string) => void;
  /**
   * Brain upkeep (B2): fade unused agent notes at start and every `intervalMs` (default 6 h) while idle.
   * `clockShiftDays` moves the decay clock forward (e2e only, to test fading without waiting).
   */
  tidy?: { intervalMs?: number; clockShiftDays?: number };
  /**
   * The Librarian's LLM review (B3): after `reviewEveryCards` finished cards (default 20) or every
   * `reviewEveryMs` (default a week), only while an engine is ready and the hive is idle and not paused.
   */
  librarian?: { reviewEveryCards?: number; reviewEveryMs?: number };
  /**
   * The code map (Phase 2 B4): symbols, imports and calls of the project, refreshed by content hash on project
   * open, after merges, on the user's rebuild and every `refreshEveryMs` (default 10 min) while idle.
   * `wasmDir`: tree-sitter's WASM folder (the host bundle can't resolve the package). Absent: off.
   */
  codeMap?: { wasmDir?: string; refreshEveryMs?: number };
  /** e2e only: seed agent records (near-duplicates, a superseded fact, an old note, two lessons) on the project shelf. */
  seedBrainForE2E?: boolean;
  /** e2e only: the demo Inspector fails C-01's first attempt once (a lesson is learned). */
  demoInspectorFailsFirst?: boolean;
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
  /** The Librarian's review clock (B3): last review, the start of the weekly wait, cards finished since. */
  librarian?: { lastReviewAt: number | null; since: number; cardsSince: number };
}

const DAY = 86_400_000;
const LIBRARIAN = 'Librarian';

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
  #tidyTimer: NodeJS.Timeout | null = null;
  #changedReason = '';
  #ticking = false;
  #disposed = false;
  /** The Foreman pass in progress, if any (awaited before the project closes). */
  #tickRun: Promise<void> | null = null;
  /** Work started without awaiting it (e.g. the Queen planning a goal), awaited before the project closes. */
  readonly #background = new Set<Promise<unknown>>();
  #limits: HiveLimits;
  /** User caps per engine and vendor limit hits (persisted in the host settings). */
  #engineLimits: Partial<Record<EngineId, EngineLimits>>;
  #limitHits: Partial<Record<EngineId, number>>;
  /** The Librarian (B3): its state, the last audit's health, and the review clock. */
  #libState: LibrarianView['state'] = 'idle';
  #libMessage = 'The Librarian checks the Brain at start and every 6 hours.';
  #health: BrainHealth | null = null;
  #lastAuditAt: number | null = null;
  #review: { lastReviewAt: number | null; since: number; cardsSince: number };
  #codeMap: CodeMapBuilder | null = null;
  #codeMapTimer: NodeJS.Timeout | null = null;

  constructor(o: HiveManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#limits = { ...(o.limits ?? DEFAULT_LIMITS) };
    const settings = this.#readSettings();
    this.#engines = new EngineRegistry(this.#adapters(), settings.engines ?? {});
    this.#engineLimits = settings.limits ?? {};
    this.#limitHits = settings.limitHits ?? {};
    this.#review = settings.librarian ?? { lastReviewAt: null, since: this.#now(), cardsSince: 0 };
    // The Treasurer (Phase 2 A5): limits steer the router, outcomes teach it.
    this.#engines.setLimitState((id) => this.#limitState(id));
    this.#engines.setLearning({ stats: (role) => o.brain.outcomes.stats(role), rng: seededRng(o.seed ?? this.#now()) });
    if (o.codeMap) {
      this.#codeMap = new CodeMapBuilder({
        brain: o.brain,
        ...(o.codeMap.wasmDir ? { wasmDir: o.codeMap.wasmDir } : {}),
        ...(o.codeMap.refreshEveryMs !== undefined ? { refreshEveryMs: o.codeMap.refreshEveryMs } : {}),
        idle: () => this.#idle(),
        onChange: () => this.#changed('code-map'),
        ...(o.log ? { log: o.log } : {}),
      });
    }
  }

  /** Look the current project's code map up (the app's Brain screen). */
  codeLookup(req: { query: string; mode: 'symbol' | 'file' | 'callers' | 'callees' }): CodeLookupResult {
    if (!this.#codeMap) return { hits: [], imports: [], truncated: false, message: 'The code map is off in this build.' };
    return this.#codeMap.lookup(req);
  }

  /** Tests: wait for the code map's current refresh. */
  async codeMapIdle(): Promise<void> {
    await this.#codeMap?.settled();
  }

  /** After a merge the project's files changed: refresh the map shortly (merges often come in a burst). */
  #codeMapSoon(): void {
    if (!this.#codeMap || this.#disposed) return;
    if (this.#codeMapTimer) clearTimeout(this.#codeMapTimer);
    this.#codeMapTimer = setTimeout(() => {
      this.#codeMapTimer = null;
      void this.#codeMap?.refresh();
    }, 2_000);
    this.#codeMapTimer.unref?.();
  }

  /**
   * The engines this hive knows. With the scripted engine (tests, e2e, demos) it is the only one that can
   * run: Claude Code is listed but never checked or run there, so a test can never spend real tokens.
   */
  #adapters(): EngineAdapter[] {
    const scripted = this.#o.engineOverride
      ? fakeAdapter(this.#o.engineOverride, { name: 'Test engine', message: 'A scripted test engine.' })
      : this.#o.engine === 'fake'
        ? fakeAdapter(demoEngine(this.#o.demoInspectorFailsFirst ? { inspectorFailsFirst: true } : {}))
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
    let opened = false;
    if (path) {
      try {
        await this.#openProject(path);
        opened = true;
      } catch (err) {
        this.#note('error', `Could not open the project ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The start audit runs on the project's shelf, and before the e2e seed: with the e2e decay clock moved
    // ahead, auditing after it would fade the records the seed just wrote.
    this.#startLibrarian();
    if (opened && this.#o.seedBrainForE2E) this.#seedBrain();
  }

  // ---- the Librarian (B2 upkeep moved under it in B3) ---------------------------------------------

  #startLibrarian(): void {
    // Its reflexes: an audit at start, then every 6 h (fading only while idle: a busy hive is reading the Brain).
    this.#audit(false);
    const every = this.#o.tidy?.intervalMs ?? 6 * 60 * 60_000;
    this.#tidyTimer = setInterval(() => {
      this.#audit(false);
      this.#maybeReview();
    }, every);
    this.#tidyTimer.unref?.();
  }

  #idle(): boolean {
    return this.#working() === 0 && this.#o.brain.goals.list('running').length === 0;
  }

  /**
   * The Librarian's free audit (code only): fade unused agent notes (B2 decay), then score the Brain's
   * health and count the near-duplicates only the user can merge. Returns how many notes faded.
   */
  #audit(force: boolean): number {
    if (this.#libState === 'idle') this.#libState = 'auditing';
    try {
      const shift = (this.#o.tidy?.clockShiftDays ?? 0) * DAY;
      const now = this.#now() + shift;
      const { brain } = this.#o;
      const faded = force || this.#idle() ? brain.fade({ now }) : [];
      for (const f of faded.slice(0, 10)) {
        this.#record('brain-tidy', `Faded into the archive: "${f.title}" (unused for ${f.days} days). You can bring it back from the Brain screen.`, {});
      }
      if (faded.length > 10) this.#record('brain-tidy', `…and ${faded.length - 10} more faded into the archive.`, {});
      const shelf = this.#project?.view.shelf ?? 'global';
      const duplicates = brain.duplicatePairs(shelf).filter((p) => p.userInvolved).length;
      this.#lastAuditAt = this.#now();
      this.#health = brainHealth(brain.healthCounts(shelf, now), duplicates, this.#lastAuditAt);
      this.#libMessage = `Checked the Brain: ${this.#health.score}/100. ${this.#health.message}`;
      return faded.length;
    } catch (err) {
      this.#libMessage = `The Librarian could not check the Brain: ${err instanceof Error ? err.message : String(err)}`;
      return 0;
    } finally {
      this.#libState = this.#libState === 'auditing' ? 'idle' : this.#libState;
      this.#changed('librarian');
    }
  }

  /** Why the LLM review can't run now, or null when it can. */
  #reviewBlocked(): string | null {
    if (!this.#project) return 'Open a project first.';
    if (this.#libState === 'reviewing') return 'The Librarian is already reviewing.';
    if (!this.#engines.defaultEngine()) return 'No AI engine is ready.';
    if (this.#paused) return 'The hive is paused.';
    if (this.#working() > 0) return 'Agents are working; the Librarian reviews when the hive is idle.';
    return null;
  }

  #reviewDue(): boolean {
    const everyCards = this.#o.librarian?.reviewEveryCards ?? 20;
    const everyMs = this.#o.librarian?.reviewEveryMs ?? 7 * DAY;
    return this.#review.cardsSince >= everyCards || this.#now() - this.#review.since >= everyMs;
  }

  /** Wake the Librarian's brain when it is due and allowed (never while busy, paused or engine-less). */
  #maybeReview(): void {
    if (this.#disposed || !this.#reviewDue() || this.#reviewBlocked()) return;
    this.#track(this.#runReview());
  }

  /**
   * The Librarian's LLM review: a read-only run over a compact audit summary. Each valid proposal becomes
   * an approval; nothing changes until the user says yes. The Queen relays one line to the user.
   */
  async #runReview(): Promise<void> {
    const p = this.#project;
    if (!p) return;
    const { brain } = this.#o;
    const now = this.#now();
    this.#review = { lastReviewAt: now, since: now, cardsSince: 0 };
    this.#writeSettings({ librarian: this.#review });
    const summary = auditSummary(brain, p.view.shelf, now + (this.#o.tidy?.clockShiftDays ?? 0) * DAY);
    if (summaryIsEmpty(summary)) {
      this.#libMessage = 'Reviewed the Brain: nothing needs you.';
      this.#note('librarian', 'The Librarian looked over the Brain: nothing needs you.');
      return;
    }
    this.#libState = 'reviewing';
    this.#libMessage = 'Reviewing the Brain with AI.';
    this.#changed('librarian');
    try {
      const r = await p.hive.librarianReview(summary);
      if (this.#disposed) return;
      for (const proposal of r.proposals) brain.approvals.create(approvalFor(proposal, brain));
      const n = r.proposals.length;
      this.#libMessage = r.error ? `The review gave nothing usable: ${r.error}` : n ? `Proposed ${n} change${n === 1 ? '' : 's'} for you to check.` : 'Reviewed the Brain: nothing to propose.';
      if (r.error) this.#note('librarian', `The Librarian's review gave nothing usable (${r.error}). Nothing changed.`);
      else if (n) this.#note('librarian', `The Librarian found ${n} thing${n === 1 ? '' : 's'} for you to check.`);
      else this.#note('librarian', 'The Librarian reviewed the Brain: nothing to propose.');
    } catch (err) {
      this.#libMessage = 'The review failed. Nothing changed.';
      this.#note('error', `The Librarian's review failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#libState = 'idle';
      this.#changed('librarian');
    }
  }

  /** A card finished (verified, or failed for good): counts toward the next review. */
  #cardFinished(): void {
    this.#review = { ...this.#review, cardsSince: this.#review.cardsSince + 1 };
    this.#writeSettings({ librarian: this.#review });
  }

  #nextReview(): string {
    const everyCards = this.#o.librarian?.reviewEveryCards ?? 20;
    const everyMs = this.#o.librarian?.reviewEveryMs ?? 7 * DAY;
    if (this.#libState === 'reviewing') return 'Reviewing now.';
    const left = Math.max(0, everyCards - this.#review.cardsSince);
    const days = Math.max(0, Math.ceil((this.#review.since + everyMs - this.#now()) / DAY));
    if (!left || !days) return 'Due now; it waits for an idle hive with an engine ready.';
    const when = days === 1 ? 'tomorrow' : `in ${days} days`;
    return `After ${left} more finished card${left === 1 ? '' : 's'} or ${when}, whichever comes first.`;
  }

  #librarianView(): LibrarianView {
    const proposalsWaiting = this.#o.brain.approvals.list().filter((a) => a.status === 'waiting' && a.from === LIBRARIAN).length;
    return {
      state: this.#libState,
      lastAuditAt: this.#lastAuditAt,
      lastReviewAt: this.#review.lastReviewAt,
      nextReview: this.#nextReview(),
      proposalsWaiting,
      message: this.#libMessage,
    };
  }

  #lessonViews(): LessonView[] {
    const shelf = this.#project?.view.shelf;
    if (!shelf) return [];
    const { brain } = this.#o;
    return brain.lessons(shelf, 50).map((l) => {
      const card = l.source ? brain.taskboard.get(l.source) : undefined;
      return { id: l.id, title: l.title, body: l.body, trust: l.trust, source: card?.title ?? l.source ?? null, seen: l.seen, createdAt: l.createdAt };
    });
  }

  /**
   * e2e: agent records that exercise B2 (two near-duplicates, a superseded fact, an old note), B3 (two
   * lessons) and B5 (four linked records: a proposed decision, a task, an unconfirmed fact an agent may
   * still change, and an update).
   */
  #seedBrain(): void {
    const shelf = this.#project?.view.shelf;
    if (!shelf) return;
    const ant = { type: 'agent' as const, id: 'Ant-seed' };
    const b = this.#o.brain;
    b.write({ kind: 'update', shelf, title: 'Checkout notes', body: 'The checkout page uses Stripe Elements for card entry.' }, ant);
    b.write({ kind: 'update', shelf, title: 'Checkout notes', body: 'the checkout page uses stripe elements, for card entry' }, ant);
    const old = b.write({ kind: 'fact', shelf, title: 'Hosting provider', body: 'The site is hosted on Netlify.' }, ant).id;
    b.write({ kind: 'fact', shelf, title: 'Hosting provider', body: 'The site moved to Vercel hosting.', supersedes: old }, ant);
    b.write({ kind: 'agent_memory', shelf, title: 'Scratch idea', body: 'Maybe try a carousel on the landing page someday.' }, ant);
    // B5 (graph and edit): a small linked cluster. Its words stay clear of the searches the B2/B3 specs use.
    const decision = b.write({ kind: 'decision', shelf, title: 'Take payments by card only', body: 'Only card payments at launch; no bank transfers yet.' }, ant).id;
    const task = b.write({ kind: 'task', shelf, title: 'Build the order summary page', body: 'Show the items, the total and the delivery date before payment.' }, ant).id;
    const fact = b.write({ kind: 'fact', shelf, title: 'Order emails come from the shop address', body: "Order confirmation emails are sent from the shop's own address." }, ant).id;
    const progress = b.write({ kind: 'update', shelf, title: 'Order page progress', body: 'The order summary page has its layout; totals come next.' }, ant).id;
    b.link(task, decision, 'implements');
    b.link(fact, decision, 'about');
    b.link(progress, task, 'about');
    const lib = { type: 'agent' as const, id: LIBRARIAN };
    b.learn({ shelf, title: 'Don\'t hand in "Add the pricing table" as done because the prices were placeholders', body: 'Card: Add the pricing table\nWhat the Inspector found: the prices were placeholders.' }, lib);
    b.learn({ shelf, title: 'Don\'t hand in "Fix the login test" as done because the test was skipped, not fixed', body: 'Card: Fix the login test\nWhat the Inspector found: the test was skipped, not fixed.' }, lib);
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
    if (this.#tidyTimer) clearInterval(this.#tidyTimer);
    if (this.#outTimer) clearTimeout(this.#outTimer);
    if (this.#changedTimer) clearTimeout(this.#changedTimer);
    if (this.#codeMapTimer) clearTimeout(this.#codeMapTimer);
    await this.#codeMap?.dispose();
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
    if (cmd.type === 'rebuildCodeMap') {
      if (!this.#codeMap) throw new Error('The code map is off in this build.');
      this.#mustProject();
      // Read every file again (not only changed ones); runs in the background, progress shows in the snapshot.
      void this.#codeMap.refresh({ force: true });
      return;
    }
    if (cmd.type === 'tidyBrain') {
      if (!this.#audit(true)) this.#note('brain-tidy', 'The Brain is tidy: nothing to fade.');
      return;
    }
    if (cmd.type === 'runLibrarian') {
      // The free audit always runs (fading too: the user asked); the LLM review only when it may.
      this.#audit(true);
      if (!cmd.review) return;
      const blocked = this.#reviewBlocked();
      if (blocked) throw new Error(`The Librarian can't review now: ${blocked}`);
      this.#track(this.#runReview());
      await Promise.resolve();
      return;
    }
    if (cmd.type === 'confirmLesson' || cmd.type === 'retireLesson') {
      const rec = this.#o.brain.get(cmd.id);
      if (!rec || rec.kind !== 'lesson') throw new Error('No such lesson.');
      if (cmd.type === 'confirmLesson') {
        this.#o.brain.update(cmd.id, { trust: 'confirmed' }, { type: 'user' });
        this.#note('lesson', `Confirmed the lesson: ${short(rec.title, 120)}`);
      } else {
        this.#o.brain.archive(cmd.id, { type: 'user' }, 'retired by you');
        this.#note('lesson', `Retired the lesson (you can bring it back): ${short(rec.title, 120)}`);
      }
      return;
    }
    if (cmd.type === 'restoreRecord') {
      this.#o.brain.unarchive(cmd.id, { type: 'user' });
      this.#note('brain-tidy', 'Brought a record back from the archive.');
      return;
    }
    if (cmd.type === 'archiveRecord') {
      const rec = this.#o.brain.get(cmd.id);
      if (!rec) throw new Error('That record is not in the Brain.');
      if (rec.archived) return;
      this.#o.brain.archive(cmd.id, { type: 'user' }, 'by you');
      this.#note('brain-edit', `Archived "${short(rec.title, 120)}" (you can bring it back).`);
      return;
    }
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
    if (cmd.type === 'setMeaningSearch') {
      if (!this.#o.meaning) throw new Error("Meaning search isn't available in this build.");
      await this.#o.meaning.setEnabled(cmd.enabled);
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
        this.#track(
          p.hive.submitGoal(cmd.text, cmd.budgetTokens ? { budgetTokens: cmd.budgetTokens } : {}).catch((err: unknown) => {
            if (this.#disposed) return;
            this.#note('error', `The Queen could not plan: ${err instanceof Error ? err.message : String(err)}`);
            this.#changed('plan-failed');
          }),
        );
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
    // A new shelf: score its health at once (read-only apart from the usual fading of idle agent notes).
    this.#audit(false);
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
      ...(this.#o.meaning ? { embedQuery: (text: string) => this.#o.meaning!.embedQuery(text) } : {}),
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
    this.#codeMap?.setProject(root, view.shelf);
  }

  async #closeProject(): Promise<void> {
    const p = this.#project;
    if (!p) return;
    this.#project = null;
    clearInterval(p.timer);
    // Stop every agent and wait for its bookkeeping (spend, outcomes, worktree cleanup) to finish, plus the
    // Foreman pass and background planning, so nothing writes to the Brain or the workspace after they
    // close. Capped so a stuck engine can never hang shutdown.
    const settled = Promise.allSettled([p.hive.settle('Switching project.'), this.#tickRun, ...this.#background]);
    await Promise.race([settled, new Promise((r) => setTimeout(r, SETTLE_TIMEOUT_MS).unref?.())]);
    // Card worktrees stay on disk (they belong to goals in the Brain); nothing is deleted here.
  }

  /** Remember work started without awaiting it, so closing the project can wait for it. */
  #track(work: Promise<unknown>): void {
    this.#background.add(work);
    void work.finally(() => this.#background.delete(work));
  }

  async #tick(): Promise<void> {
    const p = this.#project;
    if (!p || this.#ticking || this.#disposed) return;
    this.#ticking = true;
    try {
      this.#maybeResumeAfterLimit();
      this.#tickRun = p.hive.tick();
      await this.#tickRun;
    } catch (err) {
      this.#o.log?.(`[hive] tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      this.#ticking = false;
      this.#tickRun = null;
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
      meaningSearch: this.#o.meaning?.view() ?? meaningSearchOffView(),
      brainHealth: this.#health ?? brainHealth({ total: 0, stale: 0, waiting: 0, orphans: 0, unused: 0, lessons: 0 }, 0, null),
      librarian: this.#librarianView(),
      lessons: this.#lessonViews(),
      codeMap: this.#codeMap?.view() ?? codeMapOffView('The code map is off in this build.'),
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
  // ---- Brain screens (Phase 2 B5) ------------------------------------------------------------------

  /** Graph view: the open project's shelf (plus global), global alone, or every shelf. Request checked in main. */
  brainGraph(req: BrainGraphRequest): BrainGraphView {
    const r = BrainGraphRequestSchema.parse(req);
    const shelf = r.scope === 'all' ? undefined : r.scope === 'global' ? 'global' : (this.#project?.view.shelf ?? 'global');
    return this.#o.brain.graph({
      ...(shelf !== undefined ? { shelf } : {}),
      ...(r.kinds?.length ? { kinds: r.kinds } : {}),
      ...(r.since !== undefined ? { since: r.since } : {}),
      ...(r.includeArchived ? { includeArchived: true } : {}),
      limit: r.limit,
    });
  }

  /** Dashboard numbers for the open project's shelf (plus global), or global when no project is open. */
  brainDashboard(): BrainDashboardView {
    return this.#o.brain.dashboard(this.#project?.view.shelf ?? 'global');
  }

  /**
   * The user edits a record (Memory 01-D12): a new version, confirmed, only if nobody changed it since the
   * version the edit started from. Otherwise nothing is saved and the current text comes back.
   */
  brainEdit(req: BrainEditRequest): BrainEditResult {
    const r = BrainEditRequestSchema.parse(req);
    const brain = this.#o.brain;
    const cur = brain.get(r.id);
    if (!cur) return { status: 'error', message: 'That record is not in the Brain any more.' };
    if (cur.archived) return { status: 'error', message: 'This record is archived. Bring it back first.' };
    try {
      const version = brain.update(
        r.id,
        { title: r.title, body: r.body, summary: r.summary?.trim() ? r.summary : null, trust: 'confirmed', expectedVersion: r.baseVersion },
        { type: 'user' },
      );
      this.#note('brain-edit', `You edited "${short(r.title, 120)}" (version ${version}).`);
      return { status: 'saved', version };
    } catch (err) {
      if (err instanceof ConflictError) {
        const now = brain.get(r.id);
        if (!now) return { status: 'error', message: 'That record is not in the Brain any more.' };
        if (now.archived) return { status: 'error', message: 'This record is archived. Bring it back first.' };
        const last = brain.history(r.id).at(-1);
        return {
          status: 'conflict',
          current: {
            version: now.version,
            title: now.title,
            body: now.body,
            summary: now.summary,
            changedBy: last?.changedBy ?? now.owner,
            changedAt: last?.changedAt ?? now.updatedAt,
          },
        };
      }
      if (err instanceof SecretError) {
        return { status: 'error', message: 'Not saved: it looks like a password or key. Keys belong in the Vault, never in the Brain.' };
      }
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** e2e only (the host refuses it otherwise): an agent changes a record's body, to show an edit conflict. */
  e2eAgentEdit(id: string, body: string): void {
    if (process.env['INSECTOIDS_E2E'] !== '1') throw new Error('Only available in end-to-end tests.');
    this.#o.brain.update(id, { body }, { type: 'agent', id: 'e2e-agent' });
    this.#changed('brain-edit');
  }

  brainRecent(params: { kinds?: Parameters<Brain['recent']>[0]['kinds']; includeHistory?: boolean } = {}) {
    const shelf = this.#project?.view.shelf ?? 'global';
    return this.#o.brain
      .recent({ shelf, ...(params.kinds ? { kinds: params.kinds } : {}), ...(params.includeHistory ? { includeHistory: true } : {}), limit: 50 })
      .map(({ score: _s, ...h }) => h);
  }

  // ---- events → read model ---------------------------------------------------------------------

  #onHiveEvent(e: HiveEvent): void {
    // A card merged into the goal branch, or a goal merged into (or out of) main: the files changed.
    if (e.type === 'card-verified' || e.type === 'goal-done' || e.type === 'merge-undone' || e.type === 'merge-redone') this.#codeMapSoon();
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
        role: r.role === 'queen' || r.role === 'inspector' || r.role === 'librarian' ? r.role : 'insect',
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
      // The hive may just have gone idle: a review that came due while it was busy can run now.
      if (this.#working() === 0) queueMicrotask(() => this.#maybeReview());
      return;
    }
    if (e.type === 'card-verified' || (e.type === 'card-rejected' && e.cardId && this.#o.brain.taskboard.get(e.cardId)?.status === 'failed')) {
      this.#cardFinished();
      queueMicrotask(() => this.#maybeReview());
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
        librarian?: unknown;
      };
      const ids = (v: unknown): EngineId[] =>
        Array.isArray(v) ? v.flatMap((x) => (EngineIdSchema.safeParse(x).success ? [x as EngineId] : [])) : [];
      return {
        ...(typeof raw.projectPath === 'string' ? { projectPath: raw.projectPath } : {}),
        ...(raw.engines && typeof raw.engines === 'object' ? { engines: { order: ids(raw.engines.order), disabled: ids(raw.engines.disabled) } } : {}),
        limits: readLimits(raw.limits),
        limitHits: readHits(raw.limitHits),
        ...readReviewClock(raw.librarian),
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
/** The Librarian's review clock from the settings file; malformed means "start counting now". */
function readReviewClock(v: unknown): Pick<HostSettings, 'librarian'> {
  if (!v || typeof v !== 'object') return {};
  const r = v as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const since = num(r['since']);
  if (since === null) return {};
  return { librarian: { lastReviewAt: num(r['lastReviewAt']), since, cardsSince: Math.floor(num(r['cardsSince']) ?? 0) } };
}

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
