import { expect, test } from '@playwright/test';
import type { CommandResult, HiveCommand, HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Treasurer v2 (Phase 2 A5) through the real app with the scripted engine: every run lands in the usage
 * windows, every lane says why it was routed that way, and the user's caps turn an engine near or exhausted.
 */
let t: LaunchedApp;

test.beforeAll(async () => {
  t = await launchApp();
});

test.afterAll(async () => {
  await t?.close();
});

const snapshot = (): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (cmd: HiveCommand): Promise<CommandResult> => t.win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);

async function until<T>(what: string, read: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v: T | undefined | null | false;
    try {
      v = await read();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const fakeEngine = async () => (await snapshot()).engines.find((e) => e.id === 'fake')!;

test('runs count in the usage windows and every lane says why it was routed', async () => {
  await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await until('the scripted engine', async () => (await snapshot()).engine.state === 'fake');
  expect((await fakeEngine()).usage).toMatchObject({ state: 'ok', window5h: { runs: 0 }, cap5hUsd: null });

  expect(await command({ type: 'submitGoal', text: 'Say hello' })).toEqual({ ok: true });
  const plan = await until('plan approval', async () => (await snapshot()).approvals.find((a) => a.status === 'waiting' && a.kind === 'plan'));
  expect(await command({ type: 'approve', approvalId: plan.id })).toEqual({ ok: true });
  await until('merge approval', async () => (await snapshot()).approvals.find((a) => a.status === 'waiting' && a.kind === 'merge'), 60_000);

  const s = await snapshot();
  const usage = (await fakeEngine()).usage;
  expect(usage.window5h.runs).toBeGreaterThan(0);
  expect(usage.window5h.costUsd).toBeGreaterThan(0);
  expect(usage.window7d.runs).toBeGreaterThanOrEqual(usage.window5h.runs);
  expect(s.agents.length).toBeGreaterThan(0);
  for (const lane of s.agents) expect(lane.routeReason).toMatch(/^(rule|learned|fallback):/);
});

test('a tiny cap makes the engine near or exhausted; clearing works', async () => {
  const used = (await fakeEngine()).usage.window5h.costUsd;
  expect(await command({ type: 'setEngineLimits', engineId: 'fake', cap5hUsd: used / 0.9, cap7dUsd: null })).toEqual({ ok: true });
  expect((await fakeEngine()).usage.state).toBe('near');
  expect(await command({ type: 'setEngineLimits', engineId: 'fake', cap5hUsd: Math.max(used / 2, 0.0001), cap7dUsd: null })).toEqual({ ok: true });
  const exhausted = (await fakeEngine()).usage;
  expect(exhausted.state).toBe('exhausted');
  expect(exhausted.message).toMatch(/reached your limit/);

  expect(await command({ type: 'clearEngineLimitHit', engineId: 'fake' })).toEqual({ ok: true });
  expect(await command({ type: 'setEngineLimits', engineId: 'fake', cap5hUsd: null, cap7dUsd: null })).toEqual({ ok: true });
  expect((await fakeEngine()).usage.state).toBe('ok');
});
