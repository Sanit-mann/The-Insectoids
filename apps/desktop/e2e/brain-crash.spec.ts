import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * The Brain host (the single writer, in its own utility process) can crash. The app must notice,
 * restart it with backoff, and carry on with nothing lost: the database is on disk, not in the process.
 */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
});

const brainPid = (l: LaunchedApp): Promise<number | null> =>
  l.app.evaluate(({ app }) => app.getAppMetrics().find((m) => m.serviceName === 'Insectoids Brain' || m.name === 'Insectoids Brain')?.pid ?? null);

test('the Brain host restarts after a crash and keeps its data', async () => {
  test.setTimeout(90_000);
  const { win } = launched;
  const status = win.getByTestId('brain-status');
  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });

  // Something in the Brain to find again afterwards.
  await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({ answers: [{ id: 'role', answer: 'I build tiny text tools.' }] }));
  const hitsBefore = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: 'tiny text tools' }));
  expect(hitsBefore.length).toBeGreaterThan(0);

  const pid = await brainPid(launched);
  expect(pid, 'the Brain host runs as its own process').not.toBeNull();
  process.kill(pid!, 'SIGKILL');

  // A search right after the crash waits for the restarted Brain instead of failing: the user never
  // sees "Restarting the Brain…" as an error (this used to fail under load).
  const hitsAfter = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: 'tiny text tools' }));

  // The app started a new host (backoff starts at 1 s), and the status line says "ready" again.
  await expect
    .poll(async () => {
      const now = await brainPid(launched);
      return now !== null && now !== pid;
    }, { timeout: 30_000 })
    .toBe(true);
  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });

  // Nothing lost, and the hive works again.
  expect(hitsAfter.map((h) => h.id)).toEqual(hitsBefore.map((h) => h.id));
  const result = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello after the crash' }));
  expect(result).toEqual({ ok: true });
});
