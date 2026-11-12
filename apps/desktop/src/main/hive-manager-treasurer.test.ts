import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { FakeEngine, type FakeReply, demoEngine } from '@insectoids/harness';
import { type HiveSnapshot, HiveSnapshotSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HiveManager } from '../brain-host/hive-manager';

/** Treasurer v2 in the host (Phase 2 A5): usage windows, caps, vendor limits, route reasons. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-treasurer-hm-'));
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

function make(engine = demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 })): HiveManager {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: engine,
    project: repo,
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
  });
  return manager;
}

const snap = (m: HiveManager): HiveSnapshot => HiveSnapshotSchema.parse(m.snapshot());
const fake = (m: HiveManager) => snap(m).engines.find((e) => e.id === 'fake')!;

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('Treasurer v2 in the host', () => {
  it('counts every run in the usage windows and explains each route', async () => {
    const m = make();
    await m.init();
    await until('engine ready', () => snap(m).engine.state === 'fake');
    expect(fake(m).usage).toMatchObject({ window5h: { runs: 0 }, state: 'ok', cap5hUsd: null, exhaustedUntil: null });
    expect(await m.command({ type: 'submitGoal', text: 'Say hello' })).toEqual({ ok: true });
    await until('plan approval', () => snap(m).approvals.find((a) => a.status === 'waiting' && a.kind === 'plan'));
    const approval = snap(m).approvals.find((a) => a.status === 'waiting')!;
    await m.command({ type: 'approve', approvalId: approval.id });
    await until('merge approval', () => snap(m).approvals.find((a) => a.status === 'waiting' && a.kind === 'merge'), 30_000);
    const s = snap(m);
    expect(fake(m).usage.window5h.runs).toBeGreaterThan(3);
    expect(fake(m).usage.window5h.costUsd).toBeGreaterThan(0);
    expect(fake(m).usage.window7d.runs).toBe(fake(m).usage.window5h.runs);
    expect(s.agents.length).toBeGreaterThan(0);
    for (const lane of s.agents) expect(lane.routeReason).toMatch(/^(rule|learned|fallback):/);
    expect(s.agents.find((l) => l.role === 'queen')?.routeReason).toBe('rule: the Queen plans on the strongest model');
    // Outcomes are in the Brain, settled by the Inspector.
    expect(brain.outcomes.recent().filter((r) => r.result === 'pass').length).toBeGreaterThan(0);
    expect(brain.outcomes.recent().some((r) => r.result === 'pending' && r.role !== 'queen' && r.role !== 'inspector')).toBe(false);
  });

  it('your caps: near at 80%, exhausted at 100%, and they persist', async () => {
    const m = make();
    await m.init();
    await until('engine ready', () => snap(m).engine.state === 'fake');
    brain.outcomes.record({
      runId: 'past', goalId: null, cardId: null, role: 'coder', priority: 'normal', engine: 'fake', tier: 'standard', model: 'sonnet',
      effort: 'medium', attempt: 0, result: 'pass', tokensIn: 100, tokensOut: 10, tokensCache: 0, costUsd: 0.85, costEstimated: false, durationMs: 1,
    });
    expect(await m.command({ type: 'setEngineLimits', engineId: 'fake', cap5hUsd: 1, cap7dUsd: null })).toEqual({ ok: true });
    expect(fake(m).usage).toMatchObject({ state: 'near', cap5hUsd: 1, message: expect.stringMatching(/\$0\.85 of your \$1\.00 limit per 5 hours/) });
    expect(await m.command({ type: 'setEngineLimits', engineId: 'fake', cap5hUsd: 0.5, cap7dUsd: 20 })).toEqual({ ok: true });
    expect(fake(m).usage).toMatchObject({ state: 'exhausted', message: expect.stringMatching(/reached your limit of \$0\.50 per 5 hours/) });
    // A goal can't start: no engine can take the Queen's planning.
    expect(snap(m).engines.find((e) => e.id === 'fake')!.usage.state).toBe('exhausted');
    const saved = JSON.parse(readFileSync(join(root, 'userData', 'settings.json'), 'utf8')) as { limits: unknown };
    expect(saved.limits).toEqual({ fake: { cap5hUsd: 0.5, cap7dUsd: 20 } });
    expect(await m.command({ type: 'setEngineLimits', engineId: 'fake', cap5hUsd: null, cap7dUsd: null })).toEqual({ ok: true });
    expect(fake(m).usage.state).toBe('ok');
  });

  it('a vendor limit rests the engine, pauses the hive when nothing is left, and clearing it carries on', async () => {
    let hit = false;
    const plan = JSON.stringify({ summary: 'One card', waves: [{ cards: [{ id: 'C-01', title: 'Card one', brief: 'b', caste: 'coder', acceptance: ['ok'] }] }] });
    const engine = new FakeEngine((req): FakeReply => {
      if (req.role === 'queen') return { text: `\`\`\`json\n${plan}\n\`\`\`` };
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      if (!hit) {
        hit = true;
        return { text: 'Claude AI usage limit reached|4102444800', ok: false, error: 'model-error' };
      }
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, 'one.txt'), '1') };
    });
    const m = make(engine);
    await m.init();
    await until('engine ready', () => snap(m).engine.state === 'fake');
    await m.command({ type: 'submitGoal', text: 'One card' });
    await until('paused at the limit', () => snap(m).hive.paused && snap(m).hive.pausedReason?.startsWith('Usage limit:'));
    const u = fake(m).usage;
    expect(u).toMatchObject({ state: 'exhausted', exhaustedUntil: 4102444800_000, message: expect.stringMatching(/at its usage limit until/) });
    expect(snap(m).cards[0]).toMatchObject({ status: 'open', attempts: 0 });
    expect(snap(m).activity.some((a) => /hit its usage limit/.test(a.message))).toBe(true);
    expect(snap(m).agents.find((l) => l.role === 'insect')?.status).toBe('paused');

    expect(await m.command({ type: 'clearEngineLimitHit', engineId: 'fake' })).toEqual({ ok: true });
    expect(snap(m).hive.paused).toBe(false);
    expect(fake(m).usage.state).toBe('ok');
    await until('card done', () => snap(m).cards[0]?.status === 'done', 30_000);
    expect(snap(m).cards[0]!.attempts).toBe(0);
  });
});
