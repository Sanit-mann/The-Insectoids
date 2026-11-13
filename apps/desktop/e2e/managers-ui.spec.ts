import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * The managers' brain side (Hive 02-D8; Phase 2 C2), on the Hive screen: the Scout switch and the
 * periodic review frequency are kept by the hive (they survive a window reload), "Run a review now"
 * produces a summary, and a goal planned with the Scout on shows a Scout lane first.
 */
/**
 * Goals of 6+ words run the Scout first when it is on and the code map is ready (harness demo.ts);
 * the scripted Queen then plans the usual two-wave "Say hello" plan, which waits for plan approval.
 */
const SCOUT_GOAL = 'Survey the code first, then say hello';

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

test('the Scout switch and the review frequency are kept across a reload', async () => {
  await nav('Hive').click();
  const panel = t.win.getByTestId('managers-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });

  const scout = panel.getByTestId('scout-switch').getByRole('switch');
  const before = (await scout.getAttribute('aria-checked')) === 'true';
  await scout.click();
  await expect(scout).toHaveAttribute('aria-checked', String(!before));

  const every = panel.getByTestId('review-every');
  await every.getByRole('radio', { name: 'Every 10 finished cards' }).click();
  await expect(every.getByRole('radio', { name: 'Every 10 finished cards' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByTestId('review-next')).toHaveText(/Next review in \d+ cards?/);

  // The renderer forgets everything on reload; the hive keeps its managers' settings.
  await t.win.reload();
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  await nav('Hive').click();
  const again = t.win.getByTestId('managers-panel');
  await expect(again.getByTestId('scout-switch').getByRole('switch')).toHaveAttribute('aria-checked', String(!before));
  await expect(again.getByTestId('review-every').getByRole('radio', { name: 'Every 10 finished cards' })).toHaveAttribute('aria-checked', 'true');

  // Off turns the countdown off.
  await again.getByTestId('review-every').getByRole('radio', { name: 'Off' }).click();
  await expect(again.getByTestId('review-next')).toHaveText('Off');

  // Leave the Scout as it was for the next test.
  await again.getByTestId('scout-switch').getByRole('switch').click();
  await expect(again.getByTestId('scout-switch').getByRole('switch')).toHaveAttribute('aria-checked', String(before));
});

test('"Run a review now" leaves a summary', async () => {
  test.setTimeout(60_000);
  await nav('Hive').click();
  const panel = t.win.getByTestId('managers-panel');
  await panel.getByTestId('run-review').click();
  await expect(panel.getByTestId('last-review')).toContainText('Hive review:', { timeout: 30_000 });
  await expect(panel.getByTestId('last-review')).toContainText('Last review');
  // The review is written to the Brain; "Open in the Brain" opens that record in the reader.
  await panel.getByTestId('last-review').getByRole('button', { name: 'Open in the Brain' }).click();
  await expect(t.win.getByTestId('brain-reader')).toBeVisible({ timeout: 10_000 });
  await expect(t.win.getByTestId('brain-reader')).toContainText('Hive review');
});

test('with the Scout on, a goal starts with a Scout lane', async () => {
  test.setTimeout(90_000);
  await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'setManagers', scoutBeforePlanning: true }));
  // The Scout reads the code map, so it only runs when the map has code in it. The e2e project starts with
  // just a README: give it one small source file and rebuild the map.
  writeFileSync(join(t.repo, 'greet.ts'), 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n');
  await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'rebuildCodeMap' }));
  await expect
    .poll(
      async () =>
        t.win.evaluate(async () => {
          const m = (await (globalThis as unknown as Win).insectoids.hive.snapshot()).codeMap;
          return m.state === 'ready' && m.files > 0;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(await t.win.evaluate((text) => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text }), SCOUT_GOAL)).toEqual({ ok: true });

  await expect
    .poll(async () => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.hive.snapshot()).agents.some((a) => a.role === 'scout')), {
      timeout: 30_000,
    })
    .toBe(true);

  await nav('Hive').click();
  const row = t.win.getByRole('row').filter({ hasText: 'Scout' }).first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('lane-role-hint')).toHaveText('Surveys the code before the Queen plans');

  // The Scout reports to the Queen, who plans after it.
  await expect
    .poll(
      async () =>
        t.win.evaluate(async () => {
          const s = await (globalThis as unknown as Win).insectoids.hive.snapshot();
          const scout = s.agents.find((a) => a.role === 'scout');
          const queen = s.agents.find((a) => a.role === 'queen');
          return scout && queen ? queen.startedAt >= scout.startedAt : false;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
});
