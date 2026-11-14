import type { HiveSnapshot, NoticeModel } from '@insectoids/shared';

/**
 * Desktop notifications (Cadence 05-D8, App 07-D7; Phase 3 B2). Only two things notify: something new waits for the
 * user's approval, and a failure (a goal became stuck, a cadence run or a built-in job failed). Everything else stays
 * quiet and is in the digest. Only while the window isn't in front; calm (grouped, at most one a minute per kind).
 */

/** The parts of a hive snapshot the notifier reads (a full `HiveSnapshot` fits). */
export type NoticeSnapshot = Pick<HiveSnapshot, 'project' | 'approvals' | 'goals' | 'cadences' | 'activity'>;

export type NoticeKind = NoticeModel['kind'];
export type NoticeTarget = NoticeModel['target'];

/** One thing worth telling the user, before grouping. */
export interface NoticeItem {
  kind: NoticeKind;
  title: string;
  body: string;
  target: NoticeTarget;
}

export interface DecideState {
  /** The Settings switch (on by default). */
  enabled: boolean;
  /** The window is visible, not minimised and focused: the user sees the app already. */
  windowInFront: boolean;
}

/** Changes within this window become one notification. */
export const GROUP_WINDOW_MS = 3_000;
/** At most one notification per kind in this time; extra ones are folded into the next. */
export const RATE_LIMIT_MS = 60_000;

const waitingIds = (s: NoticeSnapshot): Set<string> => new Set(s.approvals.filter((a) => a.status === 'waiting').map((a) => a.id));

/** The newest "goal-stuck" activity line for a goal (the hive says why there), or null. */
function stuckReason(s: NoticeSnapshot, goalId: string): string | null {
  for (let i = s.activity.length - 1; i >= 0; i--) {
    const a = s.activity[i]!;
    if (a.goalId === goalId && a.type === 'goal-stuck' && a.message.trim()) return a.message.trim();
  }
  return null;
}

/**
 * What changed between two snapshots that deserves a notification, in plain words. Nothing on the first snapshot
 * (a baseline), when the open project changed (another project's old items are not news), while the window is in
 * front, or when notifications are switched off.
 */
export function decide(prev: NoticeSnapshot | null, next: NoticeSnapshot, _now: number, state: DecideState): NoticeItem[] {
  if (!prev || !state.enabled || state.windowInFront) return [];
  if ((prev.project?.path ?? null) !== (next.project?.path ?? null)) return [];
  const out: NoticeItem[] = [];

  const before = waitingIds(prev);
  for (const a of next.approvals) {
    if (a.status !== 'waiting' || before.has(a.id)) continue;
    out.push({ kind: 'approval', title: a.title, body: a.whyItNeedsYou.trim() || `From ${a.from}.`, target: { screen: 'approvals', goalId: null } });
  }

  const prevGoals = new Map(prev.goals.map((g) => [g.id, g.status]));
  for (const g of next.goals) {
    if (g.status !== 'stuck' || prevGoals.get(g.id) === 'stuck') continue;
    const reason = stuckReason(next, g.id);
    out.push({
      kind: 'failure',
      title: `Stuck: ${g.title}`,
      body: reason ?? 'The hive could not finish this goal. Open it to see what happened.',
      target: { screen: 'queen', goalId: g.id },
    });
  }

  const prevRuns = new Map(prev.cadences.map((c) => [c.id, c.lastRun?.id ?? null]));
  for (const c of next.cadences) {
    const run = c.lastRun;
    // Only cadences the user already had: a run is news when its id changed and it failed.
    if (!run || run.outcome !== 'failed' || !prevRuns.has(c.id) || prevRuns.get(c.id) === run.id) continue;
    out.push({
      kind: 'failure',
      title: `${c.name} failed`,
      body: run.message.trim() || (c.builtIn ? 'A built-in job failed. Open Cadence to see why.' : 'Its run failed. Open Cadence to see why.'),
      target: { screen: 'cadence', goalId: null },
    });
  }
  return out;
}

/** Several items of one kind become one calm notification ("3 things wait for you"). */
export function groupNotice(kind: NoticeKind, items: readonly NoticeItem[], at: number): NoticeModel {
  if (items.length === 1) {
    const [only] = items as [NoticeItem];
    return { kind, title: only.title, body: only.body, target: only.target, at };
  }
  const n = items.length;
  const title = kind === 'approval' ? `${n} things wait for you` : `${n} things went wrong`;
  const shown = items.slice(0, 3).map((i) => i.title);
  const body = `${shown.join('; ')}${n > shown.length ? `; and ${n - shown.length} more` : ''}.`;
  const first = items[0]!;
  const sameScreen = items.every((i) => i.target.screen === first.target.screen);
  const target: NoticeTarget = kind === 'approval' ? { screen: 'approvals', goalId: null } : { screen: sameScreen ? first.target.screen : 'queen', goalId: null };
  return { kind, title, body, target, at };
}

export interface NotifierDeps {
  /** Show one notification (Electron `Notification` in the app; under e2e it is only recorded). */
  show: (notice: NoticeModel) => void;
  enabled: () => boolean;
  windowInFront: () => boolean;
  now?: () => number;
  groupMs?: number;
  rateLimitMs?: number;
}

/**
 * Feeds snapshots through `decide`, groups what comes within a few seconds and keeps to one notification per kind a
 * minute (later ones wait and are folded into the next). The window coming to the front drops what was still waiting.
 */
export class Notifier {
  readonly #d: Required<Omit<NotifierDeps, 'now'>> & { now: () => number };
  #prev: NoticeSnapshot | null = null;
  readonly #pending = new Map<NoticeKind, NoticeItem[]>();
  readonly #timers = new Map<NoticeKind, NodeJS.Timeout>();
  readonly #lastShown = new Map<NoticeKind, number>();

  constructor(d: NotifierDeps) {
    this.#d = { groupMs: GROUP_WINDOW_MS, rateLimitMs: RATE_LIMIT_MS, now: () => Date.now(), ...d };
  }

  /** A fresh snapshot of the hive. The first one (and the first after `rebaseline`) only sets the baseline. */
  observe(next: NoticeSnapshot): void {
    const items = decide(this.#prev, next, this.#d.now(), { enabled: this.#d.enabled(), windowInFront: this.#d.windowInFront() });
    this.#prev = next;
    for (const item of items) {
      const list = this.#pending.get(item.kind) ?? [];
      list.push(item);
      this.#pending.set(item.kind, list);
      if (!this.#timers.has(item.kind)) this.#schedule(item.kind, this.#d.groupMs);
    }
  }

  /** The Brain restarted or the project changed: the next snapshot is a new baseline. */
  rebaseline(): void {
    this.#prev = null;
  }

  /** Stop every timer (quitting). */
  dispose(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#pending.clear();
  }

  #schedule(kind: NoticeKind, ms: number): void {
    const t = setTimeout(() => this.#flush(kind), ms);
    t.unref?.();
    this.#timers.set(kind, t);
  }

  #flush(kind: NoticeKind): void {
    this.#timers.delete(kind);
    const items = this.#pending.get(kind) ?? [];
    if (!items.length) return;
    // The user is looking at the app now (or switched notifications off): nothing to tell.
    if (!this.#d.enabled() || this.#d.windowInFront()) {
      this.#pending.delete(kind);
      return;
    }
    const now = this.#d.now();
    const last = this.#lastShown.get(kind);
    if (last !== undefined && now - last < this.#d.rateLimitMs) {
      this.#schedule(kind, last + this.#d.rateLimitMs - now);
      return;
    }
    this.#pending.delete(kind);
    this.#lastShown.set(kind, now);
    this.#d.show(groupNotice(kind, items, now));
  }
}
