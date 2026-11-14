import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Brain, openBrain } from '@insectoids/brain';
import { type CadenceInput, CadenceInputSchema, CadenceProposalPayloadSchema, DEFAULT_CADENCE_BUDGET_TOKENS } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CadenceProposer } from '../brain-host/cadence-proposals';

/** Cadence proposals (Cadence 05-D3; Phase 3 A5): the Queen spots a request the user keeps making. */

/** Local wall-clock times, so the tests hold in any time zone. 10 Nov 2026 is a Tuesday. */
const at = (mo: number, d: number, h = 9, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime();
const SHELF = 'project:site';

let root: string;
let brain: Brain;
let clock: number;
let created: Array<{ input: CadenceInput; shelf: string }>;
let notes: string[];
let changed: number;
let createCadence: (input: CadenceInput, shelf: string) => void;
let proposer: CadenceProposer;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-cadence-proposals-'));
  clock = at(11, 1);
  brain = openBrain(join(root, 'brain.db'), { now: () => clock });
  created = [];
  notes = [];
  changed = 0;
  createCadence = (input, shelf) => {
    created.push({ input, shelf });
    brain.cadences.create({ ...CadenceInputSchema.parse(input), shelf, nextRunAt: null });
  };
  proposer = new CadenceProposer({
    brain,
    now: () => clock,
    createCadence: (input, shelf) => createCadence(input, shelf),
    note: (t) => notes.push(t),
    changed: () => changed++,
  });
});

afterEach(() => {
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The user submits a goal at a time (or a cadence starts one). */
function ask(text: string, t: number, o: { shelf?: string; cadenceId?: string } = {}): string {
  clock = t;
  const g = brain.goals.create({ title: text.slice(0, 80), text, shelf: o.shelf ?? SHELF, ...(o.cadenceId ? { cadenceId: o.cadenceId } : {}) });
  if (!o.cadenceId) proposer.goalSubmitted(g.id);
  return g.id;
}

const proposals = () => brain.approvals.list().filter((a) => proposer.owns(a.id));
const payloadOf = (id: string) => CadenceProposalPayloadSchema.parse(brain.approvals.get(id)!.payload);

/** The same request on three mornings, worded differently each time. */
function threeMornings(): string[] {
  return [
    ask('Summarise the open GitHub issues and post the summary in notes', at(11, 10, 9, 5)),
    ask('Write a summary of the open issues on GitHub', at(11, 11, 9, 20)),
    ask("Please summarize today's open GitHub issues", at(11, 12, 8, 50)),
  ];
}

describe('cadence proposals', () => {
  it('proposes a cadence after three similar requests, worded differently', () => {
    const ids = threeMornings();
    const [a] = proposals();
    expect(proposals()).toHaveLength(1);
    expect(a!.kind).toBe('schedule');
    expect(a!.from).toBe('Queen');
    expect(a!.status).toBe('waiting');
    expect(a!.title).toBe(`Make a cadence for "Please summarize today's open GitHub issues"?`);
    expect(a!.whyItNeedsYou).toBe('You asked for this 3 times (Tue 10 Nov, Wed 11 Nov, Thu 12 Nov). A cadence would run it every day at 09:00 without you asking.');
    expect(a!.ifYouSayYes).toBe('It becomes a cadence that runs every day at 09:00. You can change or switch it off on the Cadence screen.');
    const p = payloadOf(a!.id);
    expect(p.shelf).toBe(SHELF);
    expect(p.goalIds).toEqual(ids);
    expect(p.cadence).toEqual({
      name: "Please summarize today's open GitHub issues",
      when: { type: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' },
      goal: "Please summarize today's open GitHub issues",
      budgetTokens: DEFAULT_CADENCE_BUDGET_TOKENS,
      autonomy: 'small-plans',
      enabled: true,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('It waits for your OK in Approvals.');
    expect(changed).toBe(1);
  });

  it('needs three: two similar requests propose nothing', () => {
    ask('Summarise the open GitHub issues', at(11, 10));
    ask('Write a summary of the open issues on GitHub', at(11, 11));
    expect(proposals()).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it("doesn't count goals a cadence started, other projects' goals, or unrelated goals", () => {
    ask('Summarise the open GitHub issues', at(11, 10));
    ask('Summarise the open GitHub issues', at(11, 11), { cadenceId: 'C-1' });
    ask('Summarise the open GitHub issues', at(11, 11, 12), { shelf: 'project:other' });
    ask('Fix the login bug on the settings page', at(11, 11, 14));
    ask('Write a summary of the open issues on GitHub', at(11, 12));
    expect(proposals()).toHaveLength(0);
  });

  it('treats a burst within an hour as one occasion (a retry, not a habit)', () => {
    ask('Summarise the open GitHub issues', at(11, 12, 9));
    ask('Summarise the open GitHub issues', at(11, 12, 9, 15));
    ask('Summarise the open GitHub issues', at(11, 12, 9, 40));
    expect(proposals()).toHaveLength(0);
  });

  it('proposes nothing when a cadence in the project already does it', () => {
    brain.cadences.create({
      name: 'Issue summary',
      when: { type: 'weekly', days: [1], time: '09:00' },
      goal: 'Summarise the open GitHub issues',
      budgetTokens: DEFAULT_CADENCE_BUDGET_TOKENS,
      autonomy: 'small-plans',
      enabled: true,
      shelf: SHELF,
      nextRunAt: null,
    });
    threeMornings();
    expect(proposals()).toHaveLength(0);
  });

  it('guesses a weekly schedule from requests a week apart', () => {
    ask('Draft the weekly status report for the team', at(10, 26, 16, 10));
    ask('Draft the status report for the team', at(11, 2, 15, 50));
    ask('Draft the team status report', at(11, 9, 16, 5));
    const p = payloadOf(proposals()[0]!.id);
    expect(p.cadence.when).toEqual({ type: 'weekly', days: [1], time: '16:00' });
    expect(brain.approvals.get(proposals()[0]!.id)!.whyItNeedsYou).toContain('(Mon 26 Oct, Mon 2 Nov, Mon 9 Nov)');
    expect(brain.approvals.get(proposals()[0]!.id)!.whyItNeedsYou).toContain('every Monday at 16:00');
  });

  it('yes creates the cadence from the payload and approves; the same request is never proposed again', () => {
    threeMornings();
    const [a] = proposals();
    proposer.decide(a!.id, true);
    expect(created).toEqual([{ input: payloadOf(a!.id).cadence, shelf: SHELF }]);
    expect(brain.approvals.get(a!.id)!.status).toBe('approved');
    expect(brain.approvals.get(a!.id)!.decidedBy).toBe('user');
    expect(notes.at(-1)).toContain('Made the cadence');
    // Even with the cadence removed, the approved proposal is the memory.
    for (const c of brain.cadences.list()) brain.cadences.delete(c.id);
    ask('Summarise the open GitHub issues', at(11, 13));
    expect(proposals()).toHaveLength(1);
  });

  it('no marks it denied and never proposes the same request again', () => {
    threeMornings();
    const [a] = proposals();
    proposer.decide(a!.id, false);
    expect(brain.approvals.get(a!.id)!.status).toBe('denied');
    expect(created).toHaveLength(0);
    expect(notes.at(-1)).toBe("Okay, I won't propose it again.");
    ask('Summarise the open GitHub issues please', at(11, 13));
    ask('Write a summary of the open issues on GitHub', at(11, 14));
    expect(proposals()).toHaveLength(1);
    // A different request is still proposed when it repeats.
    ask('Draft the team status report', at(11, 15));
    ask('Draft the status report for the team', at(11, 16));
    ask('Draft the team status report', at(11, 17));
    expect(proposals()).toHaveLength(2);
  });

  it('when creating the cadence fails, the error reaches the caller and the approval stays waiting', () => {
    threeMornings();
    const [a] = proposals();
    createCadence = () => {
      throw new Error('A cadence called that already exists.');
    };
    expect(() => proposer.decide(a!.id, true)).toThrow('A cadence called that already exists.');
    expect(brain.approvals.get(a!.id)!.status).toBe('waiting');
  });

  it('owns only cadence proposals, and refuses to decide twice', () => {
    const other = brain.approvals.create({ kind: 'schedule', title: 'Something else', from: 'Queen', whyItNeedsYou: 'x', ifYouSayYes: 'y', payload: { action: 'other' } });
    expect(proposer.owns(other.id)).toBe(false);
    expect(proposer.owns('A-missing')).toBe(false);
    threeMornings();
    const [a] = proposals();
    proposer.decide(a!.id, false);
    expect(proposer.owns(a!.id)).toBe(true);
    expect(() => proposer.decide(a!.id, true)).toThrow('already decided');
  });
});
