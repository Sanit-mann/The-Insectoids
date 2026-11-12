import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';
import {
  AppInfoSchema,
  BrainHitViewSchema,
  BrainRecordViewSchema,
  BrainStatusSchema,
  ChangesViewSchema,
  CommandResultSchema,
  HIVE_IPC,
  type HiveApi,
  type HivePush,
  HivePushSchema,
  HiveSnapshotSchema,
  IPC,
  type InsectoidsApi,
  ProjectViewSchema,
} from '@insectoids/shared';

/** Electron prefixes errors from main with "Error invoking remote method '…': Error: "; the UI shows plain words. */
async function invoke(channel: string, arg?: unknown): Promise<unknown> {
  try {
    return await ipcRenderer.invoke(channel, arg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''), { cause: err });
  }
}

const hive: HiveApi = {
  snapshot: async () => HiveSnapshotSchema.parse(await invoke(HIVE_IPC.snapshot)),
  command: async (cmd) => CommandResultSchema.parse(await invoke(HIVE_IPC.command, cmd)),
  changes: async (req) => ChangesViewSchema.parse(await invoke(HIVE_IPC.changes, req)),
  brainSearch: async (req) => BrainHitViewSchema.array().parse(await invoke(HIVE_IPC.brainSearch, req)),
  brainRecord: async (id) => BrainRecordViewSchema.nullable().parse(await invoke(HIVE_IPC.brainRecord, id)),
  pickProject: async () => ProjectViewSchema.nullable().parse(await invoke(HIVE_IPC.pickProject)),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, raw: unknown): void => {
      const parsed = HivePushSchema.safeParse(raw);
      if (parsed.success) listener(parsed.data as HivePush);
    };
    ipcRenderer.on(HIVE_IPC.event, handler);
    return () => {
      ipcRenderer.removeListener(HIVE_IPC.event, handler);
    };
  },
};

// The only door from the UI to the main process. Every reply is validated.
const api: InsectoidsApi = {
  appInfo: async () => AppInfoSchema.parse(await invoke(IPC.appInfo)),
  brainStatus: async () => BrainStatusSchema.parse(await invoke(IPC.brainStatus)),
  hive,
};

contextBridge.exposeInMainWorld('insectoids', api);
