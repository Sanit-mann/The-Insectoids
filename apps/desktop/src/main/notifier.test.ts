import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoticeModel } from '@insectoids/shared';
import { type NoticeSnapshot, Notifier, decide, groupNotice } from './notifier';

type Approval = NoticeSnapshot['approvals'][number];
type Goal = NoticeSnapshot['goals'][number];
type Cadence = NoticeSnapshot['cadences'][number];
type Outcome = NonNullable<Cadence['lastRun']>['outcome'];

const approval = (id: string, title = `Approve the plan for ${id}`, status: Approval['status'] = 'waiting'): Approval =>
  ({ id, goalId: null, kind: 'plan', title, from: 'Queen', whyItNeedsYou: 'The Queen made a plan.', ifYouSayYes: '', destructive: false, status, createdAt: 1, decidedAt: null }) as Approval;
const goal = (id: string, status: Goal['status']): Goal => ({ id, title: `Goal ${id}`, status }) as Goal;
const cadence = (id: string, run: { id: string; outcome: Outcome; message?: string } | null, builtIn = false): Cadence =>
  ({
    id,
    name: `Cadence ${id}`,
    builtIn,
    enabled: true,
    lastRun: run ? { id: run.id, cadenceId: id, at: 1, reason: 'schedule', outcome: run.outcome, goalId: null, message: run.message ?? `${run.outcome}.` } : null,
  }) as Cadence;

function snap(p: Partial<NoticeSnapshot> = {}): NoticeSnapshot {
  return { project: { path: '/p' } as NoticeSnapshot['project'], approvals: [], goals: [], cadences: [], activity: [], ...p };
}

const away = { enabled: true, windowInFront: false };

describe('decide: what notifies (05-D8)', () => {
  it('a new waiting approval notifies, aimed at Approvals', () => {
    const out = decide(snap(), snap({ approvals: [approval('a1')] }), 0, away);
    expect(out).toEqual([{ kind: 'approval', title: 'Approve the plan for a1', body: 'The Queen made a plan.', target: { screen: 'approvals', goalId: null } }]);
  });

  it('an approval that was already waiting, or one decided, does not', () => {
    expect(decide(snap({ approvals: [approval('a1')] }), snap({ approvals: [approval('a1')] }), 0, away)).toEqual([]);
    expect(decide(snap(), snap({ approvals: [approval('a2', 'x', 'approved')] }), 0, away)).toEqual([]);
  });

  it('a goal that became stuck notifies with its reason, aimed at the Queen and that goal', () => {
    const next = snap({
      goals: [goal('g1', 'stuck')],
      activity: [{ id: 'x', at: 1, type: 'goal-stuck', goalId: 'g1', cardId: null, agentId: null, message: 'The Queen could not produce a valid plan.' }],
    });
    const [n] = decide(snap({ goals: [goal('g1', 'running')] }), next, 0, away);
    expect(n).toEqual({ kind: 'failure', title: 'Stuck: Goal g1', body: 'The Queen could not produce a valid plan.', target: { screen: 'queen', goalId: 'g1' } });
    expect(decide(next, next, 0, away)).toEqual([]);
  });

  it('a failed run of a user cadence or a built-in job notifies, aimed at Cadence', () => {
    const prev = snap({ cadences: [cadence('c1', { id: 'r1', outcome: 'started' }), cadence('maint-backup', null, true)] });
    const next = snap({ cadences: [cadence('c1', { id: 'r2', outcome: 'failed', message: 'No engine is ready.' }), cadence('maint-backup', { id: 'r3', outcome: 'failed' }, true)] });
    const out = decide(prev, next, 0, away);
    expect(out.map((n) => [n.kind, n.title, n.target.screen])).toEqual([
      ['failure', 'Cadence c1 failed', 'cadence'],
      ['failure', 'Cadence maint-backup failed', 'cadence'],
    ]);
    expect(out[0]!.body).toBe('No engine is ready.');
    // The same failed run again is not news.
    expect(decide(next, next, 0, away)).toEqual([]);
  });

  it('stays quiet for done goals, and for started, skipped, deferred, refused, noted runs and maintenance done', () => {
    const prev = snap({ goals: [goal('g1', 'running')], cadences: ['started', 'skipped', 'deferred', 'refused', 'noted', 'done'].map((o, i) => cadence(`c${i}`, null, o === 'done')) });
    const next = snap({
      goals: [goal('g1', 'done'), goal('g2', 'cancelled')],
      cadences: (['started', 'skipped', 'deferred', 'refused', 'noted', 'done'] as const).map((o, i) => cadence(`c${i}`, { id: `r${i}`, outcome: o }, o === 'done')),
    });
    expect(decide(prev, next, 0, away)).toEqual([]);
  });

  it('the first snapshot is a baseline, and so is a project switch', () => {
    expect(decide(null, snap({ approvals: [approval('a1')], goals: [goal('g', 'stuck')] }), 0, away)).toEqual([]);
    const other = snap({ project: { path: '/other' } as NoticeSnapshot['project'], approvals: [approval('a1')] });
    expect(decide(snap(), other, 0, away)).toEqual([]);
  });

  it('nothing while the window is in front, nor when switched off', () => {
    const next = snap({ approvals: [approval('a1')] });
    expect(decide(snap(), next, 0, { enabled: true, windowInFront: true })).toEqual([]);
    expect(decide(snap(), next, 0, { enabled: false, windowInFront: false })).toEqual([]);
  });
});

describe('groupNotice', () => {
  it('one approval keeps its title; several say how many', () => {
    const items = decide(snap(), snap({ approvals: [approval('a1'), approval('a2'), approval('a3')] }), 0, away);
    expect(groupNotice('approval', items.slice(0, 1), 5).title).toBe('Approve the plan for a1');
    const g = groupNotice('approval', items, 5);
    expect(g).toMatchObject({ kind: 'approval', title: '3 things wait for you', target: { screen: 'approvals', goalId: null }, at: 5 });
    expect(g.body).toContain('Approve the plan for a1');
  });
});

describe('Notifier: calm (grouped, one per kind a minute)', () => {
  let shown: NoticeModel[];
  let front: boolean;
  let enabled: boolean;
  const make = (): Notifier => new Notifier({ show: (n) => shown.push(n), enabled: () => enabled, windowInFront: () => front });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    shown = [];
    front = false;
    enabled = true;
  });
  afterEach(() => vi.useRealTimers());

  it('baselines on the first snapshot and after a rebaseline (a Brain restart)', () => {
    const n = make();
    n.observe(snap({ approvals: [approval('a1')] }));
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual([]);
    n.rebaseline();
    n.observe(snap({ approvals: [approval('a1'), approval('a2')] }));
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual([]);
    n.observe(snap({ approvals: [approval('a1'), approval('a2'), approval('a3')] }));
    vi.advanceTimersByTime(5_000);
    expect(shown.map((s) => s.title)).toEqual(['Approve the plan for a3']);
  });

  it('changes within a few seconds become one notification', () => {
    const n = make();
    n.observe(snap());
    n.observe(snap({ approvals: [approval('a1')] }));
    vi.advanceTimersByTime(1_000);
    n.observe(snap({ approvals: [approval('a1'), approval('a2')] }));
    vi.advanceTimersByTime(2_500);
    expect(shown.map((s) => s.title)).toEqual(['2 things wait for you']);
  });

  it('at most one per kind a minute; later ones are folded into the next', () => {
    const n = make();
    n.observe(snap());
    n.observe(snap({ approvals: [approval('a1')] }));
    vi.advanceTimersByTime(3_000);
    expect(shown).toHaveLength(1);
    n.observe(snap({ approvals: [approval('a1'), approval('a2')] }));
    vi.advanceTimersByTime(10_000);
    n.observe(snap({ approvals: [approval('a1'), approval('a2'), approval('a3')] }));
    // A failure is another kind: it is not held back by the approval's minute.
    n.observe(snap({ approvals: [approval('a1'), approval('a2'), approval('a3')], goals: [goal('g1', 'stuck')] }));
    vi.advanceTimersByTime(5_000);
    expect(shown.map((s) => s.title)).toEqual(['Approve the plan for a1', 'Stuck: Goal g1']);
    vi.advanceTimersByTime(45_000);
    expect(shown.map((s) => s.title)).toEqual(['Approve the plan for a1', 'Stuck: Goal g1', '2 things wait for you']);
    const last = shown[2]!;
    expect(last.at - shown[0]!.at).toBeGreaterThanOrEqual(60_000);
  });

  it('nothing while the window is in front, and coming to the front drops what was waiting', () => {
    const n = make();
    n.observe(snap());
    front = true;
    n.observe(snap({ approvals: [approval('a1')] }));
    vi.advanceTimersByTime(5_000);
    front = false;
    n.observe(snap({ approvals: [approval('a1'), approval('a2')] }));
    front = true;
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual([]);
  });

  it('nothing when switched off, and turning it on does not dump old items', () => {
    const n = make();
    enabled = false;
    n.observe(snap());
    n.observe(snap({ approvals: [approval('a1')] }));
    vi.advanceTimersByTime(5_000);
    enabled = true;
    n.observe(snap({ approvals: [approval('a1')] }));
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual([]);
  });
});
