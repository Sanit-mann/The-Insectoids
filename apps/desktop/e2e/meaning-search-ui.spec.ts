import { type Page, expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Meaning search UI (Phase 2 B1). These tests never download anything: "Turn on" is only pressed when
 * the backend says the model is already on this PC (state "off"), otherwise that test is skipped.
 */
const go = (win: Page, name: string) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();
const meaning = (win: Page) => win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).meaningSearch);

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  await expect(launched.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  // Something in the Brain to find by its words.
  await launched.win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({ answers: [{ id: 'role', answer: 'I build tiny text tools for writers.' }] }),
  );
});

test.afterAll(async () => {
  await launched?.close();
});

test('a fresh profile offers "Turn on" with the model size and source shown first', async () => {
  const { win } = launched;
  await go(win, 'Brain');
  const strip = win.getByTestId('meaning-search');
  await expect(strip).toBeVisible({ timeout: 15_000 });
  const m = await meaning(win);
  expect(['off', 'needs-download']).toContain(m.state);
  await expect(strip).toHaveAttribute('data-state', m.state);
  await expect(win.getByRole('button', { name: 'Turn on' })).toBeVisible();
  const consent = win.getByTestId('meaning-consent');
  await expect(consent).toContainText(m.model);
  await expect(consent).toContainText('leaves this PC');
  // Size and source are always stated before any download could start.
  await expect(consent).toContainText('MB');
  await expect(consent).toContainText(m.source);
});

test('word search marks each hit as found by its words', async () => {
  const { win } = launched;
  await go(win, 'Brain');
  await win.getByTestId('brain-search').fill('tiny text tools');
  const hit = win.getByTestId('brain-hit').first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  const badges = win.getByTestId('match-badge');
  await expect(badges.first()).toHaveAttribute('data-match', 'words');
  await expect(badges.first()).toHaveText('words');
});

test('a sentence that finds nothing suggests meaning search while it is off', async () => {
  const { win } = launched;
  await go(win, 'Brain');
  await win.getByTestId('brain-search').fill('who helps people that write stories');
  await expect(win.getByTestId('try-meaning')).toBeVisible({ timeout: 10_000 });
  await win.getByRole('button', { name: 'Show me how' }).click();
  await expect(win.getByRole('button', { name: 'Turn on' })).toBeFocused();
});

test('Settings shows the meaning search block with model, size, source and indexed count', async () => {
  const { win } = launched;
  await go(win, 'Settings');
  const block = win.getByTestId('meaning-search-settings');
  await expect(block).toBeVisible({ timeout: 10_000 });
  const m = await meaning(win);
  await expect(block).toContainText(m.model);
  await expect(block).toContainText('MB');
  await expect(block).toContainText(m.source);
  await expect(block).toContainText(/\d+ of \d+ records/);
  await expect(block.getByRole('switch', { name: 'Meaning search' })).toHaveAttribute('aria-checked', 'false');
});

// No test presses "Turn on": the backend's "off" state doesn't say whether the model is on disk, so
// turning it on could download the model. The full on → ready → meaning path is covered by the
// backend's own tests with a fake model.
