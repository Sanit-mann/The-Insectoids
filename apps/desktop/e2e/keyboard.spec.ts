import { type Locator, type Page, expect, test } from '@playwright/test';
import { type HiveApi, maintenanceCadenceId } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Keyboard only (WCAG 2.2 AA, Phase 3 C1): the main flows done without a mouse. No `click()` here: only Tab,
 * Shift+Tab, Enter, Space, Escape and the arrow keys, with `toBeFocused()` checking where focus is.
 *
 * - The shell: "Skip to main content" is the first Tab stop; a screen picked in the Main navigation moves focus
 *   to that screen's heading, so a screen reader says where you are.
 * - The Queen: type a goal, Enter sends it, the plan's Approve button is reachable and works.
 * - Approvals: arrow keys walk the list; Approve works from the keyboard and focus goes back to the list.
 * - Cadence: the new-cadence form (its "When" radio group with the arrows), Runs, a built-in job switched off and
 *   on with Space, and hold-to-delete held with Space.
 * - Dialogs: "While you were away" and the backup restore confirm keep Tab inside, close on Escape and give focus
 *   back to the button that opened them.
 * - Settings: the keep-awake switch toggles with Space and its status line is a live region.
 * - On every flow, a few focused controls are checked for a visible focus indicator (an outline or a ring).
 */
type Win = AppWindow & { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string }> } };
type Doc = { document: { activeElement: unknown; querySelectorAll(q: string): ArrayLike<{ getAttribute(n: string): string | null }> } };
type Css = { getComputedStyle(el: unknown): { outlineStyle: string; outlineWidth: string; outlineColor: string; boxShadow: string } };

const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) => win.evaluate((c) => (globalThis as unknown as Win).insectoids.hive.command(c), cmd);
const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot());

/** True when `target` has focus (without waiting for it). */
async function hasFocus(target: Locator): Promise<boolean> {
  return target.evaluate((el) => el === (globalThis as unknown as Doc).document.activeElement, undefined, { timeout: 1_000 }).catch(() => false);
}

/** Presses Tab (or Shift+Tab) until `target` has focus, like a person tabbing to a control. */
async function tabTo(win: Page, target: Locator, opts: { back?: boolean; max?: number } = {}): Promise<void> {
  const key = opts.back ? 'Shift+Tab' : 'Tab';
  for (let i = 0; i < (opts.max ?? 80); i++) {
    if (await hasFocus(target)) return;
    await win.keyboard.press(key);
  }
  await expect(target).toBeFocused({ timeout: 1_000 });
}

/** The focused control shows where focus is: it matches :focus-visible and draws an outline or a ring. */
async function expectFocusVisible(target: Locator): Promise<void> {
  await expect(target).toBeFocused();
  const s = await target.evaluate((el) => {
    const css = (globalThis as unknown as Css).getComputedStyle(el);
    return {
      focusVisible: (el as unknown as { matches(q: string): boolean }).matches(':focus-visible'),
      outline: css.outlineStyle !== 'none' && Number.parseFloat(css.outlineWidth) > 0 && css.outlineColor !== 'rgba(0, 0, 0, 0)',
      ring: css.boxShadow !== 'none' && css.boxShadow !== '',
    };
  });
  expect(s.focusVisible, 'matches :focus-visible').toBe(true);
  expect(s.outline || s.ring, 'draws an outline or a ring').toBe(true);
}

/** Focus is somewhere inside `container`. */
const focusInside = (container: Locator): Promise<boolean> =>
  container.evaluate((el) => (el as unknown as { contains(n: unknown): boolean }).contains((globalThis as unknown as Doc).document.activeElement));

/** Tabs forward and back a few times; focus never leaves the dialog. */
async function expectFocusTrapped(win: Page, dialog: Locator): Promise<void> {
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await win.keyboard.press(key);
    expect(await focusInside(dialog), `focus stays in the dialog after ${key}`).toBe(true);
  }
}

/** No element puts itself ahead of the page order with a positive tabindex. */
async function expectNoPositiveTabindex(win: Page): Promise<void> {
  const n = await win.evaluate(
    () => Array.from((globalThis as unknown as Doc).document.querySelectorAll('[tabindex]')).filter((e) => Number(e.getAttribute('tabindex')) > 0).length,
  );
  expect(n, 'elements with a positive tabindex').toBe(0);
}

test.describe('keyboard only', () => {
  test.describe.configure({ mode: 'serial' });
  let t: LaunchedApp;
  let win: Page;

  const nav = () => win.getByRole('navigation', { name: 'Main' });
  const navButton = (name: string) => nav().getByRole('button', { name: new RegExp(`^${name}`) });
  const heading = (name: string) => win.getByRole('heading', { level: 1, name });

  /** Opens a screen from the Main navigation with the keyboard; focus lands on its heading. */
  async function openScreen(name: string): Promise<void> {
    await tabTo(win, navButton(name), { back: true });
    await expectFocusVisible(navButton(name));
    await win.keyboard.press('Enter');
    await expect(navButton(name)).toHaveAttribute('aria-current', 'page');
    await expect(heading(name)).toBeFocused();
  }

  test.beforeAll(async () => {
    t = await launchApp();
    win = t.win;
    // The window may sit behind others while tests run: let the page count as focused so :focus-visible applies.
    try {
      const cdp = await win.context().newCDPSession(win);
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch {
      await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
    }
    await expect
      .poll(() => win.evaluate(async () => (await (globalThis as unknown as Win).insectoids.brainStatus()).state), { timeout: 30_000 })
      .toBe('ready');
    // No Scout survey before planning: the goals here only need their plan.
    expect(await command(win, { type: 'setManagers', scoutBeforePlanning: false })).toEqual({ ok: true });
    await expect(win.getByLabel('Message the Queen')).toBeEnabled({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await t?.close();
  });

  test('the first Tab reaches "Skip to main content"; screens picked in the Main navigation focus their heading', async () => {
    await win.keyboard.press('Tab');
    const skip = win.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await expectFocusVisible(skip);
    // Visible while it has focus (not the 1 px screen-reader-only box).
    const box = await skip.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(40);
    await win.keyboard.press('Enter');
    await expect(heading('Queen')).toBeFocused();

    for (const name of ['Approvals', 'Cadence', 'Settings', 'Queen']) {
      await openScreen(name);
      await expectNoPositiveTabindex(win);
    }
  });

  test('the Queen: type a goal, Enter sends it, and the plan is approved from the keyboard', async () => {
    test.setTimeout(90_000);
    const prompt = win.getByLabel('Message the Queen');
    await tabTo(win, prompt);
    await win.keyboard.type('Say hello from the keyboard');
    await win.keyboard.press('Enter');

    const goal = win.getByRole('article', { name: /Goal:/ }).filter({ hasText: 'Say hello from the keyboard' });
    await expect(goal).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toHaveValue('');
    const approve = goal.locator('[data-approval-id]').getByRole('button', { name: /^Approve plan/ });
    await expect(approve).toBeVisible({ timeout: 30_000 });
    // The composer sits below the thread: the plan's buttons are just before it.
    await tabTo(win, approve, { back: true });
    await expectFocusVisible(approve);
    await win.keyboard.press('Enter');

    await expect(goal.getByTestId('goal-progress')).toBeVisible({ timeout: 30_000 });
    // The card left: focus stays on the goal instead of falling back to the page.
    await expect(goal).toBeFocused();
  });

  test('Approvals: the arrow keys walk the list and Enter approves', async () => {
    test.setTimeout(90_000);
    expect(await command(win, { type: 'submitGoal', text: 'Say hello once more' })).toEqual({ ok: true });
    await expect
      .poll(async () => (await snapshot(win)).approvals.filter((a) => a.kind === 'plan' && a.status === 'waiting').length, { timeout: 30_000 })
      .toBe(1);
    const waitingId = (await snapshot(win)).approvals.find((a) => a.kind === 'plan' && a.status === 'waiting')!.id;

    await openScreen('Approvals');
    const list = win.getByRole('list', { name: 'Approvals' });
    const items = list.getByRole('button');
    await expect(items).toHaveCount(2); // the new plan (waiting, first) and the first plan (approved)
    // One Tab stop for the whole list: the selected item.
    await tabTo(win, items.first());
    await expectFocusVisible(items.first());
    await win.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(items.nth(1)).toHaveAttribute('tabindex', '0');
    await win.keyboard.press('ArrowUp');
    await expect(items.first()).toBeFocused();
    await expect(items.first()).toHaveAttribute('data-id', waitingId);

    const approve = win.locator(`[data-approval-id="${waitingId}"]`).getByRole('button', { name: /^Approve/ });
    await tabTo(win, approve);
    await expectFocusVisible(approve);
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await snapshot(win)).approvals.find((a) => a.id === waitingId)?.status, { timeout: 15_000 }).toBe('approved');
    // Focus goes back to that item in the list.
    const item = list.locator(`[data-id="${waitingId}"]`);
    await expect(item).toBeFocused();
    await expect(item).toContainText('Approved');
  });

  test('Cadence: create one with the form, open Runs, switch a built-in job off and on, hold Space to delete', async () => {
    test.setTimeout(90_000);
    await openScreen('Cadence');

    // New cadence: the form opens with focus in its Name field.
    const create = win.getByTestId('cadence-empty').getByRole('button', { name: 'New cadence' });
    await tabTo(win, create);
    await expectFocusVisible(create);
    await win.keyboard.press('Enter');
    const form = win.getByTestId('cadence-form');
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Name')).toBeFocused();
    await win.keyboard.type('Keyboard report');

    // "When": one Tab stop, the arrows move and choose.
    await win.keyboard.press('Tab');
    const interval = form.getByRole('radio', { name: 'Every few minutes or hours' });
    const weekly = form.getByRole('radio', { name: 'On days of the week' });
    await expect(interval).toBeFocused();
    await expect(interval).toHaveAttribute('aria-checked', 'true');
    await expectFocusVisible(interval);
    await win.keyboard.press('ArrowRight');
    await expect(weekly).toBeFocused();
    await expect(weekly).toHaveAttribute('aria-checked', 'true');
    await expect(interval).toHaveAttribute('tabindex', '-1');

    // Weekly keeps its defaults (Monday, 09:00). The goal, then Create.
    const goal = form.getByLabel('What the Queen should do each time');
    await tabTo(win, goal);
    await win.keyboard.type('Say hello');
    const save = form.getByRole('button', { name: 'Create cadence' });
    await tabTo(win, save);
    await expectFocusVisible(save);
    await win.keyboard.press('Enter');
    await expect(form).toHaveCount(0);
    const row = win.getByTestId('cadence-row').filter({ hasText: 'Keyboard report' });
    await expect(row).toBeVisible();
    const made = (await snapshot(win)).cadences.find((c) => c.name === 'Keyboard report');
    expect(made?.when).toEqual({ type: 'weekly', days: [1], time: '09:00' });
    // The form left; focus didn't fall back to the page.
    await expect(win.getByRole('button', { name: 'New cadence' })).toBeFocused();

    // Runs: Enter opens the cadence's history.
    const runs = row.getByRole('button', { name: 'Runs' });
    await tabTo(win, runs);
    await win.keyboard.press('Enter');
    await expect(runs).toHaveAttribute('aria-pressed', 'true');
    await expect(win.getByTestId('cadence-history')).toContainText('Runs of "Keyboard report"');

    // The backup job: Run now and its Runs, then its switch off and on with Space.
    const backup = win.locator(`[data-testid="housekeeping-row"][data-cadence-id="${maintenanceCadenceId('backup')}"]`);
    const runNow = backup.getByRole('button', { name: 'Run now' });
    await tabTo(win, runNow);
    await expectFocusVisible(runNow);
    await win.keyboard.press('Enter');
    const backupRuns = backup.getByRole('button', { name: 'Runs' });
    await tabTo(win, backupRuns);
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('cadence-history').getByTestId('cadence-run').first()).toHaveAttribute('data-outcome', 'done', { timeout: 20_000 });

    const sw = backup.getByRole('switch');
    await tabTo(win, sw, { back: true });
    await expectFocusVisible(sw);
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await win.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(backup.getByTestId('housekeeping-next')).toHaveText('Off');
    // While it saves it is aria-disabled (and keeps focus); then Space works again.
    await expect(sw).toBeEnabled();
    await expect(sw).toBeFocused();
    await win.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    // Hold to delete, held with Space (the keyboard path of every hold-to-confirm button).
    const edit = row.getByRole('button', { name: 'Edit' });
    await tabTo(win, edit, { back: true });
    await win.keyboard.press('Enter');
    await expect(form.getByLabel('Name')).toBeFocused();
    const hold = form.getByRole('button', { name: 'Hold to delete Keyboard report' });
    await tabTo(win, hold);
    await expectFocusVisible(hold);
    await win.keyboard.down('Space');
    await expect(hold).toHaveAttribute('data-holding', 'true');
    await expect.poll(async () => (await snapshot(win)).cadences.some((c) => c.name === 'Keyboard report'), { timeout: 10_000 }).toBe(false);
    await win.keyboard.up('Space');
    await expect(win.getByTestId('cadence-empty')).toBeVisible();
    await expect(win.getByTestId('cadence-empty').getByRole('button', { name: 'New cadence' })).toBeFocused();
  });

  test('"While you were away": Enter opens it, Tab stays inside, Escape closes it and focus returns to the button', async () => {
    const opener = win.getByTestId('away-digest-button');
    await tabTo(win, opener, { back: true });
    await expectFocusVisible(opener);
    await win.keyboard.press('Enter');
    const dialog = win.getByRole('dialog', { name: 'While you were away' });
    await expect(dialog).toBeVisible();
    expect(await focusInside(dialog), 'focus moved into the dialog').toBe(true);
    await expectFocusTrapped(win, dialog);
    const close = dialog.getByRole('button', { name: 'Close', exact: true }).last();
    await tabTo(win, close);
    await expectFocusVisible(close);
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Settings: Space toggles keep awake and its status is announced; the restore confirm traps focus and Escape returns it', async () => {
    await openScreen('Settings');
    const box = win.getByTestId('keep-awake');
    const sw = box.getByRole('switch', { name: 'Keep the computer awake while the hive works' });
    const status = win.getByTestId('keep-awake-status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await tabTo(win, sw);
    await expectFocusVisible(sw);
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await win.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(status).toHaveText(/^On: /);
    await expect(sw).toBeEnabled();
    await expect(sw).toBeFocused();
    await win.keyboard.press('Space');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(status).toHaveText(/^Off: /);

    // The backup made on the Cadence screen is listed: its Restore asks first.
    const restore = win.getByTestId('backup-row').first().getByRole('button', { name: 'Restore' });
    await tabTo(win, restore, { back: true });
    await expectFocusVisible(restore);
    await win.keyboard.press('Enter');
    const dialog = win.getByRole('dialog', { name: 'Restore this backup?' });
    await expect(dialog).toBeVisible();
    expect(await focusInside(dialog), 'focus moved into the dialog').toBe(true);
    await expectFocusTrapped(win, dialog);
    await win.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(restore).toBeFocused();
    // Nothing was restored.
    await expect(win.getByText('Backup restored')).toHaveCount(0);
  });
});
