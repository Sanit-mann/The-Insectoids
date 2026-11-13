import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Brain screen, Phase 2 B2: how a record lives in the Brain (use, importance, still current or replaced,
 * what it replaced or absorbed, why it was archived) and searching with history included.
 */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  const { win } = launched;
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  // Confirmed facts on the global shelf (the user said them).
  await win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({
      answers: [
        { id: 'role', answer: 'I build tiny text tools for writers.' },
        { id: 'tools', answer: 'VS Code, GitHub and Notion.' },
      ],
    }),
  );
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
});

test.afterAll(async () => {
  await launched?.close();
});

test('the Brain explains how it keeps itself tidy', async () => {
  const intro = launched.win.getByTestId('brain-tidy-intro');
  await expect(intro).toContainText('nothing is');
  await expect(intro).toContainText('never change the notes you confirmed');
});

test('the reader shows how a record is used and that it is current', async () => {
  const { win } = launched;
  await win.getByTestId('brain-search').fill('tiny text tools');
  const hit = win.getByTestId('brain-hit').first();
  await expect(hit).toBeVisible({ timeout: 10_000 });
  await expect(hit).toHaveAttribute('data-status', 'current');
  await hit.click();
  const reader = win.getByTestId('brain-reader');
  await expect(reader.getByTestId('usage-line')).toContainText(/Read .* · helped \d+ · /);
  await expect(reader.getByTestId('importance-meter')).toHaveAttribute('role', 'meter');
  await expect(reader.getByTestId('validity')).toContainText('Current since');
});

test('"Include history" switches on and off and the search follows it', async () => {
  const { win } = launched;
  const toggle = win.getByRole('switch', { name: 'Include history' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await win.getByTestId('brain-search').fill('VS Code GitHub Notion');
  await expect(win.getByTestId('brain-hit').first()).toBeVisible({ timeout: 10_000 });
  // Every hit says whether it's current; with history on, older ones may appear too.
  for (const s of await win.getByTestId('brain-hit').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))) {
    expect(['current', 'superseded', 'archived']).toContain(s);
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  for (const s of await win.getByTestId('brain-hit').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))) {
    expect(s).toBe('current');
  }
});

/**
 * A Brain seeded by the backend's e2e hook (INSECTOIDS_E2E_BRAIN_SEED): a superseded "Hosting provider"
 * fact and old agent notes, with the tidy clock 90 days ahead so "Tidy now" fades them.
 */
test.describe('with a seeded Brain', () => {
  let seeded: LaunchedApp;

  test.beforeAll(async () => {
    seeded = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1', INSECTOIDS_E2E_TIDY_SHIFT_DAYS: '90' } });
    const { win } = seeded;
    await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Brain' }).click();
  });

  test.afterAll(async () => {
    await seeded?.close();
  });

  test('a replaced fact shows "replaced" and links to what replaced it', async () => {
    const { win } = seeded;
    // Default search: only the current fact.
    await win.getByTestId('brain-search').fill('hosting provider');
    await expect(win.getByTestId('brain-hit')).toHaveCount(1, { timeout: 10_000 });
    await expect(win.getByTestId('brain-hit').first()).toHaveAttribute('data-status', 'current');

    await win.getByRole('switch', { name: 'Include history' }).click();
    const row = win.locator('[data-testid="brain-hit"][data-status="superseded"]').first();
    await expect(row.getByTestId('hit-status')).toHaveText('replaced', { timeout: 10_000 });
    await row.click();
    const validity = win.getByTestId('brain-reader').getByTestId('validity');
    await expect(validity).toContainText('Replaced on');
    await validity.getByTestId('superseded-by').click();
    await expect(win.getByTestId('brain-reader').getByTestId('validity')).toContainText('Current since');
    await expect(win.getByTestId('brain-reader').getByTestId('supersedes')).toContainText('Hosting provider');
    await win.getByRole('switch', { name: 'Include history' }).click();
  });

  test('a faded note shows "faded" with its reason, and the user can restore it', async () => {
    const { win } = seeded;
    const tidied = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'tidyBrain' }));
    expect(tidied).toEqual({ ok: true });

    await win.getByRole('switch', { name: 'Include history' }).click();
    await win.getByTestId('brain-search').fill('carousel landing');
    const row = win.locator('[data-testid="brain-hit"][data-status="archived"]').first();
    await expect(row.getByTestId('hit-status')).toHaveText('faded', { timeout: 10_000 });
    await row.click();
    const note = win.getByTestId('brain-reader').getByTestId('archived-reason');
    await expect(note).toContainText('faded: unused for 90 days');
    await note.getByRole('button', { name: 'Restore' }).click();
    await expect(win.getByTestId('brain-reader').getByTestId('archived-reason')).toHaveCount(0, { timeout: 10_000 });
    await expect(win.getByTestId('brain-reader').getByTestId('validity')).toContainText('Current since');
    await win.getByRole('switch', { name: 'Include history' }).click();
  });
});
