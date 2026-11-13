import { expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * All 8 castes (Capabilities 03-D3; Phase 2 C1): the scripted Queen plans a goal across three castes,
 * the cards run, and each card shows the library skills switched on for it (03-D8).
 */
/** Goal text that makes the scripted (fake) Queen plan a 3-caste goal (harness demo.ts, DEMO_TEAM_GOAL). */
const GOAL = 'Write the welcome docs';

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

test('the Queen plans across three castes and each card carries its skills', async () => {
  test.setTimeout(120_000);
  expect(await t.win.evaluate((text) => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text }), GOAL)).toEqual({ ok: true });

  // A plan with more than one wave waits for approval (Hive 02-D11); approve it if so.
  await expect
    .poll(
      async () =>
        t.win.evaluate(async () => {
          const hive = (globalThis as unknown as Win).insectoids.hive;
          const s = await hive.snapshot();
          const plan = s.approvals.find((a) => a.kind === 'plan' && a.status === 'waiting');
          if (plan) await hive.command({ type: 'approve', approvalId: plan.id });
          return s.cards.length;
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const castes = await t.win.evaluate(async () => [...new Set((await (globalThis as unknown as Win).insectoids.hive.snapshot()).cards.map((c) => c.caste))]);
  expect(castes.length, `castes planned: ${castes.join(', ')}`).toBeGreaterThanOrEqual(3);

  // Every card finishes.
  await expect
    .poll(async () => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.hive.snapshot()).cards.every((c) => c.status === 'done')), {
      timeout: 90_000,
    })
    .toBe(true);

  // The taskboard shows three castes, and a coder card shows the skills that were on for it.
  await nav('Taskboard').click();
  const coder = await t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.hive.snapshot()).cards.find((c) => c.caste === 'coder')!);
  expect(coder.skills.length).toBeGreaterThan(0);
  expect(coder.skills.length).toBeLessThanOrEqual(5);
  const done = t.win.getByRole('region', { name: /^Done,/ });
  await done.getByRole('button', { name: new RegExp(`^${coder.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`) }).click();
  const detail = t.win.getByRole('complementary', { name: 'Card details' });
  const skills = detail.getByTestId('card-skills');
  await expect(skills.getByTestId('card-skill')).toHaveCount(coder.skills.length);

  // A skill chip opens that item in the Library.
  await skills.getByTestId('card-skill').first().click();
  await expect(t.win.getByTestId('library-screen')).toBeVisible();
  await expect(t.win.getByTestId('library-detail').getByRole('heading', { name: coder.skills[0]! })).toBeVisible({ timeout: 10_000 });
});
