import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Library screen (Capabilities 03-D3, D7, D8; Phase 2 C1): the 8 castes with their default skills and
 * network policy, and the catalog of agents, skills and tools (active / ready / dormant / draft).
 */
let t: LaunchedApp;

test.beforeAll(async () => {
  t = await launchApp();
  await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
  await expect(t.win.getByTestId('library-screen')).toBeVisible();
});

test.afterAll(async () => {
  await t?.close();
});

test('the Castes tab shows all 8 castes with their network policy in words', async () => {
  await t.win.getByTestId('library-tab-castes').click();
  const cards = t.win.getByTestId('caste-card');
  await expect(cards).toHaveCount(8, { timeout: 15_000 });
  for (const caste of ['coder', 'tester', 'reviewer', 'researcher', 'documenter', 'designer', 'analyst', 'writer']) {
    const card = t.win.locator(`[data-testid="caste-card"][data-caste="${caste}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId('caste-network')).toHaveText(/No network|Documentation sites only|Read-only web/);
  }
  // A researcher reads the web; a coder only documentation (Hive NETWORK policy).
  await expect(t.win.locator('[data-testid="caste-card"][data-caste="researcher"]').getByTestId('caste-network')).toContainText('Read-only web');
  await expect(t.win.locator('[data-testid="caste-card"][data-caste="coder"]').getByTestId('caste-network')).toContainText('Documentation sites only');
});

test('a default skill chip opens that item in the catalog', async () => {
  await t.win.getByTestId('library-tab-castes').click();
  const tester = t.win.locator('[data-testid="caste-card"][data-caste="tester"]');
  await tester.getByRole('button', { name: 'test-driven-development' }).click();
  await expect(t.win.getByTestId('library-tab-catalog')).toHaveAttribute('aria-selected', 'true');
  const detail = t.win.getByTestId('library-detail');
  await expect(detail.getByRole('heading', { name: 'test-driven-development' })).toBeVisible({ timeout: 10_000 });
});

test('the catalog finds a known skill and shows its text', async () => {
  await t.win.getByTestId('library-tab-catalog').click();
  await t.win.getByTestId('library-search').fill('code-review');
  const row = t.win.locator('[data-testid="library-row"][data-name="code-review"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  const detail = t.win.getByTestId('library-detail');
  await expect(detail.getByRole('heading', { name: 'code-review' })).toBeVisible();
  await expect(detail.getByTestId('library-safety')).toHaveText('Safety-checked, not yet field-tested');
  await detail.getByRole('button', { name: 'Read the full text' }).click();
  await expect(detail.getByTestId('library-text')).not.toBeEmpty();
});

test('counts look right, and dormant items say they are never switched on', async () => {
  await t.win.getByTestId('library-tab-catalog').click();
  await t.win.getByTestId('library-search').fill('');
  const chip = (s: string) => t.win.locator(`[data-testid="library-status-filter"][data-status="${s}"]`);
  const count = async (s: string): Promise<number> => Number((await chip(s).textContent())?.match(/(\d+)\s*$/)?.[1] ?? NaN);
  await expect.poll(() => count('dormant'), { timeout: 10_000 }).toBeGreaterThan(800);
  expect((await count('active')) + (await count('ready'))).toBeGreaterThanOrEqual(60);

  await chip('dormant').click();
  await expect(chip('dormant')).toHaveAttribute('aria-pressed', 'true');
  const rows = t.win.getByTestId('library-row');
  await expect(rows.first()).toHaveAttribute('data-status', 'dormant', { timeout: 10_000 });
  await expect(t.win.locator('[data-testid="library-row"]:not([data-status="dormant"])')).toHaveCount(0);
  await expect(t.win.getByTestId('library-more')).toBeVisible();

  await rows.first().click();
  const detail = t.win.getByTestId('library-detail');
  await expect(detail.getByTestId('library-safety')).toHaveText('Not checked yet: never switched on', { timeout: 10_000 });
  await chip('dormant').click();
});

test('drafts explain where they come from', async () => {
  await t.win.getByTestId('library-tab-catalog').click();
  const chip = t.win.locator('[data-testid="library-status-filter"][data-status="draft"]');
  await chip.click();
  await expect(t.win.getByText('No drafts yet.')).toBeVisible({ timeout: 10_000 });
  await chip.click();
});
