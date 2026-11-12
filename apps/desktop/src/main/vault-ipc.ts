import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { type VaultDeps, createVaultHandlers } from './vault-handlers';

/** The ipcMain side of the Vault and Services: trusted sender only, then the validated handler. */
export function registerVaultIpc(d: VaultDeps & { assertTrustedSender: (event: IpcMainInvokeEvent) => void }): void {
  const handlers = createVaultHandlers(d);
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  }
}
