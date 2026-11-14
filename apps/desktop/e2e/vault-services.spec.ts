import { type Locator, type Page, expect, test } from '@playwright/test';
import { type LaunchedApp, NO_KEY_STORE, launchApp, noKeyStoreOnLinux } from './support/launch';
import { holdUntilDone } from './support/hold';

/**
 * Vault and Services tabs (Connections 04-D4; Phase 2 · A3). Fake values only: the planted key below is
 * not a real credential. The point of these tests is that it never shows up again anywhere on the page.
 */
const PLANTED = 'fake-test-key-NOT-REAL-0123456789abcd';

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Connections' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

const tab = (win: Page, name: string) => win.getByRole('tab', { name: new RegExp(`^${name}`) });

/** Hold until the button says it's done (see support/hold.ts), never a fixed wait. */
const hold = (win: Page, button: Locator): Promise<void> => holdUntilDone(win, button);

/** Every bit of text and every input value on the page: the planted key must be in none of them. */
const pageNeverShowsKey = async (win: Page): Promise<void> => {
  const seen = await win.evaluate((needle) => {
    const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll: (s: string) => ArrayLike<{ value: string }> } }).document;
    const inputs = Array.from(doc.querySelectorAll('input, textarea, select')).map((el) => el.value);
    return { text: doc.body.innerText.includes(needle), inputs: inputs.some((v) => v.includes(needle)) };
  }, PLANTED);
  expect(seen).toEqual({ text: false, inputs: false });
};

test('the Vault is available and adding a key never shows it again', async () => {
  const { win } = launched;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  await tab(win, 'Vault').click();
  await expect(win.getByTestId('vault-tab')).toBeVisible();
  await expect(win.getByText("Keys can't be saved on this computer")).toHaveCount(0);

  const form = win.getByTestId('vault-add');
  await form.getByLabel('Name', { exact: true }).fill('Test GitHub key');
  const keyInput = win.getByTestId('vault-key-input');
  await expect(keyInput).toHaveAttribute('type', 'password');
  await expect(keyInput).toHaveAttribute('autocomplete', 'off');
  await keyInput.fill(PLANTED);
  await form.getByRole('button', { name: 'Save key' }).click();

  await expect(keyInput).toHaveValue('');
  const row = win.getByTestId('vault-list').locator('li').filter({ hasText: 'Test GitHub key' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.getByTestId('secret-hint')).toHaveText(/…abcd|hidden/);
  await pageNeverShowsKey(win);
});

test('a key links to GitHub, the service switches on, and the key cannot be removed while in use', async () => {
  const { win } = launched;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  await tab(win, 'Services').click();
  const github = win.getByTestId('service-github');
  await expect(github).toBeVisible({ timeout: 10_000 });

  const select = github.getByLabel('Key for GitHub');
  const ref = await select.locator('option', { hasText: 'Test GitHub key' }).getAttribute('value');
  expect(ref).toMatch(/^sec_/);
  await select.selectOption(ref!);
  await expect(select).toHaveValue(ref!);
  const sw = github.getByRole('switch', { name: 'Let insects use GitHub' });
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(github.getByTestId('service-github-status')).not.toHaveAttribute('data-status', 'needs-key');
  await expect(github.getByTestId('service-github-status')).not.toHaveAttribute('data-status', 'off');
  await pageNeverShowsKey(win);

  // In use by an enabled service: the Vault refuses to remove it.
  await tab(win, 'Vault').click();
  const row = win.getByTestId('vault-list').locator('li').filter({ hasText: 'Test GitHub key' });
  await expect(row).toContainText('GitHub');
  await hold(win, row.getByRole('button', { name: /Hold to remove Test GitHub key/ }));
  await expect(row.getByText('Not removed')).toBeVisible({ timeout: 10_000 });
  await expect(row).toBeVisible();

  // Switch GitHub back off for the next tests.
  await tab(win, 'Services').click();
  await win.getByTestId('service-github').getByRole('switch', { name: 'Let insects use GitHub' }).click();
  await expect(win.getByTestId('service-github').getByRole('switch', { name: 'Let insects use GitHub' })).toHaveAttribute('aria-checked', 'false');
});

test('a custom REST service can be added, is checked first, and can be removed', async () => {
  const { win } = launched;
  await tab(win, 'Services').click();
  await win.getByRole('button', { name: 'Add a service' }).click();
  const form = win.getByTestId('service-add');

  // Client-side checks: http is refused.
  await form.getByLabel('Name', { exact: true }).fill('Status Board');
  await expect(form.getByLabel('Short name (agents use this)')).toHaveValue('status-board');
  await form.getByLabel('Address (https)').fill('http://status.example.com');
  await form.getByLabel('Sign-in').selectOption('none');
  await form.getByRole('button', { name: 'Save service' }).click();
  await expect(form.getByText(/only https addresses/)).toBeVisible();

  await form.getByLabel('Address (https)').fill('https://status.example.com/api');
  await form.getByRole('button', { name: 'Save service' }).click();
  const card = win.getByTestId('service-status-board');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('Yours');
  await expect(card.getByRole('switch', { name: 'Let insects use Status Board' })).toHaveAttribute('aria-checked', 'false');

  await hold(win, card.getByRole('button', { name: /Hold to remove Status Board/ }));
  await expect(card).toHaveCount(0, { timeout: 10_000 });
});

test('the API providers tab (live since A4) never shows the key either', async () => {
  const { win } = launched;
  await tab(win, 'API providers').click();
  await expect(win.getByTestId('providers-tab')).toBeVisible();
  await pageNeverShowsKey(win);
});
