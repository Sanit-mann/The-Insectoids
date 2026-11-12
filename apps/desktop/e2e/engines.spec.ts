import { expect, test } from '@playwright/test';
import type { HiveSnapshot } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/** Phase 2 A1: the engine registry through the real app (scripted engine; no tokens). */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  await expect(launched.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
});

test.afterAll(async () => {
  await launched?.close();
});

const snap = (): Promise<HiveSnapshot> => launched.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (c: Parameters<AppWindow['insectoids']['hive']['command']>[0]) =>
  launched.win.evaluate((x) => (globalThis as unknown as AppWindow).insectoids.hive.command(x), c);

test('lists every engine: the scripted one ready, Claude Code and Gemini CLI listed but not run, the rest coming later', async () => {
  await expect.poll(async () => (await snap()).engines.every((e) => e.state !== 'checking'), { timeout: 15_000 }).toBe(true);
  const s = await snap();
  expect(s.engines.map((e) => [e.id, e.state])).toEqual([
    ['fake', 'fake'],
    ['claude', 'missing'],
    ['gemini', 'missing'],
    ['codex', 'unsupported'],
    ['opencode', 'unsupported'],
  ]);
  const gemini = s.engines.find((e) => e.id === 'gemini')!;
  // A real engine since A2: guarded by the per-run policy plus the hive tools; never checked or run in scripted mode.
  expect(gemini).toMatchObject({ vendor: 'Google', availableIn: null, guard: 'policy-and-tools', reportsCost: false, models: { strongest: 'pro', standard: 'flash', light: 'flash-lite' } });
  expect(gemini.message).toMatch(/Not checked/);
  expect(gemini.install?.command).toBe('npm install -g @google/gemini-cli');
  expect(s.engines.find((e) => e.id === 'claude')!.signIn?.command).toBe('claude auth login');
  expect(s.engine.state).toBe('fake');
});

test('switching engines off and on, and reordering them', async () => {
  expect(await command({ type: 'setEngineEnabled', engineId: 'gemini', enabled: false })).toEqual({ ok: true });
  expect(await command({ type: 'setEngineOrder', order: ['fake', 'opencode'] })).toEqual({ ok: true });
  let s = await snap();
  expect(s.engines.map((e) => e.id)).toEqual(['fake', 'opencode', 'claude', 'gemini', 'codex']);
  expect(s.engines.find((e) => e.id === 'gemini')!.enabled).toBe(false);
  expect(await command({ type: 'setEngineEnabled', engineId: 'gemini', enabled: true })).toEqual({ ok: true });
  s = await snap();
  expect(s.engines.find((e) => e.id === 'gemini')!.enabled).toBe(true);
});

test('a goal runs on the scripted engine, and every lane says so', async () => {
  expect(await command({ type: 'submitGoal', text: 'Say hello from the engine test' })).toEqual({ ok: true });
  await expect.poll(async () => (await snap()).agents.length, { timeout: 30_000 }).toBeGreaterThan(0);
  const s = await snap();
  expect(s.agents.every((a) => a.engine === 'fake')).toBe(true);
});
