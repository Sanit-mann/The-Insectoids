import type { DatabaseSync } from 'node:sqlite';

/**
 * The managers' logs (Hive 02-D8, D9 P3; Phase 2 C2), in the Brain's database behind its single writer:
 * the Watchdog's incidents and the Foreman's decisions.
 */
export type Sensor = 'loop' | 'error-repeat' | 'stall' | 'overspend' | 'crash' | 'hive';
export type BreakerStep = 'warn' | 'pause-card' | 'stop-agent' | 'pause-hive';

export interface IncidentInput {
  sensor: Sensor;
  step: BreakerStep;
  agentId: string;
  runId?: string | null;
  goalId?: string | null;
  cardId?: string | null;
  /** Plain words with counts. */
  evidence: string;
  /** What makes two incidents "the same" (sensor + caste + error text); counted for recurrence. */
  signature: string;
}

export interface Incident {
  id: string;
  at: number;
  sensor: Sensor;
  step: BreakerStep;
  agentId: string;
  runId: string | null;
  goalId: string | null;
  cardId: string | null;
  evidence: string;
  signature: string;
  /** How many earlier incidents had the same signature. */
  recurrence: number;
}

interface IncidentRow {
  id: string;
  at: number;
  sensor: Sensor;
  step: BreakerStep;
  agent: string;
  run_id: string | null;
  goal_id: string | null;
  card_id: string | null;
  evidence: string;
  signature: string;
  recurrence: number;
}

const toIncident = (r: IncidentRow): Incident => ({
  id: r.id,
  at: r.at,
  sensor: r.sensor,
  step: r.step,
  agentId: r.agent,
  runId: r.run_id,
  goalId: r.goal_id,
  cardId: r.card_id,
  evidence: r.evidence,
  signature: r.signature,
  recurrence: r.recurrence,
});

export class IncidentStore {
  #seq = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  record(input: IncidentInput): Incident {
    const at = this.now();
    const prior = this.db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE signature = ?').get(input.signature) as { n: number };
    const id = `inc-${at.toString(36)}-${(++this.#seq).toString(36)}`;
    this.db
      .prepare('INSERT INTO incidents (id, at, sensor, step, agent, run_id, goal_id, card_id, evidence, signature, recurrence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, at, input.sensor, input.step, input.agentId, input.runId ?? null, input.goalId ?? null, input.cardId ?? null, input.evidence, input.signature, Number(prior.n));
    return this.get(id)!;
  }

  get(id: string): Incident | undefined {
    const row = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as IncidentRow | undefined;
    return row ? toIncident(row) : undefined;
  }

  /** Newest first. */
  list(o: { limit?: number; since?: number; cardId?: string } = {}): Incident[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (o.since !== undefined) {
      where.push('at >= ?');
      params.push(o.since);
    }
    if (o.cardId) {
      where.push('card_id = ?');
      params.push(o.cardId);
    }
    const sql = `SELECT * FROM incidents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, o.limit ?? 50) as unknown as IncidentRow[]).map(toIncident);
  }
}

export type ForemanAction = 'retry-with-note' | 'stronger-model' | 'to-queen';
export type ForemanWake = 'attempts-exhausted' | 'held' | 'lease-loop';

export interface ForemanDecision {
  at: number;
  goalId: string;
  cardId: string;
  cardTitle: string;
  wake: ForemanWake;
  action: ForemanAction;
  reason: string;
}

export class ForemanLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  record(d: Omit<ForemanDecision, 'at'>): ForemanDecision {
    const at = this.now();
    this.db
      .prepare('INSERT INTO foreman_decisions (at, goal_id, card_id, card_title, wake, action, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(at, d.goalId, d.cardId, d.cardTitle, d.wake, d.action, d.reason);
    return { at, ...d };
  }

  /** Newest first. */
  list(limit = 20): ForemanDecision[] {
    const rows = this.db
      .prepare('SELECT at, goal_id, card_id, card_title, wake, action, reason FROM foreman_decisions ORDER BY seq DESC LIMIT ?')
      .all(limit) as Array<{ at: number; goal_id: string; card_id: string; card_title: string; wake: ForemanWake; action: ForemanAction; reason: string }>;
    return rows.map((r) => ({ at: r.at, goalId: r.goal_id, cardId: r.card_id, cardTitle: r.card_title, wake: r.wake, action: r.action, reason: r.reason }));
  }

  forCard(cardId: string): ForemanDecision[] {
    const rows = this.db
      .prepare('SELECT at, goal_id, card_id, card_title, wake, action, reason FROM foreman_decisions WHERE card_id = ? ORDER BY seq')
      .all(cardId) as Array<{ at: number; goal_id: string; card_id: string; card_title: string; wake: ForemanWake; action: ForemanAction; reason: string }>;
    return rows.map((r) => ({ at: r.at, goalId: r.goal_id, cardId: r.card_id, cardTitle: r.card_title, wake: r.wake, action: r.action, reason: r.reason }));
  }
}
