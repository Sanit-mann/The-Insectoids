import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_IPC, type BackupResult, BackupResultSchema, type BackupState, BackupStateSchema, backupFileName } from '@insectoids/shared';
import { AppSettingsStore } from './app-settings';
import { type BackupDeps, backupTime, checkBackupFolder, createBackupDirSync, createBackupHandlers, listBackups, restoredFolderName } from './backups';

let root: string;
let settings: AppSettingsStore;
const NOW = Date.parse('2026-11-14T12:00:00Z');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-backups-'));
  settings = new AppSettingsStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(dir: string, name: string, bytes: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), Buffer.alloc(bytes, 1));
}

function handlers(over: Partial<BackupDeps> = {}) {
  const d: BackupDeps = {
    settings,
    userDataDir: root,
    nextBackupAt: async () => NOW + 15 * 3_600_000,
    pickFolder: async () => null,
    tellHost: vi.fn(async () => null),
    brainBusy: async () => null,
    switchBrainDir: vi.fn(async () => null),
    now: () => NOW,
    ...over,
  };
  const h = createBackupHandlers(d);
  return {
    d,
    state: async () => BackupStateSchema.parse(await h[BACKUP_IPC.state](undefined)) as BackupState,
    pick: async () => BackupResultSchema.parse(await h[BACKUP_IPC.pickFolder](undefined)) as BackupResult,
    useDefault: async () => BackupResultSchema.parse(await h[BACKUP_IPC.useDefaultFolder](undefined)) as BackupResult,
    restore: async (file: unknown) => BackupResultSchema.parse(await h[BACKUP_IPC.restore](file)) as BackupResult,
  };
}

describe('backup files', () => {
  it('reads the time from the name, and only from matching names', () => {
    expect(backupTime(backupFileName(NOW))).toBe(NOW);
    expect(backupTime('brain-backup-2026-11-14.db')).toBeNull();
    expect(restoredFolderName(NOW)).toBe('brain-restored-2026-11-14T12-00-00Z');
  });

  it('lists only matching files, newest first, with their sizes', () => {
    const dir = join(root, 'backups');
    put(dir, backupFileName(NOW - 2 * 86_400_000), 10);
    put(dir, backupFileName(NOW), 30);
    put(dir, backupFileName(NOW - 86_400_000), 20);
    put(dir, 'notes.txt', 5);
    put(dir, 'brain-backup-latest.db', 5);
    mkdirSync(join(dir, 'brain-backup-2026-11-14T00-00-00Z.db')); // a folder with a backup's name
    expect(listBackups(dir)).toEqual([
      { file: backupFileName(NOW), at: NOW, sizeBytes: 30 },
      { file: backupFileName(NOW - 86_400_000), at: NOW - 86_400_000, sizeBytes: 20 },
      { file: backupFileName(NOW - 2 * 86_400_000), at: NOW - 2 * 86_400_000, sizeBytes: 10 },
    ]);
    expect(listBackups(join(root, 'nope'))).toEqual([]);
  });
});

describe('state', () => {
  it('defaults to <userData>/backups and says when the first backup runs', async () => {
    const s = await handlers().state();
    expect(s.dir).toBe(join(root, 'backups'));
    expect(s.defaultDir).toBe(join(root, 'backups'));
    expect(s.backups).toEqual([]);
    expect(s.message).toMatch(/^No backups yet\. The first one runs .+ at \d\d:\d\d, or press Back up now\.$/);
  });

  it('counts the backups and names the newest', async () => {
    put(join(root, 'backups'), backupFileName(NOW - 3_600_000), 1);
    put(join(root, 'backups'), backupFileName(NOW - 86_400_000), 1);
    const s = await handlers().state();
    expect(s.backups).toHaveLength(2);
    expect(s.message).toMatch(/^2 backups, the newest from today \d\d:\d\d\.$/);
  });

  it('says when the daily backup is switched off', async () => {
    expect((await handlers({ nextBackupAt: async () => null }).state()).message).toBe(
      'No backups yet. The daily backup is switched off; press Back up now to make one.',
    );
  });
});

describe('folder', () => {
  it('refuses the Brain folder and folders inside it, in words', () => {
    const brain = settings.brainDir;
    expect(checkBackupFolder(brain, brain)).toMatch(/can’t go in the Brain folder itself/);
    expect(checkBackupFolder(join(brain, 'backups'), brain)).toMatch(/inside the Brain folder/);
    // Case-insensitive disks (Windows, macOS): the same folder in other letters is still inside. Linux: a different folder.
    if (process.platform === 'win32' || process.platform === 'darwin') expect(checkBackupFolder(join(brain.toUpperCase(), 'x'), brain)).toMatch(/inside the Brain folder/);
    expect(checkBackupFolder('relative/folder', brain)).toBe('Choose a full folder path.');
    writeFileSync(join(root, 'a-file'), 'x');
    expect(checkBackupFolder(join(root, 'a-file'), brain)).toMatch(/is a file, not a folder/);
    expect(checkBackupFolder(join(root, 'elsewhere'), brain)).toBeNull();
  });

  it('a picked folder is saved and the host is told; a refused one changes nothing', async () => {
    const picked = join(root, 'my backups');
    const h = handlers({ pickFolder: async () => picked });
    const r = await h.pick();
    expect(r.ok).toBe(true);
    expect(r.state.dir).toBe(picked);
    expect(settings.backupDir).toBe(picked);
    expect(new AppSettingsStore(root).value.backupDir).toBe(picked);
    expect(h.d.tellHost).toHaveBeenCalledTimes(1);

    const bad = handlers({ pickFolder: async () => join(settings.brainDir, 'inside') });
    const r2 = await bad.pick();
    expect(r2.ok).toBe(false);
    expect(r2.ok ? '' : r2.error).toMatch(/inside the Brain folder/);
    expect(settings.backupDir).toBe(picked);
    expect(bad.d.tellHost).not.toHaveBeenCalled();

    const back = await h.useDefault();
    expect(back.ok).toBe(true);
    expect(settings.value).not.toHaveProperty('backupDir');
    expect(h.d.tellHost).toHaveBeenCalledTimes(2);
  });

  it('cancelling the picker changes nothing', async () => {
    const h = handlers();
    expect((await h.pick()).ok).toBe(true);
    expect(h.d.tellHost).not.toHaveBeenCalled();
  });
});

describe('restore', () => {
  const file = backupFileName(NOW - 86_400_000);
  beforeEach(() => put(join(root, 'backups'), file, 64));

  it('refuses names that are not a backup in the folder', async () => {
    const h = handlers();
    for (const bad of [42, '', '../brain.db', `..\\${file}`, `sub/${file}`, join(root, 'backups', file), 'brain.db', `${file}.bak`]) {
      const r = await h.restore(bad);
      expect(r.ok, String(bad)).toBe(false);
      expect(r.ok ? '' : r.error).toBe('That is not one of the backups in the backups folder.');
    }
    const missing = await h.restore(backupFileName(NOW));
    expect(missing.ok ? '' : missing.error).toBe('That backup is no longer in the backups folder.');
    expect(h.d.switchBrainDir).not.toHaveBeenCalled();
  });

  it('copies the backup into a new folder and switches the Brain there', async () => {
    const h = handlers();
    const r = await h.restore(file);
    expect(r.ok).toBe(true);
    const target = join(root, restoredFolderName(NOW));
    expect(h.d.switchBrainDir).toHaveBeenCalledWith(target);
    expect(readFileSync(join(target, 'brain.db')).length).toBe(64);
    // The backup itself stays.
    expect(existsSync(join(root, 'backups', file))).toBe(true);

    // A second restore at the same moment gets its own folder: nothing is overwritten.
    const again = await h.restore(file);
    expect(again.ok).toBe(true);
    expect(h.d.switchBrainDir).toHaveBeenLastCalledWith(`${target}-2`);
  });

  it('refuses while goals are running, before copying anything', async () => {
    const h = handlers({ brainBusy: async () => 'Goals are running in this Brain. Let them finish (or cancel them) before moving the Brain.' });
    const r = await h.restore(file);
    expect(r.ok ? '' : r.error).toMatch(/^Goals are running/);
    expect(readdirSync(root).filter((n) => n.startsWith('brain-restored-'))).toEqual([]);
    expect(h.d.switchBrainDir).not.toHaveBeenCalled();
  });

  it('a failed switch removes the unused copy and says why', async () => {
    const h = handlers({ switchBrainDir: vi.fn(async () => 'The Brain could not open it.') });
    const r = await h.restore(file);
    expect(r.ok ? '' : r.error).toBe('The Brain could not open it.');
    expect(readdirSync(root).filter((n) => n.startsWith('brain-restored-'))).toEqual([]);
  });
});

describe('telling the host', () => {
  const host = (state: string) => ({ status: { state }, call: vi.fn(async (_m: 'setBackupDir', _p: { dir: string }) => ({ ok: true })) });

  it('sends setBackupDir when the host becomes ready (every start), not while it starts', () => {
    const sync = createBackupDirSync({ dir: () => '/b' });
    const starting = host('starting');
    sync.onStatus(starting, starting.status);
    expect(starting.call).not.toHaveBeenCalled();
    const ready = host('ready');
    sync.onStatus(ready, ready.status);
    expect(ready.call).toHaveBeenCalledWith('setBackupDir', { dir: '/b' });
  });

  it('sends the current folder on change, and reports a failure in words', async () => {
    let dir = '/one';
    const log = vi.fn();
    const sync = createBackupDirSync({ dir: () => dir, log });
    const h = host('ready');
    dir = '/two';
    expect(await sync.send(h)).toBeNull();
    expect(h.call).toHaveBeenLastCalledWith('setBackupDir', { dir: '/two' });
    expect(await sync.send(null)).toBeNull();
    h.call.mockRejectedValueOnce(new Error('busy'));
    expect(await sync.send(h)).toBe('busy');
    expect(log).toHaveBeenCalled();
  });
});
