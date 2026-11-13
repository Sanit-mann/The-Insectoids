import { type Page, expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './support/launch';

/** Direct Anthropic and OpenAI API keys (Connections 04-D3; Phase 2 C4): presets fill the form and need a key. */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Connections' }).click();
  await win.getByRole('tab', { name: /^API providers/ }).click();
  await win.getByTestId('providers-tab').getByRole('button', { name: 'Add a provider' }).click();
  await expect(win.getByTestId('provider-add')).toBeVisible();
});

test.afterAll(async () => {
  await launched?.close();
});

const pick = async (win: Page, name: string): Promise<void> => {
  const form = win.getByTestId('provider-add');
  await form.getByRole('radio', { name }).click();
  await expect(form.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
};

for (const p of [
  { name: 'Anthropic API', base: 'https://api.anthropic.com/v1', note: /Anthropic API key, billed per token/ },
  { name: 'OpenAI API', base: 'https://api.openai.com/v1', note: /OpenAI API key, billed per token/ },
]) {
  test(`the ${p.name} preset fills the form and needs a key`, async () => {
    const { win } = launched;
    const form = win.getByTestId('provider-add');
    await pick(win, p.name);
    await expect(form.getByLabel('Name', { exact: true })).toHaveValue(p.name);
    await expect(form.getByLabel('Address (OpenAI-compatible base URL)')).toHaveValue(p.base);
    await expect(win.getByTestId('provider-preset-note')).toContainText(p.note);
    // No key in the Vault yet: the form asks for one first (a local preset like Ollama doesn't).
    await expect(form.getByRole('button', { name: 'Add a key first' })).toBeVisible();
    await pick(win, 'Ollama');
    await expect(form.getByRole('button', { name: 'Add a key first' })).toHaveCount(0);
  });
}
