import { type Page, expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * First run (Onboarding 08, Phase 1 Step 9): a fresh profile with no setup and no project.
 * Walks the quick setup by keyboard and mouse, then checks what it saved: the preset, the checklist,
 * and the "about you" answers as confirmed facts in the Brain.
 */
let launched: LaunchedApp;
let win: Page;

const stepLabel = () => win.getByTestId('setup-step-label');

test.beforeAll(async () => {
  launched = await launchApp({ onboarded: false, project: 'none' });
  win = launched.win;
});
test.afterAll(async () => {
  await launched?.close();
});

test('setup walks from welcome to the hive, by keyboard and mouse', async () => {
  test.setTimeout(120_000);

  // 1. Welcome: the privacy promise, then Enter moves on (keyboard-only).
  await expect(win.getByRole('heading', { name: 'Welcome to The Insectoids' })).toBeVisible({ timeout: 20_000 });
  await expect(stepLabel()).toHaveText('Step 1 of 9 · Welcome');
  const promise = win.getByRole('list', { name: 'Privacy promise' });
  await expect(promise).toContainText('Your Brain stays on this PC.');
  await expect(promise).toContainText('Nothing is uploaded.');
  await expect(promise).toContainText('Agents never see your keys');
  // Focus starts on the step's title, so Enter moves on without touching the mouse.
  await expect(win.locator('#setup-step-1-title')).toBeFocused();
  await win.keyboard.press('Enter');

  // 2. Brain folder: keep the default.
  await expect(stepLabel()).toHaveText('Step 2 of 9 · Brain folder');
  await expect(win.getByTestId('brain-dir')).not.toBeEmpty();
  await expect(win.getByText('Brain folder (default)')).toBeVisible();
  await win.getByRole('button', { name: 'Use this folder' }).click();

  // 3. Engines (C5: every engine, as in Connections): the scripted test engine is ready, so Next works.
  await expect(stepLabel()).toHaveText('Step 3 of 9 · AI engines');
  const engines = win.getByTestId('setup-engines-summary');
  await expect(engines).not.toHaveAttribute('data-ready', '0', { timeout: 30_000 });
  await expect(win.getByTestId('engine-list')).toBeVisible();
  await win.getByRole('button', { name: 'Check again' }).click();
  await expect(engines).not.toHaveAttribute('data-ready', '0', { timeout: 30_000 });
  await win.getByRole('button', { name: 'Next', exact: true }).click();

  // 4. Providers (optional): skip.
  await expect(stepLabel()).toHaveText('Step 4 of 9 · Providers');
  await win.getByRole('button', { name: 'Skip for now' }).click();

  // 5. About you: answer two questions, skip the rest.
  await expect(stepLabel()).toHaveText('Step 5 of 9 · About you');
  const answer = win.getByLabel(/Your answer/);
  await answer.fill('I build desktop apps for small teams.');
  await answer.press('Enter');
  await expect(win.getByText('Saved to your Brain')).toHaveCount(1, { timeout: 15_000 });
  await expect(win.getByLabel(/Your answer \(2 of 5\)/)).toBeVisible();
  await win.getByLabel(/Your answer/).fill('Ship Phase 1 of The Insectoids.');
  await win.getByRole('button', { name: 'Answer' }).click();
  await expect(win.getByText('Saved to your Brain')).toHaveCount(2, { timeout: 15_000 });
  for (let i = 0; i < 3; i++) await win.getByRole('button', { name: 'Skip this question' }).click();
  await expect(win.getByText('Skipped')).toHaveCount(3);
  await win.getByRole('button', { name: 'Continue' }).click();

  // 6. First project: later.
  await expect(stepLabel()).toHaveText('Step 6 of 9 · First project');
  await win.getByRole('button', { name: 'Later' }).click();

  // 7. Safety preset: Balanced is preselected and recommended; pick Careful.
  await expect(stepLabel()).toHaveText('Step 7 of 9 · Safety');
  await expect(win.getByRole('radio', { name: 'Balanced (recommended)' })).toBeChecked();
  await expect(win.getByText('Always asks you, in every preset')).toBeVisible();
  await win.getByTestId('preset-careful').click();
  await expect(win.getByRole('radio', { name: 'Careful' })).toBeChecked();
  await expect(win.getByTestId('preset-careful')).toContainText('Selected', { timeout: 10_000 });
  await win.getByRole('button', { name: 'Next', exact: true }).click();

  // 8. First goal: skip the sample (first-run-full covers it).
  await expect(stepLabel()).toHaveText('Step 8 of 9 · First goal');
  await win.getByRole('button', { name: "Skip: I'll give the Queen my own goal" }).click();

  // 9. Done: the checklist shows what's left, then the hive opens.
  await expect(stepLabel()).toHaveText('Step 9 of 9 · Done');
  await expect(win.getByTestId('checklist-about')).toHaveAttribute('data-done', 'true');
  await expect(win.getByTestId('checklist-project')).toHaveAttribute('data-done', 'false');
  await win.getByRole('button', { name: 'Open the hive' }).click();

  // The shell: the Queen asks for a project (none was chosen).
  await expect(win.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 15_000 });
  await expect(win.getByRole('heading', { name: 'Choose a project for the hive' })).toBeVisible();
});

test('Settings shows the checklist and the chosen preset', async () => {
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await expect(win.getByRole('heading', { level: 2, name: 'Setup' })).toBeVisible();
  await expect(win.getByTestId('checklist-about')).toHaveAttribute('data-done', 'true');
  await expect(win.getByTestId('checklist-about')).toContainText('Done');
  await expect(win.getByTestId('checklist-project')).toHaveAttribute('data-done', 'false');
  await expect(win.getByTestId('checklist-project')).toContainText('Not done');
  await expect(win.getByRole('radio', { name: 'Careful' })).toBeChecked();
  await expect(win.getByTestId('brain-dir')).not.toBeEmpty();
});

test('the "about you" answers are confirmed facts in the Brain', async () => {
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
  const search = win.getByTestId('brain-search');
  await search.fill('desktop apps');
  const hit = win.getByTestId('brain-hit').first();
  await expect(hit).toBeVisible({ timeout: 15_000 });
  await hit.click();
  await expect(win.getByTestId('trust-badge')).toHaveText(/confirmed/i);
  await expect(win.getByText('I build desktop apps for small teams.').first()).toBeVisible();
});

test('"Run setup again" reopens the wizard and keeps what was saved', async () => {
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('button', { name: 'Run setup again' }).click();
  await expect(win.getByRole('heading', { name: 'Welcome to The Insectoids' })).toBeVisible({ timeout: 15_000 });
  await win.getByRole('button', { name: 'Get started' }).click();
  const skip: Record<string, string> = { 'Step 6 of 9': 'Later', 'Step 8 of 9': "Skip: I'll give the Queen my own goal" };
  for (const label of ['Step 2 of 9', 'Step 3 of 9', 'Step 4 of 9', 'Step 5 of 9', 'Step 6 of 9', 'Step 7 of 9', 'Step 8 of 9']) {
    await expect(stepLabel()).toContainText(label);
    await win.getByRole('button', { name: skip[label] ?? 'Skip for now' }).click();
  }
  await expect(stepLabel()).toHaveText('Step 9 of 9 · Done');
  // Answers and preset survived the rerun.
  await expect(win.getByTestId('checklist-about')).toHaveAttribute('data-done', 'true');
  await win.getByRole('button', { name: 'Open the hive' }).click();
  await expect(win.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 15_000 });
});
