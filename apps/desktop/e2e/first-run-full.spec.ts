import { type Page, expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Full first run (Onboarding 08; Phase 2 C5): a fresh profile with no setup and no project, two engines
 * showing ready (the scripted engine plus Claude Code shown ready for display only: the scripted engine runs
 * everything, so no real tokens). Walks every step: engines, an Ollama provider, the sample goal on the
 * practice project with its estimate first, then checks the checklist.
 */
let launched: LaunchedApp;
let win: Page;

const stepLabel = () => win.getByTestId('setup-step-label');
const goals = (): Promise<Array<{ id: string; text: string }>> =>
  win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).goals.map((g) => ({ id: g.id, text: g.text })));

test.beforeAll(async () => {
  launched = await launchApp({ onboarded: false, project: 'none', env: { INSECTOIDS_E2E_READY_ENGINES: 'claude' } });
  win = launched.win;
});
test.afterAll(async () => {
  await launched?.close();
});

test('setup walks every step, with two engines, a provider and the sample goal', async () => {
  test.setTimeout(150_000);

  // 1–2. Welcome and the default Brain folder.
  await expect(win.getByRole('heading', { name: 'Welcome to The Insectoids' })).toBeVisible({ timeout: 20_000 });
  await expect(stepLabel()).toHaveText('Step 1 of 9 · Welcome');
  await win.getByRole('button', { name: 'Get started' }).click();
  await expect(stepLabel()).toHaveText('Step 2 of 9 · Brain folder');
  await win.getByRole('button', { name: 'Use this folder' }).click();

  // 3. Engines: every engine is listed, two are ready, and Next works.
  await expect(stepLabel()).toHaveText('Step 3 of 9 · AI engines');
  const summary = win.getByTestId('setup-engines-summary');
  await expect(summary).toHaveAttribute('data-ready', '2', { timeout: 30_000 });
  await expect(summary).toContainText('2 engines ready');
  const list = win.getByTestId('engine-list');
  await expect(list).toBeVisible();
  for (const id of ['claude', 'gemini', 'codex', 'opencode']) await expect(list.locator(`[data-engine="${id}"]`)).toHaveCount(1);
  await expect(win.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await win.getByRole('button', { name: 'Next', exact: true }).click();

  // 4. Providers: add a local Ollama provider (no key) and switch it on.
  await expect(stepLabel()).toHaveText('Step 4 of 9 · Providers');
  const providers = win.getByTestId('setup-providers');
  await providers.getByRole('button', { name: 'Add a provider' }).click();
  const form = win.getByTestId('provider-add');
  await expect(form).toBeVisible();
  await expect(form.getByRole('radio', { name: 'Anthropic API' })).toBeVisible();
  await expect(form.getByRole('radio', { name: 'OpenAI API' })).toBeVisible();
  await form.getByRole('radio', { name: 'Ollama' }).click();
  await form.getByRole('combobox', { name: 'Strongest model' }).fill('llama3.1:8b');
  await form.getByRole('button', { name: 'Save provider' }).click();
  const card = win.getByTestId('provider-ollama');
  await expect(card).toBeVisible({ timeout: 10_000 });
  const sw = card.getByRole('switch', { name: 'Let the hive use Ollama' });
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // The Vault is one click away for providers that need a key.
  await win.getByRole('button', { name: 'Add a key to the Vault' }).click();
  await expect(win.getByTestId('setup-vault')).toBeVisible();
  await win.getByRole('button', { name: 'Next', exact: true }).click();

  // 5. About you: skip it.
  await expect(stepLabel()).toHaveText('Step 5 of 9 · About you');
  await win.getByRole('button', { name: 'Skip for now' }).click();

  // 6. First project: later (the sample uses its own practice folder).
  await expect(stepLabel()).toHaveText('Step 6 of 9 · First project');
  await win.getByRole('button', { name: 'Later' }).click();

  // 7. Safety: keep Balanced.
  await expect(stepLabel()).toHaveText('Step 7 of 9 · Safety');
  await win.getByRole('button', { name: 'Next', exact: true }).click();

  // 8. First goal: the estimate shows before anything runs.
  await expect(stepLabel()).toHaveText('Step 8 of 9 · First goal');
  const estimate = win.getByTestId('sample-estimate');
  await expect(estimate).toBeVisible({ timeout: 20_000 });
  await expect(win.getByTestId('sample-cost')).toContainText('tokens');
  await expect(estimate).toContainText('Your own files aren');
  expect(await goals()).toEqual([]);

  await win.getByTestId('sample-start').click();
  await expect(win.getByTestId('sample-started')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await goals()).length, { timeout: 15_000 }).toBe(1);
  // It runs on the practice project, not a folder the user picked.
  const project = await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).project);
  expect(project?.path ?? '').toMatch(/practice/i);
  await win.getByRole('button', { name: 'Next', exact: true }).click();

  // 9. Done: engines, providers and the sample are done on the checklist.
  await expect(stepLabel()).toHaveText('Step 9 of 9 · Done');
  await expect(win.getByTestId('checklist-engine')).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
  await expect(win.getByTestId('checklist-providers')).toHaveAttribute('data-done', 'true');
  await expect(win.getByTestId('checklist-sample-goal')).toHaveAttribute('data-done', 'true');
  await expect(win.getByTestId('checklist-providers')).not.toContainText('Later');
  await win.getByRole('button', { name: 'Open the hive' }).click();
  await expect(win.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 15_000 });
});

test('the sample goal is on the board, and Settings keeps the checklist', async () => {
  // The Queen plans the sample goal into a card; the board shows it as a card button.
  await expect
    .poll(async () => win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).cards.some((c) => /farewell/i.test(c.title))), {
      timeout: 30_000,
    })
    .toBe(true);
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Taskboard' }).click();
  await expect(win.getByRole('button', { name: /farewell/i }).first()).toBeVisible({ timeout: 15_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await expect(win.getByTestId('checklist-sample-goal')).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
  await expect(win.getByTestId('checklist-providers')).toHaveAttribute('data-done', 'true');
});

test('"Watch it in the Hive" finishes setup and opens the Hive', async () => {
  // Rerun setup: the sample was started, so the First goal step offers to watch it.
  await win.getByRole('button', { name: 'Run setup again' }).click();
  await expect(win.getByRole('heading', { name: 'Welcome to The Insectoids' })).toBeVisible({ timeout: 15_000 });
  await win.getByRole('button', { name: 'Get started' }).click();
  const skip: Record<string, string> = { 'Step 6 of 9': 'Later' };
  for (const label of ['Step 2 of 9', 'Step 3 of 9', 'Step 4 of 9', 'Step 5 of 9', 'Step 6 of 9', 'Step 7 of 9']) {
    await expect(stepLabel()).toContainText(label);
    await win.getByRole('button', { name: skip[label] ?? 'Skip for now' }).click();
  }
  await expect(stepLabel()).toHaveText('Step 8 of 9 · First goal');
  await expect(win.getByTestId('sample-started')).toBeVisible({ timeout: 15_000 });
  await win.getByTestId('sample-watch-hive').click();
  await expect(win.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 15_000 });
  await expect(win.getByRole('heading', { level: 1, name: 'Hive' })).toBeVisible();
});
