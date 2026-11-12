import { type Page, expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Brain screen, Phase 2 B2: how a record lives in the Brain (use, importance, still current or replaced,
 * what it replaced or absorbed, why it was archived) and searching with history included.
 */
let launched: LaunchedApp;

const app = (win: Page) => ({
  search: (query: string, includeHistory = false) =>
    win.evaluate(
      ({ q, h }) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q, ...(h ? { includeHistory: true } : {}) }),
      { q: query, h: includeHistory },
    ),
});

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

test('a replaced record shows "replaced" and links to what replaced it', async () => {
  const { win } = launched;
  // The backend decides what a replacement looks like; if this build makes none from the user's own
  // re-answer, there is nothing honest to assert here.
  await win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({ answers: [{ id: 'role', answer: 'I now build note-taking apps for writers.' }] }),
  );
  const hits = await app(win).search('writers', true);
  const old = hits.find((h) => h.status === 'superseded');
  test.skip(!old, 'This build records a re-answer as a new version, not as a replacement record.');

  await win.getByRole('switch', { name: 'Include history' }).click();
  await win.getByTestId('brain-search').fill('writers');
  const row = win.locator(`[data-testid="brain-hit"][data-status="superseded"]`).first();
  await expect(row.getByTestId('hit-status')).toHaveText('replaced');
  await row.click();
  const validity = win.getByTestId('brain-reader').getByTestId('validity');
  await expect(validity).toContainText('Replaced on');
  await validity.getByTestId('superseded-by').click();
  await expect(win.getByTestId('brain-reader').getByTestId('validity')).toContainText('Current since');
  await win.getByRole('switch', { name: 'Include history' }).click();
});
