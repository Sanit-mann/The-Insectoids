import type { DatabaseSync } from 'node:sqlite';

/** Goal lifecycle (Hive 02-D5): plan, maybe wait for approval, run in waves, finish or get stuck. */
export type GoalStatus = 'planning' | 'awaiting_approval' | 'running' | 'stuck' | 'done' | 'cancelled';

const ALLOWED: Record<GoalStatus, readonly GoalStatus[]> = {
  planning: ['awaiting_approval', 'running', 'stuck', 'cancelled'],
  awaiting_approval: ['running', 'planning', 'cancelled'],
  running: ['stuck', 'done', 'cancelled'],
  stuck: ['running', 'planning', 'cancelled'],
  done: [],
  cancelled: [],
};

export interface Goal {
  id: string;
  title: string;
  text: string;
  shelf: string;
  status: GoalStatus;
  plan: unknown;
  currentWave: number;
  budgetTokens: number | null;
  spentTokens: number;
  spentUsd: number;
  createdAt: number;
  updatedAt: number;
}

interface GoalRow {
  id: string;
  title: string;
  text: string;
  shelf: string;
  status: string;
  plan: string | null;
  current_wave: number;
  budget_tokens: number | null;
  spent_tokens: number;
  spent_usd: number;
  created_at: number;
  updated_at: number;
}

const toGoal = (r: GoalRow): Goal => ({
  id: r.id,
  title: r.title,
  text: r.text,
  shelf: r.shelf,
  status: r.status as GoalStatus,
  plan: r.plan ? (JSON.parse(r.plan) as unknown) : null,
  currentWave: r.current_wave,
  budgetTokens: r.budget_tokens,
  spentTokens: r.spent_tokens,
  spentUsd: r.spent_usd,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class GoalStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {}

  create(input: { id?: string; title: string; text: string; shelf: string; budgetTokens?: number }): Goal {
    const id = input.id ?? `G-${this.newId()}`;
    const at = this.now();
    this.db
      .prepare(`INSERT INTO goals (id, title, text, shelf, status, budget_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, 'planning', ?, ?, ?)`)
      .run(id, input.title, input.text, input.shelf, input.budgetTokens ?? null, at, at);
    return this.#must(id);
  }

  get(id: string): Goal | undefined {
    const r = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
    return r ? toGoal(r) : undefined;
  }

  list(status?: GoalStatus): Goal[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM goals WHERE status = ? ORDER BY created_at').all(status)
      : this.db.prepare('SELECT * FROM goals ORDER BY created_at').all();
    return (rows as unknown as GoalRow[]).map(toGoal);
  }

  setStatus(id: string, to: GoalStatus): Goal {
    const g = this.#must(id);
    if (!ALLOWED[g.status].includes(to)) throw new Error(`Illegal goal transition for ${id}: ${g.status} -> ${to}`);
    this.db.prepare('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?').run(to, this.now(), id);
    return this.#must(id);
  }

  setPlan(id: string, plan: unknown): void {
    this.db.prepare('UPDATE goals SET plan = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), this.now(), id);
  }

  setWave(id: string, wave: number): void {
    this.db.prepare('UPDATE goals SET current_wave = ?, updated_at = ? WHERE id = ?').run(wave, this.now(), id);
  }

  setBudget(id: string, budgetTokens: number): void {
    this.db.prepare('UPDATE goals SET budget_tokens = ?, updated_at = ? WHERE id = ?').run(budgetTokens, this.now(), id);
  }

  addSpend(id: string, tokens: number, usd: number): void {
    this.db
      .prepare('UPDATE goals SET spent_tokens = spent_tokens + ?, spent_usd = spent_usd + ?, updated_at = ? WHERE id = ?')
      .run(Math.round(tokens), usd, this.now(), id);
  }

  #must(id: string): Goal {
    const g = this.get(id);
    if (!g) throw new Error(`No goal ${id}`);
    return g;
  }
}
