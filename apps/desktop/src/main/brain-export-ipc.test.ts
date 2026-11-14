import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAIN_EXPORT_IPC, EXPORT_FOLDER_NAME, type ObsidianExportResult, ObsidianExportResultSchema } from '@insectoids/shared';
import { AppSettingsStore } from './app-settings';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg: unknown) => Promise<unknown>>(),
  showOpenDialog: vi.fn(async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] })),
  openPath: vi.fn(async (): Promise<string> => ''),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, arg: unknown) => Promise<unknown>) => electron.handlers.set(channel, fn) },
  dialog: { showOpenDialog: electron.showOpenDialog },
  shell: { openPath: electron.openPath },
}));

const { checkExportFolder, createBrainExportHandlers, registerBrainExportIpc } = await import('./brain-export-ipc');
type Deps = Parameters<typeof createBrainExportHandlers>[0];

let root: string;
let settings: AppSettingsStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-export-ipc-'));
  settings = new AppSettingsStore(root);
  electron.handlers.clear();
  electron.showOpenDialog.mockClear();
  electron.openPath.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const picked = (): string => join(root, 'Notes');
const vaultOf = (dir: string): string => join(dir, EXPORT_FOLDER_NAME);
const okResult = (dir: string): ObsidianExportResult => ({
  ok: true,
  path: vaultOf(dir),
  notes: 3,
  links: 1,
  shelves: 2,
  redacted: 0,
  skipped: 0,
  at: 1,
  message: `Exported 3 notes from 2 shelves to ${vaultOf(dir)}.`,
});

function handlers(over: Partial<Deps> = {}) {
  const d: Deps = {
    settings,
    pickFolder: vi.fn(async () => picked()),
    notReady: () => null,
    callHost: vi.fn(async (req: { dir: string }) => okResult(req.dir)),
    openPath: vi.fn(async () => ''),
    ...over,
  };
  const h = createBrainExportHandlers(d);
  return {
    d,
    run: async (arg?: unknown) => ObsidianExportResultSchema.parse(await h[BRAIN_EXPORT_IPC.exportObsidian](arg)),
    show: (arg: unknown) => h[BRAIN_EXPORT_IPC.showFolder](arg),
  };
}

describe('Obsidian export over IPC (Phase 3 C2)', () => {
  it('picks a folder, remembers it, asks the host, and returns its result', async () => {
    const h = handlers();
    const r = await h.run({ includeArchived: true });
    expect(r).toEqual(okResult(picked()));
    expect(h.d.callHost).toHaveBeenCalledWith({ dir: picked(), includeArchived: true });
    expect(settings.value.exportDir).toBe(picked());
    // The next picker starts in the folder picked last.
    await h.run();
    expect(h.d.pickFolder).toHaveBeenLastCalledWith(picked());
    expect(h.d.callHost).toHaveBeenLastCalledWith({ dir: picked(), includeArchived: false });
  });

  it('a cancelled picker is a quiet "Cancelled." and never reaches the host', async () => {
    const h = handlers({ pickFolder: async () => null });
    expect(await h.run()).toEqual({ ok: false, error: 'Cancelled.', cancelled: true });
    expect(h.d.callHost).not.toHaveBeenCalled();
    expect(settings.value.exportDir).toBeUndefined();
  });

  it('refuses a folder inside the Brain folder (and the Brain folder itself) before the host is asked', async () => {
    for (const dir of [settings.brainDir, join(settings.brainDir, 'notes')]) {
      const h = handlers({ pickFolder: async () => dir });
      const r = await h.run();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/inside the Brain folder/);
      expect(h.d.callHost).not.toHaveBeenCalled();
    }
    expect(settings.value.exportDir).toBeUndefined();
    expect(checkExportFolder('relative/path', settings.brainDir)).toBe('Choose a full folder path.');
    // A Brain folder that is itself named "Insectoids Brain" inside the picked folder would be overwritten.
    expect(checkExportFolder(root, join(root, EXPORT_FOLDER_NAME))).toMatch(/overlap the Brain folder/);
    expect(checkExportFolder(root, settings.brainDir)).toBeNull();
  });

  it('a Brain that is not ready says so before the picker opens', async () => {
    const h = handlers({ notReady: () => 'Starting the Brain…' });
    expect(await h.run()).toEqual({ ok: false, error: 'Starting the Brain…', cancelled: false });
    expect(h.d.pickFolder).not.toHaveBeenCalled();
  });

  it('host errors and odd replies come back in words', async () => {
    const thrown = handlers({ callHost: async () => Promise.reject(new Error('The hive did not answer within 30 s.')) });
    expect(await thrown.run()).toEqual({ ok: false, error: 'The hive did not answer within 30 s.', cancelled: false });
    const refused = handlers({ callHost: async () => ({ ok: false, error: 'That folder already has an "Insectoids Brain" folder the app did not make.' }) });
    const r = await refused.run();
    expect(r).toEqual({ ok: false, error: 'That folder already has an "Insectoids Brain" folder the app did not make.', cancelled: false });
    const odd = handlers({ callHost: async () => ({ hello: 'world' }) });
    expect((await odd.run()).ok).toBe(false);
  });

  it('rejects anything but { includeArchived } from the renderer (the folder is always picked in main)', async () => {
    const h = handlers();
    for (const bad of [{ dir: 'C:\\Windows' }, { includeArchived: 'yes' }, 'x']) {
      const r = await h.run(bad);
      expect(r.ok).toBe(false);
    }
    expect(h.d.pickFolder).not.toHaveBeenCalled();
    expect(h.d.callHost).not.toHaveBeenCalled();
  });

  it('"Show folder" opens only the folder the last export made', async () => {
    const h = handlers();
    // Nothing exported yet: nothing to show.
    await expect(h.show(vaultOf(picked()))).rejects.toThrow(/not the folder the last export made/);
    await h.run();
    await expect(h.show(vaultOf(picked()))).resolves.toBeUndefined();
    expect(h.d.openPath).toHaveBeenCalledWith(vaultOf(picked()));
    for (const other of [picked(), vaultOf(join(root, 'Elsewhere')), join(vaultOf(picked()), 'Global'), 'C:\\Windows\\System32', 42, null]) {
      await expect(h.show(other)).rejects.toThrow(/not the folder the last export made/);
    }
    expect(h.d.openPath).toHaveBeenCalledTimes(1);
    // A failed export doesn't change which folder may be shown.
    const failing = handlers({ callHost: async () => ({ ok: false, error: 'Disk full.' }) });
    await failing.run();
    await expect(failing.show(vaultOf(picked()))).rejects.toThrow(/not the folder the last export made/);
  });

  it('"Show folder" passes on an error from the file manager', async () => {
    const h = handlers({ openPath: async () => 'Access is denied.' });
    await h.run();
    await expect(h.show(vaultOf(picked()))).rejects.toThrow('The folder could not be opened: Access is denied.');
  });

  it('registers both channels behind the trusted-sender check, and the e2e folder replaces the native picker', async () => {
    const assertTrustedSender = vi.fn((event: unknown) => {
      if ((event as { trusted?: boolean }).trusted !== true) throw new Error('Refused: untrusted sender');
    });
    const callHost = vi.fn(async (req: { dir: string }) => okResult(req.dir));
    registerBrainExportIpc({ settings, notReady: () => null, callHost, window: () => null, assertTrustedSender, testPickedFolder: picked() });
    expect([...electron.handlers.keys()].sort()).toEqual([BRAIN_EXPORT_IPC.exportObsidian, BRAIN_EXPORT_IPC.showFolder].sort());
    const exportFn = electron.handlers.get(BRAIN_EXPORT_IPC.exportObsidian)!;
    await expect(exportFn({ trusted: false }, {})).rejects.toThrow('Refused: untrusted sender');
    expect(callHost).not.toHaveBeenCalled();
    expect(await exportFn({ trusted: true }, {})).toEqual(okResult(picked()));
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
    await electron.handlers.get(BRAIN_EXPORT_IPC.showFolder)!({ trusted: true }, vaultOf(picked()));
    expect(electron.openPath).toHaveBeenCalledWith(vaultOf(picked()));
  });

  it('without the e2e folder the native picker opens with its title, starting in the last folder', async () => {
    settings.update((s) => ({ ...s, exportDir: picked() }));
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    registerBrainExportIpc({ settings, notReady: () => null, callHost: vi.fn(), window: () => null, assertTrustedSender: () => {} });
    const r = await electron.handlers.get(BRAIN_EXPORT_IPC.exportObsidian)!({}, undefined);
    expect(r).toEqual({ ok: false, error: 'Cancelled.', cancelled: true });
    expect(electron.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Choose where to put the Obsidian vault', defaultPath: picked() }));
  });
});
