import { expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Sleep and wake (Phase 3 A2, Cadence 05-D5): the "keep the computer awake while the hive works" switch in
 * Settings (off by default, its state always in words), and the computer's wake signal reaching the scheduler.
 */
let t: LaunchedApp;
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };

test.beforeAll(async () => {
  t = await launchApp();
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
});

test.afterAll(async () => {
  await t?.close();
});

const nav = (name: string) => t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });

test('keep awake is off by default, and while it is on it says when it is keeping the computer awake', async () => {
  await nav('Settings').click();
  const box = t.win.getByTestId('keep-awake');
  const sw = box.getByRole('switch', { name: 'Keep the computer awake while the hive works' });
  const status = t.win.getByTestId('keep-awake-status');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(status).toHaveText(/^Off: the computer sleeps as usual/);

  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(status).toHaveText(/^On: the hive is idle, so the computer may sleep as usual/);

  // Give the hive work: while insects work, the computer is kept awake; when they're done, it may sleep again.
  expect(await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello' }))).toEqual({ ok: true });
  await expect
    .poll(
      () =>
        t.win.evaluate(async () => {
          const s = await (globalThis as unknown as Win).insectoids.hive.snapshot();
          return s.approvals.find((a) => a.kind === 'plan' && a.status === 'waiting')?.id ?? null;
        }),
      { timeout: 30_000 },
    )
    .not.toBeNull();
  const planId = await t.win.evaluate(async () => {
    const s = await (globalThis as unknown as Win).insectoids.hive.snapshot();
    return s.approvals.find((a) => a.kind === 'plan' && a.status === 'waiting')!.id;
  });
  expect(await t.win.evaluate((id) => (globalThis as unknown as Win).insectoids.hive.command({ type: 'approve', approvalId: id }), planId)).toEqual({ ok: true });
  await expect(status).toHaveText(/^On: keeping the computer awake now, because the hive is working/, { timeout: 30_000 });
  await expect(status).toHaveText(/^On: the hive is idle, so the computer may sleep as usual/, { timeout: 60_000 });

  // The choice is kept.
  await nav('Queen').click();
  await nav('Settings').click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(status).toHaveText(/^Off: the computer sleeps as usual/);
});

test("the computer's wake signal reaches the hive, and the app keeps working", async () => {
  await t.app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('resume');
  });
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 10_000 })
    .toBe('ready');
  const s = await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());
  expect(s.hive.paused).toBe(false);
});
