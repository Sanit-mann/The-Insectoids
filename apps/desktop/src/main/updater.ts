import type { OutgoingHttpHeaders } from 'node:http';
import type { UpdateState, UpdateStatus } from '@insectoids/shared';

/**
 * Update checks (Tech stack 09-D4; Phase 3 C4). Wraps electron-updater's `autoUpdater` (injected, so tests use a fake)
 * and owns the state the Settings screen shows. It never downloads or installs on its own: the user presses Download,
 * then Restart. See packages/shared/src/update-api.ts for the whole contract.
 */

/** The first automatic check runs about a minute after start, then once a day (while the switch is on). */
export const FIRST_CHECK_DELAY_MS = 60_000;
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** The project's GitHub Releases; each version's page is <this>/tag/v<version>. */
export const RELEASES_PAGE = 'https://github.com/Sanit-mann/The-Insectoids/releases';
const NOTES_MAX = 4000;
/**
 * electron-updater sends an "x-user-staging-id" header holding a random id it keeps in the profile (for staged
 * rollouts, which this project does not use). The same constant for every install, so a check says nothing about
 * who is asking.
 */
const NIL_STAGING_ID = '00000000-0000-0000-0000-000000000000';

/** What electron-updater reports about a release (the subset used here). */
export interface UpdateInfoLike {
  version: string;
  releaseNotes?: string | ReadonlyArray<{ version: string; note?: string | null }> | null;
}

/** The subset of electron-updater's `autoUpdater` the Updater uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  forceDevUpdateConfig: boolean;
  requestHeaders: OutgoingHttpHeaders | null;
  /** Where electron-updater reads its app-update.yml (e2e only: dev builds have none, and downloads need one). */
  updateConfigPath: string | null;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface UpdaterDeps {
  currentVersion: string;
  platform: NodeJS.Platform;
  /** app.isPackaged: only installed builds check (or e2e with its fake feed). */
  isPackaged: boolean;
  /** process.env.APPIMAGE: set when running from the Linux AppImage, which can replace itself. */
  appImage?: string | undefined;
  /** INSECTOIDS_E2E=1: no timers, checks only on demand, restart only flags the e2e hook. */
  e2e: boolean;
  /** e2e only (INSECTOIDS_E2E_UPDATE_FEED): a generic-provider URL standing in for GitHub. */
  e2eFeedUrl?: string | undefined;
  /** e2e only: an update config written into the throwaway profile (see writeE2EUpdateConfig). */
  e2eUpdateConfigPath?: string | undefined;
  /** The switch as stored in app.json (on unless `updates: false`). */
  enabled: boolean;
  /** Created on first use only, so a dev build or a switched-off app never touches electron-updater. */
  autoUpdater: () => AutoUpdaterLike;
  saveEnabled: (enabled: boolean) => void;
  onChange: (state: UpdateState) => void;
  /** Sets the app's own quitting flag, so the tray doesn't keep the app alive. */
  beforeQuit: () => void;
  /** e2e only: what "Restart to update" does instead of quitting. */
  e2eRestartRequested: () => void;
  openExternal: (url: string) => void | Promise<void>;
  now?: () => number;
  /** Each version's release page; tests pass another to check openRelease refuses it. */
  releasePage?: (version: string) => string;
  log?: (line: string) => void;
}

interface Failure {
  phase: 'check' | 'download';
  offline: boolean;
  words: string;
}

const BUSY: ReadonlySet<UpdateStatus> = new Set(['checking', 'downloading', 'ready']);

export class Updater {
  readonly #d: UpdaterDeps;
  readonly #now: () => number;
  readonly #feed: string | null;
  #au: AutoUpdaterLike | null = null;
  #enabled: boolean;
  #status: UpdateStatus;
  #latest: string | null = null;
  #releaseUrl: string | null = null;
  #notes: string | null = null;
  #progress: number | null = null;
  #checkedAt: number | null = null;
  #failure: Failure | null = null;
  #checking: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastSent = '';

  constructor(d: UpdaterDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.#feed = d.e2e && d.e2eFeedUrl && /^https?:\/\//i.test(d.e2eFeedUrl) ? d.e2eFeedUrl : null;
    this.#enabled = d.enabled;
    this.#status = this.#restingStatus();
    this.#lastSent = JSON.stringify(this.state);
  }

  /** Installed builds (or e2e with the fake feed) check; dev builds only say so. */
  get supported(): boolean {
    return this.#d.isPackaged || this.#feed !== null;
  }

  /** Whether the app can replace itself here: Windows (NSIS) and the Linux AppImage. Never macOS, the .deb or dev. */
  get canInstall(): boolean {
    return canInstallOn({ platform: this.#d.platform, isPackaged: this.#d.isPackaged, appImage: this.#d.appImage, e2eFeed: this.#feed !== null });
  }

  get state(): UpdateState {
    return {
      enabled: this.#enabled,
      status: this.#status,
      currentVersion: this.#d.currentVersion,
      latestVersion: this.#latest,
      releaseUrl: this.#releaseUrl,
      notes: this.#notes,
      progress: this.#progress,
      checkedAt: this.#checkedAt,
      canInstall: this.canInstall,
      message: this.#message(),
    };
  }

  /** Starts the daily checks (about a minute from now first). Call once the app is ready. */
  start(): void {
    this.#schedule(FIRST_CHECK_DELAY_MS);
  }

  dispose(): void {
    this.#clearTimer();
  }

  setEnabled(enabled: boolean): UpdateState {
    if (enabled === this.#enabled) return this.state;
    // Saved first: if app.json can't be written, nothing changes.
    this.#d.saveEnabled(enabled);
    this.#enabled = enabled;
    this.#clearTimer();
    this.#reset();
    this.#status = this.#restingStatus();
    if (enabled) this.#schedule(FIRST_CHECK_DELAY_MS);
    this.#emit();
    return this.state;
  }

  /** "Check now", and the daily check. Waits for the answer; a check already running is joined, not repeated. */
  async check(): Promise<UpdateState> {
    if (this.#checking) {
      await this.#checking;
      return this.state;
    }
    if (!this.#enabled || !this.supported || BUSY.has(this.#status)) return this.state;
    this.#status = 'checking';
    this.#failure = null;
    this.#emit();
    this.#checking = (async () => {
      try {
        await this.#updater().checkForUpdates();
        // No event answered (electron-updater stays quiet when it thinks it isn't installed).
        if (this.#enabled && this.#status === 'checking') this.#fail('check', new Error('ERR_UPDATER_INACTIVE'));
      } catch (err) {
        this.#fail('check', err);
      } finally {
        this.#checking = null;
      }
    })();
    await this.#checking;
    return this.state;
  }

  /** Starts the download of the version the last check found; progress arrives as changes. */
  download(): UpdateState {
    if (!this.#enabled || this.#status !== 'available' || !this.canInstall) return this.state;
    this.#status = 'downloading';
    this.#progress = 0;
    this.#failure = null;
    this.#emit();
    this.#updater()
      .downloadUpdate()
      .catch((err: unknown) => this.#fail('download', err));
    return this.state;
  }

  /** Quits and installs. Only when an update is ready and this build can replace itself. */
  restartToUpdate(): UpdateState {
    if (!this.#enabled || this.#status !== 'ready' || !this.canInstall) return this.state;
    this.#d.beforeQuit();
    if (this.#feed !== null) this.#d.e2eRestartRequested();
    // Silent: the installer keeps the folder the user chose; then the app starts again.
    else this.#updater().quitAndInstall(true, true);
    return this.state;
  }

  /** Opens the release page the last check found, and nothing else (https://github.com/ only). */
  openRelease(): UpdateState {
    const url = this.#releaseUrl;
    if (url && isGitHubUrl(url)) {
      void Promise.resolve(this.#d.openExternal(url)).catch((err: unknown) => this.#log(`could not open the release page: ${errText(err)}`));
    } else {
      this.#log('refused to open a release page that is not on https://github.com/');
    }
    return this.state;
  }

  #restingStatus(): UpdateStatus {
    if (!this.#enabled) return 'off';
    return this.supported ? 'idle' : 'unsupported';
  }

  #reset(): void {
    this.#latest = null;
    this.#releaseUrl = null;
    this.#notes = null;
    this.#progress = null;
    this.#failure = null;
  }

  /** electron-updater, set up once: never downloads or installs by itself, never offers a downgrade or a pre-release. */
  #updater(): AutoUpdaterLike {
    if (this.#au) return this.#au;
    const au = this.#d.autoUpdater();
    au.autoDownload = false;
    au.autoInstallOnAppQuit = false;
    au.allowPrerelease = false;
    au.allowDowngrade = false;
    au.requestHeaders = { 'x-user-staging-id': NIL_STAGING_ID };
    if (this.#feed !== null) {
      // Set before the feed: setting the config path forgets any feed set earlier.
      if (this.#d.e2eUpdateConfigPath) au.updateConfigPath = this.#d.e2eUpdateConfigPath;
      au.forceDevUpdateConfig = true;
      au.setFeedURL({ provider: 'generic', url: this.#feed });
    }
    au.on('checking-for-update', () => this.#onChecking());
    au.on('update-available', (info: UpdateInfoLike) => this.#onFound(info));
    au.on('update-not-available', () => this.#onLatest());
    au.on('download-progress', (p: { percent?: number }) => this.#onProgress(p));
    au.on('update-downloaded', (info: UpdateInfoLike) => this.#onDownloaded(info));
    au.on('error', (err: unknown) => {
      if (this.#status === 'downloading') this.#fail('download', err);
      else if (this.#status === 'checking') this.#fail('check', err);
      else this.#log(`updater: ${errText(err)}`);
    });
    this.#au = au;
    return au;
  }

  #onChecking(): void {
    if (!this.#enabled || BUSY.has(this.#status)) return;
    this.#status = 'checking';
    this.#emit();
  }

  #onFound(info: UpdateInfoLike): void {
    if (!this.#enabled || this.#status !== 'checking') return;
    const version = typeof info?.version === 'string' ? info.version.trim() : '';
    if (!parseVersion(version)) {
      this.#fail('check', new Error('ERR_UPDATER_INVALID_VERSION'));
      return;
    }
    // Never a downgrade, never a pre-release: an equal, older or pre-release version means "up to date".
    if (!isNewerRelease(version, this.#d.currentVersion)) {
      this.#onLatest();
      return;
    }
    this.#status = 'available';
    this.#latest = version;
    this.#releaseUrl = (this.#d.releasePage ?? defaultReleasePage)(version);
    this.#notes = plainNotes(info.releaseNotes);
    this.#progress = null;
    this.#checkedAt = this.#now();
    this.#emit();
  }

  #onLatest(): void {
    if (!this.#enabled || this.#status !== 'checking') return;
    this.#status = 'up-to-date';
    this.#reset();
    this.#checkedAt = this.#now();
    this.#emit();
  }

  #onProgress(p: { percent?: number }): void {
    if (!this.#enabled || this.#status !== 'downloading') return;
    const pct = typeof p?.percent === 'number' && Number.isFinite(p.percent) ? p.percent : 0;
    this.#progress = Math.min(1, Math.max(0, pct / 100));
    this.#emit();
  }

  #onDownloaded(info: UpdateInfoLike): void {
    if (!this.#enabled || this.#status !== 'downloading') return;
    if (typeof info?.version === 'string' && info.version.trim() !== this.#latest) {
      this.#log(`downloaded ${info.version}, expected ${this.#latest ?? 'nothing'}`);
    }
    this.#status = 'ready';
    this.#progress = null;
    this.#emit();
  }

  #fail(phase: Failure['phase'], err: unknown): void {
    const expected = phase === 'download' ? 'downloading' : 'checking';
    if (!this.#enabled || this.#status !== expected) return;
    this.#log(`update ${phase} failed: ${errText(err)}`);
    this.#status = 'error';
    this.#progress = null;
    this.#failure = { phase, ...reasonWords(err) };
    this.#emit();
  }

  #message(): string {
    const v = this.#latest ?? '';
    switch (this.#status) {
      case 'off':
        return 'Update checks are off. Turn them on to hear about new versions.';
      case 'unsupported':
        return 'Update checks run in installed builds.';
      case 'idle':
        return this.#d.e2e ? 'Not checked yet.' : 'Not checked yet. The app checks about a minute after it starts, then once a day.';
      case 'checking':
        return 'Checking for updates…';
      case 'up-to-date':
        return `You have the latest version (${this.#d.currentVersion}). Checked ${checkedWords(this.#checkedAt ?? this.#now(), this.#now())}.`;
      case 'available':
        return this.canInstall
          ? `Version ${v} is out. Download it, then restart when you're ready.`
          : `Version ${v} is out. Download it from its release page.`;
      case 'downloading':
        return `Downloading ${v}: ${Math.floor((this.#progress ?? 0) * 100)}%.`;
      case 'ready':
        return `${v} is ready. Restart to update; your Brain and settings stay as they are.`;
      case 'error': {
        const f = this.#failure ?? { phase: 'check', offline: false, words: GENERIC_REASON };
        if (f.phase === 'download') return `Couldn't download ${v || 'the update'}: ${f.words}. Check again to retry.`;
        const again = this.#d.e2e ? 'Check again in a moment.' : 'It tries again tomorrow.';
        if (f.offline) return `You seem to be offline, so updates weren't checked. ${again}`;
        return `Couldn't check for updates: ${f.words}. ${again}`;
      }
    }
  }

  #schedule(delayMs: number): void {
    this.#clearTimer();
    if (!this.#enabled || !this.supported || this.#d.e2e) return;
    const t = setTimeout(() => {
      this.#timer = null;
      void this.#scheduledCheck();
    }, delayMs);
    t.unref?.();
    this.#timer = t;
  }

  async #scheduledCheck(): Promise<void> {
    try {
      if (!BUSY.has(this.#status)) await this.check();
    } finally {
      this.#schedule(CHECK_EVERY_MS);
    }
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Tells the window, only when something it shows changed. */
  #emit(): void {
    const s = this.state;
    const json = JSON.stringify(s);
    if (json === this.#lastSent) return;
    this.#lastSent = json;
    this.#d.onChange(s);
  }

  #log(line: string): void {
    this.#d.log?.(`[updates] ${line}`);
  }
}

export function canInstallOn(o: { platform: NodeJS.Platform; isPackaged: boolean; appImage?: string | undefined; e2eFeed: boolean }): boolean {
  if (o.e2eFeed) return true;
  if (!o.isPackaged) return false;
  if (o.platform === 'win32') return true;
  if (o.platform === 'linux') return typeof o.appImage === 'string' && o.appImage.length > 0;
  return false;
}

const defaultReleasePage = (version: string): string => `${RELEASES_PAGE}/tag/v${encodeURIComponent(version)}`;

export function isGitHubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.port === '' && u.username === '' && u.password === '' && url.startsWith('https://github.com/');
  } catch {
    return false;
  }
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string): { parts: [number, number, number]; pre: string | null } | null {
  const m = VERSION.exec(v);
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** True only for a published release (no pre-release tag) strictly newer than the current version. */
export function isNewerRelease(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b || a.pre !== null) return false;
  for (let i = 0; i < 3; i++) {
    if (a.parts[i]! !== b.parts[i]!) return a.parts[i]! > b.parts[i]!;
  }
  // Same numbers: a release is newer than the pre-release it follows.
  return b.pre !== null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number): string => String(n).padStart(2, '0');
const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** When the last check ran, in simple local words: "today 10:42", "yesterday 10:42", else "3 Dec 10:42". */
export function checkedWords(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return `today ${hm}`;
  if (days === 1) return `yesterday ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Release notes (GitHub gives HTML) as plain text, cut to a few thousand characters; null when empty. */
export function plainNotes(notes: UpdateInfoLike['releaseNotes']): string | null {
  let text = '';
  if (typeof notes === 'string') text = notes;
  else if (Array.isArray(notes)) text = notes.map((n) => (typeof n?.note === 'string' ? n.note : '')).join('\n\n');
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|li|h[1-6]|div|ul|ol|pre|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|quot|apos|nbsp);/g, (_m, name: string) => ENTITIES[name] ?? '')
    .replace(/&#(\d{1,6});/g, (_m, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  return text.length > NOTES_MAX ? `${text.slice(0, NOTES_MAX - 1).trimEnd()}…` : text;
}

const safeChar = (code: number): string => (Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '');

const GENERIC_REASON = 'something went wrong talking to the update server';

const errText = (err: unknown): string => {
  if (err instanceof Error) return `${(err as { code?: unknown }).code ?? ''} ${err.message}`.trim();
  return String(err);
};

/** Why a check or download failed, in words (never a stack trace), and whether the computer looks offline. */
export function reasonWords(err: unknown): { offline: boolean; words: string } {
  const text = errText(err).split('\n')[0] ?? '';
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  const code = typeof status === 'number' ? status : null;
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENETUNREACH|ERR_NETWORK_IO_SUSPENDED|ERR_PROXY_CONNECTION_FAILED/.test(text)) {
    return { offline: true, words: 'you seem to be offline' };
  }
  const w = (words: string): { offline: false; words: string } => ({ offline: false, words });
  if (/ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|timed? ?out/i.test(text)) return w('the update server took too long to answer');
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|socket hang up/i.test(text)) {
    return w('the connection to the update server broke off');
  }
  if (/ERR_CERT|CERT_|certificate/i.test(text)) return w("the update server's certificate couldn't be verified");
  if (/ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_NO_PUBLISHED_VERSIONS|No published versions/.test(text) || code === 404) {
    return w('no published release has an update for this computer yet');
  }
  if (code === 403 || code === 429 || /rate limit/i.test(text)) return w('GitHub is limiting requests right now');
  if (code !== null && code >= 500) return w('the update server had a problem');
  if (/sha512 checksum mismatch|ERR_CHECKSUM_MISMATCH|checksum/i.test(text)) return w("the download didn't match its checksum");
  if (/ENOSPC/.test(text)) return w("there isn't enough free disk space");
  if (/ERR_UPDATER_INVALID_RELEASE_FEED|ERR_UPDATER_INVALID_UPDATE_INFO|ERR_UPDATER_INVALID_VERSION|Cannot parse/.test(text)) {
    return w("the release information couldn't be read");
  }
  if (/ERR_UPDATER_INACTIVE/.test(text)) return w("this build can't check for updates");
  return w(GENERIC_REASON);
}
