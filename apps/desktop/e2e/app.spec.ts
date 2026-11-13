import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, _electron as electron, expect, test } from '@playwright/test';

const appDir = fileURLToPath(new URL('..', import.meta.url));

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  // GitHub's Linux runners block Chromium's OS sandbox; disable it there only, for tests.
  const ciLinux = Boolean(process.env['CI']) && process.platform === 'linux';
  app = await electron.launch({
    args: ciLinux ? ['.', '--no-sandbox'] : ['.'],
    cwd: appDir,
    // Setup counts as done here; the first-run wizard has its own spec.
    env: { ...process.env, INSECTOIDS_E2E: '1', INSECTOIDS_E2E_ONBOARDED: '1' },
  });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
});

test('opens with the rail and asks for a project first', async () => {
  await expect(win).toHaveTitle('The Insectoids');
  const nav = win.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button')).toHaveCount(10);
  await expect(nav.getByRole('button', { name: 'Queen' })).toHaveAttribute('aria-current', 'page');
  // No project yet (this spec launches without one): the Queen asks for a folder before anything else.
  await expect(win.getByRole('heading', { name: 'Choose a project for the hive' })).toBeVisible();
  await expect(win.getByRole('complementary', { name: 'Hive status' })).toBeVisible();
});

test('shows the brand logo, and it loads under the CSP', async () => {
  const marks = win.getByTestId('brand-mark');
  await expect(marks.first()).toBeVisible();
  // naturalWidth is 0 when an image fails to load (e.g. blocked by the Content-Security-Policy).
  const loaded = await marks.evaluateAll((imgs) => imgs.map((img) => (img as unknown as { naturalWidth: number }).naturalWidth > 0));
  expect(loaded.length).toBeGreaterThan(0);
  expect(loaded.every(Boolean)).toBe(true);
});

test('the Brain runs in its own process and reports ready', async () => {
  const brain = win.getByTestId('brain-status');
  await expect(brain).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(brain).toContainText('ready');
  // The single writer created the database in this run's throwaway profile.
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  expect(existsSync(join(userData, 'brain', 'brain.db'))).toBe(true);
  // The `brain` CLI launchers insects get on their PATH.
  expect(existsSync(join(userData, 'bin', 'brain.cmd'))).toBe(true);
  expect(existsSync(join(userData, 'bin', 'brain'))).toBe(true);
  // The guard hook launcher (keeps ELECTRON_RUN_AS_NODE out of Claude's environment).
  expect(existsSync(join(userData, 'hooks', process.platform === 'win32' ? 'guard-hook.cmd' : 'guard-hook'))).toBe(true);
});

test('the renderer reaches the main process through the validated bridge', async () => {
  await expect(win.getByText(/^v0\.0\.1 · Electron \d+\./)).toBeVisible();
});

test('the renderer has no Node access', async () => {
  const exposed = await win.evaluate(() => {
    const g = globalThis as Record<string, unknown> & { insectoids?: { appInfo?: unknown } };
    return { require: typeof g['require'], process: typeof g['process'], bridge: typeof g.insectoids?.appInfo };
  });
  expect(exposed).toEqual({ require: 'undefined', process: 'undefined', bridge: 'function' });
});

test('switches screens from the rail', async () => {
  await win.getByRole('button', { name: 'Library' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  // Library is a live screen since Phase 2 C1; Cadence is still a placeholder.
  await expect(win.getByTestId('library-screen')).toBeVisible();
  await win.getByRole('button', { name: 'Cadence' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Cadence' })).toBeVisible();
  await expect(win.getByText(/^Arrives in Phase \d/)).toBeVisible();
  await win.getByRole('button', { name: 'Queen' }).click();
  await expect(win.getByRole('heading', { name: 'Choose a project for the hive' })).toBeVisible();
});

test('toggles between dark and light themes', async () => {
  const html = win.locator('html');
  const before = await html.getAttribute('data-theme');
  await win.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
  await expect(html).not.toHaveAttribute('data-theme', before ?? '');
});
