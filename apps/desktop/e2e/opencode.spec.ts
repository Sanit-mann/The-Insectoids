import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Phase 2 A4: OpenCode is a real engine now (not "available later"). With the scripted engine it is
 * listed but never checked or run, so this never touches a real install or a provider.
 */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
});

test('OpenCode is listed as a real engine with its install, provider and privacy notes', async () => {
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const card = await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).engines.find((e) => e.id === 'opencode'));
  expect(card).toMatchObject({
    name: 'OpenCode',
    availableIn: null,
    reportsCost: true,
    install: { command: 'npm install -g @opencode/cli@2.2.6' },
  });
  expect(card?.state).not.toBe('unsupported');
  expect(card?.guard === 'policy-and-tools' || card?.guard === 'read-only').toBe(true);
  expect(card?.signIn?.note).toMatch(/API providers tab/);
  expect(card?.privacyNote).toMatch(/Local providers/);
  // The scripted engine is the one that runs here; OpenCode is never used in e2e.
  const s = await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).engine);
  expect(s.state).toBe('fake');
});
