import type { DatabaseSync } from 'node:sqlite';
import {
  type Caste,
  type Priority,
  type TaskCard,
  TaskCardSchema,
  type TaskStatus,
  canTransition,
} from '@insectoids/shared';
import { transaction } from './db';

/** A card as the Queen posts it. */
export type NewCard = Omit<TaskCard, 'status' | 'attempts' | 'claimedBy' | 'leaseExpiresAt' | 'result'> & {
  maxAttempts?: number;
};

/** A card on the board. */
export type BoardCard = TaskCard & { maxAttempts: number; escalated: boolean; createdAt: number; updatedAt: number };

export interface ClaimRequest {
  agentId: string;
  caste: Caste;
  leaseMs: number;
}

export interface TaskEvent {
  from: TaskStatus | 'none';
  to: TaskStatus;
  actor: string;
  note: string | null;
  at: number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

/**
 * The atomic claim. One statement: it only changes a card that is still open, belongs to the caste,
 * and has every dependency done, so two insects can never hold the same card (Hive 02-D10).
 * Parameters: agentId, leaseExpiresAt, now, cardId, caste.
 */
export const CLAIM_SQL = `
UPDATE tasks SET status = 'claimed', claimed_by = ?, lease_expires_at = ?, updated_at = ?
WHERE id = ? AND caste = ? AND status = 'open'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(tasks.depends_on) AS d
    LEFT JOIN tasks AS dep ON dep.id = d.value
    WHERE dep.status IS NOT 'done'
  )`;

interface TaskRow {
  id: string;
  goal_id: string;
  wave: number;
  title: string;
  brief: string;
  caste: string;
  priority: string;
  acceptance: string;
  depends_on: string;
  status: string;
  claimed_by: string | null;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  escalated: number;
  result: string | null;
  created_at: number;
  updated_at: number;
}

function toCard(r: TaskRow): BoardCard {
  return {
    ...TaskCardSchema.parse({
      id: r.id,
      goalId: r.goal_id,
      wave: r.wave,
      title: r.title,
      brief: r.brief,
      caste: r.caste,
      priority: r.priority,
      acceptance: JSON.parse(r.acceptance) as string[],
      dependsOn: JSON.parse(r.depends_on) as string[],
      status: r.status,
      attempts: r.attempts,
      ...(r.claimed_by ? { claimedBy: r.claimed_by } : {}),
      ...(r.lease_expires_at !== null ? { leaseExpiresAt: r.lease_expires_at } : {}),
      ...(r.result !== null ? { result: r.result } : {}),
    }),
    maxAttempts: r.max_attempts,
    escalated: r.escalated === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Taskboard {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  post(input: NewCard, postedBy = 'queen'): BoardCard {
    const { maxAttempts = DEFAULT_MAX_ATTEMPTS, ...rest } = input;
    const c = TaskCardSchema.parse({ ...rest, status: 'open', attempts: 0 });
    return transaction(this.db, () => {
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO tasks (id, goal_id, wave, title, brief, caste, priority, acceptance, depends_on, status, attempts, max_attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)`,
        )
        .run(c.id, c.goalId, c.wave, c.title, c.brief, c.caste, c.priority, JSON.stringify(c.acceptance), JSON.stringify(c.dependsOn), maxAttempts, at, at);
      this.#event(c.id, 'none', 'open', postedBy, null, at);
      return this.#must(c.id);
    });
  }

  get(id: string): BoardCard | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toCard(row) : undefined;
  }

  list(filter: { goalId?: string; status?: TaskStatus } = {}): BoardCard[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.goalId) {
      where.push('goal_id = ?');
      params.push(filter.goalId);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY wave, created_at, id`;
    return (this.db.prepare(sql).all(...params) as unknown as TaskRow[]).map(toCard);
  }

  /** Claim one specific card. Returns null if it is taken, locked, or for another caste. */
  claim(id: string, req: ClaimRequest): BoardCard | null {
    return transaction(this.db, () => {
      const at = this.now();
      const res = this.db.prepare(CLAIM_SQL).run(req.agentId, at + req.leaseMs, at, id, req.caste);
      if (Number(res.changes) !== 1) return null;
      this.#event(id, 'open', 'claimed', req.agentId, null, at);
      return this.#must(id);
    });
  }

  /** Pull the most urgent claimable card for this caste (oldest first within a priority). */
  claimNext(req: ClaimRequest): BoardCard | null {
    const candidates = this.db
      .prepare(`SELECT id, priority, created_at FROM tasks WHERE status = 'open' AND caste = ?`)
      .all(req.caste) as Array<{ id: string; priority: Priority; created_at: number }>;
    candidates.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.created_at - b.created_at || a.id.localeCompare(b.id));
    for (const c of candidates) {
      const got = this.claim(c.id, req);
      if (got) return got;
    }
    return null;
  }

  /** Renew the lease. Only the holder can, and only while the card is active. */
  heartbeat(id: string, agentId: string, leaseMs: number): boolean {
    const at = this.now();
    const res = this.db
      .prepare(`UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND claimed_by = ? AND status IN ('claimed', 'in_progress')`)
      .run(at + leaseMs, at, id, agentId);
    return Number(res.changes) === 1;
  }

  start(id: string, agentId: string): BoardCard {
    return this.#holderMove(id, agentId, 'in_progress');
  }

  /** Pauses the card, and its lease, while it waits (e.g. for the user's approval). */
  block(id: string, agentId: string, reason: string): BoardCard {
    return this.#holderMove(id, agentId, 'blocked', reason, { lease: null });
  }

  unblock(id: string, agentId: string, leaseMs = 20 * 60_000): BoardCard {
    return this.#holderMove(id, agentId, 'in_progress', null, { lease: this.now() + leaseMs });
  }

  /** Hand finished work to the Inspector. */
  submit(id: string, agentId: string, result: string): BoardCard {
    return this.#holderMove(id, agentId, 'review', null, { lease: null, result });
  }

  /** The insect gives up; counts as an attempt. */
  giveUp(id: string, agentId: string, reason: string): BoardCard {
    return transaction(this.db, () => {
      const cur = this.#must(id);
      this.#assertHolder(cur, agentId);
      return this.#retryOrEscalate(cur, agentId, reason);
    });
  }

  /** The Inspector's verdict: the only road to done (Hive 02-D10). */
  review(id: string, v: { verdict: 'pass' | 'fail'; by: string; note?: string }): BoardCard {
    return transaction(this.db, () => {
      const cur = this.#must(id);
      if (cur.status !== 'review') throw new Error(`Illegal task transition for ${id}: ${cur.status} -> ${v.verdict === 'pass' ? 'done' : 'open'}`);
      if (v.verdict === 'pass') {
        this.#set(id, 'done', {});
        this.#event(id, 'review', 'done', v.by, v.note ?? null, this.now());
        return this.#must(id);
      }
      return this.#retryOrEscalate(cur, v.by, v.note ?? null);
    });
  }

  /** Foreman reflex: cards whose insect stopped renewing go back on the board. Returns the ids moved. */
  sweepExpiredLeases(): string[] {
    return transaction(this.db, () => {
      const at = this.now();
      const rows = this.db
        .prepare(`SELECT id FROM tasks WHERE status IN ('claimed', 'in_progress') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`)
        .all(at) as Array<{ id: string }>;
      for (const { id } of rows) this.#retryOrEscalate(this.#must(id), 'foreman', 'lease expired');
      return rows.map((r) => r.id);
    });
  }

  /** Cards that failed for good and need the Queen's attention. */
  escalated(): string[] {
    return (this.db.prepare(`SELECT id FROM tasks WHERE escalated = 1 AND status = 'failed' ORDER BY updated_at`).all() as Array<{ id: string }>).map((r) => r.id);
  }

  events(id: string): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT from_st, to_st, actor, note, at FROM task_events WHERE task_id = ? ORDER BY seq')
      .all(id) as Array<{ from_st: TaskEvent['from']; to_st: TaskStatus; actor: string; note: string | null; at: number }>;
    return rows.map((r) => ({ from: r.from_st, to: r.to_st, actor: r.actor, note: r.note, at: r.at }));
  }

  #retryOrEscalate(cur: BoardCard, actor: string, note: string | null): BoardCard {
    const attempts = cur.attempts + 1;
    const to: TaskStatus = attempts >= cur.maxAttempts ? 'failed' : 'open';
    this.#assertTransition(cur, to);
    this.#set(cur.id, to, { attempts, holder: null, lease: null, escalated: to === 'failed' });
    this.#event(cur.id, cur.status, to, actor, note, this.now());
    return this.#must(cur.id);
  }

  #holderMove(id: string, agentId: string, to: TaskStatus, note: string | null = null, extra: { lease?: number | null; result?: string } = {}): BoardCard {
    return transaction(this.db, () => {
      const cur = this.#must(id);
      this.#assertTransition(cur, to);
      this.#assertHolder(cur, agentId);
      this.#set(id, to, extra);
      this.#event(id, cur.status, to, agentId, note, this.now());
      return this.#must(id);
    });
  }

  #set(id: string, status: TaskStatus, f: { attempts?: number; holder?: null; lease?: number | null; escalated?: boolean; result?: string }): void {
    const sets = ['status = ?', 'updated_at = ?'];
    const params: Array<string | number | null> = [status, this.now()];
    const add = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (f.attempts !== undefined) add('attempts', f.attempts);
    if (f.holder === null) sets.push('claimed_by = NULL');
    if (f.lease !== undefined) add('lease_expires_at', f.lease);
    if (f.escalated !== undefined) add('escalated', f.escalated ? 1 : 0);
    if (f.result !== undefined) add('result', f.result);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  #assertTransition(cur: BoardCard, to: TaskStatus): void {
    if (!canTransition(cur.status, to)) throw new Error(`Illegal task transition for ${cur.id}: ${cur.status} -> ${to}`);
  }

  #assertHolder(cur: BoardCard, agentId: string): void {
    if (cur.claimedBy !== agentId) throw new Error(`${cur.id} is held by ${cur.claimedBy ?? 'nobody'}, not ${agentId}`);
  }

  #event(id: string, from: TaskEvent['from'], to: TaskStatus, actor: string, note: string | null, at: number): void {
    this.db.prepare('INSERT INTO task_events (task_id, from_st, to_st, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, actor, note, at);
  }

  #must(id: string): BoardCard {
    const c = this.get(id);
    if (!c) throw new Error(`No task card ${id}`);
    return c;
  }
}
