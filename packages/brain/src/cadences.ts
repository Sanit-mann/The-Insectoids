import type { DatabaseSync } from 'node:sqlite';
import { type CadenceAutonomy, type CadenceWhen, CadenceWhenSchema } from '@insectoids/shared';

/**
 * Cadences and their run log (Cadence 05; Phase 3 A1), in the Brain's database behind its single writer.
 * The store keeps rows; when a cadence is due, and what a run does, is the host's job (harness `cadence/`).
 */
/** Why a run happened; the same words as the shared contract's CadenceRunReasonSchema (A2 added 'wake', A3 'file' and 'event', A4 'webhook'). */
export type CadenceRunReason = 'schedule' | 'catch-up' | 'wake' | 'manual' | 'file' | 'event' | 'webhook';
/** The same words as CadenceRunOutcomeSchema (A4 added the webhook outcomes). */
export type CadenceRunOutcome = 'started' | 'skipped' | 'deferred' | 'failed' | 'waiting' | 'noted' | 'refused' | 'declined';

export interface CadenceFields {
  name: string;
  when: CadenceWhen;
  goal: string;
  budgetTokens: number;
  autonomy: CadenceAutonomy;
  enabled: boolean;
}

export interface Cadence extends CadenceFields {
  id: string;
  shelf: string;
  nextRunAt: number | null;
  pending: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CadenceRun {
  id: string;
  cadenceId: string;
  at: number;
  reason: CadenceRunReason;
  outcome: CadenceRunOutcome;
  goalId: string | null;
  message: string;
}

interface CadenceRow {
  id: string;
  shelf: string;
  name: string;
  when_json: string;
  goal: string;
  budget_tokens: number;
  autonomy: string;
  enabled: number;
  next_run_at: number | null;
  pending: number;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  cadence_id: string;
  at: number;
  reason: string;
  outcome: string;
  goal_id: string | null;
  message: string;
}

const toCadence = (r: CadenceRow): Cadence => ({
  id: r.id,
  shelf: r.shelf,
  name: r.name,
  when: CadenceWhenSchema.parse(JSON.parse(r.when_json)),
  goal: r.goal,
  budgetTokens: r.budget_tokens,
  autonomy: r.autonomy as CadenceAutonomy,
  enabled: r.enabled === 1,
  nextRunAt: r.next_run_at,
  pending: r.pending === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRun = (r: RunRow): CadenceRun => ({
  id: r.id,
  cadenceId: r.cadence_id,
  at: r.at,
  reason: r.reason as CadenceRunReason,
  outcome: r.outcome as CadenceRunOutcome,
  goalId: r.goal_id,
  message: r.message,
});

export class CadenceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  create(input: CadenceFields & { shelf: string; nextRunAt: number | null }): Cadence {
    const id = `CAD-${this.newId()}`;
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO cadences (id, shelf, name, when_json, goal, budget_tokens, autonomy, enabled, next_run_at, pending, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.shelf, input.name, JSON.stringify(input.when), input.goal, input.budgetTokens, input.autonomy, input.enabled ? 1 : 0, input.nextRunAt, at, at);
    return this.#must(id);
  }

  /** Replaces the user's fields and the next run time (the schedule may have changed). Pending is kept. */
  update(id: string, fields: CadenceFields & { nextRunAt: number | null }): Cadence {
    this.#must(id);
    this.db
      .prepare(`UPDATE cadences SET name = ?, when_json = ?, goal = ?, budget_tokens = ?, autonomy = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
      .run(fields.name, JSON.stringify(fields.when), fields.goal, fields.budgetTokens, fields.autonomy, fields.enabled ? 1 : 0, fields.nextRunAt, this.now(), id);
    return this.#must(id);
  }

  /** Switching off also drops an owed run, so nothing fires later by surprise. */
  setEnabled(id: string, enabled: boolean, nextRunAt: number | null): Cadence {
    this.#must(id);
    this.db
      .prepare(`UPDATE cadences SET enabled = ?, next_run_at = ?, pending = CASE WHEN ? = 1 THEN pending ELSE 0 END, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, nextRunAt, enabled ? 1 : 0, this.now(), id);
    return this.#must(id);
  }

  setNextRun(id: string, nextRunAt: number | null): void {
    this.db.prepare('UPDATE cadences SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);
  }

  setPending(id: string, pending: boolean): void {
    this.db.prepare('UPDATE cadences SET pending = ? WHERE id = ?').run(pending ? 1 : 0, id);
  }

  /** Removes the cadence; its runs stay as history. */
  delete(id: string): void {
    this.#must(id);
    this.db.prepare('DELETE FROM cadences WHERE id = ?').run(id);
  }

  get(id: string): Cadence | undefined {
    const r = this.db.prepare('SELECT * FROM cadences WHERE id = ?').get(id) as CadenceRow | undefined;
    return r ? toCadence(r) : undefined;
  }

  /** One shelf's cadences in creation order, or every cadence when no shelf is given. */
  list(shelf?: string): Cadence[] {
    const rows = shelf === undefined ? this.db.prepare('SELECT * FROM cadences ORDER BY created_at, id').all() : this.db.prepare('SELECT * FROM cadences WHERE shelf = ? ORDER BY created_at, id').all(shelf);
    return (rows as unknown as CadenceRow[]).map(toCadence);
  }

  recordRun(input: { cadenceId: string; reason: CadenceRunReason; outcome: CadenceRunOutcome; goalId?: string | null; message: string; at?: number }): CadenceRun {
    const id = `CR-${this.newId()}`;
    this.db
      .prepare('INSERT INTO cadence_runs (id, cadence_id, at, reason, outcome, goal_id, message) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.cadenceId, input.at ?? this.now(), input.reason, input.outcome, input.goalId ?? null, input.message);
    return toRun(this.db.prepare('SELECT * FROM cadence_runs WHERE id = ?').get(id) as unknown as RunRow);
  }

  /** Newest first. */
  runs(cadenceId: string, limit = 50): CadenceRun[] {
    const rows = this.db.prepare('SELECT * FROM cadence_runs WHERE cadence_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(cadenceId, Math.max(1, Math.min(500, limit)));
    return (rows as unknown as RunRow[]).map(toRun);
  }

  lastRun(cadenceId: string): CadenceRun | null {
    return this.runs(cadenceId, 1)[0] ?? null;
  }

  #must(id: string): Cadence {
    const c = this.get(id);
    if (!c) throw new Error(`No cadence ${id}`);
    return c;
  }
}
