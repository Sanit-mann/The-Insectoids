import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UPDATE_IPC, type UpdateState } from '@insectoids/shared';
import type { AutoUpdaterLike, Updater } from './updater';

/**
 * electron-updater's `autoUpdater`, read only when first needed: the getter builds the platform's updater
 * (NSIS, AppImage, …), which a dev build or a switched-off app never needs. electron-vite bundles electron-updater
 * into out/main (it is a devDependency), so the packaged app carries no node_modules.
 */
export const electronAutoUpdater = (): AutoUpdaterLike => autoUpdater;

/**
 * e2e only: dev builds carry no app-update.yml, and electron-updater reads one before it downloads (for its cache
 * folder name). Written into the throwaway e2e profile; returns its path. Downloads go to the OS cache folder
 * (%LOCALAPPDATA% on Windows, ~/.cache on Linux) under "insectoids-e2e-updater", never the real app's.
 */
export function writeE2EUpdateConfig(profileDir: string, feedUrl: string): string {
  const file = join(profileDir, 'e2e-app-update.yml');
  writeFileSync(file, ['provider: generic', `url: ${JSON.stringify(feedUrl)}`, 'updaterCacheDirName: insectoids-e2e-updater', ''].join('\n'));
  return file;
}

export interface UpdateIpcDeps {
  updater: Updater;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
}

/** Update checks over IPC (Phase 3 C4): trusted sender only; every reply is the fresh state. */
export function registerUpdateIpc(d: UpdateIpcDeps): void {
  const u = d.updater;
  const handlers: Record<string, (arg: unknown) => UpdateState | Promise<UpdateState>> = {
    [UPDATE_IPC.state]: () => u.state,
    [UPDATE_IPC.setEnabled]: (arg) => {
      if (typeof arg !== 'boolean') throw new Error('Choose on or off.');
      return u.setEnabled(arg);
    },
    [UPDATE_IPC.check]: () => u.check(),
    [UPDATE_IPC.download]: () => u.download(),
    [UPDATE_IPC.restartToUpdate]: () => u.restartToUpdate(),
    [UPDATE_IPC.openRelease]: () => u.openRelease(),
  };
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  }
}
