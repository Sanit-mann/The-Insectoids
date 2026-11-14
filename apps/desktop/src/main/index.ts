import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, type IpcMainInvokeEvent, Notification, app, clipboard, ipcMain, powerMonitor, powerSaveBlocker, safeStorage, session, shell } from 'electron';
import {
  type BackgroundE2E,
  CommandResultSchema,
  HIVE_IPC,
  type HiveCommand,
  type HivePush,
  HiveSnapshotSchema,
  IPC,
  type NoticeModel,
  maintenanceCadenceId,
} from '@insectoids/shared';
import { buildAppInfo } from './app-info';
import { AppSettingsStore, checkBrainFolder, limitsFor, notificationsOn } from './app-settings';
import { registerBackupIpc } from './backup-ipc';
import { createBackupDirSync } from './backups';
import { BrainHost } from './brain-host';
import { Broker } from './broker';
import { handleBrokerRequest } from './broker-requests';
import { KeepAwake } from './keep-awake';
import { readyProviders } from './ready-providers';
import { resolveDoorPaths, resolveLibraryDir } from './doors';
import { registerHiveIpc } from './hive-ipc';
import { LoginItem, startsHidden } from './login-item';
import { Notifier } from './notifier';
import { isAllowedExternalUrl, isTrustedRendererUrl } from './security';
import { registerSetupIpc } from './setup';
import { LlmRoute } from './llm-route';
import { ProvidersStore } from './providers';
import { registerProvidersIpc } from './providers-ipc';
import { ServicesStore, type UrlRules } from './services';
import { type TrayAction, type TrayInput, createTray } from './tray';
import { Vault } from './vault';
import { registerVaultIpc } from './vault-ipc';
import { registerWebhookIpc } from './webhook-ipc';
import { type WebhookCadence, WebhookSecrets, WebhookService } from './webhooks';

const APP_NAME = 'The Insectoids';
const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '../renderer');
const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
const resourcesDir = app.isPackaged ? process.resourcesPath : join(here, '../../resources');
const isE2E = process.env['INSECTOIDS_E2E'] === '1';
// Windows draws title bar, taskbar and tray icons at 16-32 px: the .ico carries hand-tuned small
// sizes and Windows picks the one matching the display scale. Elsewhere, PNG (tray@2x.png is picked up automatically).
const isWindows = process.platform === 'win32';
const appIcon = join(resourcesDir, isWindows ? 'icon.ico' : 'icon.png');
const trayIcon = join(resourcesDir, isWindows ? 'icon.ico' : 'tray.png');

app.setName(APP_NAME);
// Test runs get a throwaway profile: they never touch the real one, and the single-instance
// lock (keyed on the profile folder) does not make them quit while the user has the app open.
if (isE2E) app.setPath('userData', mkdtempSync(join(tmpdir(), 'insectoids-e2e-')));

/**
 * e2e only, main process only (read with `app.evaluate`, never reachable from the renderer): what the tray shows,
 * what would have notified, the fake login item (B2), and a hook for the Brain screen's conflict test (Phase 2 B5).
 */
type E2EHook = BackgroundE2E & { agentEditRecord?: (id: string, body: string) => Promise<void> };
const e2eHook: E2EHook | null = isE2E ? { tray: null, notices: [], loginItem: { openAtLogin: false }, windowInFront: null } : null;
if (e2eHook) (globalThis as unknown as { __insectoidsE2E?: E2EHook }).__insectoidsE2E = e2eHook;
/** Tests may replace a field of the hook object, or the whole object: always read the current one. */
const e2e = (): E2EHook | null => (isE2E ? ((globalThis as unknown as { __insectoidsE2E?: E2EHook }).__insectoidsE2E ?? e2eHook) : null);

let mainWindow: BrowserWindow | null = null;
let tray: ReturnType<typeof createTray> | null = null;
let trayTimer: NodeJS.Timeout | null = null;
/** What the tray was last built from (B2); the login item and the clock are read fresh at every rebuild. */
let trayInput: Omit<TrayInput, 'startWithComputer' | 'now'> = { status: { working: 0, approvals: 0, paused: false }, cadences: [], digestUnseen: false };
/** "Start with my computer" (B2); created once the app is ready. */
let loginItem: LoginItem | null = null;
/** Started at sign-in (B2): the first window stays hidden in the tray. */
let startHidden = false;
/** Desktop notifications (B2): approvals needed and failures, only while the window isn't in front. */
const notifier = new Notifier({
  show: showNotice,
  enabled: () => (settings ? notificationsOn(settings.value) : true),
  windowInFront,
});
/** Shown notifications, kept so their click handlers aren't garbage-collected before the user clicks. */
const liveNotices = new Set<Notification>();
/** "Keep the computer awake while the hive works" (A2, 05-D5); created once the app is ready. */
let keepAwake: KeepAwake | null = null;
let quitting = false;
let brainHost: BrainHost | null = null;
let settings: AppSettingsStore | null = null;
/** True while the Brain is being moved to another folder (the old host is stopping, the new one starting). */
let switchingBrain = false;
/** The Vault, outside services and the secret broker (Phase 2 A3) live in main only. */
let vault: Vault | null = null;
let services: ServicesStore | null = null;
let broker: Broker | null = null;
/** API providers and the broker's LLM route (Phase 2 A4). */
let providers: ProvidersStore | null = null;
let llm: LlmRoute | null = null;
/** Webhooks (Phase 3 A4): the local listener and each webhook's secret, in main only. */
let webhookSecrets: WebhookSecrets | null = null;
let webhooks: WebhookService | null = null;
/** Brain backups (Phase 3 A5): the host writes them; main tells it the folder at every start and on change. */
const backupDirSync = createBackupDirSync({ dir: () => settings?.backupDir ?? join(app.getPath('userData'), 'backups'), log: (line) => console.log(line) });

/** e2e only: a fake upstream on http://127.0.0.1 may stand in for a service. Never in a normal run. */
function testUrlRules(): UrlRules {
  if (!isE2E || process.env['INSECTOIDS_E2E_LOOPBACK_SERVICES'] !== '1') return {};
  const github = process.env['INSECTOIDS_E2E_GITHUB_BASE'];
  return { allowLoopbackHttp: true, ...(github ? { baseOverrides: { github } } : {}) };
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** The user already sees the app: visible, not minimised and focused. Under e2e a test may decide instead. */
function windowInFront(): boolean {
  const forced = e2e()?.windowInFront;
  if (forced === true || forced === false) return forced;
  const w = mainWindow;
  return !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused();
}

/** Show the window on a screen (a notification or a tray item was clicked). */
function openScreen(target: NoticeModel['target']): void {
  const push: HivePush = { type: 'open-screen', screen: target.screen, goalId: target.goalId };
  if (!mainWindow || mainWindow.isDestroyed()) {
    // The page isn't there yet: tell it once it has loaded.
    mainWindow = createWindow();
    mainWindow.webContents.once('did-finish-load', () => forwardPush(push));
    return;
  }
  showWindow();
  forwardPush(push);
}

/** One desktop notification (B2). Under e2e it is only recorded, so test runs stay quiet. */
function showNotice(n: NoticeModel): void {
  const hook = e2e();
  if (hook) {
    hook.notices.push(n);
    return;
  }
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, silent: false });
  liveNotices.add(note);
  const forget = (): void => void liveNotices.delete(note);
  note.on('click', () => {
    forget();
    openScreen(n.target);
  });
  note.on('close', forget);
  note.on('failed', forget);
  note.show();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0F0E0B',
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Started at sign-in (B2): the first window stays hidden; the tray (or a notification) shows it.
  const hidden = startHidden;
  startHidden = false;
  win.once('ready-to-show', () => {
    if (!hidden) win.show();
  });
  // The user arriving (shown from the tray, restored from the taskbar) lets the digest open by itself (B1). Window focus
  // isn't used here: other windows (and tests running side by side) move focus around without the user arriving;
  // the page's own focus events cover switching back from another app.
  const arriving = (): void => forwardPush({ type: 'window-shown' });
  win.on('show', arriving);
  win.on('restore', arriving);

  // Closing the window keeps the hive running in the tray (App 07-D7).
  win.on('close', (event) => {
    if (!quitting && tray && !isE2E) {
      event.preventDefault();
      win.hide();
    }
  });

  // The app never navigates away from itself; https links open in the user's browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, { rendererDir, devServerUrl })) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(join(rendererDir, 'index.html'));
  return win;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedRendererUrl(event.senderFrame?.url, { rendererDir, devServerUrl })) {
    throw new Error('Refused: untrusted sender');
  }
}

/**
 * The Brain runs in its own utility process, the only writer of brain.db (Memory 01-D14).
 * Main keeps the master token and never opens the database itself.
 */
function startBrain(brainDir: string): BrainHost {
  const host = new BrainHost({
    entry: join(here, 'brain-host.js'),
    dbPath: join(brainDir, 'brain.db'),
    doors: resolveDoorPaths({ mainDir: here, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, execPath: process.execPath }),
    hive: {
      userDataDir: app.getPath('userData'),
      libraryDir: resolveLibraryDir({ mainDir: here, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
      // fake = the scripted demo engine (no AI calls, no tokens): e2e tests and demos.
      engine: process.env['INSECTOIDS_ENGINE'] === 'fake' ? 'fake' : 'claude',
      ...(isE2E && process.env['INSECTOIDS_E2E_PROJECT'] ? { project: process.env['INSECTOIDS_E2E_PROJECT'] } : {}),
      limits: limitsFor(settings?.preset ?? 'balanced'),
      // e2e only: a folder that already holds the downloaded meaning model (tests never download).
      ...(isE2E && process.env['INSECTOIDS_E2E_MODEL_DIR'] ? { modelsDir: process.env['INSECTOIDS_E2E_MODEL_DIR'] } : {}),
    },
    onPush: forwardPush,
    onHostRequest: async (method, params) => {
      // Which API providers OpenCode may use (A4): metadata only, never a key or its handle.
      if (method === 'providers.ready') {
        const v = vault;
        return providers && v ? readyProviders(providers.views((ref) => v.has(ref))) : [];
      }
      if (!broker) throw new Error('The secret broker is not running.');
      return handleBrokerRequest(broker, method, params);
    },
    onStatus: (s) => {
      // A (re)started Brain learns where backups go before anything else can ask it for one.
      backupDirSync.onStatus(host, s);
      // A (re)started Brain's first snapshot is a new baseline: nothing that already waited notifies (B2).
      if (s.state !== 'ready') notifier.rebaseline();
      scheduleTrayUpdate();
      // Every Brain status change reaches the window at once (its status line re-reads), and a (re)started
      // Brain has fresh data: the window re-reads everything.
      forwardPush({ type: 'changed', reason: s.state === 'ready' ? 'brain-ready' : `brain-${s.state}` });
    },
    log: (line) => console.log(line),
  });
  host.start();
  return host;
}

/** Hive pushes go to the window; a "changed" also refreshes the tray and keep-awake. */
function forwardPush(push: HivePush): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(HIVE_IPC.event, push);
  if (push.type === 'changed') {
    scheduleTrayUpdate();
    // A cadence may have been added or removed, or the Brain (re)started: listen only while the project has webhooks.
    webhooks?.refresh();
  }
}

/** The open project's webhook cadences (A4), or null while the Brain isn't ready. */
async function webhookCadences(): Promise<WebhookCadence[] | null> {
  const h = brainHost;
  if (!h || h.status.state !== 'ready') return null;
  const s = HiveSnapshotSchema.parse(await h.call('snapshot'));
  return s.cadences.filter((c) => c.when.type === 'webhook').map(({ id, name }) => ({ id, name }));
}

function scheduleTrayUpdate(): void {
  if (trayTimer || (!tray && !keepAwake)) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    void refreshTray();
  }, 500);
}

/** Rebuild the tray menu from the last hive state, the login item and the clock (e2e keeps the model). */
function renderTray(): void {
  if (!tray) return;
  const model = tray.update({ ...trayInput, startWithComputer: loginItem?.state() ?? { available: false, enabled: false }, now: Date.now() });
  const hook = e2e();
  if (hook) hook.tray = model;
}

/** The tray, keep-awake and notifications all follow the hive's real state, from the same snapshot. */
async function refreshTray(): Promise<void> {
  if (!brainHost || brainHost.status.state !== 'ready') {
    keepAwake?.update({ enabled: false, working: false });
    return;
  }
  try {
    const s = HiveSnapshotSchema.parse(await brainHost.call('snapshot'));
    keepAwake?.update({ enabled: settings?.value.keepAwake === true, working: s.hive.working > 0 });
    notifier.observe(s);
    trayInput = {
      status: { working: s.hive.working, paused: s.hive.paused, approvals: s.approvals.filter((a) => a.status === 'waiting').length },
      cadences: s.cadences,
      digestUnseen: s.digest.unseen,
    };
    renderTray();
  } catch {
    // The tray keeps its last state; the next change retries.
  }
}

function onTrayAction(a: TrayAction): void {
  switch (a.type) {
    case 'open':
    case 'digest':
      // Showing the window lets the digest open by itself (B1).
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
      else showWindow();
      return;
    case 'approvals':
      openScreen({ screen: 'approvals', goalId: null });
      return;
    case 'runNow':
      void hiveCommand({ type: 'runCadenceNow', id: a.cadenceId });
      return;
    case 'pause':
      void hiveCommand({ type: 'pause', reason: 'Paused from the tray.' });
      return;
    case 'resume':
      void hiveCommand({ type: 'resume' });
      return;
    case 'startWithComputer': {
      const err = loginItem?.set(a.enabled) ?? 'The app is still starting.';
      if (err) console.log(`[tray] start with my computer: ${err}`);
      renderTray();
      // Settings shows the same switch: let the window re-read it.
      forwardPush({ type: 'changed', reason: 'start-with-computer' });
      return;
    }
    case 'quit':
      quitting = true;
      app.quit();
      return;
  }
}

async function hiveCommand(cmd: HiveCommand): Promise<void> {
  if (!brainHost) return;
  const r = CommandResultSchema.parse(await brainHost.call('command', cmd).catch((e: unknown) => ({ ok: false, error: String(e) })));
  if (!r.ok) console.log(`[hive] ${cmd.type} failed: ${r.error}`);
  scheduleTrayUpdate();
}

/** Wait until a starting host is ready or has failed (it would otherwise retry with backoff). */
async function settle(host: BrainHost, timeoutMs = 25_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (host.status.state === 'starting' && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (host.status.state !== 'ready') throw new Error(host.status.message);
}

/** Why the Brain can't be switched right now (it is moving, or goals are running in it), or null. */
async function brainBusy(): Promise<string | null> {
  if (switchingBrain) return 'The Brain is already moving. Try again in a moment.';
  const h = brainHost;
  if (!h || h.status.state !== 'ready') return null;
  const snap = await h.call('snapshot').then((x) => HiveSnapshotSchema.parse(x), () => null);
  const busy = snap && (snap.hive.working > 0 || snap.goals.some((g) => g.status === 'running' || g.status === 'planning'));
  return busy ? 'Goals are running in this Brain. Let them finish (or cancel them) before moving the Brain.' : null;
}

/** When the daily backup runs next (A5): a time, null when it is switched off, undefined when the hive can't say. */
async function nextBackupAt(): Promise<number | null | undefined> {
  const h = brainHost;
  if (!h || h.status.state !== 'ready') return undefined;
  const snap = HiveSnapshotSchema.parse(await h.call('snapshot'));
  const job = snap.cadences.find((c) => c.id === maintenanceCadenceId('backup'));
  if (!job) return undefined;
  return job.enabled ? job.nextRunAt : null;
}

/**
 * Move the Brain to another folder (Onboarding 08 step 2). An existing brain.db there is used as is,
 * so a user can point the app at a Brain they already have. Refused while goals are running, because
 * the hive's data lives in the Brain. If the new folder fails, the old Brain is started again.
 */
async function switchBrainDir(dir: string | null): Promise<string | null> {
  if (!settings) return 'The app is still starting.';
  const target = dir ?? settings.defaultBrainDir;
  if (target === settings.brainDir) return null;
  if (switchingBrain) return 'The Brain is already moving. Try again in a moment.';
  const bad = checkBrainFolder(target);
  if (bad) return bad;
  const busy = await brainBusy();
  if (busy) return busy;
  const old = brainHost;
  switchingBrain = true;
  try {
    brainHost = null;
    await old?.stop();
    const next = startBrain(target);
    brainHost = next;
    try {
      await settle(next);
    } catch (err) {
      await next.stop();
      brainHost = startBrain(settings.brainDir);
      return `The Brain could not open ${target}: ${err instanceof Error ? err.message : String(err)}`;
    }
    settings.update((s) => {
      const next = { ...s };
      if (dir === null) delete next.brainDir;
      else next.brainDir = target;
      return next;
    });
    return null;
  } finally {
    switchingBrain = false;
  }
}

function registerIpc(): void {
  const testPickedFolder = isE2E ? process.env['INSECTOIDS_E2E_PICK_FOLDER'] : undefined;
  registerSetupIpc({
    settings: settings!,
    host: () => brainHost,
    keepAwake: { active: () => keepAwake?.active ?? false, changed: () => refreshTray() },
    loginItem: loginItem!,
    backgroundChanged: renderTray,
    userDataDir: app.getPath('userData'),
    providers: () => providers?.all().filter((p) => p.enabled).length ?? 0,
    // Under e2e the scripted test engine is the one that runs everything, so it counts as working.
    countScriptedEngine: isE2E,
    window: () => mainWindow,
    assertTrustedSender,
    switchBrainDir,
    ...(testPickedFolder ? { testPickedFolder } : {}),
  });
  registerHiveIpc({
    host: () => brainHost,
    window: () => mainWindow,
    assertTrustedSender,
    push: forwardPush,
    cadenceDeleted: (id) => {
      try {
        webhookSecrets?.remove(id);
      } catch (err) {
        console.log(`[webhooks] could not remove a deleted cadence's secret: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  const hook = e2e();
  if (hook) {
    // e2e only, main process only (never reachable from the renderer): an agent changes a record while the
    // user edits it, so the Brain screen's conflict view can be tested (Phase 2 B5). The host refuses it
    // unless it runs under INSECTOIDS_E2E=1 too.
    hook.agentEditRecord = async (id: string, body: string): Promise<void> => {
      if (!brainHost) throw new Error('The Brain is not running.');
      await brainHost.call('e2eAgentEdit', { id, body });
    };
  }
  registerVaultIpc({ vault: vault!, services: services!, broker: broker!, providers: providers!, assertTrustedSender });
  registerProvidersIpc({ providers: providers!, vault: vault!, llm: llm!, assertTrustedSender });
  registerWebhookIpc({ service: webhooks!, secrets: webhookSecrets!, vault: vault!, webhookCadences, clipboard, assertTrustedSender });
  const testBackupFolder = isE2E ? process.env['INSECTOIDS_E2E_BACKUP_FOLDER'] : undefined;
  registerBackupIpc({
    settings: settings!,
    userDataDir: app.getPath('userData'),
    nextBackupAt,
    tellHost: () => backupDirSync.send(brainHost),
    brainBusy,
    // The same switch as "Brain folder": the restored copy becomes the Brain, the old one stays where it was.
    switchBrainDir: (dir) => switchBrainDir(dir),
    window: () => mainWindow,
    assertTrustedSender,
    ...(testBackupFolder ? { testPickedFolder: testBackupFolder } : {}),
  });
  ipcMain.handle(IPC.brainStatus, (event) => {
    assertTrustedSender(event);
    return brainHost?.status ?? { state: 'starting', message: 'Starting the Brain…' };
  });
  ipcMain.handle(IPC.appInfo, (event) => {
    assertTrustedSender(event);
    return buildAppInfo({
      name: APP_NAME,
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
    });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', (event) => {
    quitting = true;
    keepAwake?.release();
    notifier.dispose();
    void webhooks?.stop();
    void broker?.close();
    // Let the Brain close its database cleanly before the app exits.
    if (brainHost) {
      const host = brainHost;
      brainHost = null;
      event.preventDefault();
      void host.stop().finally(() => app.quit());
    }
  });

  void app.whenReady().then(async () => {
    // The app asks for no browser permissions (camera, mic, location, …).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    settings = new AppSettingsStore(app.getPath('userData'));
    keepAwake = new KeepAwake(powerSaveBlocker);
    // Runs that came due while the computer slept happen now, once (05-D5); timers may have been held up.
    powerMonitor.on('resume', () => {
      void brainHost?.call('wake').catch(() => undefined);
      scheduleTrayUpdate();
    });
    // e2e specs that are not about setup start as if setup were done (fresh throwaway profile each run).
    if (isE2E && process.env['INSECTOIDS_E2E_ONBOARDED'] === '1' && settings.value.onboarding.completedAt === undefined) {
      settings.update((s) => ({ ...s, onboarding: { completedAt: Date.now() } }));
    }
    const userData = app.getPath('userData');
    vault = new Vault({ dir: userData, crypto: safeStorage });
    services = new ServicesStore({ dir: userData, rules: testUrlRules() });
    const v = vault;
    providers = new ProvidersStore({ dir: userData });
    llm = new LlmRoute({ providers, reveal: (ref) => v.reveal(ref), hasKey: (ref) => v.has(ref), log: (line) => console.log(line) });
    broker = new Broker({ services, reveal: (ref) => v.reveal(ref), log: (line) => console.log(line), llm });
    await broker.start();
    webhookSecrets = new WebhookSecrets({ vault, settings });
    webhooks = new WebhookService({
      secrets: webhookSecrets,
      settings,
      envPort: process.env['INSECTOIDS_WEBHOOK_PORT'],
      call: async (c) => {
        const h = brainHost;
        if (!h || h.status.state !== 'ready') throw new Error(h?.status.message ?? 'The Brain is not running.');
        return h.call('webhookCall', c);
      },
      webhookCadences,
      log: (line) => console.log(line),
    });
    // Start with my computer (B2): under e2e only the fake in __insectoidsE2E, never the real login item.
    loginItem = new LoginItem({
      platform: process.platform,
      app,
      fake: isE2E ? () => (e2e() ?? { loginItem: { openAtLogin: false } }).loginItem : null,
      devAppPath: app.isPackaged ? null : app.getAppPath(),
    });
    startHidden = startsHidden({
      argv: process.argv,
      platform: process.platform,
      ...(isE2E ? {} : { wasOpenedAtLogin: () => app.getLoginItemSettings().wasOpenedAtLogin }),
    });
    registerIpc();
    brainHost = startBrain(settings.brainDir);
    mainWindow = createWindow();
    tray = createTray({ iconPath: trayIcon, onAction: onTrayAction });
    renderTray();
    // "Next: … today 09:00" stays true as the clock moves on, even while nothing else changes.
    setInterval(renderTray, 60_000).unref();

    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
      else showWindow();
    });
  });

  app.on('window-all-closed', () => {
    // With a tray the hive keeps running; without one (or in tests) quit.
    if (!tray || isE2E) app.quit();
  });
}
