import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, type IpcMainInvokeEvent, app, ipcMain, safeStorage, session, shell } from 'electron';
import { CommandResultSchema, HIVE_IPC, type HivePush, HiveSnapshotSchema, IPC } from '@insectoids/shared';
import { buildAppInfo } from './app-info';
import { AppSettingsStore, checkBrainFolder, limitsFor } from './app-settings';
import { BrainHost } from './brain-host';
import { Broker } from './broker';
import { handleBrokerRequest } from './broker-requests';
import { readyProviders } from './ready-providers';
import { resolveDoorPaths, resolveLibraryDir } from './doors';
import { registerHiveIpc } from './hive-ipc';
import { isAllowedExternalUrl, isTrustedRendererUrl } from './security';
import { registerSetupIpc } from './setup';
import { LlmRoute } from './llm-route';
import { ProvidersStore } from './providers';
import { registerProvidersIpc } from './providers-ipc';
import { ServicesStore, type UrlRules } from './services';
import { type TrayState, createTray } from './tray';
import { Vault } from './vault';
import { registerVaultIpc } from './vault-ipc';

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

let mainWindow: BrowserWindow | null = null;
let tray: ReturnType<typeof createTray> | null = null;
let trayTimer: NodeJS.Timeout | null = null;
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

  win.once('ready-to-show', () => win.show());

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

/** Hive pushes go to the window; a "changed" also refreshes the tray. */
function forwardPush(push: HivePush): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(HIVE_IPC.event, push);
  if (push.type === 'changed') scheduleTrayUpdate();
}

function scheduleTrayUpdate(): void {
  if (trayTimer || !tray) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    void refreshTray();
  }, 500);
}

async function refreshTray(): Promise<void> {
  if (!tray || !brainHost || brainHost.status.state !== 'ready') return;
  try {
    const s = HiveSnapshotSchema.parse(await brainHost.call('snapshot'));
    const state: TrayState = { working: s.hive.working, paused: s.hive.paused, approvals: s.approvals.filter((a) => a.status === 'waiting').length };
    tray.update(state);
  } catch {
    // The tray keeps its last state; the next change retries.
  }
}

async function hiveCommand(cmd: { type: 'pause'; reason?: string } | { type: 'resume' }): Promise<void> {
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
  const old = brainHost;
  if (old && old.status.state === 'ready') {
    const snap = await old.call('snapshot').then((x) => HiveSnapshotSchema.parse(x), () => null);
    const busy = snap && (snap.hive.working > 0 || snap.goals.some((g) => g.status === 'running' || g.status === 'planning'));
    if (busy) return 'Goals are running in this Brain. Let them finish (or cancel them) before moving the Brain.';
  }
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
    userDataDir: app.getPath('userData'),
    providers: () => providers?.all().filter((p) => p.enabled).length ?? 0,
    // Under e2e the scripted test engine is the one that runs everything, so it counts as working.
    countScriptedEngine: isE2E,
    window: () => mainWindow,
    assertTrustedSender,
    switchBrainDir,
    ...(testPickedFolder ? { testPickedFolder } : {}),
  });
  registerHiveIpc({ host: () => brainHost, window: () => mainWindow, assertTrustedSender, push: forwardPush });
  if (isE2E) {
    // e2e only, main process only (never reachable from the renderer): an agent changes a record while the
    // user edits it, so the Brain screen's conflict view can be tested (Phase 2 B5). The host refuses it
    // unless it runs under INSECTOIDS_E2E=1 too.
    (globalThis as unknown as { __insectoidsE2E?: unknown }).__insectoidsE2E = {
      agentEditRecord: async (id: string, body: string): Promise<void> => {
        if (!brainHost) throw new Error('The Brain is not running.');
        await brainHost.call('e2eAgentEdit', { id, body });
      },
    };
  }
  registerVaultIpc({ vault: vault!, services: services!, broker: broker!, providers: providers!, assertTrustedSender });
  registerProvidersIpc({ providers: providers!, vault: vault!, llm: llm!, assertTrustedSender });
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
    registerIpc();
    brainHost = startBrain(settings.brainDir);
    mainWindow = createWindow();
    tray = createTray({
      iconPath: trayIcon,
      onOpen: showWindow,
      onPause: () => void hiveCommand({ type: 'pause', reason: 'Paused from the tray.' }),
      onResume: () => void hiveCommand({ type: 'resume' }),
      onQuit: () => {
        quitting = true;
        app.quit();
      },
    });

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
