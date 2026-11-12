import { type IpcRendererEvent, contextBridge, ipcRenderer } from 'electron';
import {
  AppInfoSchema,
  BrainHitViewSchema,
  BrainRecordViewSchema,
  BrainStatusSchema,
  ChangesViewSchema,
  CommandResultSchema,
  HIVE_IPC,
  IntegrationViewSchema,
  type HiveApi,
  type HivePush,
  HivePushSchema,
  HiveSnapshotSchema,
  IPC,
  type InsectoidsApi,
  ProjectViewSchema,
  SETUP_IPC,
  type SetupApi,
  SetupResultSchema,
  SetupStateSchema,
  SecretMetaSchema,
  ServiceTestResultSchema,
  VAULT_IPC,
  type VaultApi,
  VaultResultSchema,
  VaultStatusSchema,
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

const setup: SetupApi = {
  state: async () => SetupStateSchema.parse(await invoke(SETUP_IPC.state)),
  pickBrainFolder: async () => SetupResultSchema.parse(await invoke(SETUP_IPC.pickBrainFolder)),
  useDefaultBrainFolder: async () => SetupResultSchema.parse(await invoke(SETUP_IPC.useDefaultBrainFolder)),
  setPreset: async (preset) => SetupResultSchema.parse(await invoke(SETUP_IPC.setPreset, preset)),
  saveAbout: async (input) => SetupResultSchema.parse(await invoke(SETUP_IPC.saveAbout, input)),
  finish: async () => SetupResultSchema.parse(await invoke(SETUP_IPC.finish)),
  restart: async () => SetupResultSchema.parse(await invoke(SETUP_IPC.restart)),
};

/** Vault and Services: keys go in once and never come back; replies are metadata only. */
const vault: VaultApi = {
  status: async () => VaultStatusSchema.parse(await invoke(VAULT_IPC.vaultStatus)),
  list: async () => SecretMetaSchema.array().parse(await invoke(VAULT_IPC.vaultList)),
  add: async (input) => {
    const raw = (await invoke(VAULT_IPC.vaultAdd, input)) as { ref?: unknown };
    const r = VaultResultSchema.parse(raw);
    const ref = SecretMetaSchema.shape.ref.safeParse(raw?.ref);
    return r.ok && ref.success ? { ...r, ref: ref.data } : r;
  },
  remove: async (ref) => VaultResultSchema.parse(await invoke(VAULT_IPC.vaultRemove, ref)),
  services: async () => IntegrationViewSchema.array().parse(await invoke(VAULT_IPC.servicesList)),
  saveService: async (i) => VaultResultSchema.parse(await invoke(VAULT_IPC.servicesSave, i)),
  setServiceEnabled: async (id, enabled) => VaultResultSchema.parse(await invoke(VAULT_IPC.servicesSetEnabled, { id, enabled })),
  removeService: async (id) => VaultResultSchema.parse(await invoke(VAULT_IPC.servicesRemove, id)),
  testService: async (id) => ServiceTestResultSchema.parse(await invoke(VAULT_IPC.servicesTest, id)),
};

// The only door from the UI to the main process. Every reply is validated.
const api: InsectoidsApi = {
  appInfo: async () => AppInfoSchema.parse(await invoke(IPC.appInfo)),
  brainStatus: async () => BrainStatusSchema.parse(await invoke(IPC.brainStatus)),
  hive,
  setup,
  vault,
};

contextBridge.exposeInMainWorld('insectoids', api);
