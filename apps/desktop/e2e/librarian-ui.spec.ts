import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';
import { holdUntilDone } from './support/hold';

/**
 * Brain screen, Phase 2 B3: Brain health (score and what makes it up), the Librarian (free checks; an AI
 * review that only suggests) and the lessons the hive learned from failed or retried work.
 */
let launched: LaunchedApp;

const snapshot = () => launched.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());

test.beforeAll(async () => {
  // INSECTOIDS_E2E_BRAIN_SEED also seeds lessons when the backend supports it (the lesson tests skip otherwise).
  launched = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

test('the Health panel shows a score after a free check', async () => {
  const { win } = launched;
  const panel = win.getByTestId('brain-health');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByTestId('health-score')).toHaveText(/Not checked yet|\d+\s*\/ 100/);
  await expect(panel).toContainText('Checking is free');
  await panel.getByRole('button', { name: 'Check now' }).click();
  await expect(panel.getByTestId('health-score')).toHaveText(/\d+\s*\/ 100\s*(Tidy|Fair|Needs care)/, { timeout: 15_000 });
  await expect(panel.getByRole('meter')).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(panel.getByTestId('health-checked')).toContainText('Last checked');
  // The breakdown is folded away until asked for, so search and the reader stay in view.
  await expect(panel.getByTestId('health-parts')).toBeHidden();
  await panel.getByText('What makes up the score').click();
  await expect(panel.getByTestId('health-parts').locator('li').first()).toBeVisible();
});

test('the Librarian card shows its state and the review costs a little', async () => {
  const { win } = launched;
  const card = win.getByTestId('librarian');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('librarian-state')).toHaveText(/Idle|Checking the Brain|Reviewing with AI/);
  await expect(card.getByTestId('librarian-next')).not.toBeEmpty();
  await expect(card.getByRole('button', { name: 'Ask the Librarian to review now' })).toBeVisible();
  await expect(card.getByTestId('librarian-cost')).toHaveText('Uses a little of your AI subscription.');
  await expect(card).toContainText('its AI review only suggests changes; you decide', { ignoreCase: true });
});

test('lessons can be confirmed and retired from the Brain screen', async () => {
  const { win } = launched;
  const lessons = (await snapshot()).lessons;
  test.skip(lessons.filter((l) => l.trust !== 'confirmed').length < 2, 'This build seeds fewer than two unconfirmed lessons in e2e.');

  const [toConfirm, toRetire] = lessons.filter((l) => l.trust !== 'confirmed');
  const confirmRow = win.locator(`[data-testid="lesson"][data-lesson="${toConfirm!.id}"]`);
  await confirmRow.getByRole('button', { name: 'Confirm' }).click();
  await expect(confirmRow).toContainText('Confirmed', { timeout: 10_000 });
  await expect(confirmRow.getByRole('button', { name: 'Confirm' })).toHaveCount(0);

  const retireRow = win.locator(`[data-testid="lesson"][data-lesson="${toRetire!.id}"]`);
  const hold = retireRow.getByRole('button', { name: /Hold to retire/ });
  await holdUntilDone(win, hold);
  await expect(retireRow).toHaveCount(0, { timeout: 10_000 });
  // Retired, not deleted: still readable in the Brain as an archived record.
  const record = await win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.hive.brainRecord(id), toRetire!.id);
  expect(record?.archived).toBe(true);
});

test('a lesson opens in the reader like any record', async () => {
  const { win } = launched;
  const lessons = (await snapshot()).lessons;
  test.skip(lessons.length === 0, 'This build seeds no lessons in e2e.');
  await win.getByTestId('lesson').first().getByRole('button').first().click();
  await expect(win.getByTestId('brain-reader')).toContainText(lessons[0]!.title);
});

test('with no lessons the panel explains where they come from', async () => {
  const { win } = launched;
  const lessons = (await snapshot()).lessons;
  test.skip(lessons.length > 0, 'This build seeds lessons in e2e; the empty state is covered elsewhere.');
  await expect(win.getByTestId('lessons-empty')).toContainText('fails or has to be redone');
});
