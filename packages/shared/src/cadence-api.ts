import { z } from 'zod';

/**
 * Cadences (Cadence 05; Phase 3 A1): the hive works without being asked.
 *
 * A cadence = when (a schedule) + what (a goal for the Queen) + limits (token budget, autonomy) on one project.
 * Every run is normal hive work through the Queen (05-D1): it becomes a goal via the same path as the user's
 * own goals, so plan approval, budgets, the Treasurer and the Watchdog all apply as usual. Merging into the
 * user's branch always waits for approval, whatever the autonomy (Workspace 06-D3).
 *
 * A1 builds schedules (interval and weekly, local time) plus catch-up-once after the app was closed. Later steps
 * add sleep and wake (A2), file watch and hive events (A3), webhooks (A4) and maintenance (A5), each as a new
 * `CadenceWhen` shape.
 */

const Id = z.string().min(1).max(200);

/** Shortest interval a user can set. Shorter cadences would mostly burn tokens. */
export const MIN_INTERVAL_MINUTES = 15;
/** Longest interval: four weeks. */
export const MAX_INTERVAL_MINUTES = 28 * 24 * 60;

/** "HH:MM", 24-hour, local time. */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 09:00.');

/** Days of the week as JavaScript numbers them: 0 = Sunday … 6 = Saturday. */
export const WeekdaySchema = z.number().int().min(0).max(6);

/** A folder inside the project, relative to its root: "inbox", "docs/incoming" ("." is the whole project). */
export const ProjectFolderSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((s) => s.replace(/\\/g, '/').replace(/\/+$/, '') || '.')
  .refine((s) => !/^([a-zA-Z]:|\/)/.test(s), 'Use a folder inside the project, like inbox or docs/incoming.')
  .refine((s) => !s.split('/').some((p) => p === '..'), 'The folder must be inside the project.')
  .refine((s) => !s.split('/').some((p) => p === '.git'), "The project's .git folder can't be watched.");

/** A simple file-name pattern: `*` and `?` wildcards, e.g. `*.md` or `report-*.csv`. No folders. */
export const FilePatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\\]+$/, 'A file-name pattern like *.md (no folders).');

export const HiveEventTriggerSchema = z.enum(['goal-done', 'budget-warning']);
export type HiveEventTrigger = z.infer<typeof HiveEventTriggerSchema>;

/**
 * How much a webhook's outside sender is trusted (Cadence 05-D4). A call either asks the hive to act (run the
 * cadence) or only tells it something (a note for the Brain):
 * - `strict`: every call waits in Approvals, notes too;
 * - `communication-only` (the default): notes go straight into the Brain (marked unconfirmed, from outside);
 *   anything asking the hive to act waits in Approvals;
 * - `allow-all`: notes are saved and runs start on their own (the cadence's autonomy and budget still apply).
 * Every call is logged in the cadence's run history, refused ones too.
 */
export const WebhookTrustSchema = z.enum(['strict', 'communication-only', 'allow-all']);
export type WebhookTrust = z.infer<typeof WebhookTrustSchema>;
export const DEFAULT_WEBHOOK_TRUST: WebhookTrust = 'communication-only';

/** How long file changes settle before a file-watch run starts, so one copy of many files is one run. */
export const FILE_SETTLE_MS = 5_000;
/** At most this many files are listed in the run's goal (the rest are counted). */
export const MAX_LISTED_FILES = 20;

/** Every N minutes, counted from the last scheduled run (not from when the run finished). */
const IntervalWhenSchema = z.object({ type: z.literal('interval'), everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES) });
/**
 * On these weekdays at this local time ("Mon and Thu 09:00"). Always the user's local wall-clock time, so a
 * daylight-saving change never shifts it. A time that doesn't exist on a spring-forward day runs at the
 * first valid minute after it; a time that happens twice on a fall-back day runs once.
 */
const WeeklyWhenSchema = z.object({ type: z.literal('weekly'), days: z.array(WeekdaySchema).min(1).max(7), time: LocalTimeSchema });
/** A schedule on its own (interval or weekly): what a maintenance job runs on (A5). */
export const ScheduleWhenSchema = z.discriminatedUnion('type', [IntervalWhenSchema, WeeklyWhenSchema]);
export type ScheduleWhen = z.infer<typeof ScheduleWhenSchema>;

/**
 * The hive's own housekeeping (Cadence 05-D7; Phase 3 A5), built in and on by default. They are code, not goals:
 * no tokens, no Queen plan. Each runs on its own schedule and logs what it did in its run history.
 * - `brain-audit`: the Brain health check and audit (01-E12): the health score, conflicts and near-duplicates.
 * - `backup`: a local copy of the Brain (01-D8) in the backups folder; the newest BACKUP_KEEP copies stay.
 * - `consolidate`: unused agent notes fade into the archive (01-E7) and agent-only near-duplicates fold
 *   together (01-E5). Anything the user wrote or confirmed is never changed; those duplicates wait for the user.
 * - `stale-tasks`: taskboard cards left open after their goal ended are closed, with a note. Never deletes.
 * - `skill-review`: skills that keep failing, or learned/imported ones gone unused, are proposed for retiring
 *   in Approvals (03-D6).
 * Built-in jobs can't be removed: deleting one switches it off instead (05-D7: "comes back switched off").
 */
export const MaintenanceJobSchema = z.enum(['brain-audit', 'backup', 'consolidate', 'stale-tasks', 'skill-review']);
export type MaintenanceJob = z.infer<typeof MaintenanceJobSchema>;
/** Built-in jobs live on the Global shelf with a fixed id, so they run whichever project is open (or none). */
export const MAINTENANCE_SHELF = 'global';
export const maintenanceCadenceId = (job: MaintenanceJob): string => `maint-${job}`;
/** Each job's name, what it does in one sentence, and its default schedule. */
export const MAINTENANCE_JOBS: Record<MaintenanceJob, { name: string; sentence: string; schedule: ScheduleWhen }> = {
  'brain-audit': {
    name: 'Brain health check',
    sentence: "Scores the Brain's health and counts what needs you: stale notes, conflicts and near-duplicates.",
    schedule: { type: 'interval', everyMinutes: 6 * 60 },
  },
  backup: {
    name: 'Daily backup',
    sentence: 'Copies the Brain to the backups folder on this computer. The newest 7 copies are kept.',
    schedule: { type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '03:00' },
  },
  consolidate: {
    name: 'Tidy the Brain',
    sentence: 'Fades agent notes nobody used for a long time and folds agent-only near-duplicates together. Your own notes are never changed.',
    schedule: { type: 'interval', everyMinutes: 24 * 60 },
  },
  'stale-tasks': {
    name: 'Stale task cleanup',
    sentence: 'Closes taskboard cards left open after their goal ended. Nothing is deleted.',
    schedule: { type: 'interval', everyMinutes: 24 * 60 },
  },
  'skill-review': {
    name: 'Skill review',
    sentence: 'Proposes retiring skills that keep failing or go unused. Nothing changes until you say yes.',
    schedule: { type: 'interval', everyMinutes: 7 * 24 * 60 },
  },
};
export const MAINTENANCE_JOB_ORDER: readonly MaintenanceJob[] = ['brain-audit', 'backup', 'consolidate', 'stale-tasks', 'skill-review'];

export const CadenceWhenSchema = z.discriminatedUnion('type', [
  IntervalWhenSchema,
  WeeklyWhenSchema,
  /**
   * When files are added or changed in a folder of the project (A3). `folder` is relative to the project root
   * (forward slashes, no `..`, never `.git`); `pattern` optionally limits it to matching file names (`*.md`,
   * `report-*.csv`). Changes settle for a few seconds and then start ONE run that lists the files. Deleted files
   * never trigger. The hive's own worktrees and `.git` are never watched.
   */
  z.object({ type: z.literal('file'), folder: ProjectFolderSchema, pattern: FilePatternSchema.nullable().default(null) }),
  /**
   * When something happens in the hive (A3):
   * - `goal-done`: a goal finished (its merge was approved or declined). With `cadenceId`, only goals that cadence
   *   started ("after each weekly report, post a summary"); without, any goal the user or a schedule started.
   * - `budget-warning`: a goal used 75% of its token budget (once per goal).
   * Loop guard: a goal started by an event cadence never triggers another event cadence, and a cadence is never
   * triggered by its own goals.
   */
  z.object({ type: z.literal('event'), on: HiveEventTriggerSchema, cadenceId: z.string().min(1).max(200).nullable().default(null) }),
  /**
   * When an outside app calls this cadence's local URL (A4): POST http://127.0.0.1:<port>/hooks/<cadenceId> asks
   * the hive to run it; POST .../hooks/<cadenceId>/note only tells the hive something. Each webhook has its own
   * secret in the Vault (04-D4) and calls must carry it (see webhook-api.ts). The listener answers on this
   * computer only (127.0.0.1); reaching it from the internet needs a tunnel the user runs.
   */
  z.object({ type: z.literal('webhook'), trust: WebhookTrustSchema.default(DEFAULT_WEBHOOK_TRUST) }),
  /**
   * A built-in housekeeping job (A5) on its own schedule. Only the hive makes these (one per job, fixed id
   * `maint-<job>`, Global shelf); the user can switch them off, run them now, or change their schedule.
   */
  z.object({ type: z.literal('maintenance'), job: MaintenanceJobSchema, schedule: ScheduleWhenSchema }),
]);
export type CadenceWhen = z.infer<typeof CadenceWhenSchema>;
/** Schedules (and maintenance jobs, on theirs) have a next time; file, event and webhook cadences wait for something to happen. */
export const isScheduled = (w: CadenceWhen): boolean => w.type === 'interval' || w.type === 'weekly' || w.type === 'maintenance';
/** The schedule a scheduled cadence runs on (a maintenance job's inner one), else null. */
export const scheduleOf = (w: CadenceWhen): ScheduleWhen | null =>
  w.type === 'interval' || w.type === 'weekly' ? w : w.type === 'maintenance' ? w.schedule : null;

/**
 * How much a run may do without the user (05-D6), in plain words:
 * - `ask`: every plan waits for the user's approval (nothing starts unattended);
 * - `small-plans`: one-wave plans start on their own, bigger plans wait (the hive's normal rule, 02-D11);
 * - `run`: the plan starts on its own whatever its size.
 * Approvals the work itself raises (risky actions, new dependencies, merges) always wait, at every level.
 */
export const CadenceAutonomySchema = z.enum(['ask', 'small-plans', 'run']);
export type CadenceAutonomy = z.infer<typeof CadenceAutonomySchema>;

export const DEFAULT_CADENCE_BUDGET_TOKENS = 150_000;

export const CadenceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  when: CadenceWhenSchema,
  /** The goal handed to the Queen on every run. */
  goal: z.string().trim().min(3).max(8000),
  /** Token budget for each run's goal (the Treasurer stops new work past it, 02-D9). */
  budgetTokens: z.number().int().min(1_000).max(5_000_000).default(DEFAULT_CADENCE_BUDGET_TOKENS),
  autonomy: CadenceAutonomySchema.default('small-plans'),
  enabled: z.boolean().default(true),
});
export type CadenceInput = z.input<typeof CadenceInputSchema>;
/** A cadence after its defaults are filled in: what the cadence commands carry. */
export type CadenceFields = z.output<typeof CadenceInputSchema>;

/**
 * Why a run was triggered: on schedule, catching up once after the app was closed, after the computer woke from
 * sleep (A2), the user's "Run now", files changing in a watched folder (A3), a hive event (A3) or a webhook call
 * (A4). A5 adds 'maintenance'.
 */
export const CadenceRunReasonSchema = z.enum(['schedule', 'catch-up', 'wake', 'manual', 'file', 'event', 'webhook']);
/**
 * What happened when it was due:
 * - `started`: a goal was submitted (goalId set);
 * - `skipped`: the previous run's goal is still going, so this one didn't pile up on it;
 * - `deferred`: it couldn't run now (the hive is paused, or another project is open); it runs once when it can;
 * - `failed`: submitting the goal failed (message says why);
 * - `waiting` (A4): a webhook call waits for the user in Approvals;
 * - `noted` (A4): a webhook note was saved in the Brain (nothing ran);
 * - `refused` (A4): a webhook call was turned away (bad or missing secret, too big, too many calls, switched off);
 * - `declined` (A4): the user said no to a webhook call in Approvals;
 * - `done` (A5): a maintenance job ran; the message says what it did ("Backed up the Brain (2.1 MB).").
 * Maintenance jobs use the schedule reasons: schedule, catch-up, wake and manual.
 */
export const CadenceRunOutcomeSchema = z.enum(['started', 'skipped', 'deferred', 'failed', 'waiting', 'noted', 'refused', 'declined', 'done']);

export const CadenceRunViewSchema = z.object({
  id: Id,
  cadenceId: Id,
  at: z.number(),
  reason: CadenceRunReasonSchema,
  outcome: CadenceRunOutcomeSchema,
  goalId: Id.nullable(),
  /** Plain words, e.g. "Skipped: the run from 09:00 is still going." */
  message: z.string(),
});
export type CadenceRunView = z.infer<typeof CadenceRunViewSchema>;

export const CadenceViewSchema = z.object({
  id: Id,
  name: z.string(),
  when: CadenceWhenSchema,
  /** The schedule in words, e.g. "Every Monday and Thursday at 09:00" or "Every 2 hours". */
  whenText: z.string(),
  goal: z.string(),
  budgetTokens: z.number(),
  autonomy: CadenceAutonomySchema,
  enabled: z.boolean(),
  /** The project it belongs to (cadences run only while their project is the open one). */
  shelf: z.string(),
  /** Next time it is due: null when switched off, and always null for file and event cadences (they wait for something to happen). */
  nextRunAt: z.number().nullable(),
  /** Set when a run is waiting to happen once it can (paused hive, another project open, app was closed). */
  pending: z.boolean(),
  /** A built-in maintenance job (A5): it can be switched off, run now or rescheduled, but not renamed or removed. */
  builtIn: z.boolean().default(false),
  lastRun: CadenceRunViewSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type CadenceView = z.infer<typeof CadenceViewSchema>;

/** Commands (added to HiveCommandSchema). */
export const CadenceCommandSchemas = [
  z.object({ type: z.literal('createCadence'), cadence: CadenceInputSchema }),
  z.object({ type: z.literal('updateCadence'), id: Id, cadence: CadenceInputSchema }),
  z.object({ type: z.literal('setCadenceEnabled'), id: Id, enabled: z.boolean() }),
  /** Removes the cadence; its run history stays in the Brain. */
  z.object({ type: z.literal('deleteCadence'), id: Id }),
  /** Run it once now, outside its schedule (still through the Queen, with its budget and autonomy). */
  z.object({ type: z.literal('runCadenceNow'), id: Id }),
] as const;

export const CadenceRunsRequestSchema = z.object({ cadenceId: Id, limit: z.number().int().min(1).max(200).default(50) });
export type CadenceRunsRequest = z.input<typeof CadenceRunsRequestSchema>;

/**
 * Cadence proposals (05-D3; Phase 3 A5): when the user asks for much the same goal CADENCE_PROPOSAL_MIN_REPEATS
 * or more times, the Queen proposes a cadence in Approvals (kind `schedule`). Nothing is made until the user says
 * yes; a no means the same request is never proposed again. Goals a cadence started never count.
 */
export const CADENCE_PROPOSAL_MIN_REPEATS = 3;
export const CadenceProposalPayloadSchema = z.object({
  action: z.literal('cadence-proposal'),
  /** Identifies the repeated request, so it is proposed only once. */
  key: z.string().min(1).max(500),
  /** The cadence a yes creates, switched on, in the project the goals were in. */
  cadence: CadenceInputSchema,
  /** The project shelf the goals were in. */
  shelf: z.string().min(1),
  /** The goals it was spotted in, oldest first. */
  goalIds: z.array(z.string()).min(1).max(50),
});
export type CadenceProposalPayload = z.infer<typeof CadenceProposalPayloadSchema>;
