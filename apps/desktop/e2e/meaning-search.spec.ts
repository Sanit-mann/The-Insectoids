import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Meaning search in the real app (Phase 2 B1): the model runs in WebAssembly inside the Brain host
 * (an Electron utilityProcess). Tests never download: they use the model already on this PC, if any
 * (the user's dev profile), and skip the meaning part otherwise.
 */
const MODELS_DIR = process.env['APPDATA'] ? join(process.env['APPDATA'], 'The Insectoids', 'models') : '';
const MODEL_FILE = join(MODELS_DIR, 'all-MiniLM-L6-v2', '751bff37182d3f1213fa05d7196b954e230abad9', 'onnx', 'model_quantized.onnx');
const haveModel = Boolean(MODELS_DIR) && existsSync(MODEL_FILE);

let launched: LaunchedApp;
test.beforeAll(async () => {
  launched = await launchApp(haveModel ? { env: { INSECTOIDS_E2E_MODEL_DIR: MODELS_DIR } } : {});
  await expect(launched.win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
});
test.afterAll(async () => {
  await launched?.close();
});

const hive = () => (globalThis as unknown as AppWindow).insectoids.hive;

test('meaning search starts switched off on a fresh profile ("off" with the model on this PC, else "needs-download")', async () => {
  const m = await launched.win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).meaningSearch);
  expect(m).toMatchObject({ state: haveModel ? 'off' : 'needs-download', model: 'all-MiniLM-L6-v2' });
  expect(m.sizeMb).toBeGreaterThan(20);
  void hive;
});

test('switched on, a question phrased differently finds the record by meaning', async () => {
  test.skip(!haveModel, 'The meaning model is not on this PC; tests never download it.');
  test.setTimeout(120_000);
  const { win } = launched;
  // Two facts on the global shelf (saved as the user, through setup's "about you").
  await win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({
      answers: [
        { id: 'role', answer: 'I keep every API key encrypted in a vault on my laptop and never paste them into chats.' },
        { id: 'updates', answer: 'Short weekly summaries, please, in plain words.' },
      ],
    }),
  );
  const question = 'how do I protect my passwords';
  const before = await win.evaluate((q) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q }), question);
  expect(before.some((h) => /vault/i.test(h.title) || /role/i.test(h.title))).toBe(false);

  const r = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'setMeaningSearch', enabled: true }));
  expect(r).toEqual({ ok: true });
  await expect
    .poll(async () => (await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).meaningSearch)).state, { timeout: 90_000 })
    .toBe('ready');
  const m = await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).meaningSearch);
  expect(m.indexed).toBeGreaterThanOrEqual(2);
  expect(m.indexed).toBe(m.total);

  const t0 = Date.now();
  const after = await win.evaluate((q) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q }), question);
  const ms = Date.now() - t0;
  console.log(`[meaning-search e2e] search round trip ${ms} ms, ${after.length} hits:`, after.map((h) => `${h.match}:${h.title}`).join(' | '));
  const role = after.find((h) => /what do you do|role/i.test(h.title));
  expect(role, 'the API-key answer is found by meaning').toBeTruthy();
  expect(role!.match).toBe('meaning');
  expect(ms).toBeLessThan(2000);

  // Switching off: words only again, vectors kept.
  await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'setMeaningSearch', enabled: false }));
  const off = await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).meaningSearch);
  expect(off.state).toBe('off');
  const wordsOnly = await win.evaluate((q) => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: q }), question);
  expect(wordsOnly.every((h) => h.match === 'words')).toBe(true);
});

test('the real app never downloads the model under test: no model on disk means a plain error', async () => {
  test.setTimeout(60_000);
  // A second app with no model folder pointed at: its throwaway profile has no model.
  const bare = await launchApp();
  try {
    const { win, app } = bare;
    await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    const snap = () => win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).meaningSearch);
    expect((await snap()).state).toBe('needs-download');
    await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.command({ type: 'setMeaningSearch', enabled: true }));
    await expect.poll(async () => (await snap()).state, { timeout: 20_000 }).toBe('error');
    expect((await snap()).message).toMatch(/tests never download/);
    // Nothing was written to the profile's models folder.
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    const models = join(userData, 'models');
    expect(existsSync(models) ? readdirSync(models, { recursive: true }) : []).toEqual([]);
    // Every search hit says how it was found, also with meaning search in error.
    const hits = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: 'anything at all' }));
    expect(hits.every((h) => h.match === 'words')).toBe(true);
  } finally {
    await bare.close();
  }
});
