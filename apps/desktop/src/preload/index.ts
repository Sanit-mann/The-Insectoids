import { contextBridge, ipcRenderer } from 'electron';
import { AppInfoSchema, BrainStatusSchema, IPC, type InsectoidsApi } from '@insectoids/shared';

// The only door from the UI to the main process. Every reply is validated.
const api: InsectoidsApi = {
  appInfo: async () => AppInfoSchema.parse(await ipcRenderer.invoke(IPC.appInfo)),
  brainStatus: async () => BrainStatusSchema.parse(await ipcRenderer.invoke(IPC.brainStatus)),
};

contextBridge.exposeInMainWorld('insectoids', api);
