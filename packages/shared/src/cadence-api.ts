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

export const CadenceWhenSchema = z.discriminatedUnion('type', [
  /** Every N minutes, counted from the last scheduled run (not from when the run finished). */
  z.object({ type: z.literal('interval'), everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES) }),
  /**
   * On these weekdays at this local time ("Mon and Thu 09:00"). Always the user's local wall-clock time, so a
   * daylight-saving change never shifts it. A time that doesn't exist on a spring-forward day runs at the
   * first valid minute after it; a time that happens twice on a fall-back day runs once.
   */
  z.object({ type: z.literal('weekly'), days: z.array(WeekdaySchema).min(1).max(7), time: LocalTimeSchema }),
]);
export type CadenceWhen = z.infer<typeof CadenceWhenSchema>;

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

/** Why a run was triggered. A2–A5 add 'wake', 'file', 'hive-event', 'webhook' and 'maintenance'. */
export const CadenceRunReasonSchema = z.enum(['schedule', 'catch-up', 'manual']);
/**
 * What happened when it was due:
 * - `started`: a goal was submitted (goalId set);
 * - `skipped`: the previous run's goal is still going, so this one didn't pile up on it;
 * - `deferred`: it couldn't run now (the hive is paused, or another project is open); it runs once when it can;
 * - `failed`: submitting the goal failed (message says why).
 */
export const CadenceRunOutcomeSchema = z.enum(['started', 'skipped', 'deferred', 'failed']);

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
  /** Next time it is due, or null when switched off. */
  nextRunAt: z.number().nullable(),
  /** Set when a run is waiting to happen once it can (paused hive, another project open, app was closed). */
  pending: z.boolean(),
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
