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
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { type ApprovalItem, type Brain, type BoardCard, type Cadence, type Goal, ConflictError, STOP_WORDS, SecretError, brainHealth, writeBackup } from '@insectoids/brain';
import {
  ASK_ROUTE,
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
  COPILOT_PRESET,
  CODEX_PRESET,
  CURSOR_PRESET,
  QWEN_PRESET,
  GROK_PRESET,
  KIMI_PRESET,
  CRUSH_PRESET,
  PI_PRESET,
  ANTIGRAVITY_PRESET,
  type CommandPreset,
  commandAdapter,
  type LlmAccess,
  type OpenCodeInstall,
  type CommandInstall,
  type ReadyProvider,
  headlineFrom,
  routeCard,
  type LimitState,
  LIMIT_PAUSE,
  DEFAULT_LIMIT_WAIT_MS,
  formatClock,
  seededRng,
  ALL_CASTES,
  CASTE_NETWORK,
  ROLE_SKILLS,
  type DoneCard,
  UserLibrary,
  firstSentence,
  frontmatterDescription,
  loadCatalog,
  type WatchdogThresholds,
  CONTAINER_PAUSE,
} from '@insectoids/harness';
import { LibraryKeeper, scanOf } from './library-keeper';
import { ContainerKeeper, type ContainerRuntimeDeps } from './containers';
import { CadenceKeeper, isBuiltIn } from './cadence-keeper';
import { CadenceProposer } from './cadence-proposals';
import { approvalView, buildDigest } from './digest';
import { exportObsidian } from './obsidian-export';
import { NOTHING_MATCHES, NOT_ANSWERED, answerRecord, askEstimate, citedSources, findSources, sourceView } from './brain-ask';
import {
  type ActivityView,
  type AgentView,
  type BrainHealth,
  type CasteView,
  type LibraryImportResult,
  type LibraryItemDetail,
  type LibraryItemView,
  type LibrarySearchRequest,
  LibrarySearchRequestSchema,
  type LibrarySearchResult,
  type BrainDashboardView,
  type BrainAskEstimate,
  type BrainAskRequest,
  BrainAskRequestSchema,
  type BrainAskResult,
  type BudgetsView,
  type CadenceRunView,
  type DigestView,
  type ObsidianExportRequest,
  type ObsidianExportResult,
  BudgetsViewSchema,
  CasteSchema,
  type BrainEditRequest,
  BrainEditRequestSchema,
  type BrainEditResult,
  type BrainGraphRequest,
  BrainGraphRequestSchema,
  type BrainGraphView,
  type BrainTimelineRequest,
  BrainTimelineRequestSchema,
  type BrainTimelineView,
  BrainTimelineViewSchema,
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
  type IncidentView,
  MAINTENANCE_SHELF,
  type MaintenanceJob,
  type ManagersView,
  maintenanceCadenceId,
  type WebhookCall,
  WebhookCallSchema,
  type WebhookReply,
  type ContainerSettings,
  ContainerSettingsSchema,
  type ContainerStatus,
  DEFAULT_CONTAINER_SETTINGS,
  type VaultResult,
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
  /** The Watchdog's thresholds (Phase 2 C2), for tests; false switches it off. Default: WATCHDOG_DEFAULTS. */
  watchdog?: Partial<WatchdogThresholds> | false;
  /** The Foreman's brain on stuck cards (C2). Default on. */
  foremanBrain?: boolean;
  /** The user's own library: learned and imported skills (C3). Default <userData>/library. */
  userLibraryDir?: string;
  /** Skill proposals from repeated successful work (C3, 03-D6). Default on. */
  skillProposals?: boolean;
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
  /** Tests: replace a command engine's detection (else the real program on this computer is checked). */
  commandDetect?: Partial<Record<EngineId, () => Promise<CommandInstall>>>;
  opencodeSystemConfig?: () => string | null;
  /** Tests: a custom engine instead of the demo or Claude. */
  engineOverride?: Engine;
  /**
   * e2e only (C5, "first run with two engines"): listed engines that report ready on the Engines step. With the
   * scripted engine they are display-only: they have no runner, so the registry never routes work to them and
   * the real CLI is never started.
   */
  e2eReadyEngines?: readonly EngineId[];
  /**
   * Cadences (Phase 3 A1). `intervalUnitMs`: milliseconds per interval minute (e2e: INSECTOIDS_E2E_CADENCE_SECONDS=1
   * passes 1 000). `recheckMs`: the longest wait between scheduler checks (default 60 s).
   */
  /** Cadence clock (tests and the e2e hook): interval "minute", safety re-check, and how long file changes settle (A3). */
  cadence?: { intervalUnitMs?: number; recheckMs?: number; settleMs?: number };
  /** Cadence proposals (Cadence 05-D3; Phase 3 A5): asks closer together than `retryWindowMs` count as one (e2e passes 0). */
  cadenceProposals?: { retryWindowMs?: number };
  now?: () => number;
  /** Seed for the Treasurer's learning router (tests). Default: the clock. */
  seed?: number;
  /**
   * Container mode (Phase 4 D1). `deps`: tests replace the runtime layer's calls. `override`: e2e only, a fake
   * runtime program used instead of searching PATH for docker or podman.
   */
  containers?: { deps?: ContainerRuntimeDeps; override?: { command: string; commandArgs: string[] } };
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
  engines?: { order: EngineId[]; disabled: EngineId[]; enabled?: EngineId[] };
  /** Soft caps per engine (Treasurer v2, Phase 2 A5). */
  limits?: Partial<Record<EngineId, EngineLimits>>;
  /** Vendor limits hit: engine -> when the hive may use it again (epoch ms). */
  limitHits?: Partial<Record<EngineId, number>>;
  /** The Librarian's review clock (B3): last review, the start of the weekly wait, cards finished since. */
  librarian?: { lastReviewAt: number | null; since: number; cardsSince: number };
  /** The managers' brain side (C2): the user's settings, the review clock and the last review. */
  managers?: ManagerSettings;
  /** When the user last read the "while you were away" digest (Phase 3 B1); the first start sets it to then. */
  digestSeenAt?: number;
  /** Container mode (Phase 4 D1): off, or every card's commands in a container, and the image and limits. */
  containers?: ContainerSettings;
}

interface ManagerSettings {
  scoutBeforePlanning: boolean;
  /** A periodic review after every N finished cards; 0 = off. */
  reviewEveryCards: number;
  cardsSince: number;
  lastReview: { at: number; summary: string; recordId: string | null } | null;
}

const DEFAULT_MANAGERS: ManagerSettings = { scoutBeforePlanning: true, reviewEveryCards: 20, cardsSince: 0, lastReview: null };

const DAY = 86_400_000;
const LIBRARIAN = 'Librarian';
/** How long a scheduled backup waits at start for main to say where backups go (Phase 3 A5). */
const BACKUP_DIR_WAIT_MS = 30_000;

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

/** A file size in words: "2.1 MB", "640 KB" (Phase 3 A5 backups). */
const sizeText = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

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

/** e2e (C5): "claude,codex" → the listed engine ids that may show as ready; the scripted engine and unknown ids are dropped. */
export function e2eReadyEngines(list: string): EngineId[] {
  const ids = list.split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(ids)].filter((id): id is EngineId => id !== 'fake' && EngineIdSchema.safeParse(id).success);
}

export class HiveManager {
  readonly #o: HiveManagerOptions;
  readonly #now: () => number;
  readonly #engines: EngineRegistry;
  #engineTimer: NodeJS.Timeout | null = null;
  #project: ProjectState | null = null;
  #paused = false;
  /** True while the open project's hive settles on close (its own "paused" event is not a user pause). */
  #closingHive = false;
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
  #libMessage = 'The Librarian checks the Brain at start and with the Brain health check job.';
  #health: BrainHealth | null = null;
  /** Card id → its latest attempt's library skills, while one snapshot is being built. */
  #cardSkills: Map<string, string[]> | null = null;
  /** e2e only (C4): engines a scripted install marked as installed. */
  readonly #e2eInstalled = new Set<EngineId>();
  /** e2e only (Phase 4 A2): what e2eSeedRecords wrote so far, so later chunks link to earlier ones; one seeded rng. */
  readonly #e2eSeeded: string[] = [];
  readonly #e2eSeedRng = seededRng(0x5eed);
  #lastAuditAt: number | null = null;
  #review: { lastReviewAt: number | null; since: number; cardsSince: number };
  #codeMap: CodeMapBuilder | null = null;
  readonly #userLib: UserLibrary;
  readonly #keeper: LibraryKeeper;
  /** A skill proposal is being drafted (C3): one at a time. */
  #proposing = false;
  #codeMapTimer: NodeJS.Timeout | null = null;
  /** The managers' brain side (C2): settings, the review clock, and whether a review runs now. */
  #managers: ManagerSettings;
  readonly #cadences: CadenceKeeper;
  /** Spots repeated goals and proposes a cadence for them (Cadence 05-D3; Phase 3 A5). */
  readonly #proposer: CadenceProposer;
  /** When the user last read the "while you were away" digest (Phase 3 B1), from the settings file. */
  #digestSeenAt: number;
  /** Where the `backup` job writes (main sets it with host RPC setBackupDir; Phase 3 A5). Null until then. */
  #backupDir: string | null = null;
  /** Resolves once main has said where backups go (a backup due right at start waits a little for it). */
  #backupDirSet: Promise<void>;
  #backupDirKnown: () => void = () => {};
  #hiveReviewing = false;
  /** A question to the Brain is being answered (Phase 4 A1): one at a time. */
  #asking = false;
  /** Container mode (Phase 4 D1): the setting, the runtime and image checks, the image download. */
  readonly #containers: ContainerKeeper;
  #containersPushTimer: NodeJS.Timeout | null = null;

  constructor(o: HiveManagerOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#limits = { ...(o.limits ?? DEFAULT_LIMITS) };
    this.#backupDirSet = new Promise((resolve) => (this.#backupDirKnown = resolve));
    const settings = this.#readSettings();
    this.#engines = new EngineRegistry(this.#adapters(), settings.engines ?? {});
    this.#engineLimits = settings.limits ?? {};
    this.#limitHits = settings.limitHits ?? {};
    this.#review = settings.librarian ?? { lastReviewAt: null, since: this.#now(), cardsSince: 0 };
    this.#managers = settings.managers ?? { ...DEFAULT_MANAGERS };
    // The digest (B1) covers what happens from the very first start on, never older history.
    this.#digestSeenAt = settings.digestSeenAt ?? this.#now();
    if (settings.digestSeenAt === undefined) this.#writeSettings({ digestSeenAt: this.#digestSeenAt });
    this.#containers = new ContainerKeeper({
      settings: settings.containers ?? { ...DEFAULT_CONTAINER_SETTINGS },
      save: (c) => this.#writeSettings({ containers: c }),
      ...(o.containers?.deps ? { deps: o.containers.deps } : {}),
      ...(o.containers?.override ? { override: o.containers.override } : {}),
      onChange: () => this.#containersChanged(),
      ...(o.log ? { log: o.log } : {}),
    });
    this.#userLib = new UserLibrary(o.userLibraryDir ?? join(o.userDataDir, 'library'));
    this.#keeper = new LibraryKeeper({
      brain: o.brain,
      user: this.#userLib,
      note: (kind, text) => this.#note(kind, text),
      now: () => this.#now(),
      keep: new Set(Object.values(ROLE_SKILLS).flat()),
    });
    this.#cadences = new CadenceKeeper({
      brain: o.brain,
      now: () => this.#now(),
      shelf: () => this.#project?.view.shelf ?? null,
      blocked: () => this.#cadenceBlocked(),
      submit: (c, _reason, trigger) => this.#submitCadenceGoal(c, trigger),
      // Built-in maintenance jobs (Cadence 05-D7; Phase 3 A5): code, not goals.
      maintain: (job, mo) => this.#maintain(job, mo.manual),
      root: () => this.#project?.view.path ?? null,
      // The app's own data (worktrees, settings) is never watched, even if it lives inside a project.
      ignore: () => [o.userDataDir],
      note: (text) => this.#note('cadence', text),
      changed: () => this.#changed('cadence'),
      ...(o.cadence?.intervalUnitMs ? { intervalUnitMs: o.cadence.intervalUnitMs } : {}),
      ...(o.cadence?.recheckMs ? { recheckMs: o.cadence.recheckMs } : {}),
      ...(o.cadence?.settleMs !== undefined ? { settleMs: o.cadence.settleMs } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
    // The built-in jobs exist from the first start on (A5); a missing one is made switched on.
    this.#cadences.seedMaintenance();
    this.#proposer = new CadenceProposer({
      brain: o.brain,
      now: () => this.#now(),
      createCadence: (input, shelf) => {
        if (shelf !== this.#project?.view.shelf) throw new Error('Open the project first, then say yes again.');
        this.#cadences.create(input);
      },
      note: (text) => this.#note('cadence', text),
      changed: () => this.#changed('cadence'),
      ...(o.cadenceProposals?.retryWindowMs !== undefined ? { retryWindowMs: o.cadenceProposals.retryWindowMs } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
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
      // Container mode (D1): the hook blocks Claude's own Bash there, so those runs get the hive tools' run_shell.
      ...(doors?.hiveTools ? { hiveTools: { script: doors.hiveTools, runtime: doors.runtime } } : {}),
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
    // Engines on the command engine (Phase 4 B): their own tools switched off by their flags, file and shell
    // work through the hive tools. Copilot (B2), Codex (B3) and Qwen Code (B4) are guarded; the rest are listed
    // only, each with the reason, until container mode (D1).
    const command = (preset: CommandPreset): EngineAdapter => {
      const detect = this.#o.commandDetect?.[preset.id];
      return commandAdapter(preset, {
        hiveTools: doors?.hiveTools ?? null,
        runtime: doors?.runtime ?? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
        runBase: join(this.#o.userDataDir, 'hive', `${preset.id}-runs`),
        ...(detect ? { detect } : {}),
      });
    };
    const [codex, copilot, cursor] = [command(CODEX_PRESET), command(COPILOT_PRESET), command(CURSOR_PRESET)];
    const more = [QWEN_PRESET, GROK_PRESET, KIMI_PRESET, CRUSH_PRESET, PI_PRESET, ANTIGRAVITY_PRESET].map(command);
    if (!scripted) return [claude, gemini, codex, opencode, copilot, cursor, ...more];
    // An engine with no detection (unsupported here, e.g. unguarded) stays as it is, reason and all.
    const listedOnly = (a: EngineAdapter): EngineAdapter => !a.detect ? a : ({
      id: a.id,
      name: a.name,
      vendor: a.vendor,
      capabilities: a.capabilities,
      models: a.models,
      availableIn: a.availableIn,
      ...(a.startsOff ? { startsOff: true } : {}),
      install: a.install,
      signIn: a.signIn,
      privacyNote: a.privacyNote,
      // e2e (C4): after a scripted install the engine shows as installed but signed out, so a test can never
      // route real work to it.
      // e2e (C5): an engine listed in e2eReadyEngines shows as ready, still with no runner (no `create`).
      detect: async () =>
        this.#o.e2eReadyEngines?.includes(a.id)
          ? { state: 'ready', version: 'e2e', message: 'Ready (test). Shown as working; the scripted engine still runs everything.' }
          : this.#e2eInstalled.has(a.id)
            ? { state: 'signed-out', version: 'e2e-installed', message: 'Installed (test). Sign in to use it.' }
            : { state: 'missing', version: null, message: 'Not checked: the scripted engine runs everything here.' },
    });
    // In tests, OpenCode is real only when the test gave it its own detection (a stand-in binary).
    return [scripted, listedOnly(claude), listedOnly(gemini), listedOnly(codex), this.#o.opencodeDetect ? opencode : listedOnly(opencode), listedOnly(copilot), listedOnly(cursor), ...more.map(listedOnly)];
  }

  /** Restore the project and start checking the engine. Never throws: problems become activity lines. */
  async init(): Promise<void> {
    void this.#checkEngines();
    // Container mode (D1): look for Docker or Podman and the image at start (and clear a crash's leftovers).
    void this.#containers.check();
    this.#syncLibrary();
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
    // Built-in jobs run with or without a project (A5): start the scheduler even when none is open.
    if (!opened) void this.#cadences.check();
  }

  // ---- the Librarian (B2 upkeep moved under it in B3) ---------------------------------------------

  /**
   * The Librarian's reflexes. Since Phase 3 A5 (Cadence 05-D7) the periodic fading, scoring and retirement checks
   * are built-in maintenance jobs (switching one off really stops it); what stays here is the start-up check (so
   * the dashboard has a health score at once, fading only if "Tidy the Brain" is on) and the timer that wakes the
   * LLM review when it is due.
   */
  #startLibrarian(): void {
    this.#audit({ fade: this.#jobOn('consolidate') ? 'idle' : 'never', retirements: false });
    const every = this.#o.tidy?.intervalMs ?? 6 * 60 * 60_000;
    this.#tidyTimer = setInterval(() => this.#maybeReview(), every);
    this.#tidyTimer.unref?.();
  }

  #idle(): boolean {
    return this.#working() === 0 && this.#o.brain.goals.list('running').length === 0;
  }

  /** Whether a built-in maintenance job is switched on (A5). */
  #jobOn(job: MaintenanceJob): boolean {
    return this.#o.brain.cadences.get(maintenanceCadenceId(job))?.enabled ?? false;
  }

  /** The decay clock (B2): e2e may move it ahead to test fading without waiting. */
  #decayNow(): number {
    return this.#now() + (this.#o.tidy?.clockShiftDays ?? 0) * DAY;
  }

  /** Fades unused agent notes (B2 decay) and says which; `force` fades even while the hive is busy. Returns how many. */
  #fade(force: boolean): number {
    if (!force && !this.#idle()) return 0;
    const faded = this.#o.brain.fade({ now: this.#decayNow() });
    for (const f of faded.slice(0, 10)) {
      this.#record('brain-tidy', `Faded into the archive: "${f.title}" (unused for ${f.days} days). You can bring it back from the Brain screen.`, {});
    }
    if (faded.length > 10) this.#record('brain-tidy', `…and ${faded.length - 10} more faded into the archive.`, {});
    return faded.length;
  }

  /** Scores the Brain's health on the open project's shelf (or Global) and counts near-duplicates only the user can merge. */
  #scoreHealth(): { health: BrainHealth; duplicates: number } {
    const { brain } = this.#o;
    const shelf = this.#project?.view.shelf ?? MAINTENANCE_SHELF;
    const duplicates = brain.duplicatePairs(shelf).filter((p) => p.userInvolved).length;
    this.#lastAuditAt = this.#now();
    this.#health = brainHealth(brain.healthCounts(shelf, this.#decayNow()), duplicates, this.#lastAuditAt);
    this.#libMessage = `Checked the Brain: ${this.#health.score}/100. ${this.#health.message}`;
    return { health: this.#health, duplicates };
  }

  /**
   * The Librarian's free audit (code only): maybe fade unused agent notes, then score the Brain's health and
   * maybe check skills for retiring (03-D6). The user's "Tidy now" and "Check now" fade even while busy
   * (`force`). Returns how many notes faded.
   */
  #audit(o: { fade: 'force' | 'idle' | 'never'; retirements: boolean }): number {
    if (this.#libState === 'idle') this.#libState = 'auditing';
    try {
      const faded = o.fade === 'never' ? 0 : this.#fade(o.fade === 'force');
      this.#scoreHealth();
      if (o.retirements) {
        try {
          this.#keeper.proposeRetirements();
        } catch (err) {
          this.#o.log?.(`Retirement check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return faded;
    } catch (err) {
      this.#libMessage = `The Librarian could not check the Brain: ${err instanceof Error ? err.message : String(err)}`;
      return 0;
    } finally {
      this.#libState = this.#libState === 'auditing' ? 'idle' : this.#libState;
      this.#changed('librarian');
    }
  }

  // ---- built-in maintenance jobs (Cadence 05-D7; Phase 3 A5) -------------------------------------

  /** Where the `backup` job writes; main sends it at every host start and when the user changes it. */
  setBackupDir(dir: string): void {
    if (typeof dir !== 'string' || !dir.trim() || dir.length > 1_000 || dir.includes('\0')) throw new Error('That is not a folder path.');
    if (!isAbsolute(dir)) throw new Error('The backups folder must be a full path.');
    this.#backupDir = dir;
    this.#backupDirKnown();
  }

  /**
   * One built-in job, as plain code (no Queen, no tokens). Resolves to what it did, in words; throws with why it
   * couldn't. The cadence keeper logs either in the job's run history and runs one job at a time.
   */
  async #maintain(job: MaintenanceJob, manual: boolean): Promise<string> {
    const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
    switch (job) {
      case 'brain-audit': {
        const { health, duplicates } = this.#scoreHealth();
        this.#changed('librarian');
        const dupes = duplicates ? ` ${plural(duplicates, 'near-duplicate')} ${duplicates === 1 ? 'waits' : 'wait'} for you.` : '';
        return `Brain health ${health.score ?? '?'}/100. ${health.message}${dupes}`;
      }
      case 'consolidate': {
        // Fading only while idle (a busy hive is reading the Brain), unless the user ran it now.
        const busy = !manual && !this.#idle();
        const faded = this.#fade(manual);
        const shelves = [...new Set([this.#project?.view.shelf, MAINTENANCE_SHELF].filter((s): s is string => Boolean(s)))];
        const folded = shelves.flatMap((s) => this.#o.brain.foldDuplicates(s));
        for (const f of folded.slice(0, 10)) {
          this.#record('brain-tidy', `Folded a duplicate note into another: "${f.title}". You can bring it back from the Brain screen.`, {});
        }
        if (folded.length > 10) this.#record('brain-tidy', `…and ${folded.length - 10} more duplicates folded.`, {});
        if (faded || folded.length) this.#scoreHealth();
        const fadedText = busy ? 'Nothing faded: agents were working (it fades only while the hive is idle).' : `Faded ${plural(faded, 'unused agent note')}.`;
        return `${fadedText} Folded ${plural(folded.length, 'agent-only near-duplicate')}.`;
      }
      case 'stale-tasks':
        return this.#closeStaleCards();
      case 'skill-review': {
        const n = this.#keeper.proposeRetirements();
        return n ? `Proposed retiring ${plural(n, 'skill')}; ${n === 1 ? 'it waits' : 'they wait'} for you in Approvals.` : 'No skills to retire.';
      }
      case 'backup': {
        // Right at start a due backup may come before main has said where backups go: wait a little for it.
        if (!this.#backupDir && !manual) await Promise.race([this.#backupDirSet, new Promise((r) => setTimeout(r, BACKUP_DIR_WAIT_MS).unref?.())]);
        const dir = this.#backupDir;
        if (!dir) throw new Error('No backups folder yet.');
        const w = writeBackup(this.#o.brain, dir, this.#now());
        const removed = w.removed.length ? ` Removed ${plural(w.removed.length, 'older copy', 'older copies')}.` : '';
        return `Backed up the Brain (${sizeText(w.sizeBytes)}). ${plural(w.kept, 'copy', 'copies')} kept.${removed}`;
      }
    }
  }

  /**
   * Stale task cleanup: cards still open whose goal ended (done or cancelled; a stuck goal can still be re-planned, so its cards stay) over a day ago, or whose goal
   * is gone, are closed as failed with a note. Never deleted; done and failed cards are left alone.
   */
  #closeStaleCards(): string {
    const { brain } = this.#o;
    const cutoff = this.#now() - DAY;
    const goals = new Map(brain.goals.list().map((g) => [g.id, g]));
    let closed = 0;
    for (const card of brain.taskboard.list()) {
      if (card.status === 'done' || card.status === 'failed') continue;
      const g = goals.get(card.goalId);
      const ended = g ? (g.status === 'done' || g.status === 'cancelled') && g.updatedAt < cutoff : card.updatedAt < cutoff;
      if (!ended) continue;
      if (brain.taskboard.close(card.id, 'stale-tasks', g ? 'Closed by stale task cleanup: its goal ended.' : 'Closed by stale task cleanup: its goal is gone.')) closed++;
    }
    if (closed) this.#changed('cards');
    return closed ? `Closed ${closed} stale card${closed === 1 ? '' : 's'} left open after ${closed === 1 ? 'its' : 'their'} goal ended.` : 'No stale cards.';
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

  // ---- the managers' brain side (Phase 2 C2) -------------------------------------------------------

  #incidentViews(goalIds: ReadonlySet<string>): IncidentView[] {
    try {
      return this.#o.brain.incidents
        .list({ limit: 200 })
        .filter((i) => i.goalId === null || goalIds.has(i.goalId))
        .slice(0, 50)
        .map((i) => ({ id: i.id, at: i.at, sensor: i.sensor, step: i.step, agentId: i.agentId, runId: i.runId, goalId: i.goalId, cardId: i.cardId, evidence: i.evidence, recurrence: i.recurrence }));
    } catch {
      return [];
    }
  }

  #managersView(goalIds: ReadonlySet<string>): ManagersView {
    const m = this.#managers;
    let decisions: ManagersView['foremanDecisions'];
    try {
      decisions = this.#o.brain.foreman
        .list(100)
        .filter((d) => goalIds.has(d.goalId))
        .slice(0, 20)
        .map((d) => ({ at: d.at, goalId: d.goalId, cardId: d.cardId, cardTitle: d.cardTitle, action: d.action, reason: d.reason }));
    } catch {
      decisions = [];
    }
    return {
      scoutBeforePlanning: m.scoutBeforePlanning,
      reviewEveryCards: m.reviewEveryCards,
      cardsUntilReview: m.reviewEveryCards > 0 ? Math.max(0, m.reviewEveryCards - m.cardsSince) : null,
      lastReview: m.lastReview,
      foremanDecisions: decisions,
    };
  }

  /**
   * What the Scout reads instead of the whole project (C2): symbols that match the goal's words, by file, then
   * the other mapped files. Null when no project is open or its code map isn't ready (the Scout then stays out).
   */
  #scoutOutline(goal: string): string | null {
    const p = this.#project;
    if (!p || !this.#codeMap || this.#codeMap.view().state !== 'ready') return null;
    const code = this.#o.brain.code;
    const shelf = p.view.shelf;
    const files = [...code.hashes(shelf).keys()].sort();
    if (!files.length) return null;
    const words = [...new Set(goal.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])].filter((w) => !STOP_WORDS.has(w)).slice(0, 8);
    const byFile = new Map<string, string[]>();
    for (const w of words) {
      for (const h of code.findSymbols(shelf, w, 8).hits) {
        const list = byFile.get(h.path) ?? [];
        const entry = `${h.name} (${h.kind}, line ${h.line})`;
        if (list.length < 6 && !list.includes(entry)) list.push(entry);
        byFile.set(h.path, list);
      }
    }
    const lines = [...byFile].slice(0, 25).map(([path, syms]) => `${path}: ${syms.join(', ')}`);
    const rest = files.filter((f) => !byFile.has(f));
    if (rest.length) lines.push(`Other mapped files (${rest.length}):`, ...rest.slice(0, Math.max(10, 40 - lines.length)).map((f) => `- ${f}`));
    return lines.join('\n');
  }

  /** Why the Foreman's periodic review can't run now, or null. `dueOnly`: the automatic one also waits for an idle hive. */
  #hiveReviewBlocked(dueOnly: boolean): string | null {
    if (!this.#project) return 'Open a project first.';
    if (this.#hiveReviewing) return 'A review is already running.';
    if (!this.#engines.defaultEngine()) return 'No AI engine is ready.';
    if (this.#paused) return 'The hive is paused.';
    if (dueOnly && this.#working() > 0) return 'Agents are working.';
    return null;
  }

  /** The periodic review after every N finished cards (0 = off), when the hive is idle. */
  #maybeHiveReview(): void {
    const m = this.#managers;
    if (this.#disposed || m.reviewEveryCards <= 0 || m.cardsSince < m.reviewEveryCards || this.#hiveReviewBlocked(true)) return;
    this.#track(this.#runHiveReview());
  }

  /** The Foreman reviews the board; its report is saved in the Brain and told to the user through the Queen. */
  async #runHiveReview(): Promise<void> {
    const p = this.#project;
    if (!p || this.#hiveReviewing) return;
    this.#hiveReviewing = true;
    const since = this.#managers.lastReview?.at ?? null;
    this.#managers = { ...this.#managers, cardsSince: 0 };
    this.#writeSettings({ managers: this.#managers });
    this.#changed('managers');
    try {
      const r = await p.hive.review(since);
      if (this.#disposed) return;
      if (!r.ok || !r.summary) {
        this.#note('foreman', `The Foreman's review gave nothing usable (${r.error ?? 'no report'}).`);
        return;
      }
      const at = this.#now();
      let recordId: string | null = null;
      try {
        recordId = this.#o.brain.write(
          { kind: 'update', shelf: p.view.shelf, title: `Hive review, ${new Date(at).toISOString().slice(0, 10)}`, body: r.summary, source: 'foreman-review' },
          { type: 'agent', id: 'Foreman' },
        ).id;
      } catch {
        recordId = null;
      }
      this.#managers = { ...this.#managers, lastReview: { at, summary: r.summary, recordId } };
      this.#writeSettings({ managers: this.#managers });
      this.#note('foreman', r.summary);
    } catch (err) {
      this.#note('error', `The Foreman's review failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#hiveReviewing = false;
      this.#changed('managers');
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
    this.#cadences.stop();
    if (this.#engineTimer) clearTimeout(this.#engineTimer);
    if (this.#tidyTimer) clearInterval(this.#tidyTimer);
    if (this.#outTimer) clearTimeout(this.#outTimer);
    if (this.#changedTimer) clearTimeout(this.#changedTimer);
    if (this.#codeMapTimer) clearTimeout(this.#codeMapTimer);
    if (this.#containersPushTimer) clearTimeout(this.#containersPushTimer);
    this.#containers.dispose();
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
    // The library's own approvals and commands (C3) work with or without an open project.
    if ((cmd.type === 'approve' || cmd.type === 'deny') && this.#keeper.owns(cmd.approvalId)) return this.#keeper.decide(cmd.approvalId, cmd.type === 'approve');
    // Webhook calls waiting in Approvals (Cadence 05-D4; Phase 3 A4): the cadence keeper decides them.
    if ((cmd.type === 'approve' || cmd.type === 'deny') && this.#cadences.owns(cmd.approvalId)) return this.#cadences.decide(cmd.approvalId, cmd.type === 'approve');
    // Cadence proposals (Cadence 05-D3; Phase 3 A5): a yes makes the cadence, a no means never again.
    if ((cmd.type === 'approve' || cmd.type === 'deny') && this.#proposer.owns(cmd.approvalId)) return this.#proposer.decide(cmd.approvalId, cmd.type === 'approve');
    if (cmd.type === 'retireLibraryItem') return this.#keeper.retire(cmd.name);
    if (cmd.type === 'restoreLibraryItem') return this.#keeper.restore(cmd.name);
    if (cmd.type === 'markDigestSeen') {
      // "Got it" (B1): what happened so far no longer counts as unseen. command() fires the change.
      this.#digestSeenAt = this.#now();
      this.#writeSettings({ digestSeenAt: this.#digestSeenAt });
      return;
    }
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
      if (!this.#audit({ fade: 'force', retirements: true })) this.#note('brain-tidy', 'The Brain is tidy: nothing to fade.');
      return;
    }
    if (cmd.type === 'setManagers') {
      this.#managers = {
        ...this.#managers,
        ...(cmd.scoutBeforePlanning !== undefined ? { scoutBeforePlanning: cmd.scoutBeforePlanning } : {}),
        ...(cmd.reviewEveryCards !== undefined ? { reviewEveryCards: cmd.reviewEveryCards } : {}),
      };
      this.#writeSettings({ managers: this.#managers });
      this.#changed('managers');
      queueMicrotask(() => this.#maybeHiveReview());
      return;
    }
    if (cmd.type === 'runReview') {
      const blocked = this.#hiveReviewBlocked(false);
      if (blocked) throw new Error(`The Foreman can't review now: ${blocked}`);
      this.#track(this.#runHiveReview());
      await Promise.resolve();
      return;
    }
    if (cmd.type === 'runLibrarian') {
      // The free audit always runs (fading too: the user asked); the LLM review only when it may.
      this.#audit({ fade: 'force', retirements: true });
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
    // Cadences (Phase 3 A1): they belong to the open project.
    switch (cmd.type) {
      case 'createCadence':
        this.#cadences.create(cmd.cadence);
        return;
      case 'updateCadence':
        this.#cadences.update(cmd.id, cmd.cadence);
        return;
      case 'setCadenceEnabled':
        return this.#cadences.setEnabled(cmd.id, cmd.enabled);
      case 'deleteCadence':
        return this.#cadences.delete(cmd.id);
      case 'runCadenceNow':
        return this.#cadences.runNow(cmd.id);
    }
    const p = this.#mustProject();
    switch (cmd.type) {
      case 'submitGoal': {
        if (!this.#engines.defaultEngine()) {
          const view = this.#engineView();
          throw new Error(`${view.name} is not ready: ${view.message}`);
        }
        const before = new Set(this.#o.brain.goals.list().map((g) => g.id));
        // Planning can take minutes with a real engine: start it and return. The goal shows up at once.
        this.#track(
          p.hive.submitGoal(cmd.text, { ...(cmd.budgetTokens ? { budgetTokens: cmd.budgetTokens } : {}), ...(cmd.containers ? { containers: cmd.containers } : {}) }).catch((err: unknown) => {
            if (this.#disposed) return;
            this.#note('error', `The Queen could not plan: ${err instanceof Error ? err.message : String(err)}`);
            this.#changed('plan-failed');
          }),
        );
        // Let the synchronous part (goal created) run before the UI re-reads.
        await Promise.resolve();
        // The user's own goal (never a cadence's): a request asked often enough may become a cadence proposal (05-D3).
        const mine = this.#o.brain.goals.list().find((g) => !before.has(g.id) && g.cadenceId === null && g.shelf === p.view.shelf);
        if (mine) {
          try {
            this.#proposer.goalSubmitted(mine.id);
          } catch (err) {
            this.#o.log?.(`[cadence] proposal check failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return;
      }
      case 'approve':
        return p.hive.approve(cmd.approvalId);
      case 'deny':
        return p.hive.deny(cmd.approvalId);
      case 'cancelGoal':
        return p.hive.cancelGoal(this.#ownGoal(cmd.goalId).id);
      case 'setGoalContainers': {
        // Phase 4 D2: the user forces containers for a goal (or lets it follow the setting again), for its next runs.
        const goal = p.hive.setGoalContainers(this.#ownGoal(cmd.goalId).id, cmd.containers);
        this.#note(
          'containers',
          cmd.containers === 'always'
            ? `"${goal.title}" now runs every card in a container, whatever the container setting.`
            : `"${goal.title}" follows the container setting again.`,
        );
        // Letting a goal follow the setting may leave no waiting card that needs a container: carry on.
        this.#maybeResumeAfterContainers();
        return;
      }
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
      case 'saveBrainAnswer':
        return this.#saveBrainAnswer(p, cmd);
    }
  }

  /**
   * Keep an Ask-the-Brain answer (Phase 4 A1): an unconfirmed `update` on the project's shelf, written as the
   * Librarian (never as the user, so it never counts as confirmed), linked `cites` to each record it cited.
   */
  #saveBrainAnswer(p: ProjectState, cmd: Extract<HiveCommand, { type: 'saveBrainAnswer' }>): void {
    const { brain } = this.#o;
    const ids = [...new Set(cmd.citationIds)];
    const cited = ids.map((id) => {
      const rec = brain.get(id);
      if (!rec || (rec.shelf !== p.view.shelf && rec.shelf !== 'global')) throw new Error(`Not saved: ${id} is not a record in this project's Brain.`);
      return rec;
    });
    const { title, body } = answerRecord(cmd.question, cmd.answer, cited.map((r) => r.title));
    let id: string;
    try {
      id = brain.write({ kind: 'update', shelf: p.view.shelf, title, body, trust: 'unconfirmed', source: 'Ask the Brain' }, { type: 'agent', id: LIBRARIAN }).id;
    } catch (err) {
      if (err instanceof SecretError) throw new Error('Not saved: it looks like a password or key. Keys belong in the Vault, never in the Brain.', { cause: err });
      throw err;
    }
    for (const rec of cited) brain.link(id, rec.id, 'cites');
    this.#note('brain-ask', `Saved an answer from Ask the Brain as an unconfirmed note: ${short(title, 120)}`);
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
    // A cadence run owed while paused runs once now (05-D5).
    queueMicrotask(() => void this.#cadences.check());
  }

  /** Why a cadence run can't start now, in words, or null. */
  #cadenceBlocked(): string | null {
    if (!this.#project) return 'No project is open.';
    if (this.#paused) return `The hive is paused (${this.#pausedReason ?? 'paused'}).`;
    if (this.#project.hive.paused) return 'The hive is paused.';
    return null;
  }

  /** A cadence run becomes a goal through the same path as the user's own goals (05-D1); resolves to its id. */
  async #submitCadenceGoal(c: Cadence, trigger?: string): Promise<string> {
    const p = this.#mustProject();
    if (!this.#engines.defaultEngine()) {
      const view = this.#engineView();
      throw new Error(`${view.name} is not ready: ${view.message}`);
    }
    const before = new Set(this.#o.brain.goals.list().filter((g) => g.cadenceId === c.id).map((g) => g.id));
    // The goal is created at once; planning carries on in the background, as with the submitGoal command.
    this.#track(
      p.hive.submitGoal(trigger ? `${c.goal}\n\nWhat triggered this run:\n${trigger}` : c.goal, { title: c.name, budgetTokens: c.budgetTokens, cadenceId: c.id, cadenceName: c.name, autonomy: c.autonomy }).catch((err: unknown) => {
        if (this.#disposed) return;
        this.#note('error', `The Queen could not plan the cadence run "${c.name}": ${err instanceof Error ? err.message : String(err)}`);
        this.#changed('plan-failed');
      }),
    );
    await Promise.resolve();
    const goal = this.#o.brain.goals.list().find((g) => g.cadenceId === c.id && !before.has(g.id));
    if (!goal) throw new Error('The goal was not created.');
    return goal.id;
  }

  // ---- project ---------------------------------------------------------------------------------

  async #setProject(path: string): Promise<void> {
    if (this.#project && this.#working() > 0) throw new Error('Agents are working. Pause the hive and wait for them to stop before switching projects.');
    await this.#openProject(path);
    if (!this.#o.project) this.#writeSettings({ projectPath: this.#project!.view.path });
    // A new shelf: score its health at once (read-only; fading is the "Tidy the Brain" job's, Phase 3 A5).
    this.#audit({ fade: 'never', retirements: false });
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
      library: new Library(this.#o.libraryDir, this.#userLib.root),
      repoDir: root,
      dataDir: join(data, 'projects', view.shelf),
      shelf: view.shelf,
      home: homedir(),
      models: MODELS,
      insectCap: this.#limits.insectCap,
      defaultBudgetTokens: this.#limits.goalBudgetTokens,
      approveEveryPlan: this.#limits.approveEveryPlan,
      castes: [...ALL_CASTES],
      // The managers' brain side (C2).
      ...(this.#o.watchdog !== undefined ? { watchdog: this.#o.watchdog } : {}),
      ...(this.#o.foremanBrain !== undefined ? { foremanBrain: this.#o.foremanBrain } : {}),
      scout: { enabled: () => this.#managers.scoutBeforePlanning, outline: (goal: string) => this.#scoutOutline(goal) },
      // Container mode (D1): asked at the start of every card run that may run commands.
      containers: () => this.#containers.setup(),
      containerRunEnded: (box) => this.#containers.runEnded(box),
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
    // Its cadences: anything due while it was closed (or the app was) catches up once (05-D5).
    void this.#cadences.check();
  }

  async #closeProject(): Promise<void> {
    const p = this.#project;
    if (!p) return;
    this.#project = null;
    clearInterval(p.timer);
    // Stop every agent and wait for its bookkeeping (spend, outcomes, worktree cleanup) to finish, plus the
    // Foreman pass and background planning, so nothing writes to the Brain or the workspace after they
    // close. Capped so a stuck engine can never hang shutdown.
    // The old hive pauses itself to settle; that is not the user pausing the hive, so it must not carry over to
    // the next project (C5 found switching projects left the new hive paused with "Switching project.").
    this.#closingHive = true;
    try {
      const settled = Promise.allSettled([p.hive.settle('Switching project.'), this.#tickRun, ...this.#background]);
      await Promise.race([settled, new Promise((r) => setTimeout(r, SETTLE_TIMEOUT_MS).unref?.())]);
    } finally {
      this.#closingHive = false;
    }
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
      this.#maybeResumeAfterContainers();
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
    const boardCards = goals.flatMap((g) => brain.taskboard.list({ goalId: g.id }));
    this.#cardSkills = this.#latestSkills(boardCards.map((c) => c.id));
    const cards = boardCards.map((c) => this.#cardView(c));
    this.#cardSkills = null;
    const allApprovals = brain.approvals.list();
    const approvals = allApprovals.filter((a) => a.goalId === null || goalIds.has(a.goalId));
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
      incidents: this.#incidentViews(goalIds),
      managers: this.#managersView(goalIds),
      hive: { paused: this.#paused, pausedReason: this.#pausedReason, insectCap: this.#limits.insectCap, working: this.#working() },
      digest: (({ unseen, since, headline }) => ({ unseen, since, headline }))(this.#digest(allApprovals.filter((a) => a.status === 'waiting'))),
      cadences: this.#cadences.views(),
      goals: goals.map((g) => this.#goalView(g)),
      cards,
      approvals: [...waiting, ...decided].map(approvalView),
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
      cadenceId: g.cadenceId,
      containers: g.containers,
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
      skills: (this.#cardSkills ?? this.#latestSkills([c.id])).get(c.id) ?? [],
      heldReason: c.heldReason,
      // Phase 4 D2: the same rule the card's runs use, with whether containers are usable right now.
      container: this.#project?.hive.cardContainer(c.id) ?? null,
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

  /**
   * The Brain's timeline (Phase 4 A3): every change to a record, newest first, paged with `before`. Scope as the
   * graph: the open project's shelf plus Global (Global alone when no project is open), Global alone, or every
   * shelf. `actors` lists everyone who changed something in that scope and time window, for the actor filter.
   */
  brainTimeline(req: BrainTimelineRequest): BrainTimelineView {
    const r = BrainTimelineRequestSchema.parse(req);
    const project = this.#project?.view.shelf;
    const shelves = r.scope === 'all' ? undefined : r.scope === 'global' || !project ? ['global'] : [project, 'global'];
    const page = this.#o.brain.timeline({
      ...(shelves ? { shelves } : {}),
      ...(r.kinds?.length ? { kinds: r.kinds } : {}),
      ...(r.changes?.length ? { changes: r.changes } : {}),
      ...(r.actor ? { actor: r.actor } : {}),
      ...(r.query ? { query: r.query } : {}),
      ...(r.since !== undefined ? { since: r.since } : {}),
      ...(r.until !== undefined ? { until: r.until } : {}),
      ...(r.before ? { before: r.before } : {}),
      limit: r.limit,
    });
    return BrainTimelineViewSchema.parse({ ...page, actors: this.#o.brain.timelineActors(shelves, r.since, r.until) });
  }

  /**
   * The Budgets screen (Phase 2 C4; 02-D7, D9; 04-D7). Goals are the open project's; days, roles, routing and
   * what the Treasurer learned span every project, because subscriptions are shared by all of them.
   */
  /** The computer woke from sleep (Phase 3 A2, 05-D5): runs that came due while it slept happen now, once. */
  wake(): void {
    this.#cadences.wake();
  }

  /**
   * An outside app called a webhook (Cadence 05-D4; Phase 3 A4). main checked the secret, size and rate first; the
   * cadence keeper applies the trust mode, logs the call, and says what to answer the caller.
   */
  webhookCall(call: WebhookCall): Promise<WebhookReply> {
    return this.#cadences.webhook(WebhookCallSchema.parse(call));
  }

  /** The "while you were away" digest (Phase 3 B1): unattended work since the user last read it. */
  digest(): DigestView {
    return this.#digest();
  }

  /**
   * The Brain as an Obsidian vault (Memory 01-D11; Phase 3 C2): every shelf, the open project's shelf named after its
   * folder. main picked the folder; errors come back in words, never thrown.
   */
  exportObsidian(req: ObsidianExportRequest): ObsidianExportResult {
    const p = this.#project?.view;
    return exportObsidian({ brain: this.#o.brain, request: req, now: this.#now(), project: p ? { shelf: p.shelf, name: p.name } : null });
  }

  /** `waiting`: every waiting approval, when the caller already read them (the snapshot). */
  #digest(waiting?: ApprovalItem[]): DigestView {
    return buildDigest({ brain: this.#o.brain, since: this.#digestSeenAt, until: this.#now(), shelf: this.#project?.view.shelf ?? null, ...(waiting ? { waiting } : {}) });
  }

  /** A cadence's run history, newest first (Phase 3 A1). Runs of a deleted cadence stay readable. */
  cadenceRuns(req: { cadenceId: string; limit?: number }): CadenceRunView[] {
    const c = this.#o.brain.cadences.get(req.cadenceId);
    // A built-in job's history (A5) is readable with or without a project.
    if (c && !isBuiltIn(c) && c.shelf !== this.#project?.view.shelf) return [];
    return this.#cadences.runs(req.cadenceId, req.limit ?? 50);
  }

  budgets(): BudgetsView {
    const { brain } = this.#o;
    const now = this.#now();
    const goals = this.#goals().slice(0, 30);
    const runs = brain.outcomes.forGoals(goals.map((g) => g.id));
    const tokensOf = (o: { tokensIn: number; tokensOut: number; tokensCache: number }): number => o.tokensIn + o.tokensOut + o.tokensCache;
    const goalViews = goals.map((g) => {
      const mine = runs.filter((o) => o.goalId === g.id);
      const byCard = new Map<string, { tokens: number; costUsd: number }>();
      for (const o of mine) {
        if (!o.cardId) continue;
        const s = byCard.get(o.cardId) ?? { tokens: 0, costUsd: 0 };
        s.tokens += tokensOf(o);
        s.costUsd += o.costUsd;
        byCard.set(o.cardId, s);
      }
      const cards = [...byCard.entries()]
        .map(([id, s]) => ({ id, card: brain.taskboard.get(id), ...s }))
        .filter((c) => c.card)
        .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
        .slice(0, 10)
        .map(({ id, card, tokens, costUsd }) => ({ id, title: card!.title, caste: card!.caste, tokens, costUsd, attempts: card!.attempts }));
      return {
        id: g.id,
        title: g.title,
        status: g.status,
        budgetTokens: g.budgetTokens,
        usedTokens: g.spentTokens,
        costUsd: g.spentUsd,
        costEstimated: mine.some((o) => o.costEstimated),
        cards,
      };
    });
    const dayStart = (t: number): number => {
      const d = new Date(t);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    const outcome = (r: string): BudgetsView['routing'][number]['outcome'] =>
      r === 'pass' ? 'passed' : r === 'fail' || r === 'error' ? 'failed' : r === 'pending' ? 'running' : r === 'stopped' ? 'stopped' : 'other';
    const engineOf = (e: string): EngineId | null => (EngineIdSchema.safeParse(e).success ? (e as EngineId) : null);
    const routing = brain.outcomes.recent(100).map((o) => {
      const card = o.cardId ? brain.taskboard.get(o.cardId) : undefined;
      const goal = o.goalId ? brain.goals.get(o.goalId) : undefined;
      const title =
        o.role === 'queen' ? `Plan: ${goal?.title ?? 'a goal'}` : o.role === 'inspector' ? `Verify: ${card?.title ?? 'a card'}` : (card?.title ?? goal?.title ?? o.role);
      return {
        at: o.at,
        runId: o.runId,
        role: o.role,
        caste: CasteSchema.safeParse(o.role).success ? (o.role as CardView['caste']) : null,
        cardId: o.cardId,
        title,
        engine: engineOf(o.engine),
        model: o.model || null,
        effort: o.effort || null,
        rule: o.reason ?? 'Rule not recorded (an older run).',
        outcome: outcome(o.result),
        tokens: tokensOf(o),
        costUsd: o.costUsd,
      };
    });
    const TIERS = new Set(['strongest', 'standard', 'light']);
    const learned = brain.outcomes
      .learned()
      .filter((l) => engineOf(l.engine) && TIERS.has(l.tier))
      .map((l) => ({ role: l.role, engine: l.engine as EngineId, tier: l.tier as 'strongest' | 'standard' | 'light', tries: l.tries, passes: l.passes }));
    return BudgetsViewSchema.parse({
      goals: goalViews,
      days: brain.outcomes.byDay(14, now, dayStart),
      byRole: brain.outcomes.byRole(dayStart(now) - 13 * 86_400_000),
      routing,
      learned,
    });
  }

  // ---- Ask the Brain (Memory 01; Phase 4 A1) -------------------------------------------------------

  /**
   * Answer a question only from Brain records: hybrid search over the project's shelf and Global, then one short
   * read-only run (the Hive's askBrain) over the numbered sources. Nothing found → "doesn't know" with no run.
   * Quiet: no activity line, and nothing is written to the Brain unless the user saves the answer.
   */
  async brainAsk(req: BrainAskRequest): Promise<BrainAskResult> {
    const raw = (req as { question?: unknown } | null)?.question;
    const parsed = BrainAskRequestSchema.safeParse(req);
    if (!parsed.success) return { status: 'error', question: typeof raw === 'string' ? raw.trim() : '', message: 'Ask a question of 3 to 500 characters.' };
    const question = parsed.data.question;
    const error = (message: string): BrainAskResult => ({ status: 'error', question, message });
    const p = this.#project;
    if (!p) return error('Open a project first.');
    if (this.#asking) return error('One question at a time.');
    this.#asking = true;
    try {
      const embed = this.#o.meaning ? (text: string) => this.#o.meaning!.embedQuery(text) : undefined;
      const sources = await findSources(this.#o.brain, question, p.view.shelf, embed);
      if (!sources.length) return { status: 'unknown', question, message: NOTHING_MATCHES, sources: [], tokens: 0, costUsd: 0 };
      if (!this.#engines.canRoute('librarian')) return error('No AI engine is ready to answer. Set one up in Connections.');
      const work = p.hive.askBrain(question, sources);
      // Closing the project waits for the run, like any other background work.
      this.#track(work.catch(() => undefined));
      const r = await work;
      if (!r.ok) {
        if (!r.unknown) return error(`The Brain couldn't answer: ${(r.error ?? 'the AI run failed').replace(/\.$/, '')}.`);
        return { status: 'unknown', question, message: NOT_ANSWERED, sources: sources.map(sourceView), tokens: r.tokens, costUsd: r.costUsd };
      }
      const cited = citedSources(sources, r.cited);
      if (!cited.length) return { status: 'unknown', question, message: NOT_ANSWERED, sources: sources.map(sourceView), tokens: r.tokens, costUsd: r.costUsd };
      return {
        status: 'answered',
        question,
        answer: r.answer,
        citations: cited.map(sourceView),
        sourcesGiven: sources.length,
        engine: r.engine,
        model: r.model,
        tokens: r.tokens,
        costUsd: r.costUsd,
        costEstimated: r.costEstimated,
      };
    } catch (err) {
      return error(`The Brain couldn't answer: ${(err instanceof Error ? err.message : String(err)).replace(/\.$/, '')}.`);
    } finally {
      this.#asking = false;
    }
  }

  /** What one question roughly costs and where it runs (the Treasurer's route for the Librarian's role). */
  brainAskEstimate(): BrainAskEstimate {
    let engine: { id: string; name: string; free: boolean; subscription: boolean } | null = null;
    if (this.#engines.canRoute('librarian')) {
      // The same route the question's run takes, so the engine named here is the one that answers.
      const route = this.#engines.route(ASK_ROUTE, routeCard);
      const a = this.#engines.adapter(route.engine);
      engine = {
        id: route.engine,
        name: a?.name ?? route.engine,
        free: route.engine === 'fake' || a?.capabilities.free === true,
        subscription: a?.capabilities.subscription === true,
      };
    }
    const runs = this.#o.brain.outcomes
      .recent(500)
      .map((o) => ({ role: o.role, engine: o.engine, tokens: o.tokensIn + o.tokensOut + o.tokensCache, costUsd: o.costUsd }));
    return askEstimate({ project: this.#project !== null, engine, runs });
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

  /**
   * e2e only (Phase 4 A2, the Brain Globe): writes `count` records quickly (a mix of kinds, titles "Seed fact 123")
   * on the open project's shelf (Global when none is open, or when `shelf` says 'global'), each linked `relates_to`
   * to ~`linksPerRecord` records seeded before it (a fractional part is a chance of one more). Random but
   * deterministic: one seeded rng for the whole run, so the same calls give the same links. The Brain has no public
   * batch write, so these are plain writes (one small transaction each); main sends big seeds in chunks so the host
   * keeps answering other calls between them. Refused outside end-to-end tests.
   */
  e2eSeedRecords(req: { count: number; linksPerRecord: number; shelf?: 'project' | 'global' }): { created: number; links: number; total: number; ms: number } {
    if (process.env['INSECTOIDS_E2E'] !== '1') throw new Error('Only available in end-to-end tests.');
    const { count, linksPerRecord } = req;
    if (!Number.isInteger(count) || count < 1 || count > 5000) throw new Error('e2eSeedRecords needs a count from 1 to 5000.');
    if (!Number.isFinite(linksPerRecord) || linksPerRecord < 0 || linksPerRecord > 5) throw new Error('e2eSeedRecords needs linksPerRecord from 0 to 5.');
    const shelf = req.shelf === 'global' ? 'global' : (this.#project?.view.shelf ?? 'global');
    const kinds = ['fact', 'decision', 'task', 'update', 'agent_memory'] as const;
    const b = this.#o.brain;
    const rng = this.#e2eSeedRng;
    const user = { type: 'user' as const };
    const started = Date.now();
    let created = 0;
    let links = 0;
    for (let i = 0; i < count; i++) {
      const n = this.#e2eSeeded.length + 1;
      const kind = kinds[n % kinds.length]!;
      const label = kind === 'agent_memory' ? 'note' : kind;
      const { id } = b.write({ kind, shelf, title: `Seed ${label} ${n}`, body: `Seeded ${label} number ${n}, for the Brain Globe test.` }, user);
      const prior = this.#e2eSeeded.length;
      this.#e2eSeeded.push(id);
      created++;
      if (!prior) continue;
      const want = Math.floor(linksPerRecord) + (rng() < linksPerRecord % 1 ? 1 : 0);
      const targets = new Set<string>();
      for (let k = 0; k < want; k++) targets.add(this.#e2eSeeded[Math.floor(rng() * prior)]!);
      for (const to of targets) b.link(id, to, 'relates_to');
      links += targets.size;
    }
    this.#changed('brain-edit');
    return { created, links, total: this.#e2eSeeded.length, ms: Date.now() - started };
  }

  /**
   * e2e only (C4): a scripted engine install "finished", so that listed engine now shows as installed and signed
   * out (never ready: it has no runner here). Refused outside end-to-end tests.
   */
  async e2eEngineInstalled(engineId: string): Promise<void> {
    if (process.env['INSECTOIDS_E2E'] !== '1') throw new Error('Only available in end-to-end tests.');
    const id = EngineIdSchema.parse(engineId);
    this.#e2eInstalled.add(id);
    await this.#recheckEngines();
  }

  /** The engine cards (Connections), for main's installer: it reads the install command from here. */
  engineCard(engineId: string): EngineCard | null {
    return this.snapshot().engines.find((e) => e.id === engineId) ?? null;
  }

  brainRecent(params: { kinds?: Parameters<Brain['recent']>[0]['kinds']; includeHistory?: boolean } = {}) {
    const shelf = this.#project?.view.shelf ?? 'global';
    return this.#o.brain
      .recent({ shelf, ...(params.kinds ? { kinds: params.kinds } : {}), ...(params.includeHistory ? { includeHistory: true } : {}), limit: 50 })
      .map(({ score: _s, ...h }) => h);
  }

  // ---- the library (Phase 2 C1; Capabilities 03-D3, D7, D8) -------------------------------------

  /** Bring the Brain's catalog in line with the library folder. Never throws: a problem is one activity line. */
  #syncLibrary(): void {
    try {
      const r = this.#o.brain.library.sync(loadCatalog(this.#o.libraryDir));
      this.#o.log?.(`Library catalog: ${r.added} added, ${r.updated} updated, ${r.removed} removed.`);
    } catch (err) {
      this.#note('error', `Could not read the library catalog: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #latestSkills(cardIds: string[]): Map<string, string[]> {
    try {
      return this.#o.brain.library.latestByCard(cardIds);
    } catch {
      return new Map();
    }
  }

  /** The library file's text without its frontmatter, or null when it isn't on disk. */
  #libraryText(file: string | null, origin: 'built-in' | 'learned' | 'imported' = 'built-in'): string | null {
    if (!file) return null;
    if (origin !== 'built-in') return this.#userLib.read(file)?.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() ?? null;
    const path = join(this.#o.libraryDir, file);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  }

  /** The 8 castes: what each is for, the skills it always carries, and its network policy (03-D3). */
  libraryCastes(): CasteView[] {
    return ALL_CASTES.map((caste) => {
      let role = '';
      try {
        role = firstSentence(frontmatterDescription(readFileSync(join(this.#o.libraryDir, 'agents', caste, 'AGENT.md'), 'utf8')));
      } catch {
        // A missing agent file shows an empty role line rather than failing the screen.
      }
      return {
        caste,
        label: `${caste[0]!.toUpperCase()}${caste.slice(1)}`,
        role,
        defaultSkills: [...ROLE_SKILLS[caste]],
        network: CASTE_NETWORK[caste],
        enabled: true,
      };
    });
  }

  #libraryItemView(i: ReturnType<Brain['library']['search']>['items'][number]): LibraryItemView {
    return {
      name: i.name,
      kind: i.kind,
      status: i.status,
      castes: i.castes,
      description: i.description,
      safety: i.safety,
      sources: i.sources,
      usage: { uses: i.uses, passed: i.passed, failed: i.failed, lastUsedAt: i.lastUsedAt },
      origin: i.origin,
      scan: scanOf(i),
      approvalId: i.approvalId,
    };
  }

  /** Search the catalog (Library screen): words, kinds, statuses and caste; counts by status for the chips. */
  librarySearch(req: LibrarySearchRequest): LibrarySearchResult {
    const r = LibrarySearchRequestSchema.parse(req ?? {});
    const { items, total } = this.#o.brain.library.search({
      query: r.query,
      ...(r.kinds ? { kinds: r.kinds } : {}),
      ...(r.statuses ? { statuses: r.statuses } : {}),
      ...(r.caste ? { caste: r.caste } : {}),
      limit: r.limit,
      offset: r.offset,
    });
    return { items: items.map((i) => this.#libraryItemView(i)), total, counts: this.#o.brain.library.counts() };
  }

  /**
   * Import a skill or agent folder the user picked (C3, 03-D5): copied into the user library, scanned, and
   * (unless the scan blocks it) waiting for the user's OK as an approval. Never throws: problems are results.
   */
  libraryImport(path: string): LibraryImportResult {
    try {
      if (typeof path !== 'string' || !path) return { status: 'error', message: 'No folder was chosen.' };
      const r = this.#keeper.importFolder(path);
      this.#changed('library');
      return r;
    } catch (err) {
      return { status: 'error', message: `The import failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Self-learning skills (C3, 03-D6): after a card passes, look for the same kind of work done three times
   * on this project's shelf. At most one proposal a day, one at a time, never while paused.
   */
  #maybeProposeSkill(): void {
    const p = this.#project;
    if (this.#disposed || !p || this.#proposing || this.#paused || this.#o.skillProposals === false) return;
    try {
      if (!this.#keeper.proposalDue()) return;
      const { brain } = this.#o;
      const cards: DoneCard[] = [];
      for (const g of brain.goals.list().filter((x) => x.shelf === p.view.shelf)) {
        for (const c of brain.taskboard.list({ goalId: g.id, status: 'done' })) {
          cards.push({ id: c.id, caste: c.caste, title: c.title, brief: c.brief, acceptance: c.acceptance, result: c.result ?? null, at: c.updatedAt });
        }
      }
      const work = this.#keeper.repeatedWork(cards);
      if (!work) return;
      this.#proposing = true;
      this.#track(
        this.#keeper
          .propose(work, (w) => p.hive.draftSkill(w))
          .catch((err: unknown) => this.#note('error', `The skill proposal failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            this.#proposing = false;
            this.#changed('library');
          }),
      );
    } catch (err) {
      this.#o.log?.(`Skill proposal check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One item: its text when it is on disk (never for dormant entries), and the latest cards it was carried on. */
  libraryItem(name: string): LibraryItemDetail | null {
    if (typeof name !== 'string' || !name) return null;
    const i = this.#o.brain.library.get(name);
    if (!i) return null;
    return {
      item: this.#libraryItemView(i),
      body: i.status === 'dormant' ? null : this.#libraryText(i.file, i.origin),
      recentCards: this.#o.brain.library.recentCards(name, 10),
    };
  }

  // ---- events → read model ---------------------------------------------------------------------

  #onHiveEvent(e: HiveEvent): void {
    // Hive events a cadence can wait for (A3); the keeper applies the loop guard.
    if (e.type === 'goal-done' && e.goalId) {
      const goalId = e.goalId;
      const merged = e.message === 'Merged into main.' ? true : e.message === 'Finished; not merged.' ? false : undefined;
      queueMicrotask(() => this.#cadences.hiveEvent({ on: 'goal-done', goalId, ...(merged === undefined ? {} : { merged }) }));
    }
    if (e.type === 'budget-warning' && e.goalId) {
      const goalId = e.goalId;
      queueMicrotask(() => this.#cadences.hiveEvent({ on: 'budget-warning', goalId }));
    }
    // A goal ended: a file or event cadence that waited for its last run can run now.
    if (e.type === 'goal-done' || e.type === 'goal-cancelled' || e.type === 'goal-stuck') queueMicrotask(() => void this.#cadences.check());
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
        role: r.role === 'queen' || r.role === 'inspector' || r.role === 'librarian' || r.role === 'scout' || r.role === 'foreman' ? r.role : 'insect',
        caste: isInsectRole(r.role) ? (r.role as AgentView['caste']) : null,
        goalId: e.goalId ?? null,
        cardId: e.cardId ?? null,
        title: r.title,
        engine: EngineIdSchema.safeParse(r.engine).success ? (r.engine as EngineId) : null,
        model: r.model,
        effort: r.effort,
        routeReason: r.reason ?? null,
        container: r.container === true,
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
      if (this.#working() === 0) {
        queueMicrotask(() => {
          this.#maybeReview();
          this.#maybeHiveReview();
        });
      }
      return;
    }
    if (e.type === 'card-verified' || (e.type === 'card-rejected' && e.cardId && this.#o.brain.taskboard.get(e.cardId)?.status === 'failed')) {
      this.#cardFinished();
      queueMicrotask(() => this.#maybeReview());
      if (e.type === 'card-verified') queueMicrotask(() => this.#maybeProposeSkill());
      this.#managers = { ...this.#managers, cardsSince: this.#managers.cardsSince + 1 };
      this.#writeSettings({ managers: this.#managers });
      queueMicrotask(() => this.#maybeHiveReview());
    }
    if (e.type === 'card-blocked' && e.agentId && e.cardId) {
      const runId = this.#laneByAgentCard.get(`${e.agentId}|${e.cardId}`);
      const lane = runId ? this.#lanes.get(runId) : undefined;
      if (lane) lane.status = 'blocked';
    }
    // A closing project's hive pauses itself to settle: not a user pause, and not news for the activity feed.
    if (e.type === 'paused' && this.#closingHive) return;
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
  // ---- container mode (Phase 4 D1) -------------------------------------------------------------------

  containersStatus(): ContainerStatus {
    return this.#containers.status();
  }

  /** Validated in main against ContainerSettingsSchema, and again by the keeper. */
  async containersSave(settings: ContainerSettings): Promise<VaultResult> {
    const r = await this.#containers.save(settings);
    if (r.ok) {
      this.#note(
        'containers',
        settings.mode === 'always'
          ? 'Container mode is on: card commands run in a container.'
          : settings.mode === 'auto'
            ? 'Containers when needed: cards the Queen marks, cards the Watchdog moves and goals you choose run their commands in a container.'
            : 'Container mode is off: cards run commands on this computer, guarded as before, except goals you put in containers.',
      );
    }
    return r;
  }

  /** "Check again": the runtime and the image, now. */
  async containersRecheck(): Promise<ContainerStatus> {
    await this.#containers.check();
    return this.#containers.status();
  }

  /** "Download image": only on the user's click; progress comes through the status. */
  containersPull(): VaultResult {
    return this.#containers.pullImage();
  }

  /**
   * The keeper's own push, apart from #changed (which keeps only the latest reason of a burst): the Containers
   * section refreshes on reason "containers", so download progress must never be swallowed by hive activity.
   */
  #containersChanged(): void {
    this.#maybeResumeAfterContainers();
    if (this.#containersPushTimer || this.#disposed) return;
    this.#containersPushTimer = setTimeout(() => {
      this.#containersPushTimer = null;
      this.#o.push({ type: 'changed', reason: 'containers' });
    }, 100);
    this.#containersPushTimer.unref?.();
  }

  /**
   * A hive paused by container mode carries on by itself once containers are ready, or once no waiting card needs one
   * (the user switched the setting off, or let a forced goal follow the setting again). Asked on every change of the
   * keeper (download progress included), so it only resumes when that really changes something: a resume that would
   * be refused again at once would just pause again.
   */
  #maybeResumeAfterContainers(): void {
    if (!this.#paused || !this.#pausedReason?.startsWith(CONTAINER_PAUSE)) return;
    const p = this.#project;
    if (p?.hive.containersNeeded()) return;
    this.#resume();
    this.#note(
      'resumed',
      this.#containers.ready ? 'Containers are ready; the hive carries on.' : 'No waiting card needs a container now; the hive carries on, with commands on this computer as before.',
    );
  }

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
        engines?: { order?: unknown; disabled?: unknown; enabled?: unknown };
        limits?: unknown;
        limitHits?: unknown;
        librarian?: unknown;
        managers?: unknown;
        digestSeenAt?: unknown;
        containers?: unknown;
      };
      const containers = ContainerSettingsSchema.safeParse(raw.containers);
      const ids = (v: unknown): EngineId[] =>
        Array.isArray(v) ? v.flatMap((x) => (EngineIdSchema.safeParse(x).success ? [x as EngineId] : [])) : [];
      return {
        ...(typeof raw.projectPath === 'string' ? { projectPath: raw.projectPath } : {}),
        ...(raw.engines && typeof raw.engines === 'object' ? { engines: { order: ids(raw.engines.order), disabled: ids(raw.engines.disabled), enabled: ids(raw.engines.enabled) } } : {}),
        limits: readLimits(raw.limits),
        limitHits: readHits(raw.limitHits),
        ...readReviewClock(raw.librarian),
        ...readManagers(raw.managers),
        ...(typeof raw.digestSeenAt === 'number' && Number.isFinite(raw.digestSeenAt) ? { digestSeenAt: raw.digestSeenAt } : {}),
        // A malformed container setting (e.g. an image edited by hand) falls back to the defaults: off.
        ...(containers.success ? { containers: containers.data } : {}),
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

/** The managers' settings from the settings file; anything malformed falls back to the defaults. */
function readManagers(v: unknown): Pick<HostSettings, 'managers'> {
  if (!v || typeof v !== 'object') return {};
  const r = v as Record<string, unknown>;
  const int = (x: unknown, max: number): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= max ? x : null);
  const lr = r['lastReview'] as Record<string, unknown> | null | undefined;
  const lastReview =
    lr && typeof lr === 'object' && typeof lr['at'] === 'number' && typeof lr['summary'] === 'string'
      ? { at: lr['at'], summary: lr['summary'], recordId: typeof lr['recordId'] === 'string' ? lr['recordId'] : null }
      : null;
  return {
    managers: {
      scoutBeforePlanning: typeof r['scoutBeforePlanning'] === 'boolean' ? r['scoutBeforePlanning'] : DEFAULT_MANAGERS.scoutBeforePlanning,
      reviewEveryCards: int(r['reviewEveryCards'], 500) ?? DEFAULT_MANAGERS.reviewEveryCards,
      cardsSince: int(r['cardsSince'], 1_000_000) ?? 0,
      lastReview,
    },
  };
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
