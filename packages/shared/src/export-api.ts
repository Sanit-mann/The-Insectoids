import { z } from 'zod';

/**
 * Obsidian export (Memory 01-D11, E13; Phase 3 C2): a read-only copy of the Brain as a folder of Markdown notes
 * that opens as an Obsidian vault. Edits made in Obsidian don't flow back.
 *
 * Layout, inside the folder the user picks:
 *   <picked>/Insectoids Brain/
 *     README.md                         what this is, when it was made, how many notes, "read-only copy"
 *     <Shelf name>/<Kind plural>/<Title>.md   e.g. "Global/Facts/Hosting provider.md", "Shop site/Decisions/Use Stripe.md"
 *     .insectoids-export.json           the marker: what this export wrote (paths), so the next export replaces
 *                                       only its own files
 * - Each note: YAML frontmatter (id, kind, shelf, trust, owner, source, created, updated, version, confidence,
 *   valid_from, valid_to, importance, tags [insectoids/<kind>, insectoids/trust/<trust>], aliases [title when the
 *   file name had to change]), then the body, then a "## Links" section: one line per Brain link,
 *   `- <relation in words>: [[<file name>|<title>]]` (outgoing links; Obsidian shows backlinks itself).
 *   Superseded facts link to what replaced them.
 * - File names: Obsidian-safe (no * " \ / < > : | ? # ^ [ ]), trimmed to 120 characters, collisions get " (2)".
 * - Current records only by default; `includeArchived` adds archived and superseded ones (tagged
 *   `insectoids/archived`).
 * - **Secrets are never written.** Every title, body and source is passed through the Brain's secret patterns: a
 *   match is replaced with `[secret removed]` and the note gets `redacted: true`. The finished file is checked again
 *   before it is written; if anything still matches, the note is left out.
 * - **Never overwrites the user's files:** an existing `Insectoids Brain` folder without the marker is refused; with
 *   the marker, only files the last export listed are removed or replaced.
 */
export const EXPORT_FOLDER_NAME = 'Insectoids Brain';
export const EXPORT_MARKER = '.insectoids-export.json';
export const SECRET_REMOVED = '[secret removed]';

export const ObsidianExportRequestSchema = z.object({
  /** The folder the user picked; the vault goes in `<dir>/Insectoids Brain`. */
  dir: z.string().min(1).max(1000),
  includeArchived: z.boolean().default(false),
});
export type ObsidianExportRequest = z.input<typeof ObsidianExportRequestSchema>;

export const ObsidianExportResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** The vault folder (`<dir>/Insectoids Brain`). */
    path: z.string(),
    notes: z.number().int(),
    links: z.number().int(),
    shelves: z.number().int(),
    /** Notes that had a secret removed. */
    redacted: z.number().int(),
    /** Notes left out because something still looked like a secret after removal. */
    skipped: z.number().int(),
    at: z.number(),
    /** Plain words: "Exported 214 notes from 3 shelves to D:\Notes\Insectoids Brain. 1 note had a secret removed." */
    message: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string(), cancelled: z.boolean().default(false) }),
]);
export type ObsidianExportResult = z.infer<typeof ObsidianExportResultSchema>;

/** Host RPC `exportObsidian` takes ObsidianExportRequest and returns ObsidianExportResult. */
export const BRAIN_EXPORT_IPC = {
  /** Folder picker (e2e: INSECTOIDS_E2E_EXPORT_FOLDER), then the export. Arg: `{ includeArchived?: boolean }`. */
  exportObsidian: 'brain:export-obsidian',
  /** Show the vault folder in the file manager. Arg: the path from the last result. */
  showFolder: 'brain:show-export-folder',
} as const;

/** `window.insectoids.brainExport`. */
export interface BrainExportApi {
  exportObsidian(opts?: { includeArchived?: boolean }): Promise<ObsidianExportResult>;
  showFolder(path: string): Promise<void>;
}
