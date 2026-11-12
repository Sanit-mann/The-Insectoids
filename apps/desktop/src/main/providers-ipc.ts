import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { type ProvidersDeps, createProvidersHandlers } from './providers-handlers';

/** The ipcMain side of API providers: trusted sender only, then the validated handler. */
export function registerProvidersIpc(d: ProvidersDeps & { assertTrustedSender: (event: IpcMainInvokeEvent) => void }): void {
  const handlers = createProvidersHandlers(d);
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  }
}
