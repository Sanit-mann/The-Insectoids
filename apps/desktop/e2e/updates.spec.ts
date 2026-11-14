import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { E2E_UPDATE_FEED_ENV, type UpdateState, type UpdateStatus } from '@insectoids/shared';
import { type AppWindow, type LaunchedApp, launchApp } from './support/launch';
import { type UpdateFeed, channelFile, closedFeedUrl, installerName, startUpdateFeed } from './support/update-feed';

/**
 * Update checks (Phase 3 C4, Tech stack 09-D4). The app is pointed at a fake generic-provider feed on 127.0.0.1
 * (INSECTOIDS_E2E_UPDATE_FEED, see support/update-feed.ts). Under e2e with that feed `canInstall` is true and checks
 * happen only on demand (no check a minute after start), so the feed's request count is exact. "Restart to update"
 * sets `globalThis.__insectoidsE2E.updateRestartRequested` in main instead of quitting.
 */
type Win = AppWindow & { __updateStatusesSeen?: UpdateStatus[] };
type E2EGlobal = { __insectoidsE2E?: { updateRestartRequested?: boolean } };

const pkgVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

const parts = (v: string): [number, number, number] => {
  const [major, minor, patch] = v.split(/[.+-]/).map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
};
/** The app's version with the patch +1, e.g. 0.0.2 -> 0.0.3. */
const newerThan = (v: string): string => {
  const [a, b, c] = parts(v);
  return `${a}.${b}.${c + 1}`;
};
/** A version below the app's (null for 0.0.0). */
const olderThan = (v: string): string | null => {
  const [a, b, c] = parts(v);
  if (c > 0) return `${a}.${b}.${c - 1}`;
  if (b > 0) return `${a}.${b - 1}.0`;
  if (a > 0) return `${a - 1}.0.0`;
  return null;
};

const NOTES = 'Faster checks and a calmer tray.';

const state = (win: Page): Promise<UpdateState> => win.evaluate(() => (globalThis as unknown as Win).insectoids.updates.state());

/** Records every status main sends from now on (onChanged), so short-lived ones like "downloading" are not missed. */
const recordStatuses = (win: Page): Promise<void> =>
  win.evaluate(() => {
    const g = globalThis as unknown as Win;
    g.__updateStatusesSeen = [];
    g.insectoids.updates.onChanged((s) => g.__updateStatusesSeen?.push(s.status));
  });
const statusesSeen = (win: Page): Promise<UpdateStatus[]> => win.evaluate(() => (globalThis as unknown as Win).__updateStatusesSeen ?? []);

/** Asks for a check (API) and waits until the feed was asked and the check is over; returns the state. */
async function checkNow(win: Page, feed: UpdateFeed): Promise<UpdateState> {
  const before = feed.ymlRequests();
  await win.evaluate(() => (globalThis as unknown as Win).insectoids.updates.check());
  await expect
    .poll(async () => feed.ymlRequests() > before && (await state(win)).status !== 'checking', { timeout: 20_000 })
    .toBe(true);
  return state(win);
}

/** The words a person reads: there, short, and no stack trace or updater internals. */
function expectPlainWords(message: string): void {
  expect(message.trim().length).toBeGreaterThan(0);
  expect(message.length).toBeLessThan(400);
  expect(message).not.toMatch(/\n\s*at\s/); // stack frames
  expect(message).not.toMatch(/\bat\s+\S+\s+\(/); // "at fn (file:1:2)"
  expect(message).not.toMatch(/\.(js|ts):\d+/);
  expect(message).not.toMatch(/ERR_UPDATER_|HttpError|Headers:|node_modules|<html/i);
}

const restartRequested = (t: LaunchedApp): Promise<boolean> =>
  t.app.evaluate(() => (globalThis as unknown as E2EGlobal).__insectoidsE2E?.updateRestartRequested === true);

const nav = (win: Page, name: string) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name, exact: true });

/** The Updates section of Settings. */
function ui(win: Page) {
  // the section's test id, the switch's name and the status's test id.
  const box = win.getByTestId('updates');
  return {
    box,
    sw: box.getByRole('switch', { name: 'Check for updates' }),
    status: win.getByTestId('updates-status'),
    // the three buttons' names.
    checkNow: box.getByRole('button', { name: 'Check now', exact: true }),
    download: box.getByRole('button', { name: 'Download', exact: true }),
    restart: box.getByRole('button', { name: 'Restart to update', exact: true }),
  };
}

let feed: UpdateFeed | undefined;
let t: LaunchedApp | undefined;

async function open(feedUrl: string): Promise<LaunchedApp> {
  t = await launchApp({ env: { [E2E_UPDATE_FEED_ENV]: feedUrl } });
  return t;
}

test.afterEach(async () => {
  await t?.close();
  t = undefined;
  await feed?.close();
  feed = undefined;
});

// The updater keeps downloads in the OS cache folder under the e2e-only name (see update-ipc.ts): remove it afterwards.
test.afterAll(() => {
  const cache = process.platform === 'win32' ? process.env['LOCALAPPDATA'] : process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : (process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'));
  if (cache) rmSync(join(cache, 'insectoids-e2e-updater'), { recursive: true, force: true });
});

test('a newer version: Check now offers it, Download fetches it, Restart to update asks to install', async () => {
  const newer = newerThan(pkgVersion);
  feed = await startUpdateFeed({ version: newer, notes: NOTES });
  const { win } = await open(feed.url);

  const s0 = await state(win);
  expect(s0.currentVersion).toBe(pkgVersion);
  expect(s0.enabled).toBe(true);
  expect(s0.canInstall).toBe(true);
  // On demand only: nothing was fetched at start.
  expect(s0.status).not.toBe('unsupported');
  expect(feed.ymlRequests()).toBe(0);

  await nav(win, 'Settings').click();
  const u = ui(win);
  await expect(u.sw).toHaveAttribute('aria-checked', 'true');

  // Check now -> "available", naming the version.
  await u.checkNow.click();
  await expect.poll(async () => (await state(win)).status, { timeout: 20_000 }).toBe('available');
  expect(feed.paths).toContain(`/${channelFile()}`);
  const available = await state(win);
  expect(available.latestVersion).toBe(newer);
  expect(available.message).toContain(newer);
  expectPlainWords(available.message);
  expect(available.notes ?? '').toContain(NOTES);
  await expect(u.status).toContainText(available.message);
  await expect(u.status).toContainText(newer);
  expect(feed.installerRequests(), 'nothing downloads until asked').toBe(0);

  // Download -> "downloading" -> "ready" (the installer's sha512 checks out).
  await recordStatuses(win);
  await u.download.click();
  await expect.poll(async () => (await state(win)).status, { timeout: 25_000 }).toBe('ready');
  const seen = await statusesSeen(win);
  expect(seen, seen.join(' > ')).toContain('downloading');
  expect(seen.indexOf('downloading')).toBeLessThan(seen.lastIndexOf('ready'));
  expect(feed.paths).toContain(`/${installerName(newer)}`);
  const ready = await state(win);
  expect(ready.latestVersion).toBe(newer);
  expectPlainWords(ready.message);
  expect(ready.message).not.toBe(available.message);
  await expect(u.status).toContainText(ready.message);

  // Restart to update -> main is asked to quit and install (under e2e it only records that; the app stays up).
  expect(await restartRequested(t!)).toBe(false);
  await u.restart.click();
  await expect.poll(() => restartRequested(t!), { timeout: 10_000 }).toBe(true);
  expect(t!.app.windows().length).toBeGreaterThan(0);
  expect((await state(win)).currentVersion).toBe(pkgVersion);
});

test('the same or an older version is "up to date" and never offered', async () => {
  feed = await startUpdateFeed({ version: pkgVersion, notes: NOTES });
  const { win } = await open(feed.url);

  const same = await checkNow(win, feed);
  expect(same.status).toBe('up-to-date');
  expectPlainWords(same.message);

  const older = olderThan(pkgVersion);
  if (older) {
    feed.serve({ version: older, notes: NOTES });
    const s = await checkNow(win, feed);
    expect(s.status, 'never a downgrade').toBe('up-to-date');
    expectPlainWords(s.message);
  }

  await nav(win, 'Settings').click();
  const u = ui(win);
  await expect(u.status).toContainText((await state(win)).message);
  await expect(u.download).toHaveCount(0);
  await expect(u.restart).toHaveCount(0);
  expect(feed.installerRequests()).toBe(0);
});

test('switched off: nothing is fetched, Settings says so; back on, checks work again', async () => {
  feed = await startUpdateFeed({ version: newerThan(pkgVersion), notes: NOTES });
  const { win } = await open(feed.url);

  const off = await win.evaluate(() => (globalThis as unknown as Win).insectoids.updates.setEnabled(false));
  expect(off).toMatchObject({ enabled: false, status: 'off' });
  expectPlainWords(off.message);

  const before = feed.paths.length;
  const afterCheck = await win.evaluate(() => (globalThis as unknown as Win).insectoids.updates.check());
  expect(afterCheck.status).toBe('off');
  // Give a stray request time to arrive.
  await win.waitForTimeout(3_000);
  expect(feed.paths.length, `requests while off: ${feed.paths.slice(before).join(', ')}`).toBe(before);
  expect((await state(win)).status).toBe('off');

  await nav(win, 'Settings').click();
  const u = ui(win);
  await expect(u.sw).toHaveAttribute('aria-checked', 'false');
  await expect(u.status).toContainText(off.message);
  await expect(u.status).toHaveText(/\boff\b/i);

  // Back on with the switch.
  await u.sw.click();
  await expect(u.sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await state(win)).enabled, { timeout: 10_000 }).toBe(true);
  expect((await state(win)).status).not.toBe('off');
  await expect(u.status).not.toHaveText(off.message);

  const yml = feed.ymlRequests();
  await u.checkNow.click();
  await expect.poll(() => feed!.ymlRequests(), { timeout: 20_000 }).toBe(yml + 1);
  await expect.poll(async () => (await state(win)).status, { timeout: 20_000 }).toBe('available');
});

test('a broken feed (HTTP 500) is an error in plain words; a later check recovers', async () => {
  feed = await startUpdateFeed({ failWith: 500 });
  const { win } = await open(feed.url);

  const s = await checkNow(win, feed);
  expect(s.status).toBe('error');
  expectPlainWords(s.message);
  await nav(win, 'Settings').click();
  const u = ui(win);
  await expect(u.status).toContainText(s.message);
  await expect(u.download).toHaveCount(0);

  // Not sticky: the feed is fixed and the next check finds the release.
  feed.serve({ version: newerThan(pkgVersion), notes: NOTES });
  const again = await checkNow(win, feed);
  expect(again.status).toBe('available');
});

test('an unreachable feed (nothing listening) is an error in plain words', async () => {
  const { win } = await open(await closedFeedUrl());
  await win.evaluate(() => (globalThis as unknown as Win).insectoids.updates.check());
  // electron-updater retries a refused connection three times (about 3 s) before it gives up.
  await expect.poll(async () => (await state(win)).status, { timeout: 25_000 }).toBe('error');
  const s = await state(win);
  expectPlainWords(s.message);
  await nav(win, 'Settings').click();
  await expect(ui(win).status).toContainText(s.message);
});
