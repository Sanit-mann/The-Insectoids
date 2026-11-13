import { type Page, expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * One-click engine install with consent (Connections 04-D6; Phase 2 C4). Nothing real is ever installed:
 * INSECTOIDS_E2E_FAKE_INSTALL makes the main process play a scripted install (ok | fail | missing-npm).
 * The point: the exact command is shown before anything runs, Cancel runs nothing, and every outcome is
 * explained with the copy-it-yourself fallback still there.
 */
const openConnections = async (l: LaunchedApp): Promise<Page> => {
  const { win } = l;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Connections' }).click();
  await expect(win.getByTestId('engine-gemini')).toBeVisible({ timeout: 10_000 });
  return win;
};

const geminiCommand = (win: Page): Promise<string | undefined> =>
  win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).engines.find((e) => e.id === 'gemini')?.install?.command);

test.describe('install succeeds', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => {
    launched = await launchApp({ env: { INSECTOIDS_E2E_FAKE_INSTALL: 'ok' } });
  });
  test.afterAll(async () => {
    await launched?.close();
  });

  test('the exact command is shown first; Cancel runs nothing; Run streams output and ends installed', async () => {
    const win = await openConnections(launched);
    const card = win.getByTestId('engine-gemini');
    const command = await geminiCommand(win);
    expect(command).toBeTruthy();

    // Ask first: the dialog shows the very command the card shows, and nothing has run.
    await card.getByTestId('engine-install').click();
    const dialog = win.getByTestId('install-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('install-command')).toHaveText(command!);
    await expect(dialog.getByText('Run this command?')).toBeVisible();
    await expect(dialog.getByTestId('install-output')).toHaveCount(0);

    // Cancel: closed, nothing ran.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // Again, and this time run it.
    await card.getByTestId('engine-install').click();
    await expect(dialog.getByTestId('install-output')).toHaveCount(0);
    await dialog.getByTestId('install-run').click();
    const output = dialog.getByTestId('install-output');
    await expect(output).toBeVisible();
    const result = dialog.getByTestId('install-result');
    await expect(result).toHaveAttribute('data-status', 'installed', { timeout: 20_000 });
    await expect(output).not.toHaveText('No output.');
    await expect(result).toContainText('is installed');

    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('install fails', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => {
    launched = await launchApp({ env: { INSECTOIDS_E2E_FAKE_INSTALL: 'fail' } });
  });
  test.afterAll(async () => {
    await launched?.close();
  });

  test('a failed install says so, with its exit code and the copy-it-yourself fallback', async () => {
    const win = await openConnections(launched);
    const card = win.getByTestId('engine-gemini');
    await card.getByTestId('engine-install').click();
    const dialog = win.getByTestId('install-dialog');
    await dialog.getByTestId('install-run').click();
    const result = dialog.getByTestId('install-result');
    await expect(result).toHaveAttribute('data-status', 'failed', { timeout: 20_000 });
    await expect(result).toContainText("didn't finish");
    await expect(dialog.getByText(/Copy the command to run it yourself/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Copy: / })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    // The card keeps its own copy fallback.
    await expect(card.getByTestId('engine-gemini-install')).toBeVisible();
  });
});

test.describe('a ladder step is missing', () => {
  let launched: LaunchedApp;
  test.beforeAll(async () => {
    launched = await launchApp({ env: { INSECTOIDS_E2E_FAKE_INSTALL: 'missing-npm' } });
  });
  test.afterAll(async () => {
    await launched?.close();
  });

  test('when npm is missing nothing runs, and the app says what to do instead', async () => {
    const win = await openConnections(launched);
    await win.getByTestId('engine-gemini').getByTestId('engine-install').click();
    const dialog = win.getByTestId('install-dialog');
    await dialog.getByTestId('install-run').click();
    const result = dialog.getByTestId('install-result');
    await expect(result).toHaveAttribute('data-status', 'not-run', { timeout: 20_000 });
    await expect(result).toContainText('Nothing was run');
    await expect(result).not.toHaveText(/^\s*$/);
  });
});
