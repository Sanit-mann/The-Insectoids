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

export const PlanViewSchema = z.object({
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
  /** Model and effort that actually ran (App 07 principle 3); null until the engine reports it. */
  model: z.string().nullable(),
  effort: z.string().nullable(),
  status: LaneStatusSchema,
  tokens: z.number(),
  costUsd: z.number(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** Last ~200 output lines (tool calls and text, already shortened for display). */
  output: z.array(z.string()),
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

export const HiveSnapshotSchema = z.object({
  /** null until the user picks a project folder. */
  project: ProjectViewSchema.nullable(),
  engine: EngineViewSchema,
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
});
export const BrainHitViewSchema = z.object({
  id: z.string(),
  kind: RecordKindSchema,
  shelf: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
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
