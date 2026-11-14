import { basename, isAbsolute, join, resolve } from 'node:path';
import { type BrowserWindow, type IpcMainInvokeEvent, dialog, ipcMain, shell } from 'electron';
import { BRAIN_EXPORT_IPC, EXPORT_FOLDER_NAME, ObsidianExportRequestSchema, type ObsidianExportResult, ObsidianExportResultSchema } from '@insectoids/shared';
import type { AppSettingsStore } from './app-settings';
import { isSameOrInside } from './backups';

/**
 * The Brain as an Obsidian vault, main's side (Memory 01-D11; Phase 3 C2). main shows the folder picker, refuses a
 * folder in the Brain folder, remembers the folder for next time, and asks the Brain host (the only process that
 * opens brain.db) to write the vault. "Show folder" opens only the folder the last export made.
 */
export interface BrainExportDeps {
  settings: Pick<AppSettingsStore, 'brainDir' | 'value' | 'update'>;
  /** The native folder picker (or the e2e folder), starting at `defaultPath`; null when cancelled. */
  pickFolder: (defaultPath: string | undefined) => Promise<string | null>;
  /** Why the Brain can't export right now (not running yet), or null. Checked before the picker opens. */
  notReady: () => string | null;
  /** Host RPC `exportObsidian`; may throw (host gone, timeout). */
  callHost: (req: { dir: string; includeArchived: boolean }) => Promise<unknown>;
  /** shell.openPath: '' on success, otherwise the error in words. */
  openPath: (path: string) => Promise<string>;
}

/** What the renderer may send: only whether to include archived notes (the folder is always picked here). */
const ExportArgSchema = ObsidianExportRequestSchema.pick({ includeArchived: true }).strict();

const norm = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

const fail = (error: string, cancelled = false): ObsidianExportResult => ({ ok: false, error, cancelled });

/** Why this folder can't hold the vault, in words, or null. The vault goes in `<dir>/Insectoids Brain`. */
export function checkExportFolder(dir: string, brainDir: string): string | null {
  if (!isAbsolute(dir)) return 'Choose a full folder path.';
  const vault = join(dir, EXPORT_FOLDER_NAME);
  // The Brain folder is the vault folder or inside it: the export would write over the Brain.
  if (isSameOrInside(brainDir, vault)) return 'The vault would overlap the Brain folder. Choose another folder for the Obsidian vault.';
  if (isSameOrInside(vault, brainDir)) return 'That folder is inside the Brain folder. Choose a folder outside it for the Obsidian vault.';
  return null;
}

export function createBrainExportHandlers(d: BrainExportDeps): Record<(typeof BRAIN_EXPORT_IPC)[keyof typeof BRAIN_EXPORT_IPC], (arg: unknown) => Promise<unknown>> {
  /** The vault folder the last successful export wrote; the only path "Show folder" opens. */
  let lastExportPath: string | null = null;

  const exportObsidian = async (arg: unknown): Promise<ObsidianExportResult> => {
    const parsed = ExportArgSchema.safeParse(arg ?? {});
    if (!parsed.success) return fail('The export request was not understood.');
    const notReady = d.notReady();
    if (notReady) return fail(notReady);
    const dir = await d.pickFolder(d.settings.value.exportDir);
    if (!dir) return fail('Cancelled.', true);
    const bad = checkExportFolder(dir, d.settings.brainDir);
    if (bad) return fail(bad);
    d.settings.update((s) => ({ ...s, exportDir: dir }));
    let raw: unknown;
    try {
      raw = await d.callHost({ dir, includeArchived: parsed.data.includeArchived });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const r = ObsidianExportResultSchema.safeParse(raw);
    if (!r.success) return fail('The Brain sent back an answer the app did not understand. Nothing was shown.');
    if (r.data.ok) lastExportPath = r.data.path;
    return r.data;
  };

  const showFolder = async (arg: unknown): Promise<void> => {
    if (typeof arg !== 'string' || basename(arg) !== EXPORT_FOLDER_NAME || !lastExportPath || norm(arg) !== norm(lastExportPath)) {
      throw new Error('That is not the folder the last export made.');
    }
    const err = await d.openPath(lastExportPath);
    if (err) throw new Error(`The folder could not be opened: ${err}`);
  };

  return {
    [BRAIN_EXPORT_IPC.exportObsidian]: exportObsidian,
    [BRAIN_EXPORT_IPC.showFolder]: showFolder,
  };
}

export interface BrainExportIpcDeps extends Omit<BrainExportDeps, 'pickFolder' | 'openPath'> {
  window: () => BrowserWindow | null;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  /** e2e only (INSECTOIDS_E2E_EXPORT_FOLDER with INSECTOIDS_E2E=1): the folder the native picker would return. */
  testPickedFolder?: string;
}

/** Obsidian export over IPC (Phase 3 C2): trusted sender only, then the handler. */
export function registerBrainExportIpc(d: BrainExportIpcDeps): void {
  const pickFolder = async (defaultPath: string | undefined): Promise<string | null> => {
    if (d.testPickedFolder) return d.testPickedFolder;
    const win = d.window();
    const options = {
      title: 'Choose where to put the Obsidian vault',
      buttonLabel: 'Export here',
      properties: ['openDirectory' as const, 'createDirectory' as const],
      ...(defaultPath ? { defaultPath } : {}),
    };
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const dir = res.filePaths[0];
    return res.canceled || !dir ? null : dir;
  };
  const handlers = createBrainExportHandlers({ ...d, pickFolder, openPath: (p) => shell.openPath(p) });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, arg: unknown) => {
      d.assertTrustedSender(event);
      return fn(arg);
    });
  }
}
