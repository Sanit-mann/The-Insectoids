/**
 * The "while you were away" digest (Cadence 05-D8; Phase 3 B1): what the hive did on its own since the user last
 * read it. A plain function over the Brain, so it is tested without a running hive.
 *
 * Unattended = cadence runs the user didn't start (every reason but `manual`), on the open project's cadences and
 * the built-in maintenance jobs. Runs of a cadence that was deleted since are left out (there is no name to show).
 */
import type { ApprovalItem, Brain, Cadence, CadenceRun, Goal } from '@insectoids/brain';
import { type ApprovalView, type DigestCadence, type DigestGoal, type DigestView, MAINTENANCE_JOB_ORDER } from '@insectoids/shared';
import { isBuiltIn } from './cadence-keeper';

export interface DigestInput {
  brain: Brain;
  /** The moment the user last read the digest (or the first start); runs after it count. */
  since: number;
  until: number;
  /** The open project's shelf, or null when none is open. */
  shelf: string | null;
  /** Every waiting approval, when the caller already read them (the snapshot does); else they are read here. */
  waiting?: ApprovalItem[];
}

const MAX_LINES = 5;
const MAX_WAITING_ITEMS = 5;
const OPEN: ReadonlySet<Goal['status']> = new Set(['planning', 'awaiting_approval', 'running']);
const PROBLEM: ReadonlySet<CadenceRun['outcome']> = new Set(['failed', 'refused', 'skipped', 'deferred']);
const BAD_LINE: ReadonlySet<CadenceRun['outcome']> = new Set(['failed', 'refused', 'declined']);
const SKIPPED_TOO = '; its next runs are skipped until then.';

/** "1 run", "3 runs". */
const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const money = (usd: number): string => (usd < 0.005 ? 'under $0.01' : `$${usd.toFixed(2)}`);

export function buildDigest(i: DigestInput): DigestView {
  const { brain, since, until, shelf } = i;
  const cadences = new Map<string, Cadence | null>();
  const cadenceOf = (id: string): Cadence | null => {
    if (!cadences.has(id)) cadences.set(id, brain.cadences.get(id) ?? null);
    return cadences.get(id)!;
  };
  // Which runs count: unattended, after `since`, on a cadence that still exists and is the open project's or built in.
  const runs = brain.cadences.runsSince(since, { excludeReasons: ['manual'] }).filter((r) => {
    if (r.at > until) return false;
    const c = cadenceOf(r.cadenceId);
    return c !== null && (isBuiltIn(c) || (shelf !== null && c.shelf === shelf));
  });

  const waitingAll = i.waiting ?? brain.approvals.list({ status: 'waiting' });
  const goalCache = new Map<string, Goal | null>();
  const goalOf = (id: string): Goal | null => {
    if (!goalCache.has(id)) goalCache.set(id, brain.goals.get(id) ?? null);
    return goalCache.get(id)!;
  };

  // Group by cadence (runs come newest first, so each group's first run is its latest activity).
  const groups = new Map<string, CadenceRun[]>();
  for (const r of runs) {
    const g = groups.get(r.cadenceId);
    if (g) g.push(r);
    else groups.set(r.cadenceId, [r]);
  }

  const user: Array<{ view: DigestCadence; latest: number }> = [];
  const jobs: DigestCadence[] = [];
  for (const [id, rs] of groups) {
    const c = cadenceOf(id)!;
    const builtIn = isBuiltIn(c);
    const outcomes: Record<string, number> = {};
    for (const r of rs) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    const goalIds = [...new Set(rs.filter((r) => r.outcome === 'started' && r.goalId).map((r) => r.goalId!))];
    const goals = goalIds
      .map((gid) => goalOf(gid))
      .filter((g): g is Goal => g !== null)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map((g) => digestGoal(brain, g, waitingAll));
    const view: DigestCadence = { cadenceId: c.id, name: c.name, builtIn, outcomes, goals, lines: notableLines(rs, builtIn) };
    if (builtIn) jobs.push(view);
    else user.push({ view, latest: rs[0]!.at });
  }
  const jobOrder = (v: DigestCadence): number => {
    const c = cadenceOf(v.cadenceId);
    return c?.when.type === 'maintenance' ? MAINTENANCE_JOB_ORDER.indexOf(c.when.job) : MAINTENANCE_JOB_ORDER.length;
  };
  jobs.sort((a, b) => jobOrder(a) - jobOrder(b));
  const ordered = [...user.sort((a, b) => b.latest - a.latest).map((u) => u.view), ...jobs];

  // Totals over the goals this period's runs started, and the runs themselves.
  const allGoals = ordered.flatMap((c) => c.goals);
  const userRuns = runs.filter((r) => !isBuiltIn(cadenceOf(r.cadenceId)!));
  const jobRuns = runs.filter((r) => isBuiltIn(cadenceOf(r.cadenceId)!));
  const totals: DigestView['totals'] = {
    runs: userRuns.filter((r) => r.outcome === 'started').length,
    goalsDone: allGoals.filter((g) => g.status === 'done').length,
    goalsFailed: allGoals.filter((g) => g.status === 'stuck' || g.status === 'cancelled').length,
    goalsOpen: allGoals.filter((g) => OPEN.has(g.status)).length,
    problems: runs.filter((r) => PROBLEM.has(r.outcome)).length,
    jobs: jobRuns.length,
    tokens: allGoals.reduce((s, g) => s + g.spentTokens, 0),
    costUsd: allGoals.reduce((s, g) => s + g.spentUsd, 0),
  };

  // Everything waiting for the user now (not only from this period), as the Approvals screen shows it: the open
  // project's and those that belong to no goal.
  const visible = waitingAll.filter((a) => a.goalId === null || (shelf !== null && goalOf(a.goalId)?.shelf === shelf));
  const byKind: Record<string, number> = {};
  for (const a of visible) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  const waiting: DigestView['waiting'] = {
    total: visible.length,
    byKind,
    items: [...visible].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, MAX_WAITING_ITEMS).map(approvalView),
  };

  const unseen = userRuns.length > 0 || jobRuns.some((r) => r.outcome === 'failed');
  const headline = headlineFor({ userRuns, jobRuns, goals: allGoals, totals, waitingTotal: waiting.total });
  return { since, until, unseen, headline, totals, cadences: ordered, waiting };
}

/** As the snapshot builds it. */
export function approvalView(a: ApprovalItem): ApprovalView {
  return {
    id: a.id, goalId: a.goalId, kind: a.kind, title: a.title, from: a.from, whyItNeedsYou: a.whyItNeedsYou,
    ifYouSayYes: a.ifYouSayYes, destructive: a.destructive, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt,
  };
}

/** A goal a cadence started, as it stands now, in words. */
function digestGoal(brain: Brain, g: Goal, waitingAll: ApprovalItem[]): DigestGoal {
  const base = { goalId: g.id, title: g.title, status: g.status, spentTokens: g.spentTokens, spentUsd: g.spentUsd, startedAt: g.createdAt };
  // While a goal is open, the user's yes is what it may wait for (the same order as the cadence keeper's words).
  const kinds = OPEN.has(g.status) ? new Set(waitingAll.filter((a) => a.goalId === g.id).map((a) => a.kind)) : new Set<string>();
  const waitingFor: DigestGoal['waitingFor'] = kinds.has('plan') ? 'plan' : kinds.has('merge') ? 'merge' : kinds.size ? 'approval' : null;
  // An open cadence goal holds back its cadence's next runs (they are skipped while it goes on), so say so.
  if (waitingFor === 'plan') return { ...base, waitingFor, outcome: `Waiting for you to approve its plan${SKIPPED_TOO}` };
  if (waitingFor === 'merge') return { ...base, waitingFor, outcome: `Waiting for you to approve its merge${SKIPPED_TOO}` };
  if (waitingFor === 'approval') return { ...base, waitingFor, outcome: `Waiting for your answer in Approvals${SKIPPED_TOO}` };
  return { ...base, waitingFor: null, outcome: settledWords(brain, g) };
}

function settledWords(brain: Brain, g: Goal): string {
  switch (g.status) {
    case 'planning':
      return 'The Queen is still planning it.';
    case 'awaiting_approval':
    case 'running':
      return 'Still running.';
    case 'done': {
      const merges = brain.approvals.list({ goalId: g.id }).filter((a) => a.kind === 'merge' && (a.payload as { action?: unknown } | null)?.action === 'merge-goal');
      if (merges.some((a) => a.status === 'approved')) return 'Done and merged.';
      if (merges.some((a) => a.status === 'denied')) return 'Done; you chose not to merge it.';
      return 'Done.';
    }
    case 'stuck': {
      const failed = brain.taskboard.list({ goalId: g.id, status: 'failed' })[0];
      return failed ? `Stuck: the card "${failed.title}" failed after all its attempts.` : 'Stuck: the Queen needs to re-plan it with you.';
    }
    case 'cancelled': {
      const plan = brain.approvals.list({ goalId: g.id }).find((a) => a.kind === 'plan' && a.status === 'denied');
      return plan ? 'Cancelled: you said no to its plan.' : 'Cancelled.';
    }
  }
}

/** Up to five run lines worth reading: failures first, then what maintenance did, then the rest; newest first in each. */
function notableLines(rs: CadenceRun[], builtIn: boolean): DigestCadence['lines'] {
  const rank = (r: CadenceRun): number => (BAD_LINE.has(r.outcome) ? 0 : builtIn && r.outcome === 'done' ? 1 : 2);
  return [...rs]
    .sort((a, b) => rank(a) - rank(b) || b.at - a.at)
    .slice(0, MAX_LINES)
    .map((r) => ({ at: r.at, outcome: r.outcome, message: r.message }));
}

/** One plain line, or null when nothing happened. */
function headlineFor(h: { userRuns: CadenceRun[]; jobRuns: CadenceRun[]; goals: DigestGoal[]; totals: DigestView['totals']; waitingTotal: number }): string | null {
  const { userRuns, jobRuns, goals, totals } = h;
  if (!userRuns.length && !jobRuns.length) return null;
  const jobsFailed = jobRuns.filter((r) => r.outcome === 'failed').length;
  if (!userRuns.length) {
    const ran = `housekeeping ran ${count(jobRuns.length, 'time')}`;
    if (jobsFailed) return `While you were away: ${ran}, ${jobsFailed} failed.`;
    return h.waitingTotal
      ? `While you were away: ${ran}; ${count(h.waitingTotal, 'thing')} ${h.waitingTotal === 1 ? 'waits' : 'wait'} for you in Approvals.`
      : `While you were away: ${ran}; nothing needs you.`;
  }
  const by = (o: CadenceRun['outcome']): number => userRuns.filter((r) => r.outcome === o).length;
  const waits = goals.filter((g) => g.waitingFor !== null).length;
  const going = goals.filter((g) => OPEN.has(g.status) && g.waitingFor === null).length;
  const stuck = goals.filter((g) => g.status === 'stuck').length;
  const cancelled = goals.filter((g) => g.status === 'cancelled').length;
  const calls = by('waiting');
  const parts = [
    totals.runs ? count(totals.runs, 'run') : '',
    totals.goalsDone ? `${totals.goalsDone} done` : '',
    waits ? `${waits} ${waits === 1 ? 'waits' : 'wait'} for you` : '',
    going ? `${going} still going` : '',
    stuck ? `${stuck} stuck` : '',
    cancelled ? `${cancelled} cancelled` : '',
    by('failed') ? `${count(by('failed'), 'run')} couldn't start` : '',
    by('skipped') + by('deferred') ? `${count(by('skipped') + by('deferred'), 'run')} skipped or put off` : '',
    calls ? `${count(calls, 'webhook call')} ${calls === 1 ? 'waits' : 'wait'} for you` : '',
    by('refused') ? `${count(by('refused'), 'webhook call')} turned away` : '',
    by('noted') ? `${count(by('noted'), 'note')} saved` : '',
    by('declined') ? `${count(by('declined'), 'webhook call')} declined` : '',
    jobsFailed ? `${count(jobsFailed, 'housekeeping job')} failed` : '',
  ].filter(Boolean);
  if (!parts.length) parts.push(count(userRuns.length, 'run'));
  const spend = totals.tokens > 0 ? ` ${count(totals.tokens, 'token')}${totals.costUsd > 0 ? ` (${money(totals.costUsd)})` : ''}.` : '';
  return `While you were away: ${parts.join(', ')}.${spend}`;
}
