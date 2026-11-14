import { type Locator, type Page, expect, test } from '@playwright/test';
import { type LaunchedApp, NO_KEY_STORE, launchApp, noKeyStoreOnLinux } from './support/launch';
import { holdUntilDone } from './support/hold';

/**
 * API providers tab (Connections 04-D3; Phase 2 · A4). Fake values only: the planted key below is not a
 * real credential, and the point is that it never shows up anywhere on the page after it's saved.
 */
const PLANTED = 'fake-provider-key-NOT-REAL-9876543210zz';

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

const pageNeverShowsKey = async (win: Page): Promise<void> => {
  const seen = await win.evaluate((needle) => {
    const doc = (globalThis as unknown as { document: { body: { innerText: string }; querySelectorAll: (s: string) => ArrayLike<{ value: string }> } }).document;
    const inputs = Array.from(doc.querySelectorAll('input, textarea, select')).map((el) => el.value);
    return { text: doc.body.innerText.includes(needle), inputs: inputs.some((v) => v.includes(needle)) };
  }, PLANTED);
  expect(seen).toEqual({ text: false, inputs: false });
};

const openAddForm = async (win: Page): Promise<Locator> => {
  const form = win.getByTestId('provider-add');
  if (!(await form.isVisible())) await win.getByTestId('providers-tab').getByRole('button', { name: 'Add a provider' }).click();
  await expect(form).toBeVisible();
  return form;
};

test('the API providers tab is live and explains where keys go', async () => {
  const { win } = launched;
  await tab(win, 'API providers').click();
  const panel = win.getByTestId('providers-tab');
  await expect(panel).toBeVisible();
  await expect(tab(win, 'API providers')).not.toContainText('Later');
  await expect(panel).toContainText('OpenCode and the AI never see');
  // The engines note links back to the Engines tab.
  await panel.getByRole('button', { name: 'Engines tab' }).click();
  await expect(win.getByTestId('engine-list')).toBeVisible();
  await tab(win, 'API providers').click();
});

test('FreeLLMAPI shows its personal-use note', async () => {
  const { win } = launched;
  const form = await openAddForm(win);
  await form.getByRole('radio', { name: 'FreeLLMAPI' }).click();
  await expect(form.getByRole('radio', { name: 'FreeLLMAPI' })).toHaveAttribute('aria-checked', 'true');
  await expect(win.getByTestId('provider-preset-note')).toContainText('personal use');
  await expect(win.getByTestId('provider-preset-note')).toContainText('terms can change');
});

test('an Ollama provider is local and has no key field; tiers, switch and removal work', async () => {
  const { win } = launched;
  const form = await openAddForm(win);
  await form.getByRole('radio', { name: 'Ollama' }).click();
  await expect(form.getByLabel('Address (OpenAI-compatible base URL)')).toHaveValue('http://127.0.0.1:11434/v1');
  await expect(form.getByLabel('Key', { exact: true })).toHaveCount(0);
  await expect(form.getByRole('button', { name: 'Add a key first' })).toHaveCount(0);
  await form.getByRole('combobox', { name: 'Strongest model' }).fill('llama3.1:8b');
  await form.getByRole('button', { name: 'Save provider' }).click();

  const card = win.getByTestId('provider-ollama');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(win.getByTestId('provider-ollama-local')).toContainText('nothing leaves this PC');
  await expect(card.getByLabel('Key for Ollama')).toHaveCount(0);
  // One model filled every tier.
  await expect(card.getByRole('combobox', { name: 'Light model' })).toHaveValue('llama3.1:8b');

  // Edit the tiers.
  await card.getByRole('combobox', { name: 'Light model' }).fill('llama3.2:3b');
  await card.getByRole('button', { name: 'Save models' }).click();
  await expect(card.getByRole('button', { name: 'Save models' })).toHaveCount(0);
  await expect(card.getByRole('combobox', { name: 'Light model' })).toHaveValue('llama3.2:3b');
  await expect.poll(async () => (await win.evaluate(() => (globalThis as unknown as { insectoids: { providers: { list: () => Promise<Array<{ id: string; models: { light: string } }>> } } }).insectoids.providers.list())).find((p) => p.id === 'ollama')?.models.light).toBe('llama3.2:3b');

  // On, then off.
  const sw = card.getByRole('switch', { name: 'Let the hive use Ollama' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');

  // Remove with a hold.
  await hold(win, card.getByRole('button', { name: 'Hold to remove Ollama' }));
  await expect(card).toHaveCount(0, { timeout: 10_000 });
});

test('an OpenRouter provider uses a Vault key, and the key never appears on the page', async () => {
  const { win } = launched;
  test.skip(await noKeyStoreOnLinux(win), NO_KEY_STORE);
  // A fake key in the Vault first.
  await tab(win, 'Vault').click();
  const vault = win.getByTestId('vault-add');
  await vault.getByLabel('Name', { exact: true }).fill('Fake OpenRouter key');
  await win.getByTestId('vault-key-input').fill(PLANTED);
  await vault.getByRole('button', { name: 'Save key' }).click();
  await expect(win.getByTestId('vault-list').locator('li').filter({ hasText: 'Fake OpenRouter key' })).toBeVisible();

  await tab(win, 'API providers').click();
  const form = await openAddForm(win);
  await form.getByRole('radio', { name: 'OpenRouter' }).click();
  await expect(form.getByLabel('Address (OpenAI-compatible base URL)')).toHaveValue('https://openrouter.ai/api/v1');
  // Plain http to a remote host is refused client-side.
  await form.getByLabel('Address (OpenAI-compatible base URL)').fill('http://example.com/v1');
  await form.getByRole('combobox', { name: 'Strongest model' }).fill('test/model-a');
  await form.getByRole('button', { name: 'Save provider' }).click();
  await expect(form).toContainText('use https');
  await form.getByLabel('Address (OpenAI-compatible base URL)').fill('https://openrouter.ai/api/v1');
  const keySelect = form.getByLabel('Key', { exact: true });
  const ref = await keySelect.locator('option', { hasText: 'Fake OpenRouter key' }).getAttribute('value');
  await keySelect.selectOption(ref!);
  await form.getByRole('button', { name: 'Save provider' }).click();

  const card = win.getByTestId('provider-openrouter');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(win.getByTestId('provider-openrouter-local')).toHaveCount(0);
  await expect(card.getByLabel('Key for OpenRouter')).toBeVisible();
  await pageNeverShowsKey(win);

  await hold(win, card.getByRole('button', { name: 'Hold to remove OpenRouter' }));
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await pageNeverShowsKey(win);
});
