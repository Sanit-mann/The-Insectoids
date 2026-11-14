import { z } from 'zod';

/**
 * Update checks (Tech stack 09-D4; Phase 3 C4). The app asks whether a newer version exists; it sends nothing
 * about the user (GitHub sees the IP address, as with any website). Never forced: the user chooses to download,
 * and chooses when to restart.
 *
 * - **Where it looks:** the project's published GitHub Releases (drafts never count), through electron-updater's
 *   GitHub provider and the `latest*.yml` files the release workflow attaches. e2e points it at a local fake feed
 *   (`INSECTOIDS_E2E_UPDATE_FEED`, a generic-provider URL) instead.
 * - **When:** only in installed builds (and under e2e with the fake feed): about a minute after start, then once a
 *   day, while the switch is on (on by default). "Check now" any time.
 * - **What it may do:** newer version → "available"; the user presses Download → it downloads in the background
 *   → "ready" → the user presses "Restart to update". `canInstall` is true only where the app can replace itself:
 *   Windows (NSIS) and the Linux AppImage. macOS (no Developer ID signature) and the .deb get a Download link to the
 *   release page instead. An older or equal version is "up to date" (never a downgrade).
 * - **Settings:** app.json `updates: false` turns checks off; nothing is fetched while off.
 */
export const UpdateStatusSchema = z.enum([
  /** The switch is off. */
  'off',
  /** A dev build: update checks run only in installed builds. */
  'unsupported',
  'idle',
  'checking',
  'up-to-date',
  'available',
  'downloading',
  /** Downloaded; restart to install. */
  'ready',
  'error',
]);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const UpdateStateSchema = z.object({
  enabled: z.boolean(),
  status: UpdateStatusSchema,
  currentVersion: z.string(),
  /** The newest published version when one was found, else null. */
  latestVersion: z.string().nullable(),
  /** Its GitHub release page (for the Download link and "What's new"). */
  releaseUrl: z.string().nullable(),
  /** Release notes as plain text (cut to a few thousand characters), or null. */
  notes: z.string().nullable(),
  /** Download progress 0..1 while downloading. */
  progress: z.number().min(0).max(1).nullable(),
  checkedAt: z.number().nullable(),
  /** Whether "Restart to update" is possible on this platform/build (see above). */
  canInstall: z.boolean(),
  /** The state in plain words, e.g. "Version 0.0.4 is out. Download it, then restart when you're ready." */
  message: z.string(),
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UPDATE_IPC = {
  state: 'update:state',
  setEnabled: 'update:set-enabled',
  check: 'update:check',
  download: 'update:download',
  /** Quits and installs a downloaded update. Only when status is 'ready' and canInstall. */
  restartToUpdate: 'update:restart',
  /** Opens the release page in the browser (only the URL the last check found). */
  openRelease: 'update:open-release',
  /** main -> renderer: the state changed (payload: UpdateState). */
  changed: 'update:changed',
} as const;

/** `window.insectoids.updates`. Every call resolves to the fresh state. */
export interface UpdateApi {
  state(): Promise<UpdateState>;
  setEnabled(enabled: boolean): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  restartToUpdate(): Promise<UpdateState>;
  openRelease(): Promise<UpdateState>;
  onChanged(listener: (s: UpdateState) => void): () => void;
}

/** e2e (INSECTOIDS_E2E only): `globalThis.__insectoidsE2E.updateRestartRequested` is set instead of quitting. */
export const E2E_UPDATE_FEED_ENV = 'INSECTOIDS_E2E_UPDATE_FEED';
