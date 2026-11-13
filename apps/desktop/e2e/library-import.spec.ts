import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';
import { holdUntilDone } from './support/hold';

/**
 * Importing a skill (Capabilities 03-D5; Phase 2 C3): every import is scanned for hidden instructions,
 * data exfiltration, risky scripts and secrets, then waits for the user's OK. A clean one can be approved
 * (it becomes Ready), retired and brought back; a malicious one is Blocked and can never be approved.
 *
 * Under e2e the folder picker is replaced by INSECTOIDS_E2E_IMPORT_PATH, fixed per launch, so each
 * import gets its own app.
 */
const FIXTURES = fileURLToPath(new URL('./fixtures/library/', import.meta.url));
/** Fixture folders (apps/desktop/e2e/fixtures/library); the folder name is the skill's name. */
const CLEAN = 'tidy-commit-messages';
const MALICIOUS = 'quick-setup-helper';

const openCatalog = async (t: LaunchedApp): Promise<void> => {
  await expect(t.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await t.win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library', exact: true }).click();
  await t.win.getByTestId('library-tab-catalog').click();
  await expect(t.win.getByTestId('library-import')).toBeVisible();
};

test.describe('a clean import', () => {
  let t: LaunchedApp;
  test.beforeAll(async () => {
    t = await launchApp({ env: { INSECTOIDS_E2E_IMPORT_PATH: `${FIXTURES}${CLEAN}` } });
    await openCatalog(t);
  });
  test.afterAll(async () => {
    await t?.close();
  });

  test('is scanned Clean, waits for approval, and becomes Ready once approved', async () => {
    const { win } = t;
    await win.getByTestId('library-import').click();
    const detail = win.getByTestId('library-detail');
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(detail.getByTestId('scan-verdict')).toHaveAttribute('data-verdict', 'clean');
    await expect(detail.getByTestId('origin-badge')).toHaveAttribute('data-origin', 'imported');
    await expect(detail.getByTestId('library-status')).toHaveText(/Draft/);

    // It waits in Approvals as an import.
    const waiting = await win.evaluate(async () =>
      (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).approvals.filter((a) => a.kind === 'skill_import' && a.status === 'waiting').length,
    );
    expect(waiting).toBe(1);

    await detail.getByTestId('draft-approve').click();
    await expect(detail.getByTestId('library-status')).toHaveText(/Ready/, { timeout: 15_000 });
    await expect(detail.getByTestId('draft-approve')).toHaveCount(0);
  });

  test('can be retired, then brought back', async () => {
    const detail = t.win.getByTestId('library-detail');
    await holdUntilDone(t.win, detail.getByTestId('item-retire'));
    await expect(detail.getByTestId('library-status')).toHaveText(/Retired/, { timeout: 15_000 });
    await detail.getByTestId('item-restore').click();
    await expect(detail.getByTestId('library-status')).toHaveText(/Ready/, { timeout: 15_000 });
  });

  test('the approval shows as an import, with a link back to the Library', async () => {
    const { win } = t;
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Approvals/ }).click();
    await win.getByRole('button', { name: /Imports/ }).click();
    const row = win.getByRole('list', { name: 'Approvals' }).getByRole('button').first();
    await expect(row).toContainText('Imported skill or agent');
    await row.click();
    await win.getByTestId('approval-open-library').click();
    await expect(win.getByTestId('library-screen')).toBeVisible();
    await expect(win.getByTestId('library-detail')).toBeVisible();
  });
});

test.describe('a malicious import', () => {
  let t: LaunchedApp;
  test.beforeAll(async () => {
    t = await launchApp({ env: { INSECTOIDS_E2E_IMPORT_PATH: `${FIXTURES}${MALICIOUS}` } });
    await openCatalog(t);
  });
  test.afterAll(async () => {
    await t?.close();
  });

  test('is Blocked, says why, and can never be approved', async () => {
    const { win } = t;
    await win.getByTestId('library-import').click();
    const detail = win.getByTestId('library-detail');
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(detail.getByTestId('scan-verdict')).toHaveAttribute('data-verdict', 'blocked');
    await expect(detail.getByTestId('scan-blocked')).toContainText("can’t be approved");
    await expect(detail.locator('[data-testid="scan-finding"][data-rule="hidden-instructions"][data-severity="block"]').first()).toBeVisible();
    await expect(detail.locator('[data-testid="scan-finding"][data-rule="risky-script"][data-severity="block"]').first()).toBeVisible();
    await expect(detail.getByTestId('draft-approve')).toHaveCount(0);
    await expect(detail.getByTestId('library-status')).toHaveText(/Draft/);
  });
});
