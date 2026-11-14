import { z } from 'zod';

/**
 * Brain backups (Memory 01-D8, Cadence 05-D7; Phase 3 A5). Local only, never uploaded.
 *
 * - The `backup` maintenance job runs in the Brain host (the single writer): it writes a consistent copy with
 *   SQLite `VACUUM INTO` to `<backups folder>/<backupFileName(at)>` and keeps the newest BACKUP_KEEP copies.
 * - The folder is a setting kept by main (app.json `backupDir`; default `<userData>/backups`). Main tells the host
 *   with host RPC `setBackupDir` `{ dir }` at every host start and whenever the user changes it.
 * - Restoring never overwrites anything: main copies the chosen backup to a new folder
 *   `<userData>/brain-restored-<stamp>/brain.db` and switches the Brain there (the same path as "Brain folder").
 *   The old Brain stays where it was, so a restore can be undone by switching back.
 */
export const BACKUP_KEEP = 7;
export const BACKUP_FILE_PATTERN = /^brain-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/;
/** `brain-backup-2026-11-14T03-00-00Z.db` (UTC, so names sort by time and never collide across DST). */
export const backupFileName = (at: number): string => `brain-backup-${new Date(at).toISOString().slice(0, 19).replace(/:/g, '-')}Z.db`;

export const BackupEntrySchema = z.object({
  /** The file name (matches BACKUP_FILE_PATTERN). */
  file: z.string(),
  at: z.number(),
  sizeBytes: z.number().int().nonnegative(),
});
export type BackupEntry = z.infer<typeof BackupEntrySchema>;

export const BackupStateSchema = z.object({
  dir: z.string(),
  defaultDir: z.string(),
  /** Newest first. */
  backups: z.array(BackupEntrySchema),
  /** In words: "7 backups, the newest from today 03:00." or why the folder can't be read. */
  message: z.string(),
});
export type BackupState = z.infer<typeof BackupStateSchema>;

export const BackupResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: BackupStateSchema }),
  z.object({ ok: z.literal(false), error: z.string(), state: BackupStateSchema }),
]);
export type BackupResult = z.infer<typeof BackupResultSchema>;

export const BACKUP_IPC = {
  state: 'backup:state',
  /** Native folder picker; the next backup goes there (existing copies stay where they are). */
  pickFolder: 'backup:pick-folder',
  useDefaultFolder: 'backup:use-default-folder',
  /** Arg: a backup's file name in the current folder. Restores into a new Brain folder and switches to it. */
  restore: 'backup:restore',
} as const;

/** `window.insectoids.backups`. "Back up now" is the `backup` job's Run now (`runCadenceNow` with `maint-backup`). */
export interface BackupApi {
  state(): Promise<BackupState>;
  pickFolder(): Promise<BackupResult>;
  useDefaultFolder(): Promise<BackupResult>;
  restore(file: string): Promise<BackupResult>;
}
