import { z } from 'zod';
import type { HiveApi } from './hive-api';
import type { SetupApi } from './setup-api';
import type { VaultApi } from './vault-api';

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
}
