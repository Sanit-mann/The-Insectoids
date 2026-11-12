import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * First-run setup backend (Onboarding 08, Phase 1 Step 9), driven through window.insectoids.setup.
 * The folder picker is a native dialog, so the Brain-folder switch is exercised via "use default"
 * here and its checks are unit-tested (app-settings.test.ts).
 */
let launched: LaunchedApp;
/** Where the e2e "folder picker" points (a folder with a space in its name, like a real profile). */
const pickedRoot = mkdtempSync(join(tmpdir(), 'insectoids-e2e-brain-'));
const picked = join(pickedRoot, 'My Brain');

const brainReady = () =>
  expect
    .poll(() => launched.win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.brainStatus()).state), { timeout: 25_000 })
    .toBe('ready');

test.beforeAll(async () => {
  // The wizard may hide the shell's status line, so wait on the bridge.
  launched = await launchApp({ onboarded: false, project: 'none', env: { INSECTOIDS_E2E_PICK_FOLDER: picked } });
  await brainReady();
});
test.afterAll(async () => {
  await launched?.close();
  rmSync(pickedRoot, { recursive: true, force: true, maxRetries: 3 });
});

test('a first run is not set up yet, with defaults and an honest checklist', async () => {
  const s = await launched.win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.state());
  expect(s.completed).toBe(false);
  expect(s.preset).toBe('balanced');
  expect(s.brainDir).toBe(s.defaultBrainDir);
  expect(s.aboutAnswered).toEqual([]);
  const done = Object.fromEntries(s.checklist.map((i) => [i.id, i.done]));
  expect(done).toMatchObject({ brain: false, engine: true /* fake engine */, about: false, preset: true, project: false, backup: false });
});

test('the Careful preset reaches the hive (insect limit 2), and Balanced brings 3 back', async () => {
  const { win } = launched;
  const r = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.setPreset('careful'));
  expect(r).toMatchObject({ ok: true, state: { preset: 'careful' } });
  expect(await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).hive.insectCap)).toBe(2);
  await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.setPreset('balanced'));
  expect(await win.evaluate(async () => (await (globalThis as unknown as AppWindow).insectoids.hive.snapshot()).hive.insectCap)).toBe(3);
});

test('"About you" answers become confirmed facts on the Global shelf; re-answering updates them', async () => {
  const { win } = launched;
  const r = await win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({
      answers: [
        { id: 'role', answer: 'I run a small design studio.' },
        { id: 'tools', answer: 'Figma, Notion and GitHub' },
      ],
    }),
  );
  expect(r.ok).toBe(true);
  expect([...r.state.aboutAnswered].sort()).toEqual(['role', 'tools']);
  expect(r.state.checklist.find((i) => i.id === 'about')?.done).toBe(true);

  await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({ answers: [{ id: 'role', answer: 'I run a design studio of four.' }] }));
  const hits = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.brainSearch({ query: 'About you role' }));
  const role = hits.filter((h) => h.title === 'About you: Role and work');
  expect(role).toHaveLength(1);
  const rec = await win.evaluate((id) => (globalThis as unknown as AppWindow).insectoids.hive.brainRecord(id), role[0]!.id);
  expect(rec).toMatchObject({ shelf: 'global', trust: 'confirmed', owner: 'user', body: 'I run a design studio of four.', version: 2 });
});

test('a secret in an answer is refused and nothing is saved', async () => {
  const { win } = launched;
  const r = await win.evaluate(() =>
    (globalThis as unknown as AppWindow).insectoids.setup.saveAbout({ answers: [{ id: 'goals', answer: 'my key is AKIAABCDEFGHIJKLMNOP' }] }),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/secret/i);
  expect(r.state.aboutAnswered).not.toContain('goals');
});

test('the default Brain folder is kept as is, and launchers stay in the profile', async () => {
  const { win, app } = launched;
  const r = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.useDefaultBrainFolder());
  expect(r.ok).toBe(true);
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  expect(r.state.brainDir).toBe(join(userData, 'brain'));
  expect(existsSync(join(userData, 'brain', 'brain.db'))).toBe(true);
  expect(existsSync(join(userData, 'bin', 'brain.cmd'))).toBe(true);
});

test('moving the Brain to another folder restarts it there, keeps launchers in the profile, and moves back', async () => {
  const { win, app } = launched;
  const moved = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.pickBrainFolder());
  expect(moved).toMatchObject({ ok: true, state: { brainDir: picked } });
  await brainReady();
  expect(existsSync(join(picked, 'brain.db'))).toBe(true);
  expect(existsSync(join(pickedRoot, 'bin'))).toBe(false);
  // A new, empty Brain: the earlier answers live in the default one.
  expect((await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.state())).aboutAnswered).toEqual([]);

  const back = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.useDefaultBrainFolder());
  expect(back.ok).toBe(true);
  expect(back.state.brainDir).toBe(back.state.defaultBrainDir);
  await brainReady();
  // The original Brain (and its answers) is back, untouched.
  expect([...(await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.state())).aboutAnswered].sort()).toEqual(['role', 'tools']);
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  expect(existsSync(join(userData, 'hooks'))).toBe(true);
});

test('finish completes setup; restart brings the wizard back', async () => {
  const { win } = launched;
  const fin = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.finish());
  expect(fin).toMatchObject({ ok: true, state: { completed: true } });
  expect(fin.state.completedAt).toEqual(expect.any(Number));
  expect(fin.state.checklist.find((i) => i.id === 'brain')?.done).toBe(true);
  const again = await win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.setup.restart());
  expect(again.state).toMatchObject({ completed: false, completedAt: null });
});
