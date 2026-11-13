import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { LibraryItemInput } from '@insectoids/brain';
import { type FolderScan, SCAN_LIMITS, scanFolder } from './scan';

/**
 * The user's own library (Capabilities 03-D5, D6; Phase 2 C3): skills the hive learned from repeated work and
 * skills or agents the user imported. It lives in the app's data folder, never in the shipped library:
 *
 *   <root>/learned/skills/<name>/SKILL.md
 *   <root>/imported/skills/<name>/SKILL.md (+ any other files)
 *   <root>/imported/agents/<name>/AGENT.md
 *
 * Library rows point at these files with paths relative to <root>. Whether an item may be used is the
 * Brain's catalog status (draft until the user approves), not its presence here.
 */
export type UserOrigin = 'learned' | 'imported';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface StoredItem {
  item: LibraryItemInput & { origin: UserOrigin };
  scan: FolderScan;
}

export type ImportOutcome = { ok: true; stored: StoredItem } | { ok: false; message: string };

export class UserLibrary {
  constructor(readonly root: string) {}

  /** An item's folder: <root>/<origin>/<kind>s/<name>. */
  folder(origin: UserOrigin, kind: 'skill' | 'agent', name: string): string {
    return join(this.root, origin, `${kind}s`, name);
  }

  /** A file of an item, from its library path (relative to the root); null when it is outside the root or missing. */
  read(file: string): string | null {
    const path = join(this.root, file);
    if (relative(this.root, path).startsWith('..') || !existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  }

  /**
   * Import a skill or agent folder (03-D5). It is scanned where it is (links are never followed), then its
   * regular files are copied in, within the scan's limits, so even a blocked item can be shown with its
   * findings. `taken` says whether a name is already in the catalog.
   */
  importFolder(src: string, o: { taken: (name: string) => boolean; now?: () => number }): ImportOutcome {
    let st;
    try {
      st = lstatSync(src);
    } catch {
      return { ok: false, message: 'That folder could not be read.' };
    }
    if (!st.isDirectory()) return { ok: false, message: 'Choose a folder that holds a SKILL.md or an AGENT.md.' };
    const scan = scanFolder(src, { expectedName: basename(src), ...(o.now ? { now: o.now } : {}) });
    if (!scan.mainFile || !scan.header) return { ok: false, message: 'That folder has no SKILL.md or AGENT.md at its top, so it is not a skill or an agent.' };
    const name = NAME_RE.test(scan.header.name) ? scan.header.name : slug(basename(src));
    if (!name) return { ok: false, message: 'The item needs a name of lowercase letters, digits and hyphens.' };
    if (o.taken(name)) return { ok: false, message: `The library already has an item called "${name}". Rename the import and try again.` };
    const kind = scan.header.kind;
    const dest = this.folder('imported', kind, name);
    const staging = `${dest}.importing`;
    rmSync(staging, { recursive: true, force: true });
    try {
      copyRegularFiles(src, staging);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(join(dest, '..'), { recursive: true });
      renameSync(staging, dest);
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      return { ok: false, message: `The folder could not be copied: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, stored: { item: this.#input('imported', kind, name, scan, [{ repo: 'imported', path: basename(src), license: null }]), scan } };
  }

  /** Save a skill the hive drafted from repeated work (03-D6), and scan it like an import. */
  writeLearned(name: string, skillMd: string, o: { cards: readonly string[]; now?: () => number }): StoredItem {
    if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid skill name.`);
    const dir = this.folder('learned', 'skill', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd.endsWith('\n') ? skillMd : `${skillMd}\n`);
    const scan = scanFolder(dir, { expectedName: name, ...(o.now ? { now: o.now } : {}) });
    const sources = [{ repo: 'the-insectoids/learned', path: `cards: ${o.cards.join(', ')}`, license: 'MIT' }];
    return { item: this.#input('learned', 'skill', name, scan, sources), scan };
  }

  /** Delete an item's files (a draft the user turned down, or a dropped proposal). */
  remove(origin: UserOrigin, kind: 'skill' | 'agent', name: string): void {
    if (NAME_RE.test(name)) rmSync(this.folder(origin, kind, name), { recursive: true, force: true });
  }

  #input(origin: UserOrigin, kind: 'skill' | 'agent', name: string, scan: FolderScan, sources: LibraryItemInput['sources']): LibraryItemInput & { origin: UserOrigin } {
    return {
      name,
      kind,
      status: 'draft',
      castes: scan.header?.castes ?? [],
      description: scan.header?.description ?? '',
      safety: 'unscanned',
      file: `${origin}/${kind}s/${name}/${kind === 'skill' ? 'SKILL.md' : 'AGENT.md'}`,
      sources,
      origin,
    };
  }
}

/** A folder name as an item name: lowercase letters, digits and hyphens, or '' when nothing is left. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Copy regular files only (no links, no oversized files), up to the scan's limits. */
function copyRegularFiles(src: string, dest: string): void {
  let files = 0;
  let total = 0;
  const walk = (from: string, to: string, depth: number): void => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from).sort()) {
      const s = join(from, e);
      const st = lstatSync(s);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < 4) walk(s, join(to, e), depth + 1);
        continue;
      }
      if (!st.isFile() || st.size > SCAN_LIMITS.maxFileBytes) continue;
      if (files >= SCAN_LIMITS.maxFiles || total + st.size > SCAN_LIMITS.maxTotalBytes) return;
      copyFileSync(s, join(to, e));
      files++;
      total += st.size;
    }
  };
  walk(src, dest, 0);
}
