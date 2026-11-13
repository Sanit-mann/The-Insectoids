import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Brain screen, Phase 2 B5: the dashboard (Memory 01-D13 phase 2, E12). Totals, what the Brain holds by
 * kind, the last 8 weeks, most used, and a timeline of changes; health and lessons are the B3 panels.
 * A user edit shows up at the top of the timeline.
 */
let launched: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1' } });
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
  await win.getByRole('tablist', { name: 'Brain view' }).getByRole('tab', { name: 'Dashboard' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

const dash = () => launched.win.getByTestId('brain-dashboard');

test('the dashboard shows totals, kinds, the last 8 weeks and the Brain health panels', async () => {
  const totals = dash().getByTestId('dash-totals');
  await expect(totals).toBeVisible({ timeout: 10_000 });
  await expect(totals).toContainText('Records');
  await expect(totals).toContainText('Confirmed by you');
  await expect(totals).toContainText('Links');
  const records = Number((await totals.locator('dd').first().textContent())?.replace(/\D/g, ''));
  expect(records).toBeGreaterThanOrEqual(4);

  const kinds = dash().getByTestId('dash-kinds');
  await expect(kinds).toContainText('Decision');
  await expect(kinds).toContainText('Fact');

  const weeks = dash().getByTestId('dash-weeks');
  await expect(weeks.getByRole('list', { name: /Records added per week/ }).getByRole('listitem')).toHaveCount(8);
  await expect(weeks.getByRole('list', { name: /Agent reads per week/ }).getByRole('listitem')).toHaveCount(8);

  await expect(dash().getByTestId('dash-most-used')).toBeVisible();
  await expect(dash().getByTestId('brain-health')).toBeVisible();
  await expect(dash().getByTestId('lessons')).toBeVisible();
});

test('the timeline lists changes newest first, and an item opens the reader', async () => {
  const { win } = launched;
  const timeline = dash().getByTestId('dash-timeline');
  const items = timeline.getByTestId('dash-timeline-item');
  await expect(items.first()).toBeVisible({ timeout: 10_000 });
  await expect(timeline).toContainText('Ant-seed added');
  await items.filter({ hasText: 'Order page progress' }).first().click();
  await expect(win.getByTestId('brain-reader').getByRole('heading', { name: 'Order page progress' })).toBeVisible({ timeout: 10_000 });
});

test('a user edit appears at the top of the timeline', async () => {
  const { win } = launched;
  const reader = win.getByTestId('brain-reader');
  await expect(reader.getByRole('heading', { name: 'Order page progress' })).toBeVisible({ timeout: 10_000 });
  await reader.getByTestId('record-edit').click();
  await reader.getByTestId('record-editor').getByLabel('Text').fill('The order summary page shows totals now; delivery dates come next.');
  await reader.getByTestId('record-save').click();
  await expect(reader.getByTestId('record-editor')).toHaveCount(0);

  const first = dash().getByTestId('dash-timeline').getByTestId('dash-timeline-item').first();
  await expect(first).toContainText('You edited', { timeout: 10_000 });
  await expect(first).toContainText('Order page progress');
});
