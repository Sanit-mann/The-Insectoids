import { expect, test } from '@playwright/test';
import { holdUntilDone } from './support/hold';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * Phase 2 services (Connections 04-D5; Phase 2 C4): Notion, Linear and Slack built in and off by default;
 * Jira as a template (its address is per site) with "Email and API token" sign-in. Fake key only.
 */
const FAKE = 'fake-jira-user@example.invalid:fake-token-NOT-REAL-0123';
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

test('Notion, Linear and Slack are built in, off by default, and say changes need your OK', async () => {
  const { win } = launched;
  await win.getByRole('tab', { name: /^Services/ }).click();
  for (const [id, label] of [
    ['notion', 'Notion'],
    ['linear', 'Linear'],
    ['slack', 'Slack'],
  ] as const) {
    const card = win.getByTestId(`service-${id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText('Built in');
    await expect(card.getByRole('switch', { name: `Let insects use ${label}` })).toHaveAttribute('aria-checked', 'false');
    await expect(card).toContainText(`Anything that changes something on ${label} waits for your OK.`);
    await expect(card.getByTestId(`service-${id}-reads`)).not.toBeEmpty();
  }
  await expect(win.getByTestId('service-linear-reads')).toContainText('GraphQL queries (not mutations)');
});

test('the Jira template fills the form, and a Jira service can be saved with a key and removed', async () => {
  const { win } = launched;

  // A fake key in the Vault, written as email:token.
  await win.getByRole('tab', { name: /^Vault/ }).click();
  const vaultForm = win.getByTestId('vault-add');
  await vaultForm.getByLabel('Name', { exact: true }).fill('Test Jira key');
  await win.getByTestId('vault-key-input').fill(FAKE);
  await vaultForm.getByRole('button', { name: 'Save key' }).click();
  await expect(win.getByTestId('vault-list').locator('li').filter({ hasText: 'Test Jira key' })).toBeVisible({ timeout: 10_000 });

  await win.getByRole('tab', { name: /^Services/ }).click();
  await win.getByRole('button', { name: 'Add a service' }).click();
  const form = win.getByTestId('service-add');
  await form.getByTestId('service-template-jira').click();
  await expect(form.getByTestId('service-template-jira')).toHaveAttribute('aria-checked', 'true');
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Jira');
  await expect(form.getByLabel('Short name (agents use this)')).toHaveValue('jira');
  await expect(form.getByLabel('Address (https)')).toHaveValue('https://<your-site>.atlassian.net');
  await expect(form.getByLabel('Sign-in')).toHaveValue('basic');
  await expect(form.getByTestId('service-basic-hint')).toContainText('email:token');
  await expect(form.getByTestId('service-read-posts')).toContainText('/rest/api/3/search');

  // The placeholder site must be replaced first.
  await form.getByRole('button', { name: 'Save service' }).click();
  await expect(form.getByText(/in place of <your-site>/)).toBeVisible();

  await form.getByLabel('Address (https)').fill('https://example-site.atlassian.net');
  const keySelect = form.getByRole('combobox', { name: 'Key', exact: true });
  await keySelect.selectOption({ label: 'Test Jira key' });
  await expect(keySelect).toHaveValue(/^sec_/);
  await form.getByRole('button', { name: 'Save service' }).click();

  const card = win.getByTestId('service-jira');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('Yours');
  await expect(card).toContainText('Email and API token');
  await expect(card.getByTestId('service-jira-reads')).toContainText('/rest/api/3/search');
  await expect(card.getByRole('switch', { name: 'Let insects use Jira' })).toHaveAttribute('aria-checked', 'false');
  // The key never shows on the page.
  expect(await win.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText)).not.toContain('fake-token-NOT-REAL');

  await holdUntilDone(win, card.getByRole('button', { name: /Hold to remove Jira/ }));
  await expect(card).toHaveCount(0, { timeout: 10_000 });
});
