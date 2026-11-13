import { expect, test } from '@playwright/test';
import type { HiveApi, HiveSnapshot } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * The Watchdog's breaker ladder and the Foreman's decisions (Hive 02-D8, D9 P3; Phase 2 C2), driven by
 * scripted fake-engine scenarios (harness demo.ts): an insect that repeats itself is warned, then its card
 * is paused, the Foreman retries it with a note and the goal finishes; a card that keeps failing is sent
 * to the Queen and the goal is stuck with the Foreman's reason.
 */
/** One coder card whose first attempt repeats the same tool call (demo.ts: the Watchdog loop scenario). */
const LOOP_GOAL = 'Loop on purpose';
/** One coder card the Inspector always fails; after 3 attempts the Foreman sends it to the Queen (demo.ts). */
const STUCK_GOAL = 'Fail on purpose';

type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };

const snapshot = (t: LaunchedApp): Promise<HiveSnapshot> => t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());

async function start(goal: string): Promise<LaunchedApp> {
  const t = await launchApp();
  await expect
    .poll(() => t.win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  // The Scout isn't part of these scenarios; keep the runs short.
  await t.win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'setManagers', scoutBeforePlanning: false }));
  expect(await t.win.evaluate((text) => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text }), goal)).toEqual({ ok: true });
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
  return t;
}

const nav = (t: LaunchedApp, name: string) => t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });

test('a looping insect is warned, its card paused, and the Foreman retries it with a note', async () => {
  test.setTimeout(150_000);
  const t = await start(LOOP_GOAL);
  try {
    // Warned first, then the card paused: the ladder, in order.
    await expect
      .poll(async () => (await snapshot(t)).incidents.map((i) => i.step), { timeout: 60_000 })
      .toEqual(expect.arrayContaining(['warn', 'pause-card']));
    const incidents = (await snapshot(t)).incidents;
    const warn = incidents.find((i) => i.step === 'warn')!;
    const paused = incidents.find((i) => i.step === 'pause-card')!;
    expect(warn.at).toBeLessThanOrEqual(paused.at);

    await nav(t, 'Hive').click();
    const panel = t.win.getByTestId('watchdog-panel');
    await expect(panel.locator('[data-testid="incident"][data-step="warn"]').first()).toContainText('Warned');
    const pausedRow = panel.locator('[data-testid="incident"][data-step="pause-card"]').first();
    await expect(pausedRow).toContainText('Card paused');
    await expect(pausedRow).toHaveAttribute('data-sensor', paused.sensor);

    // The Foreman decides: retry with a note.
    const managers = t.win.getByTestId('managers-panel');
    await expect(managers.locator('[data-testid="foreman-decision"][data-action="retry-with-note"]').first()).toContainText('Retried with a note', {
      timeout: 60_000,
    });

    // The incident's card link opens the card on the Taskboard.
    if (paused.cardId) {
      await pausedRow.getByRole('button', { name: /C-\d+/ }).click();
      await expect(t.win.getByRole('complementary', { name: 'Card details' })).toBeVisible();
    }

    // The retry passes: the card is done (no longer held) and the goal waits for the user's merge.
    await expect
      .poll(
        async () => {
          const s = await snapshot(t);
          return s.cards.every((c) => c.status === 'done' && c.heldReason === null) && s.approvals.some((a) => a.kind === 'merge' && a.status === 'waiting');
        },
        { timeout: 90_000 },
      )
      .toBe(true);
  } finally {
    await t.close();
  }
});

test('a card that keeps failing is sent to the Queen and the goal is stuck with the reason', async () => {
  test.setTimeout(150_000);
  const t = await start(STUCK_GOAL);
  try {
    await expect.poll(async () => (await snapshot(t)).goals[0]?.status, { timeout: 120_000 }).toBe('stuck');
    const decision = (await snapshot(t)).managers.foremanDecisions.find((d) => d.action === 'to-queen');
    expect(decision, 'the Foreman sent the card to the Queen').toBeTruthy();

    await nav(t, 'Hive').click();
    const row = t.win.getByTestId('managers-panel').locator('[data-testid="foreman-decision"][data-action="to-queen"]').first();
    await expect(row).toContainText('Sent to the Queen');
    await expect(row).toContainText(decision!.reason);

    // The Queen tells the user: the goal's stuck message is the Foreman's finding.
    expect((await snapshot(t)).activity.some((a) => a.message.includes('Foreman:'))).toBe(true);
    await nav(t, 'Queen').click();
    await expect(t.win.getByText(/Foreman:/).first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await t.close();
  }
});
