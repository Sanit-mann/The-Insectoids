import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EngineRequest, FakeEngine, type FakeReply } from './engine';
import { Hive, type HiveEvent } from './hive';
import { Library } from './prompts';

const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let root: string;
let repo: string;
let brain: Brain;
let ws: Workspace;
let events: HiveEvent[];

const planReply = (waves: Array<Array<Record<string, unknown>>>): FakeReply => ({
  text: `Plan below.\n\`\`\`json\n${JSON.stringify({ summary: 'Test plan', waves: waves.map((cards) => ({ cards })) })}\n\`\`\``,
});
const card = (id: string, caste: 'coder' | 'tester', extra: Record<string, unknown> = {}) => ({
  id, title: `Card ${id}`, brief: `Do ${id}`, caste, acceptance: [`${id} works`], ...extra,
});
const cardOf = (req: EngineRequest): string => /# (?:Verify card|Card) (C-\d+)/.exec(req.task)?.[1] ?? '';

function makeHive(engine: FakeEngine, extra: Partial<ConstructorParameters<typeof Hive>[0]> = {}): Hive {
  return new Hive({
    brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
    models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: ['coder', 'tester'],
    leaseMs: 60_000, onEvent: (e) => events.push(e), ...extra,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-hive-'));
  repo = join(root, 'project');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'user@example.com');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  brain = openBrain(':memory:');
  ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'worktrees') });
  events = [];
});

afterEach(async () => {
  await ws.dispose();
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('one goal, end to end', () => {
  it('plans, builds in worktrees, verifies, and merges into main only after approval', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([[card('C-01', 'coder'), card('C-02', 'tester', { dependsOn: ['C-01'] })]]);
      if (req.role === 'inspector') return { text: 'Checked every item.\nVERDICT: PASS' };
      if (cardOf(req) === 'C-01') return { text: 'Built the form.\nSTATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'contact.js'), 'export const form = 1;\n') };
      return { text: 'Added tests.\nSTATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'contact.test.js'), 'test\n') };
    });
    const hive = makeHive(engine);

    const goal = await hive.submitGoal('Add a contact form with tests');
    expect(goal.status).toBe('running');
    await hive.runUntilIdle();

    expect(engine.calls.map((c) => `${c.role}:${cardOf(c)}`)).toEqual(['queen:', 'coder:C-01', 'inspector:C-01', 'tester:C-02', 'inspector:C-02']);
    expect(existsSync(join(repo, 'contact.js'))).toBe(false);

    const merge = brain.approvals.list({ status: 'waiting' }).find((a) => a.kind === 'merge')!;
    expect(merge).toBeTruthy();
    await hive.approve(merge.id);

    expect(read(join(repo, 'contact.js'))).toContain('form');
    expect(existsSync(join(repo, 'contact.test.js'))).toBe(true);
    expect(brain.goals.get(goal.id)).toMatchObject({ status: 'done' });
    expect(brain.goals.get(goal.id)!.spentTokens).toBeGreaterThan(0);
    expect(brain.search('verified', { shelf: 'site' }).length).toBe(2);
  });

  it('runs each insect in its own worktree with its own guard policy', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([[card('C-01', 'coder')]]);
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'x.txt'), 'x') };
    });
    await makeHive(engine).submitGoal('g');
    await makeHive(engine).runUntilIdle().catch(() => {});
    const coder = engine.calls.find((c) => c.role === 'coder')!;
    expect(coder.cwd).not.toBe(repo);
    expect(coder.guard).toMatchObject({ workspace: coder.cwd, network: 'docs' });
    expect(coder.route).toMatchObject({ model: 'sonnet', effort: 'medium' });
    const queen = engine.calls.find((c) => c.role === 'queen')!;
    expect(queen.route).toMatchObject({ model: 'opus', effort: 'high' });
    expect(queen.guard.workspace).not.toBe(repo);
  });
});

describe('big plans and waves (Hive 02-D5, D11)', () => {
  it('a plan with more than one wave waits for approval, then runs wave by wave', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([[card('C-01', 'coder')], [card('C-02', 'coder')]]);
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `${cardOf(req)}.txt`), 'ok') };
    });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Two-step goal');
    expect(goal.status).toBe('awaiting_approval');
    await hive.runUntilIdle();
    expect(engine.calls.filter((c) => c.role === 'coder')).toHaveLength(0);

    await hive.approve(brain.approvals.list({ status: 'waiting' }).find((a) => a.kind === 'plan')!.id);
    await hive.runUntilIdle();
    expect(engine.calls.filter((c) => c.role === 'coder').map(cardOf)).toEqual(['C-01', 'C-02']);
    expect(git(repo, 'show', `hive/${goal.id}:C-02.txt`)).toBe('ok');
  });

  it('a denied plan is cancelled and nothing runs', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([[card('C-01', 'coder')], [card('C-02', 'coder')]]) : { text: 'STATUS: DONE' }));
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('g');
    await hive.deny(brain.approvals.list({ status: 'waiting' })[0]!.id);
    await hive.runUntilIdle();
    expect(brain.goals.get(goal.id)?.status).toBe('cancelled');
    expect(engine.calls).toHaveLength(1);
  });

  it('with approveEveryPlan (Careful preset) a one-wave plan waits too', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([[card('C-01', 'coder')]]) : { text: 'STATUS: DONE' }));
    const hive = makeHive(engine, { approveEveryPlan: true });
    const goal = await hive.submitGoal('g');
    expect(goal.status).toBe('awaiting_approval');
    const ask = brain.approvals.list({ status: 'waiting' })[0]!;
    expect(ask.kind).toBe('plan');
    expect(ask.whyItNeedsYou).toMatch(/Careful/);
    expect(engine.calls).toHaveLength(1);
  });

  it('configure() changes the limits for the next goal and dispatch', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([[card('C-01', 'coder')]]) : { text: 'STATUS: DONE' }));
    const hive = makeHive(engine);
    hive.configure({ approveEveryPlan: true, defaultBudgetTokens: 1_000_000, insectCap: 1 });
    const goal = await hive.submitGoal('g');
    expect(goal.status).toBe('awaiting_approval');
    expect(goal.budgetTokens).toBe(1_000_000);
    expect(() => hive.configure({ insectCap: 0 })).toThrow(/at least 1/);
  });
});

describe('retry, escalation and the Queen\'s plan check', () => {
  it('a rejected card is retried with the reason and more effort, then passes', async () => {
    let inspections = 0;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([[card('C-01', 'coder')]]);
      if (req.role === 'inspector') return { text: ++inspections === 1 ? 'VERDICT: FAIL: email is not validated' : 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'f.txt'), String(Date.now())) };
    });
    const hive = makeHive(engine);
    await hive.submitGoal('g');
    await hive.runUntilIdle();
    const coders = engine.calls.filter((c) => c.role === 'coder');
    expect(coders).toHaveLength(2);
    expect(coders[1]!.task).toContain('email is not validated');
    expect(coders[1]!.route.effort).toBe('high');
    expect(brain.approvals.list({ status: 'waiting' }).some((a) => a.kind === 'merge')).toBe(true);
  });

  it('a card that keeps failing is escalated and the goal is marked stuck', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([[card('C-01', 'coder')]]);
      if (req.role === 'inspector') return { text: 'VERDICT: FAIL: still wrong' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'f.txt'), String(Math.random())) };
    });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('g');
    await hive.runUntilIdle();
    expect(engine.calls.filter((c) => c.role === 'coder')).toHaveLength(3);
    expect(brain.goals.get(goal.id)?.status).toBe('stuck');
    expect(events.some((e) => e.type === 'goal-stuck')).toBe(true);
  });

  it('an invalid plan gets one correction round, then the goal is stuck', async () => {
    const engine = new FakeEngine(() => ({ text: '```json\n{"summary":"x","waves":[{"cards":[{"title":"t","brief":"b","caste":"designer","acceptance":["a"]}]}]}\n```' }));
    const goal = await makeHive(engine).submitGoal('g');
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[1]!.task).toMatch(/not valid.*designer/s);
    expect(goal.status).toBe('stuck');
  });
});

describe('approvals for blocked insects (Hive 02-D7)', () => {
  it('an action needing approval blocks the card; approving lets exactly that rule through', async () => {
    let coderRuns = 0;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([[card('C-01', 'coder')]]);
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      if (++coderRuns === 1) {
        return {
          text: 'I need a validation library.\nSTATUS: BLOCKED: add zod as a dependency',
          events: [{ kind: 'tool_result', toolUseId: 't1', isError: true, content: "Needs the user's approval [new-dependency]: Adding zod ..." }],
        };
      }
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'v.txt'), 'zod') };
    });
    const hive = makeHive(engine);
    await hive.submitGoal('g');
    await hive.runUntilIdle();

    const ask = brain.approvals.list({ status: 'waiting' })[0]!;
    expect(ask).toMatchObject({ kind: 'risky_action', title: 'add zod as a dependency' });
    expect(ask.whyItNeedsYou).toContain('new-dependency');

    await hive.approve(ask.id);
    await hive.runUntilIdle();
    const resumed = engine.calls.filter((c) => c.role === 'coder')[1]!;
    expect(resumed.guard.approvedRules).toEqual(['new-dependency']);
    expect(resumed.task).toContain('The user approved');
    expect(brain.approvals.list({ status: 'waiting' }).some((a) => a.kind === 'merge')).toBe(true);
  });
});

describe('Foreman, Treasurer and Watchdog reflexes', () => {
  it('never runs more insects at once than the user allows', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return planReply([['C-01', 'C-02', 'C-03', 'C-04'].map((id) => card(id, 'coder'))]);
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      // Long enough to overlap the next insect's worktree setup (git is slow on Windows); real insects work for minutes.
      return { text: 'STATUS: DONE', delayMs: 1_500, effects: (cwd) => writeFileSync(join(cwd, `${cardOf(req)}.txt`), 'x') };
    });
    const hive = makeHive(engine, { insectCap: 2 });
    await hive.submitGoal('g');
    await hive.runUntilIdle();
    expect(engine.calls.filter((c) => c.role === 'coder')).toHaveLength(4);
    expect(engine.maxConcurrentInsects).toBe(2);
  });

  it('stops handing out cards when the goal reaches its budget, and asks you', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return { ...planReply([[card('C-01', 'coder'), card('C-02', 'coder', { dependsOn: ['C-01'] })]]), tokens: 1_000 };
      if (req.role === 'inspector') return { text: 'VERDICT: PASS', tokens: 100 };
      return { text: 'STATUS: DONE', tokens: 1_000, effects: (cwd) => writeFileSync(join(cwd, `${cardOf(req)}.txt`), 'x') };
    });
    const hive = makeHive(engine);
    await hive.submitGoal('g', { budgetTokens: 2_000 });
    await hive.runUntilIdle();
    expect(engine.calls.filter((c) => c.role === 'coder').map(cardOf)).toEqual(['C-01']);
    const ask = brain.approvals.list({ status: 'waiting' }).find((a) => a.title.includes('budget'))!;
    expect(ask).toBeTruthy();
    await hive.approve(ask.id);
    await hive.runUntilIdle();
    expect(engine.calls.filter((c) => c.role === 'coder').map(cardOf)).toEqual(['C-01', 'C-02']);
  });

  it('pauses the whole hive when the engine is signed out', async () => {
    const engine = new FakeEngine((req) => (req.role === 'queen' ? planReply([[card('C-01', 'coder')]]) : { text: 'Invalid API key', ok: false, error: 'auth' }));
    const hive = makeHive(engine);
    await hive.submitGoal('g');
    await hive.runUntilIdle();
    expect(hive.paused).toBe(true);
    expect(events.some((e) => e.type === 'paused')).toBe(true);
    expect(brain.taskboard.list({ status: 'blocked' })).toHaveLength(1);
  });
});
