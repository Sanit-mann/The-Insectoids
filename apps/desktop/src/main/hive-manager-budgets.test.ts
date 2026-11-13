import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { demoEngine } from '@insectoids/harness';
import { BudgetsViewSchema, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** The Budgets screen in the host (Phase 2 C4; 02-D7, D9; 04-D7), and the e2e engine-install hook. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-budgets-hm-'));
  repo = join(root, 'site');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  brain = openBrain(':memory:');
  manager = null;
});

afterEach(async () => {
  await manager?.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function make(): Promise<HiveManager> {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    project: repo,
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
  });
  await manager.init();
  return manager;
}

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('the Budgets screen (C4)', () => {
  it('starts empty but complete: 14 days, no goals, no routing', async () => {
    const m = await make();
    const b = BudgetsViewSchema.parse(m.budgets());
    expect(b.goals).toEqual([]);
    expect(b.days).toHaveLength(14);
    expect(b.days.every((d) => d.runs === 0)).toBe(true);
    expect(b.routing).toEqual([]);
  });

  it('after a goal: its spend and cards, spend per day and role, the routing rule per run, what was learned', async () => {
    const m = await make();
    await m.command({ type: 'submitGoal', text: 'Write the welcome docs', budgetTokens: 500_000 });
    await until('all cards done', () => {
      const cs = HiveSnapshotSchema.parse(m.snapshot()).cards;
      return cs.length === 3 && cs.every((c) => c.status === 'done');
    });
    const b = BudgetsViewSchema.parse(m.budgets());
    const g = b.goals[0]!;
    expect(g).toMatchObject({ title: expect.stringMatching(/welcome/i), budgetTokens: 500_000 });
    expect(g.usedTokens).toBeGreaterThan(0);
    expect(g.cards.map((c) => c.caste).sort()).toEqual(['coder', 'documenter', 'tester']);
    // attempts counts like the card does (0 = passed on its first try).
    expect(g.cards.every((c) => c.tokens > 0 && c.attempts === 0)).toBe(true);
    expect(b.days.at(-1)!.runs).toBeGreaterThan(0);
    expect(b.byRole.map((r) => r.role)).toEqual(expect.arrayContaining(['queen', 'coder', 'inspector']));
    expect(b.byRole.find((r) => r.role === 'coder')!.passRate).toBe(1);
    const queen = b.routing.find((r) => r.role === 'queen')!;
    expect(queen).toMatchObject({ title: expect.stringMatching(/^Plan: /), engine: 'fake', caste: null, outcome: 'passed' });
    expect(queen.rule).not.toMatch(/not recorded/);
    const coder = b.routing.find((r) => r.role === 'coder')!;
    expect(coder).toMatchObject({ caste: 'coder', outcome: 'passed', cardId: expect.any(String) });
    expect(b.routing.find((r) => r.role === 'inspector')!.title).toMatch(/^Verify: /);
    expect(b.learned.find((l) => l.role === 'coder')).toMatchObject({ engine: 'fake', tries: 1, passes: 1 });
  });
});

describe('the e2e engine-install hook (C4)', () => {
  it('is refused outside end-to-end tests', async () => {
    const m = await make();
    const before = process.env['INSECTOIDS_E2E'];
    delete process.env['INSECTOIDS_E2E'];
    try {
      await expect(m.e2eEngineInstalled('gemini')).rejects.toThrow(/end-to-end/);
    } finally {
      if (before !== undefined) process.env['INSECTOIDS_E2E'] = before;
    }
  });

  it('under e2e a listed engine becomes installed and signed out, never ready', async () => {
    const m = await make();
    const before = process.env['INSECTOIDS_E2E'];
    process.env['INSECTOIDS_E2E'] = '1';
    try {
      expect(m.engineCard('gemini')).toMatchObject({ state: 'missing' });
      await m.e2eEngineInstalled('gemini');
      expect(m.engineCard('gemini')).toMatchObject({ state: 'signed-out', version: 'e2e-installed' });
      expect(m.engineCard('claude')).toMatchObject({ state: 'missing' });
      expect(m.engineCard('nope')).toBeNull();
    } finally {
      if (before === undefined) delete process.env['INSECTOIDS_E2E'];
      else process.env['INSECTOIDS_E2E'] = before;
    }
  });
});
