/**
 * The Brain as an Obsidian vault, the host's side (Memory 01-D11, E13; Phase 3 C2). The host is the only process
 * that opens brain.db, so it builds and writes the vault; main picked the folder and checked it is not the Brain
 * folder. No Electron imports: unit-tested under plain Node.
 */
import { type Brain, buildObsidianVault, writeObsidianVault } from '@insectoids/brain';
import { type ObsidianExportResult, ObsidianExportRequestSchema, ObsidianExportResultSchema } from '@insectoids/shared';

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Exported 214 notes from 3 shelves to D:\Notes\Insectoids Brain. 1 note had a secret removed." */
export function exportMessage(r: { notes: number; shelves: number; path: string; redacted: number; skipped: number }): string {
  const parts = [`Exported ${count(r.notes, 'note', 'notes')} from ${count(r.shelves, 'shelf', 'shelves')} to ${r.path}.`];
  if (r.redacted > 0) parts.push(`${count(r.redacted, 'note', 'notes')} had a secret removed.`);
  if (r.skipped > 0) {
    parts.push(
      r.skipped === 1
        ? '1 note was left out because it looked like it held a secret.'
        : `${r.skipped} notes were left out because they looked like they held a secret.`,
    );
  }
  return parts.join(' ');
}

/** Folder names for shelves: "Global", and the open project's own folder name for its shelf; other shelves keep their name. */
export function shelfNamer(project: { shelf: string; name: string } | null): (shelf: string) => string {
  return (shelf) => {
    if (shelf === 'global') return 'Global';
    if (project && shelf === project.shelf && project.name.trim()) return project.name.trim();
    return shelf;
  };
}

/**
 * Builds the vault from the Brain and writes it to `<dir>/Insectoids Brain`. Never throws: a bad request or a
 * refusal from the writer (a folder it must not overwrite, a disk error) comes back as `{ ok: false, error }`.
 */
export function exportObsidian(o: {
  brain: Brain;
  /** An ObsidianExportRequest; checked again here. */
  request: unknown;
  now: number;
  project?: { shelf: string; name: string } | null;
}): ObsidianExportResult {
  const req = ObsidianExportRequestSchema.safeParse(o.request);
  if (!req.success) return { ok: false, error: 'The export needs a folder to write to.', cancelled: false };
  try {
    const build = buildObsidianVault(o.brain, { includeArchived: req.data.includeArchived, now: o.now, shelfName: shelfNamer(o.project ?? null) });
    const { path } = writeObsidianVault(req.data.dir, build, { now: o.now });
    const shelves = build.shelves.length;
    return ObsidianExportResultSchema.parse({
      ok: true,
      path,
      notes: build.notes,
      links: build.links,
      shelves,
      redacted: build.redacted,
      skipped: build.skipped,
      at: o.now,
      message: exportMessage({ notes: build.notes, shelves, path, redacted: build.redacted, skipped: build.skipped }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || 'The export failed.', cancelled: false };
  }
}
