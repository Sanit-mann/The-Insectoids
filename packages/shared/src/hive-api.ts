import { z } from 'zod';
import { ApprovalKindSchema, ApprovalStatusSchema } from './approvals';
import { CadenceCommandSchemas, type CadenceRunView, type CadenceRunsRequest, CadenceViewSchema } from './cadence-api';
import { RecordKindSchema, TrustSchema } from './brain';
import { CasteSchema, PrioritySchema } from './hive';
import { TaskStatusSchema } from './taskboard';

/**
 * The UI's contract with the hive (App 07, Phase 1 Step 8).
 *
 * Flow: the renderer reads one `HiveSnapshot` (the whole read model for the current project) and
 * re-reads it when a `hive:event` arrives (debounced). Live agent output arrives as `agent-output`
 * events and is appended without a re-read. Every action is one `HiveCommand`. Diffs and Brain records
 * are fetched on demand. All payloads are validated on both sides of the bridge.
 */
export const HIVE_IPC = {
  snapshot: 'hive:snapshot',
  command: 'hive:command',
  changes: 'hive:changes',
  brainSearch: 'hive:brain-search',
  brainRecord: 'hive:brain-record',
  /** Look up the code map (Phase 2 B4): symbols, files, who calls what. */
  codeLookup: 'hive:code-lookup',
  /** Brain screens (Phase 2 B5): the graph, the dashboard, and the user's safe edit of a record. */
  brainGraph: 'hive:brain-graph',
  brainDashboard: 'hive:brain-dashboard',
  brainEdit: 'hive:brain-edit',
  /** Ask the Brain (Phase 4 A1): a plain-words question answered from Brain records, with citations. */
  brainAsk: 'hive:brain-ask',
  /** What one question will roughly cost, shown before the first one. */
  brainAskEstimate: 'hive:brain-ask-estimate',
  /** The Brain's timeline view (Phase 4 A3). */
  brainTimeline: 'hive:brain-timeline',
  /** Library screen (Phase 2 C1): the castes, and the catalog of agents and skills. */
  libraryCastes: 'hive:library-castes',
  librarySearch: 'hive:library-search',
  libraryItem: 'hive:library-item',
  /** Import a skill or agent folder (C3): main opens a folder picker; the item is scanned and waits for approval. */
  libraryImport: 'hive:library-import',
  /** Budgets screen (C4): goal, caste and subscription spend, and the Treasurer's routing history. */
  budgets: 'hive:budgets',
  /** One-click engine install after the user saw the exact command and said yes (C4, 04-D6). */
  engineInstall: 'hive:engine-install',
  /** A cadence's run history (Phase 3 A1), newest first. */
  cadenceRuns: 'hive:cadence-runs',
  /** The "while you were away" digest (Phase 3 B1). */
  digest: 'hive:digest',
  /** Opens the folder picker in main; returns the chosen project or null if cancelled. */
  pickProject: 'hive:pick-project',
  /** main -> renderer push. */
  event: 'hive:event',
} as const;

const Id = z.string().min(1).max(200);

// ---- read model ------------------------------------------------------------------------------

export const ProjectViewSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** Brain shelf for this project (Memory 01-D2). */
  shelf: z.string(),
  /** Branch merges go into after approval. */
  branch: z.string().nullable(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

export const EngineViewSchema = z.object({
  /** fake = scripted test engine (e2e and demos without tokens). */
  state: z.enum(['ready', 'missing', 'outdated', 'signed-out', 'checking', 'fake']),
  name: z.string(),
  version: z.string().nullable(),
  /** Plain words, including the fix when not ready. */
  message: z.string(),
});
export type EngineView = z.infer<typeof EngineViewSchema>;

/** Every engine the hive knows about (Connections 04-D2). 'fake' is the scripted test engine. */
export const EngineIdSchema = z.enum([
  'claude', 'gemini', 'codex', 'opencode',
  // Phase 4 B: more engines, most as presets on the generic command engine; 'custom' is the user's own command.
  'copilot', 'cursor', 'qwen', 'grok', 'kimi', 'crush', 'pi', 'antigravity', 'custom',
  'fake',
]);
export type EngineId = z.infer<typeof EngineIdSchema>;

/**
 * One engine on the Connections screen (Phase 2 A1).
 * The hive never runs an engine the user switched off, and never one whose guard can't be enforced.
 */
export const EngineCardSchema = z.object({
  id: EngineIdSchema,
  name: z.string(),
  vendor: z.string(),
  /** unsupported = known but no adapter in this build yet (see availableIn). */
  state: z.enum(['ready', 'missing', 'outdated', 'signed-out', 'checking', 'fake', 'unsupported']),
  version: z.string().nullable(),
  /** Plain words, including the fix when not ready. */
  message: z.string(),
  /** The user can switch an engine off; the hive then never routes work to it. */
  enabled: z.boolean(),
  /** e.g. "Phase 2 · step A2" for engines whose adapter comes later; null when supported. */
  availableIn: z.string().nullable(),
  /**
   * How the command guard protects this engine's runs:
   * hook = a pre-tool hook that fails closed (Claude Code);
   * policy-and-tools = built-in side-effect tools denied by policy, the hive's guarded tools instead (Gemini CLI);
   * read-only = only read-only work (castes that don't change files).
   */
  guard: z.enum(['hook', 'policy-and-tools', 'read-only']).nullable(),
  /** Whether the engine reports cost itself; otherwise the hive estimates it from tokens. */
  reportsCost: z.boolean(),
  /**
   * Paid by the user's plan (Claude, Copilot, …): no per-token price, runs count toward the plan's limits.
   * Estimates say "your subscription" for it. Optional so older cards still parse; absent means no.
   */
  subscription: z.boolean().optional(),
  /** The engine's model names by tier. */
  models: z.object({ strongest: z.string(), standard: z.string(), light: z.string() }).nullable(),
  /** Official install command, shown for the user to copy or run with consent (04-D6). */
  install: z.object({ command: z.string(), note: z.string() }).nullable(),
  /** How to sign in, in the engine's own login (the hive never sees passwords or tokens). */
  signIn: z.object({ command: z.string(), note: z.string() }).nullable(),
  /** Anything the user should know about privacy with this engine (e.g. it keeps its own chat logs). */
  privacyNote: z.string().nullable(),
  /** The Treasurer's view of this engine's subscription (02-D9, 04-D7; Phase 2 A5). */
  usage: z.lazy(() => EngineUsageSchema),
});
export type EngineCard = z.infer<typeof EngineCardSchema>;

/** Hive usage in one rolling window (from the engine's own reports; cost marked when estimated). */
export const UsageWindowSchema = z.object({
  runs: z.number().int(),
  tokens: z.number(),
  costUsd: z.number(),
  /** Some runs' cost was estimated by the hive (the engine didn't report it). */
  costEstimated: z.boolean(),
});

/**
 * Subscription usage (04-D7). The hive can't read a vendor's real quota, so it tracks its own use in
 * rolling 5-hour and 7-day windows, honours limits the user sets, and believes the engine when it says
 * a limit was hit (until the reset time it gives, or a safe default).
 */
export const EngineUsageSchema = z.object({
  window5h: UsageWindowSchema,
  window7d: UsageWindowSchema,
  /** The user's own soft limits in USD per window; null = none. */
  cap5hUsd: z.number().positive().nullable(),
  cap7dUsd: z.number().positive().nullable(),
  /** ok; near = 80%+ of a cap (the Treasurer lowers the insect cap); exhausted = a cap or the vendor's limit was hit. */
  state: z.enum(['ok', 'near', 'exhausted']),
  /** When the hive may use it again after a vendor limit (epoch ms); null when not limited. */
  exhaustedUntil: z.number().nullable(),
  /** Plain words: why near or exhausted, and when it frees up. */
  message: z.string(),
});
export type EngineUsage = z.infer<typeof EngineUsageSchema>;

export const PlanViewSchema = z.object({
  /** One short line for the plan card. */
  headline: z.string(),
  summary: z.string(),
  waves: z.array(
    z.object({
      n: z.number().int().positive(),
      cards: z.array(z.object({ id: z.string(), title: z.string(), caste: CasteSchema })),
    }),
  ),
});
export type PlanView = z.infer<typeof PlanViewSchema>;

export const GoalStatusSchema = z.enum(['planning', 'awaiting_approval', 'running', 'stuck', 'done', 'cancelled']);
export type GoalStatusView = z.infer<typeof GoalStatusSchema>;

/** Where the goal's work stands relative to the user's branch (Workspace 06-D3, D6). */
export const MergeStateSchema = z.enum(['not-merged', 'awaiting-approval', 'merged', 'undone']);

/**
 * Whether a card's commands run in a container, and why (Phase 4 D2), in plain words on the card.
 * - source: queen (marked risky in the plan), watchdog (moved after it got stuck), goal (the user forced
 *   containers for this goal), always (the setting is "every card").
 * - state: container (its runs use one), waiting (a container is needed but Docker/Podman or the image isn't
 *   ready, so it waits; never the computer instead), suggested (the Queen marked it but containers are off, so
 *   it runs on the computer, guarded as usual).
 */
export const CardContainerSchema = z.object({
  source: z.enum(['queen', 'watchdog', 'goal', 'always']),
  state: z.enum(['container', 'waiting', 'suggested']),
  /** Plain words, e.g. "The Queen marked it: it installs packages." */
  reason: z.string(),
});
export type CardContainer = z.infer<typeof CardContainerSchema>;

/** The user's container choice for one goal (Phase 4 D2): auto follows the setting; always forces containers. */
export const GoalContainersSchema = z.enum(['auto', 'always']);
export type GoalContainers = z.infer<typeof GoalContainersSchema>;

export const GoalViewSchema = z.object({
  id: Id,
  title: z.string(),
  text: z.string(),
  status: GoalStatusSchema,
  plan: PlanViewSchema.nullable(),
  currentWave: z.number().int().nonnegative(),
  budgetTokens: z.number().nullable(),
  spentTokens: z.number(),
  spentUsd: z.number(),
  merge: MergeStateSchema,
  /** The cadence that started this goal (Phase 3 A1), or null when the user gave it. */
  cadenceId: Id.nullable().default(null),
  /** The user's container choice for this goal (Phase 4 D2). */
  containers: GoalContainersSchema.default('auto'),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type GoalView = z.infer<typeof GoalViewSchema>;

export const CardViewSchema = z.object({
  id: Id,
  goalId: Id,
  wave: z.number().int().positive(),
  title: z.string(),
  brief: z.string(),
  caste: CasteSchema,
  priority: PrioritySchema,
  acceptance: z.array(z.string()),
  dependsOn: z.array(z.string()),
  /** Outside services this card may use through the secret broker (04-D4: least privilege). */
  integrations: z.array(z.string()),
  status: TaskStatusSchema,
  claimedBy: z.string().nullable(),
  leaseExpiresAt: z.number().nullable(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  escalated: z.boolean(),
  result: z.string().nullable(),
  /** The card's changes were undone (reverted on the hive branch). */
  undone: z.boolean(),
  /** Library skills switched on for the card's latest attempt (Capabilities 03-D8; Phase 2 C1), at most 5. */
  skills: z.array(z.string()).default([]),
  /** Set while the Watchdog holds the card (breaker step "pause the card") until the Foreman decides (C2). */
  heldReason: z.string().nullable().default(null),
  /** Container mode for this card (Phase 4 D2); null = its commands run on the computer, nothing to say. */
  container: CardContainerSchema.nullable().default(null),
  updatedAt: z.number(),
});
export type CardView = z.infer<typeof CardViewSchema>;

export const ApprovalViewSchema = z.object({
  id: Id,
  goalId: z.string().nullable(),
  kind: ApprovalKindSchema,
  title: z.string(),
  from: z.string(),
  whyItNeedsYou: z.string(),
  ifYouSayYes: z.string(),
  /** Destructive approvals use hold-to-approve (App 07 principle 2). */
  destructive: z.boolean(),
  status: ApprovalStatusSchema,
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

/** Status colours + labels from App 07 visual tokens. */
export const LaneStatusSchema = z.enum(['working', 'waiting', 'blocked', 'done', 'paused', 'idle', 'failed']);
export type LaneStatus = z.infer<typeof LaneStatusSchema>;

/** One lane in the Hive monitor: an agent run, live or recently finished. */
export const AgentViewSchema = z.object({
  /** Run id (unique per run). */
  runId: Id,
  agentId: z.string(),
  /** 'librarian': the Librarian's LLM review of the Brain (B3); it belongs to no goal or card. */
  /** C2: 'scout' surveys the code before the Queen plans; 'foreman' decides on stuck cards and runs periodic reviews. */
  role: z.enum(['queen', 'insect', 'inspector', 'librarian', 'scout', 'foreman']),
  caste: CasteSchema.nullable(),
  goalId: z.string().nullable(),
  cardId: z.string().nullable(),
  title: z.string(),
  /** Which engine ran it. */
  engine: EngineIdSchema.nullable(),
  /** Model as reported by the engine (App 07 principle 3) and the effort the hive asked for; null until known. */
  model: z.string().nullable(),
  effort: z.string().nullable(),
  status: LaneStatusSchema,
  tokens: z.number(),
  costUsd: z.number(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** Last ~200 output lines (tool calls and text, already shortened for display). */
  output: z.array(z.string()),
  /**
   * Why the Treasurer chose this engine, model and effort, in plain words (e.g. "learned: sonnet·medium
   * passes 9/10 coder cards here, cheaper than opus" or "rule: high priority"). Null for older lanes.
   */
  routeReason: z.string().nullable(),
  /** The run's commands run in a container (Phase 4 D2), for a short status on the lane. False for older lanes. */
  container: z.boolean().default(false),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

/** One line in the Queen thread / activity log (from HiveEvent). */
export const ActivityViewSchema = z.object({
  id: z.string(),
  at: z.number(),
  type: z.string(),
  goalId: z.string().nullable(),
  cardId: z.string().nullable(),
  agentId: z.string().nullable(),
  message: z.string(),
});
export type ActivityView = z.infer<typeof ActivityViewSchema>;

/**
 * Meaning search (Memory 01-E11; Phase 2 B1): a small model on this PC turns each record into a vector.
 * The model is downloaded once, only after the user switches meaning search on.
 */
export const MeaningSearchSchema = z.object({
  state: z.enum(['off', 'needs-download', 'downloading', 'indexing', 'ready', 'error']),
  /** e.g. "all-MiniLM-L6-v2". */
  model: z.string(),
  /** Download size in MB (shown before the user agrees). */
  sizeMb: z.number(),
  /** Where it comes from, e.g. "huggingface.co/Xenova/all-MiniLM-L6-v2 (pinned revision, checked)". */
  source: z.string(),
  /** 0..1 while downloading. */
  progress: z.number().min(0).max(1),
  indexed: z.number().int(),
  total: z.number().int(),
  message: z.string(),
});
export type MeaningSearch = z.infer<typeof MeaningSearchSchema>;

/** Brain health (Memory 01-E12; Phase 2 B3): 0–100, with the parts that make it up, in plain words. */
export const BrainHealthSchema = z.object({
  /** 0 (needs care) to 100 (tidy); null before the first audit. */
  score: z.number().min(0).max(100).nullable(),
  parts: z.array(
    z.object({
      id: z.enum(['stale', 'waiting', 'orphans', 'unused', 'duplicates', 'lessons']),
      label: z.string(),
      /** How many records this part counts. */
      count: z.number().int(),
      /** Points it costs the score. */
      penalty: z.number(),
      /** One line: what it means and what to do. */
      hint: z.string(),
    }),
  ),
  total: z.number().int(),
  lastAuditAt: z.number().nullable(),
  message: z.string(),
});
export type BrainHealth = z.infer<typeof BrainHealthSchema>;

/** The Librarian, the memory keeper (Hive 02, manager "reflexes + brain"; Phase 2 B3). */
export const LibrarianViewSchema = z.object({
  /** idle; auditing = reflexes (free, code only); reviewing = its LLM brain is reading (spends tokens). */
  state: z.enum(['idle', 'auditing', 'reviewing']),
  lastAuditAt: z.number().nullable(),
  lastReviewAt: z.number().nullable(),
  /** When the next LLM review is due (every N finished cards, or weekly), as plain words. */
  nextReview: z.string(),
  /** Proposals it has waiting in the approval inbox. */
  proposalsWaiting: z.number().int(),
  message: z.string(),
});
export type LibrarianView = z.infer<typeof LibrarianViewSchema>;

/** A lesson the hive learned from failed or retried work (Memory 01-E10), shown at boot. */
export const LessonViewSchema = z.object({
  id: z.string(),
  /** "Don't … because …" in one line. */
  title: z.string(),
  body: z.string(),
  trust: TrustSchema,
  /** Where it came from (card or goal title), if known. */
  source: z.string().nullable(),
  /** How many failures taught it (similar lessons fold together). */
  seen: z.number().int(),
  createdAt: z.number(),
});
export type LessonView = z.infer<typeof LessonViewSchema>;

/**
 * The code map (Memory 01-E3, D6; Phase 2 B4): per file of the current project, its symbols (functions,
 * classes, methods, …), imports and calls, parsed with tree-sitter (no AI). Refreshed by content hash.
 */
export const CodeMapViewSchema = z.object({
  state: z.enum(['off', 'building', 'ready', 'error']),
  files: z.number().int(),
  symbols: z.number().int(),
  /** e.g. [{ language: 'typescript', files: 120 }]. */
  languages: z.array(z.object({ language: z.string(), files: z.number().int() })),
  /** Files seen but not mapped (unsupported language, too large, binary). */
  skipped: z.number().int(),
  lastBuiltAt: z.number().nullable(),
  /** While building: files done of total. */
  progress: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
  message: z.string(),
});
export type CodeMapView = z.infer<typeof CodeMapViewSchema>;

export const CodeSymbolKindSchema = z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'variable', 'module']);

export const CodeLookupRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  /** symbol: find by name; file: a file's outline; callers / callees: who calls it, what it calls. */
  mode: z.enum(['symbol', 'file', 'callers', 'callees']),
});

export const CodeHitSchema = z.object({
  /** Path relative to the project root, with forward slashes. */
  path: z.string(),
  name: z.string(),
  kind: CodeSymbolKindSchema,
  /** 1-based lines. */
  line: z.number().int(),
  endLine: z.number().int(),
  /** The declaration line, shortened (e.g. "export function slugify(text: string): string"). */
  signature: z.string(),
  /** From a doc comment or the first comment line, if any (no AI). */
  doc: z.string().nullable(),
  /** Containing class or namespace, if any. */
  parent: z.string().nullable(),
});
export type CodeHit = z.infer<typeof CodeHitSchema>;

export const CodeLookupResultSchema = z.object({
  hits: z.array(CodeHitSchema),
  /** For mode "file": its imports (module specifiers). */
  imports: z.array(z.string()),
  /** True when more matched than were returned. */
  truncated: z.boolean(),
  message: z.string(),
});
export type CodeLookupResult = z.infer<typeof CodeLookupResultSchema>;

// ---- Managers' brain side (Phase 2 C2; Hive 02-D8, D9 P3, D12) ---------------------------------

/**
 * Watchdog breaker ladder (02-D9 P3), plain code:
 * warn = recorded and told to the Queen, the agent keeps going;
 * pause-card = the agent is stopped and the card is held until the Foreman decides;
 * stop-agent = a hard limit: the agent is stopped at once and its card goes back with an incident note;
 * pause-hive = a hive-wide trip (several agents at once, or the Queen herself): the hive pauses until the user resumes it.
 */
export const BreakerStepSchema = z.enum(['warn', 'pause-card', 'stop-agent', 'pause-hive']);
export const SensorSchema = z.enum(['loop', 'error-repeat', 'stall', 'overspend', 'crash', 'hive']);
export const IncidentViewSchema = z.object({
  id: z.string(),
  at: z.number(),
  sensor: SensorSchema,
  step: BreakerStepSchema,
  /** e.g. "Ant-03", "Queen". */
  agentId: z.string(),
  runId: z.string().nullable(),
  goalId: z.string().nullable(),
  cardId: z.string().nullable(),
  /** Plain words with counts, e.g. "Ran the same command 5 times: npm test". */
  evidence: z.string(),
  /** How many times this signature (sensor + caste + error text) has tripped before. */
  recurrence: z.number().int(),
});
export type IncidentView = z.infer<typeof IncidentViewSchema>;

export const ForemanActionSchema = z.enum(['retry-with-note', 'stronger-model', 'to-queen']);
export const ManagersViewSchema = z.object({
  /** The Scout surveys the code (with the code map) before the Queen plans a goal. */
  scoutBeforePlanning: z.boolean(),
  /** A periodic review after every N finished cards; 0 = off. */
  reviewEveryCards: z.number().int().min(0).max(500),
  /** Finished cards until the next review (null when off). */
  cardsUntilReview: z.number().int().nullable(),
  lastReview: z.object({ at: z.number(), summary: z.string(), recordId: z.string().nullable() }).nullable(),
  /** The Foreman's latest decisions on stuck cards, newest first (max 20). */
  foremanDecisions: z.array(
    z.object({ at: z.number(), goalId: z.string(), cardId: z.string(), cardTitle: z.string(), action: ForemanActionSchema, reason: z.string() }),
  ),
});
export type ManagersView = z.infer<typeof ManagersViewSchema>;

// ---- the "while you were away" digest (Cadence 05-D8; Phase 3 B1) ------------------------------------

/**
 * Unattended work = cadence runs the user didn't start themselves: reasons schedule, catch-up, wake, file, event
 * and webhook (never `manual`), plus the built-in maintenance jobs. The digest covers everything since the user
 * last said "Got it" (`markDigestSeen`; on the very first start that moment is "now", so old history never shows).
 *
 * It opens by itself on the first visit after unattended work that matters: a user cadence ran (started, failed,
 * waited, was refused…) or a maintenance job failed. Routine maintenance (`done`) alone is listed but never opens
 * it, so a health check every 6 hours doesn't pop it up every morning.
 */
export const DigestBadgeSchema = z.object({
  /** True when unattended work that matters happened since the user last read the digest: the app opens it. */
  unseen: z.boolean(),
  /** The moment the user last read it (or the first start). */
  since: z.number(),
  /** One line, e.g. "While you were away: 3 runs, 2 done, 1 waits for you. 41,200 tokens.", or null when nothing happened. */
  headline: z.string().nullable(),
});
export type DigestBadge = z.infer<typeof DigestBadgeSchema>;

/** One goal a cadence started while the user was away, as it stands now. */
export const DigestGoalSchema = z.object({
  goalId: Id,
  title: z.string(),
  status: GoalStatusSchema,
  /** In words: "Done and merged", "Waiting for you to approve its merge", "Stuck: <reason>", "Still running". */
  outcome: z.string(),
  /** What the user's yes would unblock, or null. */
  waitingFor: z.enum(['plan', 'merge', 'approval']).nullable(),
  spentTokens: z.number(),
  spentUsd: z.number(),
  startedAt: z.number(),
});
export type DigestGoal = z.infer<typeof DigestGoalSchema>;

/** One cadence (user-made or built-in) that did something while the user was away. */
export const DigestCadenceSchema = z.object({
  cadenceId: Id,
  name: z.string(),
  builtIn: z.boolean(),
  /** Run-log counts in the period by outcome (only non-zero ones need be present). */
  outcomes: z.record(z.string(), z.number().int()),
  goals: z.array(DigestGoalSchema),
  /** The newest few run-log lines worth reading (failures first; maintenance `done` messages), at most 5. */
  lines: z.array(z.object({ at: z.number(), outcome: z.string(), message: z.string() })),
});
export type DigestCadence = z.infer<typeof DigestCadenceSchema>;

export const DigestViewSchema = z.object({
  since: z.number(),
  until: z.number(),
  /** Same as the badge's. */
  unseen: z.boolean(),
  headline: z.string().nullable(),
  totals: z.object({
    /** Unattended runs that started a goal. */
    runs: z.number().int(),
    goalsDone: z.number().int(),
    /** Stuck or cancelled. */
    goalsFailed: z.number().int(),
    /** Still planning, waiting or running. */
    goalsOpen: z.number().int(),
    /** Runs that failed, were refused or were skipped/deferred. */
    problems: z.number().int(),
    /** Maintenance jobs that ran. */
    jobs: z.number().int(),
    tokens: z.number(),
    costUsd: z.number(),
  }),
  /** User cadences first (by most recent activity), then built-in jobs. */
  cadences: z.array(DigestCadenceSchema),
  /** Everything waiting for the user right now (not only from this period). */
  waiting: z.object({
    total: z.number().int(),
    byKind: z.record(z.string(), z.number().int()),
    /** The oldest few waiting approvals, at most 5. */
    items: z.array(ApprovalViewSchema),
  }),
});
export type DigestView = z.infer<typeof DigestViewSchema>;

export const HiveSnapshotSchema = z.object({
  /** null until the user picks a project folder. */
  project: ProjectViewSchema.nullable(),
  /** The engine the hive uses by default (the first enabled, ready one in the user's order). */
  engine: EngineViewSchema,
  /** Every known engine, in the user's preference order (Connections screen). */
  engines: z.array(EngineCardSchema),
  meaningSearch: MeaningSearchSchema,
  brainHealth: BrainHealthSchema,
  librarian: LibrarianViewSchema,
  /** Current lessons for this project and global, newest first (max 50). */
  lessons: z.array(LessonViewSchema),
  codeMap: CodeMapViewSchema,
  /** Watchdog incidents (C2), newest first, last 50. */
  incidents: z.array(IncidentViewSchema).default([]),
  /** The managers' brain side (C2): Scout, Foreman decisions, periodic reviews. */
  managers: ManagersViewSchema.default({
    scoutBeforePlanning: true,
    reviewEveryCards: 20,
    cardsUntilReview: 20,
    lastReview: null,
    foremanDecisions: [],
  }),
  hive: z.object({
    paused: z.boolean(),
    pausedReason: z.string().nullable(),
    insectCap: z.number().int(),
    /** Agents working right now. */
    working: z.number().int(),
  }),
  /** Whether a "while you were away" digest waits to be read (B1); the full digest is `HiveApi.digest()`. */
  digest: DigestBadgeSchema.default({ unseen: false, since: 0, headline: null }),
  /** This project's cadences (Phase 3 A1), in creation order. */
  cadences: z.array(CadenceViewSchema).default([]),
  /** Newest first. */
  goals: z.array(GoalViewSchema),
  /** Cards of every goal above. */
  cards: z.array(CardViewSchema),
  /** Pending first, then the last 30 decided. */
  approvals: z.array(ApprovalViewSchema),
  /** Running agents plus the last 20 finished runs. */
  agents: z.array(AgentViewSchema),
  /** Oldest first, last 300. */
  activity: z.array(ActivityViewSchema),
});
export type HiveSnapshot = z.infer<typeof HiveSnapshotSchema>;

// ---- commands --------------------------------------------------------------------------------

export const HiveCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setProject'), path: z.string().min(1).max(1000) }),
  z.object({
    type: z.literal('submitGoal'),
    text: z.string().trim().min(3).max(8000),
    budgetTokens: z.number().int().positive().optional(),
    /** Phase 4 D2: "always" runs every card of this goal in a container, whatever the setting. */
    containers: GoalContainersSchema.optional(),
  }),
  /** Phase 4 D2: force containers for a goal (or go back to following the setting); applies to its next runs. */
  z.object({ type: z.literal('setGoalContainers'), goalId: Id, containers: GoalContainersSchema }),
  z.object({ type: z.literal('approve'), approvalId: Id }),
  z.object({ type: z.literal('deny'), approvalId: Id }),
  z.object({ type: z.literal('pause'), reason: z.string().max(200).optional() }),
  z.object({ type: z.literal('resume') }),
  /** Check the AI engines again now (e.g. right after the user signed in). */
  z.object({ type: z.literal('checkEngine') }),
  /** Switch an engine on or off for the hive. */
  z.object({ type: z.literal('setEngineEnabled'), engineId: EngineIdSchema, enabled: z.boolean() }),
  /** The user's preference order (first = default). Unknown ids are ignored; missing ones keep their place at the end. */
  z.object({ type: z.literal('setEngineOrder'), order: z.array(EngineIdSchema).max(EngineIdSchema.options.length) }),
  /** The user's soft spending limits for an engine's subscription (null clears). */
  z.object({ type: z.literal('setEngineLimits'), engineId: EngineIdSchema, cap5hUsd: z.number().positive().max(10_000).nullable(), cap7dUsd: z.number().positive().max(100_000).nullable() }),
  /** Tidy the Brain now (B2): fade unused, unimportant agent notes into the archive. Also runs on its own every 6 h. */
  z.object({ type: z.literal('tidyBrain') }),
  /** Bring an archived (e.g. faded) Brain record back, as a new version. The user only (B2). */
  z.object({ type: z.literal('restoreRecord'), id: Id }),
  /** The user archives a record (Phase 2 B5): it leaves search, stays readable, and can be brought back. */
  z.object({ type: z.literal('archiveRecord'), id: Id }),
  /** Managers' settings (C2). */
  z.object({
    type: z.literal('setManagers'),
    scoutBeforePlanning: z.boolean().optional(),
    reviewEveryCards: z.number().int().min(0).max(500).optional(),
  }),
  /** Run the periodic review now (C2; uses a little of the AI subscription). */
  z.object({ type: z.literal('runReview') }),
  /** The user retires a ready skill, or brings a retired one back (C3). Built-in caste defaults can't be retired. */
  z.object({ type: z.literal('retireLibraryItem'), name: z.string().min(1).max(120) }),
  z.object({ type: z.literal('restoreLibraryItem'), name: z.string().min(1).max(120) }),
  /** Run the Librarian now: its free audit always; its LLM review only when an engine is ready (spends tokens). */
  z.object({ type: z.literal('runLibrarian'), review: z.boolean() }),
  /** Rebuild the code map now (otherwise it refreshes changed files by itself). */
  z.object({ type: z.literal('rebuildCodeMap') }),
  /** The user confirms a lesson (it then always shows at boot) or retires it (archived, never deleted). */
  z.object({ type: z.literal('confirmLesson'), id: Id }),
  z.object({ type: z.literal('retireLesson'), id: Id }),
  /** Switch meaning search on (downloads the model once if needed) or off (vectors kept, search uses words only). */
  z.object({ type: z.literal('setMeaningSearch'), enabled: z.boolean() }),
  /** Forget an engine's "limit reached" state now (e.g. the user upgraded the plan). */
  z.object({ type: z.literal('clearEngineLimitHit'), engineId: EngineIdSchema }),
  z.object({ type: z.literal('cancelGoal'), goalId: Id }),
  /** Revert one card's changes on the hive branch (history kept). */
  z.object({ type: z.literal('undoCard'), goalId: Id, cardId: Id }),
  /** Reset the goal to its checkpoint (old tip archived). */
  z.object({ type: z.literal('undoGoal'), goalId: Id }),
  /** Asks for approval to undo the merge into the user's branch. */
  z.object({ type: z.literal('requestUndoMerge'), goalId: Id }),
  /** Asks for approval to merge again after an undo ("redo"). */
  z.object({ type: z.literal('requestRedoMerge'), goalId: Id }),
  ...CadenceCommandSchemas,
  /** The user read the digest ("Got it"): what happened so far no longer counts as unseen (B1). */
  z.object({ type: z.literal('markDigestSeen') }),
  /** Keep an Ask-the-Brain answer as an unconfirmed note that links to the records it cited (Phase 4 A1). */
  z.object({ type: z.literal('saveBrainAnswer'), question: z.string().trim().min(3).max(500), answer: z.string().trim().min(1).max(8000), citationIds: z.array(Id).max(20) }),
]);
export type HiveCommand = z.infer<typeof HiveCommandSchema>;

export const CommandResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CommandResult = z.infer<typeof CommandResultSchema>;

// ---- on demand -------------------------------------------------------------------------------

export const ChangesRequestSchema = z.object({ goalId: Id, cardId: Id });
export const ChangesViewSchema = z.object({
  files: z.array(z.object({ path: z.string(), status: z.enum(['added', 'modified', 'deleted', 'renamed']) })),
  /** Unified diff, capped at ~400 KB (truncated flag says so). */
  patch: z.string(),
  truncated: z.boolean(),
});
export type ChangesView = z.infer<typeof ChangesViewSchema>;

export const BrainSearchRequestSchema = z.object({
  query: z.string().trim().max(500),
  kinds: z.array(RecordKindSchema).optional(),
  /** Include superseded facts and faded (archived) records too (B2). Default: current records only. */
  includeHistory: z.boolean().optional(),
});
export const BrainHitViewSchema = z.object({
  id: z.string(),
  /** How it was found: by its words, by meaning, or both (hybrid search, B1). */
  match: z.enum(['words', 'meaning', 'both']),
  kind: RecordKindSchema,
  shelf: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  /** No longer current: replaced by a newer record, or faded into the archive (only with includeHistory). */
  status: z.enum(['current', 'superseded', 'archived']),
});
export type BrainHitView = z.infer<typeof BrainHitViewSchema>;

// ---- Ask the Brain (Memory 01; Phase 4 A1) ---------------------------------------------------------

/**
 * A plain-words question answered only from Brain records:
 * 1. retrieval: hybrid search (words + meaning) over the open project's shelf and Global, current records only, at most
 *    BRAIN_ASK_MAX_SOURCES; nothing found → `unknown` without any AI run (no tokens);
 * 2. one short read-only run (the Librarian's role, routed by the Treasurer: a free local model when one is ready,
 *    else a light/standard model at low effort) that sees only those numbered sources and must cite them as [1], [2];
 * 3. checks: every cited number must be one of the sources given (anything else is dropped); an answer citing nothing
 *    becomes `unknown` ("The Brain doesn't know"), so the hive never answers from outside the Brain.
 * Secrets never reach the run (the Brain refuses them on write). The cost is recorded like any run (no goal).
 */
export const BRAIN_ASK_MAX_SOURCES = 8;

export const BrainAskRequestSchema = z.object({
  question: z.string().trim().min(3).max(500),
});
export type BrainAskRequest = z.infer<typeof BrainAskRequestSchema>;

/** A record the answer was built from. */
export const BrainAskSourceSchema = z.object({
  /** 1-based, as cited in the answer text ("[2]"). */
  n: z.number().int().positive(),
  id: Id,
  kind: RecordKindSchema,
  shelf: z.string(),
  title: z.string(),
  trust: TrustSchema,
});
export type BrainAskSource = z.infer<typeof BrainAskSourceSchema>;

export const BrainAskResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('answered'),
    question: z.string(),
    /** Plain text with citation markers like [1] that match `citations[].n`. */
    answer: z.string(),
    /** Only the sources the answer actually cites, in number order. */
    citations: z.array(BrainAskSourceSchema).min(1),
    /** How many sources the run was given. */
    sourcesGiven: z.number().int(),
    engine: z.string(),
    model: z.string().nullable(),
    tokens: z.number(),
    costUsd: z.number(),
    /** True when the engine didn't report cost (it was worked out from a price table). */
    costEstimated: z.boolean(),
  }),
  z.object({
    status: z.literal('unknown'),
    question: z.string(),
    /** "The Brain doesn't know: nothing in it matches …" or "The records found don't answer it." */
    message: z.string(),
    /** What retrieval found, if anything (so the user can look). */
    sources: z.array(BrainAskSourceSchema),
    /** 0 when no AI run happened. */
    tokens: z.number(),
    costUsd: z.number(),
  }),
  z.object({ status: z.literal('error'), question: z.string(), message: z.string() }),
]);
export type BrainAskResult = z.infer<typeof BrainAskResultSchema>;

/** Shown before the first question: what one question roughly costs and on which engine. */
export const BrainAskEstimateSchema = z.object({
  /** False when no engine can run it right now (message says why). */
  canAsk: z.boolean(),
  engine: z.string().nullable(),
  /** True for a local model: no subscription use, no money. */
  free: z.boolean(),
  tokensLow: z.number(),
  tokensHigh: z.number(),
  /** Null when the engine doesn't price runs (subscription) or it's free. */
  costUsdHigh: z.number().nullable(),
  /** e.g. "About 3,000–8,000 tokens per question on Claude Code (your subscription)." */
  message: z.string(),
});
export type BrainAskEstimate = z.infer<typeof BrainAskEstimateSchema>;

export const BrainRecordViewSchema = z.object({
  id: z.string(),
  kind: RecordKindSchema,
  shelf: z.string(),
  owner: z.string(),
  title: z.string(),
  body: z.string(),
  summary: z.string().nullable(),
  trust: TrustSchema,
  source: z.string().nullable(),
  version: z.number(),
  archived: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  history: z.array(z.object({ version: z.number(), change: z.string(), title: z.string(), trust: TrustSchema, changedBy: z.string(), changedAt: z.number() })),
  /**
   * Use and importance (Memory 01-E7; Phase 2 B2). Importance (0..1) blends recency (freshness
   * half-life), how often agents read it, and whether it helped work that passed inspection.
   */
  usage: z.object({
    reads: z.number().int(),
    helped: z.number().int(),
    lastUsedAt: z.number().nullable(),
    importance: z.number().min(0).max(1),
  }),
  /** Time-aware facts (01-E9): when it became true and, once replaced, when it stopped being current. */
  validFrom: z.number(),
  validTo: z.number().nullable(),
  supersededBy: z.object({ id: z.string(), title: z.string() }).nullable(),
  supersedes: z.array(z.object({ id: z.string(), title: z.string() })),
  /** Why it was archived, when it was (e.g. "faded: unused for 90 days", "merged into …", "by you"). */
  archivedReason: z.string().nullable(),
  /** Near-duplicates folded into this record (01-E5). */
  mergedFrom: z.array(z.object({ id: z.string(), title: z.string() })),
  links: z.array(z.object({ id: z.string(), rel: z.string(), direction: z.enum(['in', 'out']), title: z.string() })),
});
export type BrainRecordView = z.infer<typeof BrainRecordViewSchema>;

// ---- Brain screens (Phase 2 B5; Memory 01-D10–D13) --------------------------------------------

/** Graph view: records as nodes, edges only from real links (01-D13). Filters by shelf, kind and date. */
export const BrainGraphRequestSchema = z.object({
  /** 'project' = the open project's shelf (global when none is open); 'global'; or 'all' shelves. */
  scope: z.enum(['project', 'global', 'all']).default('project'),
  kinds: z.array(RecordKindSchema).max(20).optional(),
  /** Only records updated at or after this time (ms). */
  since: z.number().int().nonnegative().optional(),
  includeArchived: z.boolean().optional(),
  /** Most important first; the rest is counted in `hidden`. The 2D graph asks for 200; the Globe (Phase 4 A2) for up to 5,000. */
  limit: z.number().int().min(1).max(5000).default(200),
});
export const BrainGraphNodeSchema = z.object({
  id: z.string(),
  kind: RecordKindSchema,
  title: z.string(),
  trust: TrustSchema,
  shelf: z.string(),
  archived: z.boolean(),
  /** 0..1 (B2): drawn as node size. */
  importance: z.number().min(0).max(1),
  updatedAt: z.number(),
});
export const BrainGraphEdgeSchema = z.object({ from: z.string(), to: z.string(), rel: z.string() });
export const BrainGraphViewSchema = z.object({
  nodes: z.array(BrainGraphNodeSchema),
  /** Only edges whose both ends are in `nodes`. */
  edges: z.array(BrainGraphEdgeSchema),
  /** Records that matched the filters but were left out by `limit`. */
  hidden: z.number().int().nonnegative(),
});
export type BrainGraphRequest = z.input<typeof BrainGraphRequestSchema>;
export type BrainGraphNode = z.infer<typeof BrainGraphNodeSchema>;
export type BrainGraphView = z.infer<typeof BrainGraphViewSchema>;

// ---- the Brain's timeline (01-D13 phase 2; Phase 4 A3) ----------------------------------------------

/** What happened to a record at one version (the record_versions log). */
export const BrainChangeSchema = z.enum(['create', 'update', 'archive', 'supersede', 'unarchive', 'merge']);
export type BrainChange = z.infer<typeof BrainChangeSchema>;

/** Where the next page starts: the last entry of the previous page (entries are ordered by time, then record, then version, newest first). */
export const BrainTimelineCursorSchema = z.object({ changedAt: z.number(), recordId: z.string(), version: z.number().int() });
export type BrainTimelineCursor = z.infer<typeof BrainTimelineCursorSchema>;

export const BrainTimelineRequestSchema = z.object({
  /** Same meaning as the graph: the open project's shelf plus Global, Global alone, or every shelf. */
  scope: z.enum(['project', 'global', 'all']).default('project'),
  kinds: z.array(RecordKindSchema).max(20).optional(),
  changes: z.array(BrainChangeSchema).max(6).optional(),
  /** 'user' = only the user's own changes, 'agents' = only agents', or one agent's id ("Ant-02", "Librarian"). */
  actor: z.string().trim().min(1).max(100).optional(),
  /** Words to look for in the record's title (at that version). */
  query: z.string().trim().max(200).optional(),
  /** Only changes at or after / before these times (ms). */
  since: z.number().int().nonnegative().optional(),
  until: z.number().int().nonnegative().optional(),
  before: BrainTimelineCursorSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type BrainTimelineRequest = z.input<typeof BrainTimelineRequestSchema>;

export const BrainTimelineEntrySchema = z.object({
  recordId: Id,
  version: z.number().int(),
  change: BrainChangeSchema,
  kind: RecordKindSchema,
  shelf: z.string(),
  /** The title at that version (it may have been renamed since). */
  title: z.string(),
  /** The record's title now, when different from `title`; else null. */
  currentTitle: z.string().nullable(),
  trust: TrustSchema,
  /** 'user' or the agent's id. */
  changedBy: z.string(),
  actorType: z.enum(['user', 'agent']),
  changedAt: z.number(),
  /** The change in plain words: "Created", "Edited", "Faded into the archive: unused for 90 days", "Replaced by …", "Merged into …", "Brought back". */
  what: z.string(),
  /** The goal the change came from, when the hive knows it (an agent working on a card of that goal); else null. */
  goalId: z.string().nullable(),
  goalTitle: z.string().nullable(),
});
export type BrainTimelineEntry = z.infer<typeof BrainTimelineEntrySchema>;

export const BrainTimelineViewSchema = z.object({
  /** Newest first. */
  entries: z.array(BrainTimelineEntrySchema),
  /** Pass as `before` to get the next (older) page; null at the end. */
  nextCursor: BrainTimelineCursorSchema.nullable(),
  /** Everyone who changed something within the scope (for the actor filter): 'user' first, then agent ids A–Z. */
  actors: z.array(z.string()),
});
export type BrainTimelineView = z.infer<typeof BrainTimelineViewSchema>;

/** Dashboard (01-D13 phase 2): health is in the snapshot (B3); this adds counts, growth, most used and a timeline. */
export const BrainDashboardViewSchema = z.object({
  /** Shelf the numbers are for (the open project's, or global). */
  shelf: z.string(),
  totals: z.object({ records: z.number().int(), archived: z.number().int(), confirmed: z.number().int(), links: z.number().int() }),
  byKind: z.array(z.object({ kind: RecordKindSchema, count: z.number().int() })),
  /** Last 8 weeks, oldest first: records added and agent reads per week. */
  weeks: z.array(z.object({ weekStart: z.number(), added: z.number().int(), reads: z.number().int() })),
  /** Top 5 by importance among current records. */
  mostUsed: z.array(z.object({ id: z.string(), kind: RecordKindSchema, title: z.string(), reads: z.number().int(), helped: z.number().int(), importance: z.number() })),
  /** Timeline: the latest 30 changes to records on the shelf, newest first. */
  timeline: z.array(
    z.object({
      id: z.string(),
      kind: RecordKindSchema,
      title: z.string(),
      version: z.number().int(),
      change: z.string(),
      /** 'user' or the agent id. */
      changedBy: z.string(),
      changedAt: z.number(),
    }),
  ),
});
export type BrainDashboardView = z.infer<typeof BrainDashboardViewSchema>;

/**
 * The user edits a record (01-D12). Saved as a new version; user edits count as confirmed. If someone
 * (an agent) changed it after `baseVersion`, nothing is saved and the current text comes back as a conflict.
 */
export const BrainEditRequestSchema = z.object({
  id: Id,
  baseVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(100_000),
  summary: z.string().max(1_000).nullable(),
});
export const BrainEditResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), version: z.number().int() }),
  z.object({
    status: z.literal('conflict'),
    current: z.object({ version: z.number().int(), title: z.string(), body: z.string(), summary: z.string().nullable(), changedBy: z.string(), changedAt: z.number() }),
  }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);
export type BrainEditRequest = z.infer<typeof BrainEditRequestSchema>;
export type BrainEditResult = z.infer<typeof BrainEditResultSchema>;

// ---- Library (Phase 2 C1; Capabilities 03-D3, D7, D8) ------------------------------------------

/**
 * Where a library item stands:
 * active = always on for its castes (the warm set: a caste's default skills, and the caste agents themselves);
 * ready = rewritten and safety-checked, on disk, switched on for a card only when that card needs it;
 * dormant = listed in the catalog only (not rewritten or safety-scanned yet): never switched on;
 * draft = proposed by the hive or imported by the user, scanned, and waiting for the user's OK (C3);
 * retired = taken out of use with the user's OK (it kept failing or went unused); never switched on, can be restored.
 */
export const LibraryStatusSchema = z.enum(['active', 'ready', 'dormant', 'draft', 'retired']);
export type LibraryStatus = z.infer<typeof LibraryStatusSchema>;
export const LibraryKindSchema = z.enum(['agent', 'skill', 'tool']);

/**
 * The import safety scan (03-D5), plain code: hidden instructions, data exfiltration, risky scripts, secrets,
 * and format. A 'block' finding means it can never be approved; 'warn' findings are shown to the user first.
 */
export const LibraryScanFindingSchema = z.object({
  severity: z.enum(['block', 'warn']),
  rule: z.enum(['hidden-instructions', 'exfiltration', 'risky-script', 'secret', 'format']),
  message: z.string(),
  /** File inside the item (e.g. "SKILL.md", "scripts/setup.sh"). */
  file: z.string(),
  line: z.number().int().nullable(),
});
export const LibraryScanSchema = z.object({
  verdict: z.enum(['clean', 'warn', 'blocked']),
  findings: z.array(LibraryScanFindingSchema),
  scannedAt: z.number(),
});
export type LibraryScan = z.infer<typeof LibraryScanSchema>;

export const LibraryItemViewSchema = z.object({
  name: z.string(),
  kind: LibraryKindSchema,
  status: LibraryStatusSchema,
  /** Castes from the catalog; may include labels that aren't hive castes yet (e.g. "specialist"). */
  castes: z.array(z.string()),
  description: z.string(),
  /** 'vetted' = safety-reviewed (not yet field-tested); 'unscanned' = not checked. */
  safety: z.enum(['vetted', 'unscanned']),
  sources: z.array(z.object({ repo: z.string(), path: z.string(), license: z.string().nullable() })),
  usage: z.object({ uses: z.number().int(), passed: z.number().int(), failed: z.number().int(), lastUsedAt: z.number().nullable() }),
  /** built-in = shipped with the app; learned = drafted by the hive from repeated work; imported = brought in by the user (C3). */
  origin: z.enum(['built-in', 'learned', 'imported']).default('built-in'),
  /** Safety scan of learned and imported items (D5); null for built-in ones (vetted before shipping). */
  scan: LibraryScanSchema.nullable().default(null),
  /** The waiting approval for a draft (or a retirement proposal), if any. */
  approvalId: z.string().nullable().default(null),
});
export type LibraryItemView = z.infer<typeof LibraryItemViewSchema>;

export const LibrarySearchRequestSchema = z.object({
  /** Words to match in name and description; empty lists everything. */
  query: z.string().max(200).default(''),
  kinds: z.array(LibraryKindSchema).optional(),
  statuses: z.array(LibraryStatusSchema).optional(),
  /** Only items for this caste. */
  caste: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export const LibrarySearchResultSchema = z.object({
  items: z.array(LibraryItemViewSchema),
  /** Items matching the filters (before limit/offset). */
  total: z.number().int(),
  /** Whole catalog, by status (ignores filters), for the filter chips. */
  counts: z.object({
    active: z.number().int(),
    ready: z.number().int(),
    dormant: z.number().int(),
    draft: z.number().int(),
    retired: z.number().int().default(0),
  }),
});
export type LibrarySearchRequest = z.input<typeof LibrarySearchRequestSchema>;
export type LibrarySearchResult = z.infer<typeof LibrarySearchResultSchema>;

export const LibraryItemDetailSchema = z.object({
  item: LibraryItemViewSchema,
  /** The item's text (AGENT.md / SKILL.md without frontmatter) when it is on disk; null for dormant entries. */
  body: z.string().nullable(),
  /** The latest cards it was switched on for, newest first (at most 10). */
  recentCards: z.array(z.object({ cardId: z.string(), title: z.string(), outcome: z.enum(['passed', 'failed', 'running']), at: z.number() })),
});
export type LibraryItemDetail = z.infer<typeof LibraryItemDetailSchema>;

export const LibraryImportResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  /** Scanned and saved as a draft; `scan.verdict` 'blocked' means it can't be approved (it stays visible with the reasons). */
  z.object({ status: z.literal('imported'), name: z.string(), scan: LibraryScanSchema }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);
export type LibraryImportResult = z.infer<typeof LibraryImportResultSchema>;

/** One insect caste: what it is for, what it always carries, and what it may reach on the network. */
export const CasteViewSchema = z.object({
  caste: CasteSchema,
  label: z.string(),
  /** One line from its AGENT.md description. */
  role: z.string(),
  defaultSkills: z.array(z.string()),
  /** none = no network; docs = documentation sites only; web = the open web (read-only). */
  network: z.enum(['none', 'docs', 'web']),
  /** Whether the hive gives it cards (all 8 since C1). */
  enabled: z.boolean(),
});
export type CasteView = z.infer<typeof CasteViewSchema>;

// ---- Budgets (Phase 2 C4; Hive 02-D7, D9; Connections 04-D7) ------------------------------------

export const BudgetsViewSchema = z.object({
  /** Goals, newest first (max 30): their budget, what they used, and the most expensive cards. */
  goals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      budgetTokens: z.number().nullable(),
      usedTokens: z.number(),
      costUsd: z.number(),
      /** True when any cost in it is the hive's estimate (engine didn't report cost). */
      costEstimated: z.boolean(),
      cards: z.array(z.object({ id: z.string(), title: z.string(), caste: CasteSchema, tokens: z.number(), costUsd: z.number(), attempts: z.number().int() })),
    }),
  ),
  /** Last 14 days, oldest first: tokens and cost per day across all agents. */
  days: z.array(z.object({ day: z.number(), tokens: z.number(), costUsd: z.number(), runs: z.number().int() })),
  /** Spend by role/caste over the last 14 days (insect castes plus queen, inspector and managers). */
  byRole: z.array(z.object({ role: z.string(), runs: z.number().int(), tokens: z.number(), costUsd: z.number(), passRate: z.number().nullable() })),
  /** The Treasurer's latest routing decisions, newest first (max 100). */
  routing: z.array(
    z.object({
      at: z.number(),
      runId: z.string(),
      role: z.string(),
      caste: CasteSchema.nullable(),
      cardId: z.string().nullable(),
      title: z.string(),
      engine: EngineIdSchema.nullable(),
      model: z.string().nullable(),
      effort: z.string().nullable(),
      /** The rule in plain words ("retry 1, so more effort or a stronger model"). */
      rule: z.string(),
      outcome: z.enum(['passed', 'failed', 'running', 'stopped', 'other']),
      tokens: z.number(),
      costUsd: z.number(),
    }),
  ),
  /** What the Treasurer has learned (A5 Thompson sampling): tries and passes per role and tier. */
  learned: z.array(z.object({ role: z.string(), engine: EngineIdSchema, tier: z.enum(['strongest', 'standard', 'light']), tries: z.number().int(), passes: z.number().int() })),
});
export type BudgetsView = z.infer<typeof BudgetsViewSchema>;

export const EngineInstallResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('installed'), version: z.string().nullable(), message: z.string() }),
  /** A step on the install ladder is missing (e.g. no npm): nothing was run; `message` says what to do. */
  z.object({ status: z.literal('not-run'), message: z.string() }),
  z.object({ status: z.literal('failed'), message: z.string(), exitCode: z.number().nullable() }),
]);
export type EngineInstallResult = z.infer<typeof EngineInstallResultSchema>;

// ---- push events -----------------------------------------------------------------------------

export const HivePushSchema = z.discriminatedUnion('type', [
  /** Something changed: re-read the snapshot (debounce in the renderer). */
  z.object({ type: z.literal('changed'), reason: z.string() }),
  /** Live output from one run; append to that lane. */
  z.object({ type: z.literal('agent-output'), runId: z.string(), lines: z.array(z.string()) }),
  /** Live output of an engine install the user approved (C4, 04-D6). */
  z.object({ type: z.literal('install-output'), engineId: z.string(), lines: z.array(z.string()) }),
  /** The window was shown (from the tray) or restored: the user is arriving (B1 digest). */
  z.object({ type: z.literal('window-shown') }),
  /** Open a screen (B2: the user clicked a desktop notification or a tray item): Approvals, the Queen (with a goal) or Cadence. */
  z.object({ type: z.literal('open-screen'), screen: z.enum(['approvals', 'queen', 'cadence']), goalId: z.string().nullable() }),
]);
export type HivePush = z.infer<typeof HivePushSchema>;

/** The hive part of `window.insectoids`. */
export interface HiveApi {
  snapshot(): Promise<HiveSnapshot>;
  command(cmd: HiveCommand): Promise<CommandResult>;
  changes(req: z.infer<typeof ChangesRequestSchema>): Promise<ChangesView>;
  brainSearch(req: z.infer<typeof BrainSearchRequestSchema>): Promise<BrainHitView[]>;
  brainRecord(id: string): Promise<BrainRecordView | null>;
  codeLookup(req: z.infer<typeof CodeLookupRequestSchema>): Promise<CodeLookupResult>;
  brainGraph(req: BrainGraphRequest): Promise<BrainGraphView>;
  brainDashboard(): Promise<BrainDashboardView>;
  /** Ask the Brain (Phase 4 A1). Never throws for an unknown answer: it says so. */
  brainAsk(req: BrainAskRequest): Promise<BrainAskResult>;
  brainAskEstimate(): Promise<BrainAskEstimate>;
  /** The Brain's timeline (Phase 4 A3): every change to a record, newest first, paged. */
  brainTimeline(req: BrainTimelineRequest): Promise<BrainTimelineView>;
  brainEdit(req: BrainEditRequest): Promise<BrainEditResult>;
  libraryCastes(): Promise<CasteView[]>;
  librarySearch(req: LibrarySearchRequest): Promise<LibrarySearchResult>;
  /** null when no item has that name. */
  libraryItem(name: string): Promise<LibraryItemDetail | null>;
  /** Opens a folder picker for a skill (SKILL.md) or agent (AGENT.md) folder; scans it; it waits as a draft for approval. */
  libraryImport(): Promise<LibraryImportResult>;
  budgets(): Promise<BudgetsView>;
  /** A cadence's run history, newest first (Phase 3 A1). */
  cadenceRuns(req: CadenceRunsRequest): Promise<CadenceRunView[]>;
  /** What happened unattended since the user last said "Got it" (Phase 3 B1). */
  digest(): Promise<DigestView>;
  /**
   * Runs the engine's own official install command (the one its card shows), after the user agreed in the app.
   * Output streams as 'install-output' pushes; the engine is checked again at the end.
   */
  engineInstall(engineId: string): Promise<EngineInstallResult>;
  pickProject(): Promise<ProjectView | null>;
  /** Returns an unsubscribe function. */
  onEvent(listener: (e: HivePush) => void): () => void;
}
