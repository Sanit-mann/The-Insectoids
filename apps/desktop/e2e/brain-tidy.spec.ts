import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Phase 2 B2 through the real app: near-duplicates fold into one record, a superseded fact becomes
 * history, and the decay job fades old agent notes with a reason (the e2e decay clock runs 90 days ahead).
 */
let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp({ env: { INSECTOIDS_E2E_BRAIN_SEED: '1', INSECTOIDS_E2E_TIDY_SHIFT_DAYS: '90' } });
  await expect(launched.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
});

test.afterAll(async () => {
  await launched?.close();
});

const search = (q: string, includeHistory = false) =>
  launched.win.evaluate(
    ([query, history]) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query, ...(history ? { includeHistory: true } : {}) }),
    [q, includeHistory] as const,
  );
const record = (id: string) => launched.win.evaluate((x) => (globalThis as unknown as AppWindow).insectoids.hive.brainRecord(x), id);
const command = (c: Parameters<AppWindow['insectoids']['hive']['command']>[0]) =>
  launched.win.evaluate((x) => (globalThis as unknown as AppWindow).insectoids.hive.command(x), c);

test('two near-duplicate agent notes become one record that lists what was folded in', async () => {
  const hits = await expect.poll(() => search('checkout stripe elements'), { timeout: 15_000 }).toHaveLength(1).then(() => search('checkout stripe elements'));
  const rec = await record(hits[0]!.id);
  expect(rec).not.toBeNull();
  expect(rec!.mergedFrom).toHaveLength(1);
  expect(rec!.history.at(-1)).toMatchObject({ change: 'merge' });
});

test('a superseded fact leaves default search and shows up with history, marked', async () => {
  const current = await search('hosting provider');
  expect(current.map((h) => h.status)).toEqual(['current']);
  const all = await search('hosting provider', true);
  expect(all.map((h) => h.status).sort()).toEqual(['current', 'superseded']);
  const old = all.find((h) => h.status === 'superseded')!;
  const rec = await record(old.id);
  expect(rec!.supersededBy).toMatchObject({ id: current[0]!.id });
  expect(rec!.validTo).not.toBeNull();
  const now = await record(current[0]!.id);
  expect(now!.supersedes).toEqual([{ id: old.id, title: 'Hosting provider' }]);
  expect(now!.usage).toMatchObject({ reads: 0, helped: 0 });
});

test('"Tidy now" fades old agent notes with a reason; the user can bring one back', async () => {
  expect(await command({ type: 'tidyBrain' })).toEqual({ ok: true });
  const faded = (await search('carousel landing', true)).find((h) => h.status === 'archived');
  expect(faded).toBeDefined();
  const rec = await record(faded!.id);
  expect(rec!.archivedReason).toMatch(/^faded: unused for 90 days$/);
  const snap = await launched.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
  expect(snap.activity.some((a) => a.type === 'brain-tidy' && a.message.startsWith('Faded into the archive'))).toBe(true);
  expect(await command({ type: 'restoreRecord', id: faded!.id })).toEqual({ ok: true });
  expect((await record(faded!.id))!.archived).toBe(false);
});
