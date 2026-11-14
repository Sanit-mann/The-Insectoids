import { EventEmitter } from 'node:events';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateStateSchema, type UpdateState } from '@insectoids/shared';
import {
  type AutoUpdaterLike,
  CHECK_EVERY_MS,
  FIRST_CHECK_DELAY_MS,
  Updater,
  type UpdaterDeps,
  canInstallOn,
  checkedWords,
  isGitHubUrl,
  isNewerRelease,
  plainNotes,
  reasonWords,
} from './updater';

/** A fake electron-updater: each check answers with the scripted latest version (or error), the way the real one emits. */
class FakeAutoUpdater implements AutoUpdaterLike {
  readonly #events = new EventEmitter();
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  forceDevUpdateConfig = false;
  requestHeaders: OutgoingHttpHeaders | null = null;
  updateConfigPath: string | null = null;
  current = '0.0.3';
  latest: string | null = '0.0.3';
  checkError: Error | null = null;
  downloadError: Error | null = null;
  notes: string | null = null;
  setFeedURL = vi.fn();
  quitAndInstall = vi.fn();
  on(event: string, listener: (...args: never[]) => void): this {
    this.#events.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    this.#events.emit(event, ...args);
  }
  checkForUpdates = vi.fn(async (): Promise<unknown> => {
    this.emit('checking-for-update');
    if (this.checkError) {
      this.emit('error', this.checkError);
      throw this.checkError;
    }
    const info = { version: this.latest ?? '', releaseNotes: this.notes };
    // Like the real one: only a strictly newer version (no downgrade) is "available".
    if (isNewerRelease(info.version, this.current) || (this.allowDowngrade && info.version !== this.current)) this.emit('update-available', info);
    else this.emit('update-not-available', info);
    return { updateInfo: info };
  });
  downloadUpdate = vi.fn(async () => {
    await Promise.resolve();
    if (this.downloadError) {
      this.emit('error', this.downloadError);
      throw this.downloadError;
    }
    this.emit('download-progress', { percent: 42.7 });
    await Promise.resolve();
    this.emit('update-downloaded', { version: this.latest });
    return [];
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(over: Partial<UpdaterDeps> = {}, configure?: (f: FakeAutoUpdater) => void) {
  const fake = new FakeAutoUpdater();
  configure?.(fake);
  const changes: UpdateState[] = [];
  const factory = vi.fn(() => fake);
  const deps: UpdaterDeps = {
    currentVersion: '0.0.3',
    platform: 'win32',
    isPackaged: true,
    e2e: false,
    enabled: true,
    autoUpdater: factory,
    saveEnabled: vi.fn(),
    onChange: (s) => changes.push(s),
    beforeQuit: vi.fn(),
    e2eRestartRequested: vi.fn(),
    openExternal: vi.fn(),
    now: () => new Date(2026, 10, 14, 10, 42).getTime(),
    ...over,
  };
  const updater = new Updater(deps);
  return { updater, fake, factory, changes, deps };
}

describe('Updater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle, and sets electron-updater up to never download, install, downgrade or take a pre-release by itself', async () => {
    const { updater, fake } = setup();
    expect(updater.state).toMatchObject({ enabled: true, status: 'idle', canInstall: true, currentVersion: '0.0.3' });
    await updater.check();
    expect(fake).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false, forceDevUpdateConfig: false });
    // Nothing about the user: electron-updater's per-install staging id is replaced with one constant.
    expect(fake.requestHeaders).toEqual({ 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' });
    expect(fake.setFeedURL).not.toHaveBeenCalled();
  });

  it('a newer version is available; download shows progress, then ready; restart quits and installs', async () => {
    const { updater, fake, changes, deps } = setup({}, (f) => {
      f.latest = '0.0.4';
      f.notes = '<h2>What&#39;s new</h2><ul><li>Faster &amp; calmer</li></ul>';
    });
    // Restart does nothing before an update is ready.
    updater.restartToUpdate();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    const s = await updater.check();
    expect(s).toMatchObject({
      status: 'available',
      latestVersion: '0.0.4',
      releaseUrl: 'https://github.com/Sanit-mann/The-Insectoids/releases/tag/v0.0.4',
      notes: "What's new\n- Faster & calmer",
      message: "Version 0.0.4 is out. Download it, then restart when you're ready.",
    });
    expect(s.checkedAt).toBe(deps.now!());
    expect(changes.map((c) => c.status)).toEqual(['checking', 'available']);

    updater.restartToUpdate();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    expect(updater.download()).toMatchObject({ status: 'downloading', progress: 0, message: 'Downloading 0.0.4: 0%.' });
    await flush();
    expect(changes.find((c) => c.status === 'downloading' && (c.progress ?? 0) > 0)?.message).toBe('Downloading 0.0.4: 42%.');
    expect(updater.state).toMatchObject({
      status: 'ready',
      progress: null,
      message: '0.0.4 is ready. Restart to update; your Brain and settings stay as they are.',
    });
    for (const c of changes) expect(UpdateStateSchema.safeParse(c).success).toBe(true);

    updater.restartToUpdate();
    expect(deps.beforeQuit).toHaveBeenCalledOnce();
    expect(fake.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(vi.mocked(deps.beforeQuit).mock.invocationCallOrder[0]!).toBeLessThan(fake.quitAndInstall.mock.invocationCallOrder[0]!);
  });

  it('the same version is up to date', async () => {
    const { updater } = setup();
    expect(await updater.check()).toMatchObject({
      status: 'up-to-date',
      latestVersion: null,
      releaseUrl: null,
      message: 'You have the latest version (0.0.3). Checked today 10:42.',
    });
  });

  it('an older or pre-release version is up to date, never a downgrade, even if the updater says "available"', async () => {
    for (const latest of ['0.0.2', '0.0.4-beta.1']) {
      const { updater, fake } = setup({}, (f) => {
        f.latest = latest;
        f.current = '0.0.3';
      });
      // Make the fake misbehave (as if downgrades were on): the Updater still refuses.
      fake.checkForUpdates.mockImplementationOnce(async () => {
        fake.emit('checking-for-update');
        fake.emit('update-available', { version: latest });
        return null;
      });
      expect(await updater.check()).toMatchObject({ status: 'up-to-date', latestVersion: null });
      expect(updater.download().status).toBe('up-to-date');
      expect(fake.downloadUpdate).not.toHaveBeenCalled();
    }
  });

  it('offline and other failures become plain words, never a stack trace', async () => {
    const offline = Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED\n    at Foo (bar.js:1:1)'), {});
    const a = setup({}, (f) => (f.checkError = offline));
    expect(await a.updater.check()).toMatchObject({
      status: 'error',
      message: "You seem to be offline, so updates weren't checked. It tries again tomorrow.",
    });

    const notFound = Object.assign(new Error('Cannot find latest.yml in the latest release artifacts\n    at x (y.js:2:3)'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    const b = setup({}, (f) => (f.checkError = notFound));
    const s = await b.updater.check();
    expect(s.message).toBe("Couldn't check for updates: no published release has an update for this computer yet. It tries again tomorrow.");
    expect(s.message).not.toMatch(/at |\.js|latest\.yml/);

    const weird = setup({}, (f) => (f.checkError = new Error('TypeError: boom\n    at z (z.js:9:9)')));
    expect((await weird.updater.check()).message).toBe("Couldn't check for updates: something went wrong talking to the update server. It tries again tomorrow.");

    // A failed download says so, and a new check brings the Download button back.
    const c = setup({}, (f) => {
      f.latest = '0.0.4';
      f.downloadError = Object.assign(new Error('sha512 checksum mismatch, expected abc'), { code: 'ERR_CHECKSUM_MISMATCH' });
    });
    await c.updater.check();
    c.updater.download();
    await flush();
    expect(c.updater.state).toMatchObject({ status: 'error', message: "Couldn't download 0.0.4: the download didn't match its checksum. Check again to retry." });
    expect((await c.updater.check()).status).toBe('available');
  });

  it('checks about a minute after start, then once a day', async () => {
    const { updater, fake } = setup();
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3);
    updater.dispose();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('off: nothing is fetched, timers stop, the choice is saved; on again schedules the checks', async () => {
    const { updater, fake, factory, deps } = setup({ enabled: false });
    expect(updater.state).toMatchObject({ enabled: false, status: 'off', message: 'Update checks are off. Turn them on to hear about new versions.' });
    updater.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect((await updater.check()).status).toBe('off');
    expect(factory).not.toHaveBeenCalled();
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    expect(updater.setEnabled(true)).toMatchObject({ enabled: true, status: 'idle' });
    expect(deps.saveEnabled).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);

    expect(updater.setEnabled(false)).toMatchObject({ enabled: false, status: 'off' });
    expect(deps.saveEnabled).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('a switch that cannot be saved changes nothing', () => {
    const { updater } = setup({ saveEnabled: () => { throw new Error('EACCES'); } });
    expect(() => updater.setEnabled(false)).toThrow('EACCES');
    expect(updater.state).toMatchObject({ enabled: true, status: 'idle' });
  });

  it('a dev build says checks run in installed builds and never touches electron-updater', async () => {
    const { updater, factory } = setup({ isPackaged: false });
    expect(updater.state).toMatchObject({ status: 'unsupported', canInstall: false, message: 'Update checks run in installed builds.' });
    updater.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect((await updater.check()).status).toBe('unsupported');
    updater.download();
    updater.restartToUpdate();
    expect(factory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('e2e with the fake feed: generic provider, no timers, canInstall, and restart only flags the hook', async () => {
    const { updater, fake, deps } = setup({ isPackaged: false, e2e: true, e2eFeedUrl: 'http://127.0.0.1:4567/', e2eUpdateConfigPath: '/tmp/p/e2e-app-update.yml', platform: 'darwin' }, (f) => (f.latest = '0.0.4'));
    expect(updater.state).toMatchObject({ status: 'idle', canInstall: true, message: 'Not checked yet.' });
    updater.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await updater.check();
    expect(fake.forceDevUpdateConfig).toBe(true);
    expect(fake.updateConfigPath).toBe('/tmp/p/e2e-app-update.yml');
    expect(fake.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:4567/' });
    updater.download();
    await flush();
    expect(updater.state.status).toBe('ready');
    updater.restartToUpdate();
    expect(deps.beforeQuit).toHaveBeenCalledOnce();
    expect(deps.e2eRestartRequested).toHaveBeenCalledOnce();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('the e2e feed is ignored outside e2e', () => {
    const { updater } = setup({ isPackaged: false, e2e: false, e2eFeedUrl: 'http://127.0.0.1:4567/' });
    expect(updater.state.status).toBe('unsupported');
  });

  it("where the app can't replace itself (macOS, .deb) it offers the release page, never a download or restart", async () => {
    const { updater, fake, deps } = setup({ platform: 'darwin' }, (f) => (f.latest = '0.0.4'));
    expect(await updater.check()).toMatchObject({ status: 'available', canInstall: false, message: 'Version 0.0.4 is out. Download it from its release page.' });
    expect(updater.download().status).toBe('available');
    expect(fake.downloadUpdate).not.toHaveBeenCalled();
    updater.openRelease();
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/Sanit-mann/The-Insectoids/releases/tag/v0.0.4');
  });

  it('openRelease opens only the github.com page the last check found', async () => {
    const none = setup();
    none.updater.openRelease();
    expect(none.deps.openExternal).not.toHaveBeenCalled();

    const other = setup({ releasePage: (v) => `https://evil.example/releases/${v}` }, (f) => (f.latest = '0.0.4'));
    await other.updater.check();
    other.updater.openRelease();
    expect(other.deps.openExternal).not.toHaveBeenCalled();

    const lookalike = setup({ releasePage: () => 'https://github.com.evil.example/x' }, (f) => (f.latest = '0.0.4'));
    await lookalike.updater.check();
    lookalike.updater.openRelease();
    expect(lookalike.deps.openExternal).not.toHaveBeenCalled();
  });

  it('a check already running is joined, not repeated; changes are only pushed when something changed', async () => {
    const { updater, fake, changes } = setup();
    await Promise.all([updater.check(), updater.check()]);
    expect(fake.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(changes.map((c) => c.status)).toEqual(['checking', 'up-to-date']);
  });
});

describe('canInstallOn', () => {
  it('Windows and the AppImage can replace themselves; macOS, the .deb and dev builds cannot', () => {
    expect(canInstallOn({ platform: 'win32', isPackaged: true, e2eFeed: false })).toBe(true);
    expect(canInstallOn({ platform: 'linux', isPackaged: true, appImage: '/home/u/The-Insectoids.AppImage', e2eFeed: false })).toBe(true);
    expect(canInstallOn({ platform: 'linux', isPackaged: true, e2eFeed: false })).toBe(false);
    expect(canInstallOn({ platform: 'darwin', isPackaged: true, e2eFeed: false })).toBe(false);
    expect(canInstallOn({ platform: 'win32', isPackaged: false, e2eFeed: false })).toBe(false);
    expect(canInstallOn({ platform: 'darwin', isPackaged: false, e2eFeed: true })).toBe(true);
  });
});

describe('helpers', () => {
  it('isNewerRelease: strictly newer published releases only', () => {
    expect(isNewerRelease('0.0.4', '0.0.3')).toBe(true);
    expect(isNewerRelease('0.1.0', '0.0.9')).toBe(true);
    expect(isNewerRelease('0.0.10', '0.0.9')).toBe(true);
    expect(isNewerRelease('0.0.3', '0.0.3')).toBe(false);
    expect(isNewerRelease('0.0.2', '0.0.3')).toBe(false);
    expect(isNewerRelease('0.0.4-beta.1', '0.0.3')).toBe(false);
    expect(isNewerRelease('0.0.3', '0.0.3-beta.2')).toBe(true);
    expect(isNewerRelease('not a version', '0.0.3')).toBe(false);
  });

  it('checkedWords', () => {
    const now = new Date(2026, 10, 14, 18, 0).getTime();
    expect(checkedWords(new Date(2026, 10, 14, 9, 5).getTime(), now)).toBe('today 09:05');
    expect(checkedWords(new Date(2026, 10, 13, 23, 59).getTime(), now)).toBe('yesterday 23:59');
    expect(checkedWords(new Date(2026, 11, 3, 10, 42).getTime(), new Date(2026, 11, 20).getTime())).toBe('3 Dec 10:42');
  });

  it('plainNotes strips HTML, keeps it short, and gives null when empty', () => {
    expect(plainNotes(null)).toBeNull();
    expect(plainNotes('<p></p>')).toBeNull();
    expect(plainNotes([{ version: '0.0.4', note: '<p>One</p>' }, { version: '0.0.3', note: null }])).toBe('One');
    const long = plainNotes(`<p>${'a'.repeat(10_000)}</p>`)!;
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reasonWords', () => {
    expect(reasonWords(new Error('getaddrinfo ENOTFOUND github.com'))).toEqual({ offline: true, words: 'you seem to be offline' });
    expect(reasonWords(new Error('net::ERR_CONNECTION_TIMED_OUT')).words).toBe('the update server took too long to answer');
    expect(reasonWords(Object.assign(new Error('HttpError: 403 Forbidden'), { statusCode: 403 })).words).toBe('GitHub is limiting requests right now');
    expect(reasonWords(Object.assign(new Error('HttpError: 503'), { statusCode: 503 })).words).toBe('the update server had a problem');
    expect(reasonWords('weird').words).toBe('something went wrong talking to the update server');
  });

  it('isGitHubUrl', () => {
    expect(isGitHubUrl('https://github.com/Sanit-mann/The-Insectoids/releases/tag/v0.0.4')).toBe(true);
    expect(isGitHubUrl('http://github.com/x')).toBe(false);
    expect(isGitHubUrl('https://github.com.evil.example/x')).toBe(false);
    expect(isGitHubUrl('https://user@github.com/x')).toBe(false);
    expect(isGitHubUrl('javascript:alert(1)')).toBe(false);
  });
});
