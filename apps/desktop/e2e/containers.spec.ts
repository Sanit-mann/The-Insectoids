import AxeBuilder from '@axe-core/playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { type ContainerStatus, DEFAULT_CONTAINER_IMAGE, type HiveApi } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';

/**
 * Container mode (Phase 4 D1) with the fake runtime (packages/workspace/src/fake-runtime.mjs), which stands in for
 * docker: INSECTOIDS_E2E_CONTAINER_RUNTIME names it and INSECTOIDS_E2E_CONTAINER_NODE the Node that runs it (this
 * test's own; the app's executable can't act as Node for it). Nothing here starts a real container or downloads
 * anything. The scripted engine never calls run_shell, so this checks the setting, the words, the download, that
 * cards are refused while it isn't usable and run once it is, and that the setting survives a Brain host restart.
 */
const FAKE_RUNTIME = fileURLToPath(new URL('../../../packages/workspace/src/fake-runtime.mjs', import.meta.url));
const THEMES = ['dark', 'light'] as const;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** The scripted Queen plans this goal as one wave with one card (no plan approval). */
const GOAL = 'Add a farewell function to the site';

const status = (win: Page): Promise<ContainerStatus> => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.containers.status());
const snapshot = (win: Page) => win.evaluate(() => (globalThis as unknown as AppWindow).insectoids.hive.snapshot());
const command = (win: Page, cmd: Parameters<HiveApi['command']>[0]) => win.evaluate((c) => (globalThis as unknown as AppWindow).insectoids.hive.command(c), cmd);

async function openSettings(win: Page): Promise<void> {
  await expect(win.getByTestId('brain-status')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Settings/ }).click();
  await expect(win.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible({ timeout: 15_000 });
  await win.getByRole('heading', { level: 2, name: 'Containers' }).scrollIntoViewIfNeeded();
}

/** axe on the Containers section in both themes; serious and critical findings fail. */
async function axe(win: Page, state: string): Promise<void> {
  const serious: string[] = [];
  for (const theme of THEMES) {
    await win.evaluate((t) => {
      (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['theme'] = t;
    }, theme);
    await win.waitForTimeout(300);
    const r = await new AxeBuilder({ page: win }).setLegacyMode(true).include('[data-testid="containers"]').withTags(TAGS).analyze();
    for (const v of r.violations) {
      if (v.impact === 'serious' || v.impact === 'critical') serious.push(`[${theme}] ${state}: ${v.id} ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    }
  }
  await win.evaluate(() => {
    (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset['theme'] = 'dark';
  });
  expect(serious, 'serious or critical accessibility findings').toEqual([]);
}

let t: LaunchedApp | null = null;
let scratch: string;

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'insectoids-e2e-box-'));
});

test.afterEach(async () => {
  await t?.close();
  t = null;
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

test('no runtime: plain words with where to get one; switched on, cards wait and never run on the computer', async () => {
  test.setTimeout(120_000);
  // A runtime program that can't start = neither Docker nor Podman found.
  t = await launchApp({
    env: { INSECTOIDS_E2E_CONTAINER_RUNTIME: FAKE_RUNTIME, INSECTOIDS_E2E_CONTAINER_NODE: join(scratch, 'no-such-node.exe') },
  });
  const { win } = t;
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await openSettings(win);
  const box = win.getByTestId('containers');
  await expect(box).toHaveAttribute('data-runtime', 'missing', { timeout: 30_000 });
  const words = box.getByTestId('containers-status');
  await expect(words).toContainText('Neither Docker nor Podman is on this computer');
  await expect(words).toContainText('the app never installs one');
  await expect(box.getByRole('link', { name: /Get Docker Desktop/ })).toHaveAttribute('href', 'https://www.docker.com/products/docker-desktop/');
  await expect(box.getByRole('link', { name: /Get Podman Desktop/ })).toHaveAttribute('href', 'https://podman-desktop.io/');
  // No download is offered without a runtime.
  await expect(box.getByTestId('containers-download')).toHaveCount(0);
  await axe(win, 'no runtime');

  // Every card (D2's three-way choice), anyway: the card that would run commands waits with the reason, and the hive pauses.
  const mode = (name: string) => box.getByRole('radiogroup', { name: 'When to use a container' }).getByRole('radio', { name, exact: true });
  await mode('Every card').click();
  await expect(mode('Every card')).toHaveAttribute('aria-checked', 'true');
  expect(await command(win, { type: 'setManagers', scoutBeforePlanning: false })).toEqual({ ok: true });
  expect(await command(win, { type: 'submitGoal', text: GOAL })).toEqual({ ok: true });
  await expect.poll(async () => (await snapshot(win)).hive.pausedReason ?? '', { timeout: 30_000 }).toMatch(/^Container mode: Neither Docker nor Podman is on this computer/);
  const s = await snapshot(win);
  expect(s.cards.map((c) => c.status)).toEqual(['blocked']);
  expect(s.agents.filter((a) => a.role === 'insect')).toEqual([]);

  // Switched off: the hive carries on by itself, with commands on the computer as before.
  await mode('Off').click();
  await expect(mode('Off')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await snapshot(win)).approvals.some((a) => a.status === 'waiting' && a.kind === 'merge'), { timeout: 60_000 }).toBe(true);
  expect((await snapshot(win)).hive.paused).toBe(false);
});

test('runtime ready, image missing: the download names the image, shows progress, then cards run in containers; it survives a host restart', async () => {
  test.setTimeout(180_000);
  const log = join(scratch, 'runtime.log');
  t = await launchApp({
    env: {
      INSECTOIDS_E2E_CONTAINER_RUNTIME: FAKE_RUNTIME,
      INSECTOIDS_E2E_CONTAINER_NODE: process.execPath,
      FAKE_RUNTIME_STATE: join(scratch, 'state.json'),
      FAKE_RUNTIME_LOG: log,
      // About 20 s, so the progress is there to see (and to scan).
      FAKE_RUNTIME_PULL: 'slow',
    },
  });
  const { win } = t;
  await win.emulateMedia({ reducedMotion: 'reduce' });
  await openSettings(win);
  const box = win.getByTestId('containers');
  await expect(box).toHaveAttribute('data-runtime', 'ready', { timeout: 30_000 });
  await expect(box.getByTestId('containers-status')).toHaveText(
    "Docker 27.3.1 is ready, but the image isn't on this computer yet. Download the image (about 80 MB) on the Containers settings.",
  );
  // The consent names the exact image and its size before anything downloads.
  const panel = box.getByTestId('containers-download-panel');
  await expect(panel.getByTestId('containers-download-image')).toHaveText(DEFAULT_CONTAINER_IMAGE);
  await expect(panel).toContainText('(about 80 MB)');
  await expect(panel).toContainText('nothing downloads until you press the button');
  expect(readFileSync(log, 'utf8')).not.toMatch(/"pull"/);
  await axe(win, 'image missing');

  const download = panel.getByRole('button', { name: 'Download image' });
  await download.click();
  await expect(panel.getByRole('button', { name: 'Downloading…' })).toBeFocused();
  const progress = panel.getByRole('log', { name: 'Download progress' });
  await expect(progress).toContainText(/Downloading\s+\d+MB\/200MB/, { timeout: 15_000 });
  await axe(win, 'downloading');
  await expect(box.getByTestId('containers-status')).toContainText('is ready and the image is on this computer', { timeout: 60_000 });
  expect(readFileSync(log, 'utf8')).toContain(JSON.stringify(['pull', DEFAULT_CONTAINER_IMAGE]));
  // Leftovers from a crash are looked for once, by label.
  expect(readFileSync(log, 'utf8')).toContain('"label=io.insectoids.run"');

  // Every card: usable, and a goal's card runs (the scripted engine gets the container in its guard).
  await box.getByRole('radiogroup', { name: 'When to use a container' }).getByRole('radio', { name: 'Every card', exact: true }).click();
  await expect(box).toHaveAttribute('data-usable', 'true');
  await expect(box.getByTestId('containers-status')).toContainText("Container mode is on: every card's commands run in a Docker container");
  await axe(win, 'on and ready');
  expect(await command(win, { type: 'setManagers', scoutBeforePlanning: false })).toEqual({ ok: true });
  expect(await command(win, { type: 'submitGoal', text: GOAL })).toEqual({ ok: true });
  await expect.poll(async () => (await snapshot(win)).approvals.some((a) => a.status === 'waiting' && a.kind === 'merge'), { timeout: 60_000 }).toBe(true);
  expect((await snapshot(win)).hive.paused).toBe(false);

  // A bad image is refused in words, next to the field.
  const image = box.getByLabel('Image', { exact: true });
  await image.fill('node:22; rm -rf /');
  await box.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(box.getByTestId('containers-image-error')).toContainText('isn’t an image name the app can use');
  await expect(image).toHaveAttribute('aria-invalid', 'true');
  await axe(win, 'invalid image');
  await box.getByRole('button', { name: 'Use the default image' }).click();

  // The Brain host restarts (as after a crash): the setting is read back from the host's settings file.
  const pid = await t.app.evaluate(({ app }) => app.getAppMetrics().find((m) => m.serviceName === 'Insectoids Brain' || m.name === 'Insectoids Brain')?.pid ?? null);
  expect(pid).not.toBeNull();
  process.kill(pid!, 'SIGKILL');
  await expect
    .poll(async () => {
      const s = await status(win).catch(() => null);
      return s ? `${s.settings.mode} ${s.runtime.state} ${s.usable}` : 'down';
    }, { timeout: 60_000 })
    .toBe('always ready true');
  expect(existsSync(join(scratch, 'state.json'))).toBe(true);
});
