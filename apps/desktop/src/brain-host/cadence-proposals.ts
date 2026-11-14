import type { ApprovalItem, Brain } from '@insectoids/brain';
import { type AskedGoal, findRepeatedRequest, guessSchedule, requestWords, sameRequest, whenText } from '@insectoids/harness';
import {
  CADENCE_PROPOSAL_MIN_REPEATS,
  type CadenceInput,
  type CadenceProposalPayload,
  CadenceProposalPayloadSchema,
  DEFAULT_CADENCE_BUDGET_TOKENS,
} from '@insectoids/shared';

/**
 * Cadence proposals (Cadence 05-D3; Phase 3 A5). When the user asks for much the same goal on
 * CADENCE_PROPOSAL_MIN_REPEATS or more occasions in one project, the Queen proposes a cadence in Approvals
 * (kind `schedule`). Nothing exists until the user says yes. Every proposal stays in the approvals table, and its
 * `key` is the memory: a request that was proposed once (waiting, approved or denied) is never proposed again.
 */
export const QUEEN = 'Queen';
const NAME_MAX = 60;
const LISTED_DATES = 5;

export interface CadenceProposerDeps {
  brain: Brain;
  now: () => number;
  /** Makes the cadence (the host's normal path). May throw a plain-words Error. */
  createCadence: (input: CadenceInput, shelf: string) => void;
  /** One Queen activity line. */
  note: (text: string) => void;
  /** Something the screens show changed (a new or decided approval). */
  changed: () => void;
  log?: (line: string) => void;
  /** Asks this close together count as one occasion (default one hour; e2e passes 0 so three quick asks count). */
  retryWindowMs?: number;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Mon 10 Nov", local time. */
const dayText = (t: number): string => {
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const keyOf = (shelf: string, words: readonly string[]): string => `${shelf}|${words.join(' ')}`.slice(0, 500);
const keyWords = (key: string): Set<string> => new Set(key.slice(key.lastIndexOf('|') + 1).split(' ').filter(Boolean));

export class CadenceProposer {
  constructor(private readonly d: CadenceProposerDeps) {}

  /** After a USER goal was submitted (the host never calls it for cadence-started goals). Never throws. */
  goalSubmitted(goalId: string): void {
    try {
      this.#consider(goalId);
    } catch (err) {
      this.d.log?.(`cadence proposal for ${goalId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Whether an approval is a cadence proposal (this class decides it, whatever its status). */
  owns(approvalId: string): boolean {
    const a = this.d.brain.approvals.get(approvalId);
    return Boolean(a && isProposal(a));
  }

  /**
   * Yes: create the cadence (createCadence may throw a plain-words Error; it propagates and the approval stays
   * waiting). No: mark it denied; the same request is never proposed again.
   */
  decide(approvalId: string, approve: boolean): void {
    const { brain } = this.d;
    const a = brain.approvals.get(approvalId);
    if (!a) throw new Error(`No approval ${approvalId}`);
    if (!isProposal(a)) throw new Error('This is not a cadence proposal.');
    if (a.status !== 'waiting') throw new Error('This was already decided.');
    if (approve) {
      const parsed = CadenceProposalPayloadSchema.safeParse(a.payload);
      if (!parsed.success) throw new Error("This proposal's details are damaged, so no cadence can be made from it. Say no and make it on the Cadence screen.");
      const p = parsed.data;
      this.d.createCadence(p.cadence, p.shelf);
      brain.approvals.decide(approvalId, 'approved', { type: 'user' });
      this.d.note(`Made the cadence "${p.cadence.name}". It runs ${lowerFirst(whenText(p.cadence.when))}. You can change or switch it off on the Cadence screen.`);
    } else {
      brain.approvals.decide(approvalId, 'denied', { type: 'user' });
      this.d.note("Okay, I won't propose it again.");
    }
    this.d.changed();
  }

  #consider(goalId: string): void {
    const { brain } = this.d;
    const goal = brain.goals.get(goalId);
    if (!goal || goal.cadenceId !== null) return;
    const shelf = goal.shelf;
    const earlier: AskedGoal[] = brain.goals.list().filter((g) => g.shelf === shelf && g.cadenceId === null && g.id !== goal.id);
    const found = findRepeatedRequest(goal, earlier, { now: this.d.now(), minRepeats: CADENCE_PROPOSAL_MIN_REPEATS, ...(this.d.retryWindowMs === undefined ? {} : { retryWindowMs: this.d.retryWindowMs }) });
    if (!found) return;
    const mine = requestWords(`${goal.title}\n${goal.text}`);
    const key = keyOf(shelf, found.words);

    // A cadence in this project already does it.
    if (brain.cadences.list(shelf).some((c) => sameRequest(mine, requestWords(`${c.name}\n${c.goal}`)))) return;
    // Proposed before (waiting, approved or denied): never again. The same key, or one about much the same words.
    const before = brain.approvals.list().filter(isProposal).map((a) => a.payload as Partial<CadenceProposalPayload>);
    if (before.some((p) => p.key === key || (p.shelf === shelf && typeof p.key === 'string' && sameRequest(mine, keyWords(p.key))))) return;

    const latest = found.goals.at(-1)!;
    const name = clip((latest.title || latest.text).replace(/\s+/g, ' ').trim(), NAME_MAX);
    const cadence: CadenceInput = {
      name,
      when: guessSchedule(found.occasions.map((g) => g.createdAt)),
      goal: latest.text.trim().slice(0, 8000),
      budgetTokens: DEFAULT_CADENCE_BUDGET_TOKENS,
      autonomy: 'small-plans',
      enabled: true,
    };
    const payload = CadenceProposalPayloadSchema.parse({
      action: 'cadence-proposal',
      key,
      cadence,
      shelf,
      goalIds: found.goals.slice(-50).map((g) => g.id),
    });
    const when = lowerFirst(whenText(payload.cadence.when));
    const n = found.occasions.length;
    const shown = found.occasions.slice(-LISTED_DATES).map((g) => dayText(g.createdAt));
    const dates = `${n > LISTED_DATES ? '…, ' : ''}${shown.join(', ')}`;
    brain.approvals.create({
      kind: 'schedule',
      title: `Make a cadence for "${name}"?`,
      from: QUEEN,
      whyItNeedsYou: `You asked for this ${n} times (${dates}). A cadence would run it ${when} without you asking.`,
      ifYouSayYes: `It becomes a cadence that runs ${when}. You can change or switch it off on the Cadence screen.`,
      payload,
    });
    this.d.note(`You've asked for "${name}" ${n} times, so I suggest a cadence that runs it ${when}. It waits for your OK in Approvals.`);
    this.d.changed();
  }
}

function isProposal(a: ApprovalItem): boolean {
  const p = a.payload as { action?: unknown } | null;
  return a.kind === 'schedule' && p !== null && typeof p === 'object' && p.action === 'cadence-proposal';
}
