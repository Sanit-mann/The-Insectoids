import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  BACKUP_FILE_PATTERN,
  BACKUP_IPC,
  type BackupEntry,
  type BackupResult,
  BackupResultSchema,
  type BackupState,
  BackupStateSchema,
} from '@insectoids/shared';
import type { AppSettingsStore } from './app-settings';

/**
 * Brain backups, main's side (Memory 01-D8; Phase 3 A5). The Brain host writes the copies (it is the only writer
 * of brain.db); main keeps the folder setting, lists the copies, and restores one into a NEW Brain folder.
 * Nothing here touches the network: backups stay on this computer.
 */

const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today 03:00", "yesterday 03:00", "tomorrow 03:00" or "Mon 10 Nov 03:00" (local time, 24-hour). */
export function timeWords(at: number, now: number): string {
  const d = new Date(at);
  const day = (offset: number): Date => {
    const x = new Date(now);
    x.setDate(x.getDate() + offset);
    return x;
  };
  if (sameDay(d, day(0))) return `today ${hhmm(d)}`;
  if (sameDay(d, day(-1))) return `yesterday ${hhmm(d)}`;
  if (sameDay(d, day(1))) return `tomorrow ${hhmm(d)}`;
  const weekday = d.toLocaleString('en', { weekday: 'short' });
  const month = d.toLocaleString('en', { month: 'short' });
  return `${weekday} ${d.getDate()} ${month} ${hhmm(d)}`;
}

/** When a backup was made, from its name (UTC, `brain-backup-2026-11-14T03-00-00Z.db`); null for other names. */
export function backupTime(file: string): number | null {
  if (!BACKUP_FILE_PATTERN.test(file)) return null;
  const m = /^brain-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db$/.exec(file);
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isFinite(at) ? at : null;
}

/**
 * The backups in a folder, newest first: only files whose names match BACKUP_FILE_PATTERN (anything else the user
 * keeps there is left alone and not listed). A folder that doesn't exist yet simply has no backups.
 */
export function listBackups(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return [];
  const out: BackupEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !BACKUP_FILE_PATTERN.test(e.name)) continue;
    let size: number;
    let mtime: number;
    try {
      const st = statSync(join(dir, e.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      continue; // removed while we looked (the host keeps only the newest copies)
    }
    out.push({ file: e.name, at: backupTime(e.name) ?? Math.round(mtime), sizeBytes: size });
  }
  return out.sort((a, b) => b.at - a.at || (a.file < b.file ? 1 : -1));
}

/** Is `child` the folder `parent` or inside it? Windows paths compare without case. */
export function isSameOrInside(child: string, parent: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Can this folder hold the backups? A full path, not the Brain folder nor inside it (a lost Brain folder must not
 * take its backups with it), and a folder we can write to (created if missing). Returns why not in words, or null.
 */
export function checkBackupFolder(dir: string, brainDir: string): string | null {
  if (!isAbsolute(dir)) return 'Choose a full folder path.';
  if (isSameOrInside(dir, brainDir)) {
    return isSameOrInside(brainDir, dir)
      ? 'Backups can’t go in the Brain folder itself. Choose a folder outside it, so the backups survive if the Brain folder is lost.'
      : 'That folder is inside the Brain folder. Choose a folder outside it, so the backups survive if the Brain folder is lost.';
  }
  try {
    if (existsSync(dir) && !statSync(dir).isDirectory()) return `${dir} is a file, not a folder.`;
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.insectoids-write-test-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return `Backups can’t be saved in ${dir}${code ? ` (${code})` : ''}. Choose a folder you can write to.`;
  }
  return null;
}

/** `brain-restored-2026-11-14T03-00-00Z` (UTC, like the backup names). */
export const restoredFolderName = (at: number): string => `brain-restored-${new Date(at).toISOString().slice(0, 19).replace(/:/g, '-')}Z`;

/** Makes a brand-new folder for a restore; never reuses one that exists (adds -2, -3, … instead). */
function makeRestoreFolder(userDataDir: string, at: number): string {
  mkdirSync(userDataDir, { recursive: true });
  const base = join(userDataDir, restoredFolderName(at));
  for (let n = 1; n < 100; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try {
      mkdirSync(dir); // not recursive: fails if it already exists
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Too many restored Brains with the same time. Try again in a second.');
}

export interface BackupHost {
  status: { state: string };
  call(method: 'setBackupDir', params: { dir: string }): Promise<unknown>;
}

/**
 * Tells the Brain host where backups go: at every host start (on "ready") and whenever the folder changes.
 * A host that is not ready is skipped: it gets the folder when it becomes ready.
 */
export function createBackupDirSync(o: { dir: () => string; log?: (line: string) => void }) {
  const send = async (host: BackupHost | null): Promise<string | null> => {
    if (!host || host.status.state !== 'ready') return null;
    try {
      await host.call('setBackupDir', { dir: o.dir() });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      o.log?.(`[backups] could not tell the Brain the backups folder: ${message}`);
      return message;
    }
  };
  return {
    send,
    /** Hook for BrainHost's onStatus: a (re)started host gets the folder at once. */
    onStatus: (host: BackupHost | null, status: { state: string }): void => {
      if (status.state === 'ready') void send(host);
    },
  };
}

export type BackupSettings = Pick<AppSettingsStore, 'backupDir' | 'defaultBackupDir' | 'brainDir' | 'update'>;

export interface BackupDeps {
  settings: BackupSettings;
  /** Restored Brains go in `<userData>/brain-restored-<stamp>`. */
  userDataDir: string;
  /** When the backup job runs next: a time, null when it is switched off, undefined when the hive can't say. */
  nextBackupAt: () => Promise<number | null | undefined>;
  /** The native folder picker (or the e2e folder); null when cancelled. */
  pickFolder: () => Promise<string | null>;
  /** Tell the Brain host the folder changed; an error in words, or null. */
  tellHost: () => Promise<string | null>;
  /** Why the Brain can't be switched right now (goals running, already moving), or null. */
  brainBusy: () => Promise<string | null>;
  /** The same switch "Brain folder" uses (restarts the host). An error in words, or null. */
  switchBrainDir: (dir: string) => Promise<string | null>;
  now?: () => number;
}

const NOT_A_BACKUP = 'That is not one of the backups in the backups folder.';

export function createBackupHandlers(d: BackupDeps): Record<(typeof BACKUP_IPC)[keyof typeof BACKUP_IPC], (arg: unknown) => Promise<unknown>> {
  const now = d.now ?? Date.now;

  const message = async (dir: string, backups: BackupEntry[]): Promise<string> => {
    const t = now();
    if (isSameOrInside(dir, d.settings.brainDir)) return 'The backups folder is inside the Brain folder. Choose another folder for backups.';
    const next = await d.nextBackupAt().catch(() => undefined);
    const off = next === null ? ' The daily backup is switched off.' : '';
    const newest = backups[0];
    if (newest) {
      const n = backups.length;
      return `${n} ${n === 1 ? 'backup' : 'backups'}, the newest from ${timeWords(newest.at, t)}.${off}`;
    }
    if (next === null) return 'No backups yet. The daily backup is switched off; press Back up now to make one.';
    if (next === undefined) return 'No backups yet. The first one runs at the daily backup time, or press Back up now.';
    return `No backups yet. The first one runs ${timeWords(next, t).replace(/ (\d\d:\d\d)$/, ' at $1')}, or press Back up now.`;
  };

  const state = async (): Promise<BackupState> => {
    const dir = d.settings.backupDir;
    let backups: BackupEntry[] = [];
    let msg: string;
    try {
      backups = listBackups(dir);
      msg = await message(dir, backups);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      msg = `The backups folder can’t be read${code ? ` (${code})` : ''}. Choose another folder.`;
    }
    return BackupStateSchema.parse({ dir, defaultDir: d.settings.defaultBackupDir, backups, message: msg });
  };

  const result = async (error?: string | null): Promise<BackupResult> =>
    BackupResultSchema.parse(error ? { ok: false, error, state: await state() } : { ok: true, state: await state() });

  const setFolder = async (dir: string | null): Promise<BackupResult> => {
    const target = dir ?? d.settings.defaultBackupDir;
    const bad = checkBackupFolder(target, d.settings.brainDir);
    if (bad) return result(bad);
    d.settings.update((s) => {
      const next = { ...s };
      if (dir === null || target === d.settings.defaultBackupDir) delete next.backupDir;
      else next.backupDir = target;
      return next;
    });
    const err = await d.tellHost();
    return result(err ? `Saved, but the Brain could not use it yet: ${err}` : null);
  };

  const restore = async (arg: unknown): Promise<BackupResult> => {
    if (typeof arg !== 'string' || basename(arg) !== arg || arg.includes('..') || !BACKUP_FILE_PATTERN.test(arg)) return result(NOT_A_BACKUP);
    const src = join(d.settings.backupDir, arg);
    try {
      if (!statSync(src).isFile()) return result(NOT_A_BACKUP);
    } catch {
      return result('That backup is no longer in the backups folder.');
    }
    const busy = await d.brainBusy();
    if (busy) return result(busy);
    let target: string;
    try {
      target = makeRestoreFolder(d.userDataDir, now());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return result(`Could not make a folder for the restored Brain${code ? ` (${code})` : ''}.`);
    }
    try {
      // COPYFILE_EXCL: never overwrite (the folder is brand new, so nothing is there to overwrite anyway).
      copyFileSync(src, join(target, 'brain.db'), constants.COPYFILE_EXCL);
    } catch (err) {
      rmSync(target, { recursive: true, force: true });
      const code = (err as NodeJS.ErrnoException).code;
      return result(`Could not copy the backup${code ? ` (${code})` : ''}. Your Brain was not changed.`);
    }
    const err = await d.switchBrainDir(target);
    if (err) {
      // Our own fresh copy only: the user's Brain was never touched.
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // A file may still be held open for a moment; an unused copy is harmless.
      }
      return result(err);
    }
    return result();
  };

  return {
    [BACKUP_IPC.state]: () => state(),
    [BACKUP_IPC.pickFolder]: async () => {
      const dir = await d.pickFolder();
      return dir ? setFolder(dir) : result();
    },
    [BACKUP_IPC.useDefaultFolder]: () => setFolder(null),
    [BACKUP_IPC.restore]: restore,
  };
}
