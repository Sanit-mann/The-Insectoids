import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { HiveApi } from '@insectoids/shared';
import { type LaunchedApp, launchApp } from './support/launch';

/**
 * The packaged app (Phase 3 C3): runs only when INSECTOIDS_PACKAGED_EXE points at a built executable, e.g.
 * `apps/desktop/release/win-unpacked/The Insectoids.exe` (or the installed one). It checks what only packaging can
 * break: the resources layout (helper scripts, wasm files, the library), the Brain host starting from inside the
 * app archive, the code map's tree-sitter, and a goal reaching its plan. It still uses a throwaway data folder
 * (INSECTOIDS_E2E), so it never touches the real Brain.
 */
const exe = process.env['INSECTOIDS_PACKAGED_EXE'];
type Win = { insectoids: { hive: HiveApi; brainStatus(): Promise<{ state: string; message: string }> } };

test.skip(!exe, 'Set INSECTOIDS_PACKAGED_EXE to a built app to run this.');

let t: LaunchedApp;
test.beforeAll(async () => {
  t = await launchApp({ executablePath: exe! });
});
test.afterAll(async () => {
  await t?.close();
});

test('the packaged app starts, finds its resources, and a goal reaches its plan', async () => {
  test.setTimeout(120_000);
  const { app, win } = t;
  const info = await app.evaluate(({ app: a }) => ({ packaged: a.isPackaged, resources: process.resourcesPath, version: a.getVersion() }));
  expect(info.packaged).toBe(true);
  for (const f of ['doors/guard-hook.mjs', 'doors/brain-mcp.mjs', 'doors/brain.mjs', 'doors/hive-tools-mcp.mjs', 'doors/services-mcp.mjs', 'ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.mjs', 'tree-sitter/tree-sitter.wasm', 'library']) {
    expect(existsSync(join(info.resources, f)), f).toBe(true);
  }

  // The Brain host runs from the app archive.
  await expect
    .poll(async () => (await win.evaluate(() => (globalThis as unknown as Win).insectoids.brainStatus())).state, { timeout: 30_000 })
    .toBe('ready');
  // The code map (tree-sitter from resources) maps the test project.
  await expect
    .poll(async () => (await win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot())).codeMap.state, { timeout: 30_000 })
    .toBe('ready');
  // The library loads (the castes come from resources/library).
  expect((await win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.libraryCastes())).length).toBeGreaterThan(0);

  // A goal reaches its plan with the scripted engine.
  await expect(win.getByLabel('Message the Queen')).toBeEnabled({ timeout: 30_000 });
  expect(await win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.command({ type: 'submitGoal', text: 'Say hello from the hive' }))).toEqual({ ok: true });
  await expect
    .poll(async () => (await win.evaluate(() => (globalThis as unknown as Win).insectoids.hive.snapshot())).approvals.some((a) => a.kind === 'plan' && a.status === 'waiting'), { timeout: 60_000 })
    .toBe(true);
});
