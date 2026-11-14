import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_FILE_PATTERN, BACKUP_KEEP, backupFileName } from '@insectoids/shared';
import type { Brain } from './brain';

/**
 * Brain backups (Memory 01-D8, Cadence 05-D7; Phase 3 A5): the `backup` maintenance job's file work. Local only.
 * A copy is written with SQLite `VACUUM INTO` (Brain.backupTo) as `brain-backup-<UTC stamp>.db`; afterwards only
 * the newest `keep` files whose names match BACKUP_FILE_PATTERN stay. Nothing else in the folder is ever touched.
 */
export interface BackupWritten {
  file: string;
  sizeBytes: number;
  /** Backups in the folder after pruning (this one included). */
  kept: number;
  /** Older backups deleted to keep only the newest `keep`. */
  removed: string[];
}

/** Writes a new backup of the Brain into `dir` (made if missing), then prunes older ones beyond `keep`. */
export function writeBackup(brain: Brain, dir: string, at: number, keep = BACKUP_KEEP): BackupWritten {
  mkdirSync(dir, { recursive: true });
  const name = backupFileName(at);
  const file = join(dir, name);
  if (existsSync(file)) throw new Error('A backup from this very second is already there. Try again in a moment.');
  const sizeBytes = brain.backupTo(file);
  const removed = pruneBackups(dir, keep);
  return { file, sizeBytes, kept: backupFiles(dir).length, removed };
}

/** The backup files in `dir`, oldest first (their UTC names sort by time). Only names matching the pattern. */
export function backupFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_FILE_PATTERN.test(n))
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Deletes the oldest backups beyond the newest `keep`; returns the deleted names. Never touches other files. */
export function pruneBackups(dir: string, keep = BACKUP_KEEP): string[] {
  const files = backupFiles(dir);
  const old = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const n of old) unlinkSync(join(dir, n));
  return old;
}
