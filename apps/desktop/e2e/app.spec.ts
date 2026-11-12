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
    env: { ...process.env, INSECTOIDS_E2E: '1' },
  });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
});

test('opens with the rail and an empty Queen screen', async () => {
  await expect(win).toHaveTitle('The Insectoids');
  const nav = win.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button')).toHaveCount(10);
  await expect(nav.getByRole('button', { name: 'Queen' })).toHaveAttribute('aria-current', 'page');
  await expect(win.getByRole('heading', { name: 'Give the hive its first goal' })).toBeVisible();
  await expect(win.getByRole('complementary', { name: 'Hive status' })).toBeVisible();
});

test('shows the brand logo in the rail and on the Queen screen', async () => {
  const marks = win.getByTestId('brand-mark');
  await expect(marks).toHaveCount(2);
  // naturalWidth is 0 when an image fails to load (e.g. blocked by the Content-Security-Policy).
  const loaded = await marks.evaluateAll((imgs) => imgs.map((img) => (img as unknown as { naturalWidth: number }).naturalWidth > 0));
  expect(loaded).toEqual([true, true]);
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
  await win.getByRole('button', { name: 'Taskboard' }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Taskboard' })).toBeVisible();
  await expect(win.getByText('Arrives in Phase 1')).toBeVisible();
  await win.getByRole('button', { name: 'Queen' }).click();
  await expect(win.getByRole('heading', { name: 'Give the hive its first goal' })).toBeVisible();
});

test('toggles between dark and light themes', async () => {
  const html = win.locator('html');
  const before = await html.getAttribute('data-theme');
  await win.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
  await expect(html).not.toHaveAttribute('data-theme', before ?? '');
});
