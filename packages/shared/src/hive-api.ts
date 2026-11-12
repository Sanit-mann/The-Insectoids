import { z } from 'zod';
import { ApprovalKindSchema, ApprovalStatusSchema } from './approvals';
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
export const EngineIdSchema = z.enum(['claude', 'gemini', 'codex', 'opencode', 'fake']);
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
  role: z.enum(['queen', 'insect', 'inspector']),
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

export const HiveSnapshotSchema = z.object({
  /** null until the user picks a project folder. */
  project: ProjectViewSchema.nullable(),
  /** The engine the hive uses by default (the first enabled, ready one in the user's order). */
  engine: EngineViewSchema,
  /** Every known engine, in the user's preference order (Connections screen). */
  engines: z.array(EngineCardSchema),
  meaningSearch: MeaningSearchSchema,
  hive: z.object({
    paused: z.boolean(),
    pausedReason: z.string().nullable(),
    insectCap: z.number().int(),
    /** Agents working right now. */
    working: z.number().int(),
  }),
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
  z.object({ type: z.literal('submitGoal'), text: z.string().trim().min(3).max(8000), budgetTokens: z.number().int().positive().optional() }),
  z.object({ type: z.literal('approve'), approvalId: Id }),
  z.object({ type: z.literal('deny'), approvalId: Id }),
  z.object({ type: z.literal('pause'), reason: z.string().max(200).optional() }),
  z.object({ type: z.literal('resume') }),
  /** Check the AI engines again now (e.g. right after the user signed in). */
  z.object({ type: z.literal('checkEngine') }),
  /** Switch an engine on or off for the hive. */
  z.object({ type: z.literal('setEngineEnabled'), engineId: EngineIdSchema, enabled: z.boolean() }),
  /** The user's preference order (first = default). Unknown ids are ignored; missing ones keep their place at the end. */
  z.object({ type: z.literal('setEngineOrder'), order: z.array(EngineIdSchema).max(5) }),
  /** The user's soft spending limits for an engine's subscription (null clears). */
  z.object({ type: z.literal('setEngineLimits'), engineId: EngineIdSchema, cap5hUsd: z.number().positive().max(10_000).nullable(), cap7dUsd: z.number().positive().max(100_000).nullable() }),
  /** Tidy the Brain now (B2): fade unused, unimportant agent notes into the archive. Also runs on its own every 6 h. */
  z.object({ type: z.literal('tidyBrain') }),
  /** Bring an archived (e.g. faded) Brain record back, as a new version. The user only (B2). */
  z.object({ type: z.literal('restoreRecord'), id: Id }),
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

// ---- push events -----------------------------------------------------------------------------

export const HivePushSchema = z.discriminatedUnion('type', [
  /** Something changed: re-read the snapshot (debounce in the renderer). */
  z.object({ type: z.literal('changed'), reason: z.string() }),
  /** Live output from one run; append to that lane. */
  z.object({ type: z.literal('agent-output'), runId: z.string(), lines: z.array(z.string()) }),
]);
export type HivePush = z.infer<typeof HivePushSchema>;

/** The hive part of `window.insectoids`. */
export interface HiveApi {
  snapshot(): Promise<HiveSnapshot>;
  command(cmd: HiveCommand): Promise<CommandResult>;
  changes(req: z.infer<typeof ChangesRequestSchema>): Promise<ChangesView>;
  brainSearch(req: z.infer<typeof BrainSearchRequestSchema>): Promise<BrainHitView[]>;
  brainRecord(id: string): Promise<BrainRecordView | null>;
  pickProject(): Promise<ProjectView | null>;
  /** Returns an unsubscribe function. */
  onEvent(listener: (e: HivePush) => void): () => void;
}
