import { type Page, expect, test } from '@playwright/test';
import {
  type BackgroundE2E,
  type HiveApi,
  type HiveSnapshot,
  MAINTENANCE_JOBS,
  MAINTENANCE_JOB_ORDER,
  type NoticeModel,
  type SetupState,
  type TrayMenuItemModel,
} from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Working in the background (Phase 3 B2, Cadence 05-D8, App 07-D7): the tray menu, desktop notifications and
 * "Start with my computer".
 *
 * Main keeps `globalThis.__insectoidsE2E` under INSECTOIDS_E2E (read with `app.evaluate`): `tray` is what the tray
 * shows (tooltip + menu items, separators left out), `notices` every notification main decided to show, `loginItem`
 * a fake login item (the real one is never touched under e2e), and `windowInFront`, which the tests set to act as if
 * the window were (true) or weren't (false) in front.
 *
 * The fake engine's Queen plans every goal in two waves, so at the default preset each submitted goal's plan waits
 * for approval: that is the "new approval" used throughout.
 */
type Win = AppWindow;
type E2EGlobal = { __insectoidsE2E?: Partial<BackgroundE2E> };

/**
 * Notifications are grouped over "a few seconds" before main decides on one. A check that nothing was added
 * waits this long after the change, so a grouped notice would have been decided by then.
 */
const QUIET_MS = 8_000;

const snapshot = (win: Page): Promise<HiveSnapshot> => win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) =>
  win.evaluate((c) => (globalThis as unknown as Win).insectoids.hive.command(c), cmd);
const setupState = (win: Page): Promise<SetupState> => win.evaluate(() => (globalThis as unknown as Win).insectoids.setup.state());

/** What main's e2e hook holds right now (plain data, copied out of the main process). */
const background = (t: LaunchedApp): Promise<BackgroundE2E> =>
  t.app.evaluate(() => {
    const g = (globalThis as unknown as E2EGlobal).__insectoidsE2E;
    return {
      tray: g?.tray ?? null,
      notices: g?.notices ?? [],
      loginItem: g?.loginItem ?? { openAtLogin: false },
      windowInFront: g?.windowInFront ?? null,
    };
  });
const tray = async (t: LaunchedApp) => (await background(t)).tray;
const notices = async (t: LaunchedApp): Promise<NoticeModel[]> => (await background(t)).notices;

/** Act as if the app window were (true) or weren't (false) in front. */
async function setWindowInFront(t: LaunchedApp, inFront: boolean): Promise<void> {
  await t.app.evaluate((_electron, v) => {
    const g = (globalThis as unknown as E2EGlobal).__insectoidsE2E;
    if (!g) throw new Error('No __insectoidsE2E hook in main.');
    g.windowInFront = v;
  }, inFront);
}

const itemLabels = (items: TrayMenuItemModel[] | undefined): string[] => (items ?? []).map((i) => i.label);
const findItem = (items: TrayMenuItemModel[] | undefined, match: RegExp | string): TrayMenuItemModel | undefined =>
  (items ?? []).find((i) => (typeof match === 'string' ? i.label === match : match.test(i.label)));
const runNowMenu = async (t: LaunchedApp): Promise<TrayMenuItemModel[] | undefined> =>
  // the submenu item is labelled "Run now".
  findItem((await tray(t))?.items, 'Run now')?.submenu;

async function ready(win: Page): Promise<void> {
  await expect
    .poll(() => win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
    .toBe('ready');
  // No Scout survey before planning: the goals here only need their plans to wait.
  expect(await command(win, { type: 'setManagers', scoutBeforePlanning: false })).toEqual({ ok: true });
}

const waitingPlans = async (win: Page) => (await snapshot(win)).approvals.filter((a) => a.kind === 'plan' && a.status === 'waiting');

/** Submits a goal and waits for its plan to wait for approval; returns that approval. */
async function submitUntilPlanWaits(win: Page, text: string) {
  const before = new Set((await waitingPlans(win)).map((a) => a.id));
  expect(await command(win, { type: 'submitGoal', text })).toEqual({ ok: true });
  await expect.poll(async () => (await waitingPlans(win)).filter((a) => !before.has(a.id)).length, { timeout: 30_000 }).toBe(1);
  return (await waitingPlans(win)).find((a) => !before.has(a.id))!;
}

const nav = (win: Page, name: string) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });

test.describe('the tray', () => {
  test.describe.configure({ mode: 'serial' });
  let t: LaunchedApp;

  test.beforeAll(async () => {
    t = await launchApp();
    await ready(t.win);
  });
  test.afterAll(async () => {
    await t?.close();
  });

  test('says the hive is idle on start, with nothing waiting', async () => {
    await expect.poll(async () => (await tray(t)) !== null, { timeout: 15_000 }).toBe(true);
    const m = (await tray(t))!;
    expect(m.tooltip).toMatch(/idle/i);
    expect(m.tooltip).not.toMatch(/needs you/i);
    // the status line, e.g. "Hive idle".
    expect(findItem(m.items, /\bidle\b/i), itemLabels(m.items).join(' | ')).toBeDefined();
    expect(findItem(m.items, /^Needs you/)).toBeUndefined();
    expect(findItem(m.items, 'Pause hive')).toBeDefined();
    expect(findItem(m.items, 'Resume hive')).toBeUndefined();
    expect(findItem(m.items, 'Open The Insectoids')).toBeDefined();
    expect(findItem(m.items, 'Quit')).toBeDefined();
    if (process.platform === 'linux') expect(findItem(m.items, 'Start with my computer')).toBeUndefined();
    else expect(findItem(m.items, 'Start with my computer')).toMatchObject({ checked: false });
  });

  test('"Run now" lists the cadence you made and the five built-in jobs; "Next:" names the soonest', async () => {
    // Real minutes (no fast clock): 15 minutes away, sooner than every built-in job's default schedule
    // (unless the test happens to run in the 15 minutes before the 03:00 Daily backup).
    const created = await command(t.win, {
      type: 'createCadence',
      cadence: { name: 'Weekly check', when: { type: 'interval', everyMinutes: 15 }, goal: 'Say hello', budgetTokens: 150_000, autonomy: 'small-plans', enabled: true },
    });
    expect(created).toEqual({ ok: true });

    const builtInNames = MAINTENANCE_JOB_ORDER.map((j) => MAINTENANCE_JOBS[j].name);
    await expect.poll(async () => itemLabels(await runNowMenu(t)), { timeout: 10_000 }).toContain('Weekly check');
    const labels = itemLabels(await runNowMenu(t));
    // The project's cadences come first, then the built-in jobs.
    expect(labels[0]).toBe('Weekly check');
    expect([...labels.slice(1)].sort()).toEqual([...builtInNames].sort());
    for (const item of (await runNowMenu(t))!) expect(item.enabled, item.label).toBe(true);

    // "Next: <name> <when>".
    await expect.poll(async () => findItem((await tray(t))?.items, /^Next: /)?.label ?? null, { timeout: 10_000 }).toMatch(/^Next: Weekly check\b/);
  });

  test('a plan that waits shows "Needs you (1)" and the tooltip says so', async () => {
    await submitUntilPlanWaits(t.win, 'Say hello');
    await expect.poll(async () => findItem((await tray(t))?.items, /^Needs you/)?.label ?? null, { timeout: 10_000 }).toBe('Needs you (1)');
    expect((await tray(t))!.tooltip).toMatch(/needs you/i);
  });

  test('pausing shows "Resume hive" and the cadence can no longer be run now; resuming flips back', async () => {
    expect(await command(t.win, { type: 'pause' })).toEqual({ ok: true });
    await expect.poll(async () => findItem((await tray(t))?.items, 'Resume hive') !== undefined, { timeout: 10_000 }).toBe(true);
    let m = (await tray(t))!;
    expect(findItem(m.items, 'Pause hive')).toBeUndefined();
    expect(m.tooltip).toMatch(/paused/i);
    await expect.poll(async () => findItem(await runNowMenu(t), 'Weekly check')?.enabled, { timeout: 10_000 }).toBe(false);
    // Built-in jobs aren't hive work and run while paused (A5), so their items are not checked here.

    expect(await command(t.win, { type: 'resume' })).toEqual({ ok: true });
    await expect.poll(async () => findItem((await tray(t))?.items, 'Pause hive') !== undefined, { timeout: 10_000 }).toBe(true);
    m = (await tray(t))!;
    expect(findItem(m.items, 'Resume hive')).toBeUndefined();
    expect(m.tooltip).not.toMatch(/paused/i);
    await expect.poll(async () => findItem(await runNowMenu(t), 'Weekly check')?.enabled, { timeout: 10_000 }).toBe(true);
    // The plan still waits.
    expect(findItem(m.items, /^Needs you/)?.label).toBe('Needs you (1)');
  });
});

test.describe('desktop notifications', () => {
  test.describe.configure({ mode: 'serial' });
  let t: LaunchedApp;
  /** The first goal's plan: it waited while the window was in front, so it is never "new". */
  let first: { approvalId: string; goalId: string };

  test.beforeAll(async () => {
    t = await launchApp();
    await ready(t.win);
  });
  test.afterAll(async () => {
    await t?.close();
  });

  test('approvals already waiting stay quiet; a new plan approval notifies once, to Approvals', async () => {
    await setWindowInFront(t, true);
    const planA = await submitUntilPlanWaits(t.win, 'Say hello');
    first = { approvalId: planA.id, goalId: planA.goalId! };
    await t.win.waitForTimeout(QUIET_MS);
    expect(await notices(t), 'the window is in front').toHaveLength(0);

    // The window goes to the back: the plan that was already waiting is not new, so it doesn't notify.
    await setWindowInFront(t, false);
    await t.win.waitForTimeout(QUIET_MS);
    expect(await notices(t), 'already waiting').toHaveLength(0);

    // A new plan waits while the window isn't in front: one notice, of kind approval, opening Approvals.
    await submitUntilPlanWaits(t.win, 'Say hello again');
    await expect.poll(async () => (await notices(t)).length, { timeout: 15_000 }).toBe(1);
    const [n] = await notices(t);
    expect(n).toMatchObject({ kind: 'approval', target: { screen: 'approvals' } });
    expect(n!.title.length).toBeGreaterThan(0);
    // Grouped: no second notice for the same change.
    await t.win.waitForTimeout(QUIET_MS);
    expect(await notices(t)).toHaveLength(1);
  });

  test('a run starting and a goal finishing add none', async () => {
    // Goals run through to their merge approval here, which takes longer than the other checks.
    test.setTimeout(120_000);
    await setWindowInFront(t, false);
    const before = (await notices(t)).length;

    // A cadence run starts (autonomy "run": its plan starts on its own, no approval).
    expect(
      await command(t.win, {
        type: 'createCadence',
        cadence: { name: 'Night run', when: { type: 'interval', everyMinutes: 24 * 60 }, goal: 'Say hello', budgetTokens: 150_000, autonomy: 'run', enabled: true },
      }),
    ).toEqual({ ok: true });
    const cadenceId = (await snapshot(t.win)).cadences.find((c) => c.name === 'Night run')!.id;
    expect(await command(t.win, { type: 'runCadenceNow', id: cadenceId })).toEqual({ ok: true });
    // And the first goal starts once its plan is approved.
    expect(await command(t.win, { type: 'approve', approvalId: first.approvalId })).toEqual({ ok: true });
    await expect
      .poll(
        async () => {
          const s = await snapshot(t.win);
          const cadenceGoal = s.goals.find((g) => g.cadenceId === cadenceId);
          return `${cadenceGoal?.status ?? 'none'}/${s.goals.find((g) => g.id === first.goalId)?.status ?? 'none'}`;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^(running|done)\/(running|done)$/);
    await t.win.waitForTimeout(QUIET_MS);
    expect((await notices(t)).length, 'runs starting').toBe(before);

    // Both goals reach their merge approval while the window is in front (new approvals in front don't notify)...
    await setWindowInFront(t, true);
    const cadenceGoalId = (await snapshot(t.win)).goals.find((g) => g.cadenceId === cadenceId)!.id;
    const mergeOf = async (goalId: string) =>
      (await snapshot(t.win)).approvals.find((a) => a.kind === 'merge' && a.status === 'waiting' && a.goalId === goalId)?.id ?? null;
    await expect.poll(async () => (await mergeOf(first.goalId)) !== null && (await mergeOf(cadenceGoalId)) !== null, { timeout: 75_000 }).toBe(true);
    const merge = (await mergeOf(first.goalId))!;
    await t.win.waitForTimeout(QUIET_MS);
    expect((await notices(t)).length, 'in front').toBe(before);

    // ...then, with the window at the back, the first goal finishes: still quiet.
    await setWindowInFront(t, false);
    expect(await command(t.win, { type: 'approve', approvalId: merge })).toEqual({ ok: true });
    await expect.poll(async () => (await snapshot(t.win)).goals.find((g) => g.id === first.goalId)?.status, { timeout: 30_000 }).toBe('done');
    await t.win.waitForTimeout(QUIET_MS);
    expect((await notices(t)).length, 'a goal finishing').toBe(before);
  });

  test('nothing notifies while the window is in front, or with the Settings switch off', async () => {
    const before = (await notices(t)).length;

    await setWindowInFront(t, true);
    await submitUntilPlanWaits(t.win, 'Say hello in front');
    await t.win.waitForTimeout(QUIET_MS);
    expect((await notices(t)).length, 'window in front').toBe(before);

    await nav(t.win, 'Settings').click();
    const box = t.win.getByTestId('notifications');
    const sw = box.getByRole('switch', { name: 'Desktop notifications for approvals and failures' });
    const status = t.win.getByTestId('notifications-status');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    // the status says on/off in words (like keep-awake's "On: …" / "Off: …").
    await expect(status).toHaveText(/\bon\b/i);
    const onWords = (await status.textContent()) ?? '';
    expect((await setupState(t.win)).notifications.enabled).toBe(true);

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(status).not.toHaveText(onWords);
    await expect(status).toHaveText(/\boff\b/i);
    expect((await setupState(t.win)).notifications.enabled).toBe(false);

    await setWindowInFront(t, false);
    await submitUntilPlanWaits(t.win, 'Say hello while off');
    await t.win.waitForTimeout(QUIET_MS);
    expect((await notices(t)).length, 'switched off').toBe(before);

    // Back on: the words come back.
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(status).toHaveText(onWords);
    expect((await setupState(t.win)).notifications.enabled).toBe(true);
  });
});

test.describe('start with my computer', () => {
  let t: LaunchedApp;

  test.beforeAll(async () => {
    t = await launchApp();
    await ready(t.win);
  });
  test.afterAll(async () => {
    await t?.close();
  });

  const parts = () => {
    const box = t.win.getByTestId('start-with-computer');
    return {
      sw: box.getByRole('switch', { name: 'Start The Insectoids when I sign in' }),
      status: t.win.getByTestId('start-with-computer-status'),
    };
  };
  const trayItem = async () => findItem((await tray(t))?.items, 'Start with my computer');

  test('is off by default; on registers the (fake) login item and checks the tray item; off reverts', async () => {
    test.skip(process.platform === 'linux', 'Not offered on Linux yet (see the next test).');
    const s0 = (await setupState(t.win)).startWithComputer;
    expect(s0).toMatchObject({ enabled: false, available: true });
    expect(s0.message.length).toBeGreaterThan(0);
    expect((await background(t)).loginItem.openAtLogin).toBe(false);
    await expect.poll(async () => (await trayItem())?.checked, { timeout: 15_000 }).toBe(false);

    await nav(t.win, 'Settings').click();
    const { sw, status } = parts();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(status).toContainText(s0.message);

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await background(t)).loginItem.openAtLogin, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await trayItem())?.checked, { timeout: 10_000 }).toBe(true);
    const s1 = (await setupState(t.win)).startWithComputer;
    expect(s1).toMatchObject({ enabled: true, available: true });
    expect(s1.message).not.toBe(s0.message);
    await expect(status).toContainText(s1.message);

    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect.poll(async () => (await background(t)).loginItem.openAtLogin, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await trayItem())?.checked, { timeout: 10_000 }).toBe(false);
    expect((await setupState(t.win)).startWithComputer).toMatchObject({ enabled: false, message: s0.message });
    await expect(status).toContainText(s0.message);
  });

  test('on Linux it is not offered: the switch is disabled and says why', async () => {
    test.skip(process.platform !== 'linux', 'Only Linux lacks it.');
    const s = (await setupState(t.win)).startWithComputer;
    expect(s).toMatchObject({ enabled: false, available: false });
    expect(s.message.length).toBeGreaterThan(0);
    await nav(t.win, 'Settings').click();
    const { sw, status } = parts();
    await expect(sw).toBeDisabled();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(status).toContainText(s.message);
    await expect.poll(async () => (await tray(t)) !== null, { timeout: 15_000 }).toBe(true);
    expect(await trayItem()).toBeUndefined();
    expect((await background(t)).loginItem.openAtLogin).toBe(false);
  });
});
