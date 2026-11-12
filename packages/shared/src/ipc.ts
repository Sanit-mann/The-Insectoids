import { z } from 'zod';

/**
 * Typed contract between the renderer and the main process.
 * The renderer has no Node access; every call goes through the preload bridge
 * and every payload is validated on both sides.
 */
export const IPC = {
  appInfo: 'app:info',
} as const;

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['win32', 'darwin', 'linux']),
  electron: z.string(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** The API the preload script exposes on `window.insectoids`. */
export interface InsectoidsApi {
  appInfo(): Promise<AppInfo>;
}
