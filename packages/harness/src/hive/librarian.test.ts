import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine, type FakeReply } from './engine';
import { Hive, type HiveEvent } from './hive';
import { type AuditSummary, applyLibrarianProposal, approvalFor, auditSummary, lessonFrom, librarianPrompt, parseLibrarianReply, summaryIsEmpty } from './librarian';
import { Library } from './prompts';

/** The Librarian (Phase 2 B3): lessons from failed work, the audit summary, and its strictly read review. */
const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const user = { type: 'user' } as const;
const ant = { type: 'agent', id: 'Ant-1' } as const;
const lib = { type: 'agent', id: 'Librarian' } as const;
const DAY = 86_400_000;

let root: string;
let repo: string;
let brain: Brain;
let ws: Workspace;
let events: HiveEvent[];
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-librarian-'));
  repo = join(root, 'project');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'user@example.com');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  clock = Date.now();
  brain = openBrain(':memory:', { now: () => clock });
  ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'worktrees') });
  events = [];
});

afterEach(async () => {
  await ws.dispose();
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeHive(engine: FakeEngine): Hive {
  return new Hive({
    brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
    models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: ['coder', 'tester'],
    leaseMs: 60_000, onEvent: (e) => events.push(e),
  });
}

const planReply = (): FakeReply => ({
  text: `\`\`\`json\n${JSON.stringify({ summary: 'Test plan', waves: [{ cards: [{ id: 'C-01', title: 'Add the signup form', brief: 'Do it', caste: 'coder', acceptance: ['works'] }] }] })}\n\`\`\``,
});

describe('lessons from failed work', () => {
  it('lessonFrom: "Don\'t … because …" from the card and the first sentence of the reason', () => {
    const l = lessonFrom({ title: 'Add the signup form' }, 'Email is not validated. Also the button is blue.');
    expect(l.title).toBe('Don\'t hand in "Add the signup form" as done because email is not validated');
    expect(l.body).toBe('Card: Add the signup form\nWhat the Inspector found: Email is not validated. Also the button is blue.');
  });

  it('a retried card leaves one lesson; failing again folds into it (seen goes up), escalation included', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply();
      if (req.role === 'inspector') return { text: 'VERDICT: FAIL: email is not validated' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'f.txt'), String(Math.random())) };
    });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('g');
    await hive.runUntilIdle();
    expect(brain.goals.get(goal.id)!.status).toBe('stuck');
    const lessons = brain.lessons('site');
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ kind: 'lesson', trust: 'unconfirmed', owner: 'Librarian', seen: 3, source: `${goal.id}.C-01` });
    expect(lessons[0]!.title).toMatch(/^Don't hand in "Add the signup form" as done because email is not validated$/);
    // The next brief carries it (boot card).
    expect(brain.bootCard('site')).toContain('Lessons (avoid these):\n- Don\'t hand in "Add the signup form"');
  });

  it('a reason with a secret in it never becomes a lesson, and the hive carries on', async () => {
    let n = 0;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply();
      if (req.role === 'inspector') return { text: ++n === 1 ? 'VERDICT: FAIL: it logs the key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' : 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'f.txt'), String(Math.random())) };
    });
    const hive = makeHive(engine);
    await hive.submitGoal('g');
    await hive.runUntilIdle();
    expect(brain.lessons('site')).toHaveLength(0);
    expect(events.some((e) => e.type === 'card-verified')).toBe(true);
  });
});

function summaryWith(): { summary: AuditSummary; ids: Record<string, string> } {
  const agentNote = brain.write({ kind: 'fact', shelf: 'site', title: 'Hosting', body: 'The site is hosted on Vercel in the EU region!' }, ant).id;
  const userNote = brain.write({ kind: 'fact', shelf: 'site', title: 'Hosting', body: 'The site is hosted on Vercel in the EU region.' }, user).id;
  const oldFact = brain.write({ kind: 'decision', shelf: 'site', title: 'Use Postgres', body: 'We store data in Postgres.' }, user).id;
  clock += 100 * DAY;
  const lesson = brain.learn({ shelf: 'site', title: "Don't skip tests because the Inspector runs them", body: 'Card: x' }, lib).id;
  const other = brain.learn({ shelf: 'site', title: "Don't commit build output because it bloats the repo", body: 'Card: y' }, lib).id;
  return { summary: auditSummary(brain, 'site', clock), ids: { agentNote, userNote, oldFact, lesson, other } };
}

const reply = (proposals: unknown[]) => `Here you go.\n\`\`\`json\n${JSON.stringify({ proposals })}\n\`\`\``;

describe('the audit summary and the review prompt', () => {
  it('lists user-involved near-duplicates, stale confirmed facts and waiting lessons', () => {
    const { summary, ids } = summaryWith();
    expect(summary.duplicates.map((p) => [p.a.id, p.b.id].sort())).toEqual([[ids.agentNote, ids.userNote].sort()]);
    expect(summary.staleFacts.map((r) => r.id)).toContain(ids.oldFact);
    expect(summary.lessons.map((r) => r.id).sort()).toEqual([ids.lesson, ids.other].sort());
    expect(summaryIsEmpty(summary)).toBe(false);
    const prompt = librarianPrompt(library, summary);
    expect(prompt.system).toMatch(/You change nothing yourself/);
    expect(prompt.task).toContain(ids.lesson!);
  });

  it('an empty Brain gives an empty summary', () => {
    expect(summaryIsEmpty(auditSummary(brain, 'site', clock))).toBe(true);
  });
});

describe('parseLibrarianReply: strict, ids from the audit only, at most 10', () => {
  it('keeps valid proposals of every type', () => {
    const { summary, ids } = summaryWith();
    const r = parseLibrarianReply(
      reply([
        { type: 'merge', keep: ids.userNote, fold: ids.agentNote, reason: 'Same fact twice.' },
        { type: 'supersede', old: ids.agentNote, new: ids.userNote, reason: 'The user wrote the newer one.' },
        { type: 'confirm', id: ids.lesson, reason: 'It explains a real failure.' },
        { type: 'archive', id: ids.oldFact, reason: 'Nobody has used it in months.' },
      ]),
      summary,
    );
    expect(r.error).toBeNull();
    expect(r.dropped).toBe(0);
    expect(r.proposals.map((p) => p.type)).toEqual(['merge', 'supersede', 'confirm', 'archive']);
  });

  it('drops unknown ids, wrong types for an id, extra keys, bad shapes and repeats', () => {
    const { summary, ids } = summaryWith();
    const r = parseLibrarianReply(
      reply([
        { type: 'confirm', id: 'r-made-up', reason: 'Looks good.' },
        { type: 'confirm', id: ids.oldFact, reason: 'Not a lesson.' },
        { type: 'merge', keep: ids.lesson, fold: ids.other, reason: 'Not a listed pair.' },
        { type: 'archive', id: ids.agentNote, reason: 'Not a confirmed stale fact.' },
        { type: 'confirm', id: ids.lesson, reason: 'Fine.', extra: true },
        { type: 'delete', id: ids.lesson, reason: 'Nothing is deleted.' },
        { type: 'confirm', id: ids.lesson },
        { type: 'confirm', id: ids.lesson, reason: 'Keep it.' },
        { type: 'confirm', id: ids.lesson, reason: 'Keep it again.' },
        { type: 'merge', keep: ids.agentNote, fold: ids.userNote, reason: 'Same pair.' },
        { type: 'merge', keep: ids.userNote, fold: ids.agentNote, reason: 'Same pair, flipped.' },
      ]),
      summary,
    );
    expect(r.proposals).toEqual([
      { type: 'confirm', id: ids.lesson, reason: 'Keep it.' },
      { type: 'merge', keep: ids.agentNote, fold: ids.userNote, reason: 'Same pair.' },
    ]);
    expect(r.dropped).toBe(9);
  });

  it('keeps at most 10', () => {
    const { summary } = summaryWith();
    // Twelve distinct valid proposals: the first ten are kept, the rest dropped.
    const big = { ...summary, lessons: Array.from({ length: 12 }, (_, i) => ({ ...summary.lessons[0]!, id: `L${i}` })) };
    const capped = parseLibrarianReply(reply(big.lessons.map((l) => ({ type: 'confirm', id: l.id, reason: 'Worth keeping.' }))), big);
    expect(capped.proposals).toHaveLength(10);
    expect(capped.dropped).toBe(2);
  });

  it('bad JSON or no list: no proposals and a plain error', () => {
    const { summary } = summaryWith();
    expect(parseLibrarianReply('All good {not json', summary)).toEqual({ proposals: [], dropped: 0, error: "The Librarian's reply was not valid JSON." });
    expect(parseLibrarianReply('```json\n{"ideas": []}\n```', summary)).toEqual({ proposals: [], dropped: 0, error: 'The Librarian\'s reply had no "proposals" list.' });
  });
});

describe('approvals and applying them', () => {
  it('a proposal becomes a plain approval from the Librarian; applying acts as the user', () => {
    const { ids } = summaryWith();
    const a = approvalFor({ type: 'merge', keep: ids.userNote!, fold: ids.agentNote!, reason: 'Same fact twice.' }, brain);
    expect(a).toMatchObject({ from: 'Librarian', kind: 'fact', title: 'Merge "Hosting" into "Hosting"', payload: { action: 'librarian' } });
    expect(a.ifYouSayYes).toMatch(/Nothing is deleted/);
    applyLibrarianProposal(brain, { type: 'merge', keep: ids.userNote!, fold: ids.agentNote!, reason: 'x' });
    expect(brain.get(ids.agentNote!)).toMatchObject({ archived: true, archivedReason: `merged into ${ids.userNote}` });
    applyLibrarianProposal(brain, { type: 'confirm', id: ids.lesson!, reason: 'x' });
    expect(brain.get(ids.lesson!)!.trust).toBe('confirmed');
    applyLibrarianProposal(brain, { type: 'archive', id: ids.oldFact!, reason: 'x' });
    expect(brain.get(ids.oldFact!)).toMatchObject({ archived: true, archivedReason: "archived on the Librarian's advice" });
  });

  it('the review run is read-only, has no goal, and its approval applies only on yes', async () => {
    const { summary, ids } = summaryWith();
    const engine = new FakeEngine((req) =>
      req.role === 'librarian' ? { text: reply([{ type: 'confirm', id: ids.lesson, reason: 'It explains a real failure.' }]) } : { text: '' },
    );
    const hive = makeHive(engine);
    const r = await hive.librarianReview(summary);
    expect(r).toMatchObject({ ok: true, dropped: 0, error: null });
    const call = engine.calls[0]!;
    expect(call).toMatchObject({ role: 'librarian', agentId: 'Librarian', route: { tier: 'standard', effort: 'low' } });
    expect(call.guard.network).toBe('none');
    const started = events.find((e) => e.type === 'run-started')!;
    expect(started.goalId).toBeUndefined();

    const yes = brain.approvals.create(approvalFor(r.proposals[0]!, brain));
    const no = brain.approvals.create(approvalFor({ type: 'confirm', id: ids.other!, reason: 'Also good.' }, brain));
    await hive.deny(no.id);
    expect(brain.get(ids.other!)!.trust).toBe('unconfirmed');
    await hive.approve(yes.id);
    expect(brain.get(ids.lesson!)!.trust).toBe('confirmed');
    expect(events.some((e) => e.type === 'librarian' && e.message.startsWith('Done: Keep the lesson'))).toBe(true);
  });
});
