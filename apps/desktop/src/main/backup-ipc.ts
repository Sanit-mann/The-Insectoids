import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain } from 'electron';
import { type BackupDeps, createBackupHandlers } from './backups';

export interface BackupIpcDeps extends Omit<BackupDeps, 'pickFolder'> {
  window: () => BrowserWindow | null;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  /** e2e only (INSECTOIDS_E2E_BACKUP_FOLDER): the folder the native picker would return. */
  testPickedFolder?: string;
}

/** Backups over IPC (Phase 3 A5): trusted sender only, then the handler; every reply carries the fresh state. */
export function registerBackupIpc(d: BackupIpcDeps): void {
  const pickFolder = async (): Promise<string | null> => {
    if (d.testPickedFolder) return d.testPickedFolder;
    const win = d.window();
    const options = {
      title: 'Choose where Brain backups go',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory' as const, 'createDirectory' as const],
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const dir = res.filePaths[0];
    return res.canceled || !dir ? null : dir;
  };
  for (const [channel, fn] of Object.entries(createBackupHandlers({ ...d, pickFolder }))) {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  }
}
