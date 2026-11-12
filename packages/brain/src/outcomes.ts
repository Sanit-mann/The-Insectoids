import type { DatabaseSync } from 'node:sqlite';

/**
 * Run outcomes: the Treasurer's memory (Hive 02-D9 P1, Connections 04-D7; Phase 2 A5).
 * One row per agent run: what ran (engine, model tier, model, effort), what it cost, and how it ended.
 * An insect run that finished its card stays `pending` until the Inspector decides; then it becomes pass or fail.
 */
export type OutcomeResult = 'pending' | 'pass' | 'fail' | 'error' | 'limit' | 'auth' | 'stopped';

export interface RunOutcome {
  runId: string;
  goalId: string | null;
  cardId: string | null;
  /** queen, inspector, or the insect's caste. */
  role: string;
  priority: string;
  engine: string;
  tier: string;
  /** The model the engine reported (or the one asked for, if it reported none). */
  model: string;
  /** The effort the hive asked for (engines don't report it). */
  effort: string;
  attempt: number;
  result: OutcomeResult;
  tokensIn: number;
  tokensOut: number;
  tokensCache: number;
  costUsd: number;
  costEstimated: boolean;
  durationMs: number;
  at: number;
}

/** Learning numbers for one way of running a caste's cards (engine × tier × effort). */
export interface OutcomeStat {
  role: string;
  engine: string;
  tier: string;
  effort: string;
  successes: number;
  failures: number;
  /** Average cost of a successful run; null until there's a success with a known cost. */
  avgCostPerSuccess: number | null;
}

export interface UsageSum {
  runs: number;
  tokens: number;
  costUsd: number;
  costEstimated: boolean;
}

interface Row {
  run_id: string;
  goal_id: string | null;
  card_id: string | null;
  role: string;
  priority: string;
  engine: string;
  tier: string;
  model: string;
  effort: string;
  attempt: number;
  result: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache: number;
  cost_usd: number;
  cost_estimated: number;
  duration_ms: number;
  at: number;
}

const toOutcome = (r: Row): RunOutcome => ({
  runId: r.run_id,
  goalId: r.goal_id,
  cardId: r.card_id,
  role: r.role,
  priority: r.priority,
  engine: r.engine,
  tier: r.tier,
  model: r.model,
  effort: r.effort,
  attempt: r.attempt,
  result: r.result as OutcomeResult,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  tokensCache: r.tokens_cache,
  costUsd: r.cost_usd,
  costEstimated: r.cost_estimated === 1,
  durationMs: r.duration_ms,
  at: r.at,
});

export class OutcomeStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  /** Record (or replace) one run. `at` defaults to now. */
  record(o: Omit<RunOutcome, 'at'> & { at?: number }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_outcomes (run_id, goal_id, card_id, role, priority, engine, tier, model, effort, attempt, result,
           tokens_in, tokens_out, tokens_cache, cost_usd, cost_estimated, duration_ms, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.runId, o.goalId, o.cardId, o.role, o.priority, o.engine, o.tier, o.model, o.effort, o.attempt, o.result,
        Math.round(o.tokensIn), Math.round(o.tokensOut), Math.round(o.tokensCache), o.costUsd, o.costEstimated ? 1 : 0,
        Math.round(o.durationMs), o.at ?? this.now(),
      );
  }

  get(runId: string): RunOutcome | undefined {
    const r = this.db.prepare('SELECT * FROM run_outcomes WHERE run_id = ?').get(runId) as Row | undefined;
    return r ? toOutcome(r) : undefined;
  }

  /**
   * The Inspector decided a card's attempt: its insect runs that finished (`pending`) become pass or fail.
   * Returns how many runs were settled.
   */
  settle(cardId: string, attempt: number, verdict: 'pass' | 'fail'): number {
    const r = this.db
      .prepare(`UPDATE run_outcomes SET result = ? WHERE card_id = ? AND attempt = ? AND result = 'pending' AND role NOT IN ('queen', 'inspector')`)
      .run(verdict, cardId, attempt);
    return Number(r.changes);
  }

  /**
   * What worked for a role (an insect caste): successes and failures per engine × tier × effort.
   * Runs that hit a vendor limit, a sign-out or were stopped by the user say nothing about the model, so they
   * don't count; errors (timeouts, crashes, bad output) count as failures.
   */
  stats(role: string): OutcomeStat[] {
    const rows = this.db
      .prepare(
        `SELECT engine, tier, effort,
           SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN result IN ('fail', 'error') THEN 1 ELSE 0 END) AS failures,
           AVG(CASE WHEN result = 'pass' AND cost_usd > 0 THEN cost_usd END) AS avg_cost
         FROM run_outcomes WHERE role = ? AND result IN ('pass', 'fail', 'error')
         GROUP BY engine, tier, effort`,
      )
      .all(role) as Array<{ engine: string; tier: string; effort: string; successes: number; failures: number; avg_cost: number | null }>;
    return rows.map((r) => ({
      role,
      engine: r.engine,
      tier: r.tier,
      effort: r.effort,
      successes: r.successes,
      failures: r.failures,
      avgCostPerSuccess: r.avg_cost ?? null,
    }));
  }

  /** Everything an engine's runs used since `since` (epoch ms): the rolling usage windows (04-D7). */
  usageSince(engine: string, since: number): UsageSum {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_in + tokens_out + tokens_cache), 0) AS tokens,
           COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(MAX(cost_estimated), 0) AS est
         FROM run_outcomes WHERE engine = ? AND at >= ?`,
      )
      .get(engine, since) as { runs: number; tokens: number; cost: number; est: number };
    return { runs: r.runs, tokens: r.tokens, costUsd: r.cost, costEstimated: r.est === 1 };
  }

  /** Newest first, for the Budgets screen and tests. */
  recent(limit = 50): RunOutcome[] {
    return (this.db.prepare('SELECT * FROM run_outcomes ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as unknown as Row[]).map(toOutcome);
  }
}
