import { z } from 'zod';
import type { HiveApi } from './hive-api';
import type { SetupApi } from './setup-api';
import type { ProvidersApi } from './providers-api';
import type { VaultApi } from './vault-api';
import type { ContainerApi } from './container-api';
import type { WebhookApi } from './webhook-api';
import type { BackupApi } from './backup-api';
import type { BrainExportApi } from './export-api';
import type { UpdateApi } from './update-api';

/**
 * Typed contract between the renderer and the main process.
 * The renderer has no Node access; every call goes through the preload bridge
 * and every payload is validated on both sides.
 */
export const IPC = {
  appInfo: 'app:info',
  brainStatus: 'brain:status',
} as const;

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['win32', 'darwin', 'linux']),
  electron: z.string(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** Health of the Brain host process (the single writer, Memory 01-D14). */
export const BrainStatusSchema = z.object({
  state: z.enum(['starting', 'ready', 'failed']),
  /** Plain words for the user, e.g. why it failed and when it retries. */
  message: z.string(),
});
export type BrainStatus = z.infer<typeof BrainStatusSchema>;

/** The API the preload script exposes on `window.insectoids`. */
export interface InsectoidsApi {
  appInfo(): Promise<AppInfo>;
  brainStatus(): Promise<BrainStatus>;
  hive: HiveApi;
  setup: SetupApi;
  vault: VaultApi;
  /** Container mode settings and status (Phase 4 D1). */
  containers: ContainerApi;
  providers: ProvidersApi;
  /** Webhook URLs and secrets (Phase 3 A4). */
  webhooks: WebhookApi;
  /** Brain backups and restore (Phase 3 A5). */
  backups: BackupApi;
  /** The Brain as an Obsidian vault (Phase 3 C2). */
  brainExport: BrainExportApi;
  /** Update checks (Phase 3 C4). */
  updates: UpdateApi;
}
