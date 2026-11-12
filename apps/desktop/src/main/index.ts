import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, type IpcMainInvokeEvent, app, ipcMain, session, shell, type Tray } from 'electron';
import { IPC } from '@insectoids/shared';
import { buildAppInfo } from './app-info';
import { BrainHost } from './brain-host';
import { resolveDoorPaths } from './doors';
import { isAllowedExternalUrl, isTrustedRendererUrl } from './security';
import { createTray } from './tray';

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
let tray: Tray | null = null;
let quitting = false;
let brainHost: BrainHost | null = null;

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
function startBrain(): BrainHost {
  const host = new BrainHost({
    entry: join(here, 'brain-host.js'),
    dbPath: join(app.getPath('userData'), 'brain', 'brain.db'),
    doors: resolveDoorPaths({ mainDir: here, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, execPath: process.execPath }),
    log: (line) => console.log(line),
  });
  host.start();
  return host;
}

function registerIpc(): void {
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
    // Let the Brain close its database cleanly before the app exits.
    if (brainHost) {
      const host = brainHost;
      brainHost = null;
      event.preventDefault();
      void host.stop().finally(() => app.quit());
    }
  });

  void app.whenReady().then(() => {
    // The app asks for no browser permissions (camera, mic, location, …).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    registerIpc();
    brainHost = startBrain();
    mainWindow = createWindow();
    tray = createTray({
      iconPath: trayIcon,
      onOpen: showWindow,
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
