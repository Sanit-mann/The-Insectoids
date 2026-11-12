import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalKind, ApprovalStatus } from '@insectoids/shared';
import type { Actor } from './brain';

/** An item in the user's approval inbox (App 07). Only the user can decide it. */
export interface ApprovalItem {
  id: string;
  goalId: string | null;
  kind: ApprovalKind;
  title: string;
  from: string;
  whyItNeedsYou: string;
  ifYouSayYes: string;
  destructive: boolean;
  status: ApprovalStatus;
  /** What the hive should do once it is decided (e.g. which card to unblock). */
  payload: unknown;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface NewApproval {
  goalId?: string;
  kind: ApprovalKind;
  title: string;
  from: string;
  whyItNeedsYou: string;
  ifYouSayYes: string;
  destructive?: boolean;
  payload?: unknown;
}

interface Row {
  id: string;
  goal_id: string | null;
  kind: string;
  title: string;
  from_agent: string;
  why: string;
  effect: string;
  destructive: number;
  status: string;
  payload: string | null;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

const toItem = (r: Row): ApprovalItem => ({
  id: r.id,
  goalId: r.goal_id,
  kind: r.kind as ApprovalKind,
  title: r.title,
  from: r.from_agent,
  whyItNeedsYou: r.why,
  ifYouSayYes: r.effect,
  destructive: r.destructive === 1,
  status: r.status as ApprovalStatus,
  payload: r.payload ? (JSON.parse(r.payload) as unknown) : null,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  decidedBy: r.decided_by,
});

export class ApprovalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  create(a: NewApproval): ApprovalItem {
    const id = `A-${this.newId()}`;
    this.db
      .prepare(
        `INSERT INTO approvals (id, goal_id, kind, title, from_agent, why, effect, destructive, status, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
      )
      .run(id, a.goalId ?? null, a.kind, a.title, a.from, a.whyItNeedsYou, a.ifYouSayYes, a.destructive ? 1 : 0, a.payload === undefined ? null : JSON.stringify(a.payload), this.now());
    return this.#must(id);
  }

  get(id: string): ApprovalItem | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return r ? toItem(r) : undefined;
  }

  list(filter: { status?: ApprovalStatus; goalId?: string } = {}): ApprovalItem[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.goalId) {
      where.push('goal_id = ?');
      params.push(filter.goalId);
    }
    const sql = `SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`;
    return (this.db.prepare(sql).all(...params) as unknown as Row[]).map(toItem);
  }

  /** Only the user decides (Memory 01-D3, Hive 02-D4). Decisions are final. */
  decide(id: string, status: 'approved' | 'denied', actor: Actor): ApprovalItem {
    if (actor.type !== 'user') throw new Error('Only the user can decide an approval.');
    const cur = this.#must(id);
    if (cur.status !== 'waiting') throw new Error(`Approval ${id} was already ${cur.status}.`);
    this.db.prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(status, this.now(), 'user', id);
    return this.#must(id);
  }

  #must(id: string): ApprovalItem {
    const a = this.get(id);
    if (!a) throw new Error(`No approval ${id}`);
    return a;
  }
}
