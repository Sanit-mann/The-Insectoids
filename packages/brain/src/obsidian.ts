import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXPORT_FOLDER_NAME, EXPORT_MARKER } from '@insectoids/shared';
import type { Brain, BrainRecord } from './brain';
import { detectSecrets, redactSecrets } from './secrets';

/**
 * Obsidian export (Memory 01-D11, E13; Phase 3 C2): the Brain as a folder of Markdown notes, a read-only copy.
 * The layout, frontmatter, links and safety rules are described in @insectoids/shared export-api.ts.
 */

export interface VaultFile {
  /** Relative, forward slashes, e.g. "Global/Facts/Hosting provider.md". */
  path: string;
  content: string;
}

export interface VaultBuild {
  /** Every note, sorted by path. README.md is added by writeObsidianVault. */
  files: VaultFile[];
  notes: number;
  /** Links written as [[wikilinks]] (links to notes left out are not counted). */
  links: number;
  /** Folder names of the shelves that have at least one note, sorted. */
  shelves: string[];
  /** Notes that had a secret removed. */
  redacted: number;
  /** Notes left out because something still looked like a secret after removal. */
  skipped: number;
}

const GLOBAL_SHELF = 'global';
const NAME_MAX = 120;
const SHELF_MAX = 60;

const KIND_FOLDERS: Record<string, string> = {
  fact: 'Facts',
  decision: 'Decisions',
  task: 'Tasks',
  file: 'Files',
  update: 'Updates',
  agent_memory: 'Agent memories',
  outcome: 'Outcomes',
  lesson: 'Lessons',
};

const REL_WORDS: Record<string, string> = {
  supersedes: 'Replaces',
  superseded_by: 'Replaced by',
  merged_into: 'Merged into',
  proposes_to_supersede: 'Proposed to replace',
};

type Status = 'current' | 'superseded' | 'archived';

interface Note {
  rec: BrainRecord;
  title: string;
  body: string;
  source: string | null;
  owner: string;
  redacted: boolean;
  status: Status;
  shelfFolder: string;
  kindFolder: string;
  /** File name without .md, unique across the vault (case-insensitive) so [[name]] always resolves. */
  name: string;
  path: string;
}

interface OutLink {
  rel: string;
  to: string;
}

export function buildObsidianVault(
  brain: Brain,
  o: { includeArchived: boolean; now: number; shelfName?: (shelf: string) => string },
): VaultBuild {
  const records = brain
    .graph({ includeArchived: o.includeArchived, limit: Number.MAX_SAFE_INTEGER }, o.now)
    .nodes.map((n) => brain.get(n.id))
    .filter((r): r is BrainRecord => r !== undefined);

  const shelfFolders = folderNames(
    [...new Set(records.map((r) => r.shelf))],
    (shelf) => o.shelfName?.(shelf) || (shelf === GLOBAL_SHELF ? 'Global' : shelf),
  );

  const notes: Note[] = records.map((rec) => {
    const title = redactSecrets(oneLine(rec.title));
    const body = redactSecrets(rec.body.replace(/\r\n?/g, '\n'));
    const source = rec.source === null ? null : redactSecrets(rec.source);
    return {
      rec,
      title: title.text,
      body: body.text,
      source: source?.text ?? null,
      owner: rec.owner,
      redacted: title.kinds.length + body.kinds.length + (source?.kinds.length ?? 0) > 0,
      status: rec.archived ? 'archived' : rec.validTo !== null || rec.supersededBy !== null ? 'superseded' : 'current',
      shelfFolder: shelfFolders.get(rec.shelf) ?? 'Shelf',
      kindFolder: KIND_FOLDERS[rec.kind] ?? capitalise(rec.kind.replaceAll('_', ' ')),
      name: '',
      path: '',
    };
  });
  notes.sort(
    (a, b) =>
      cmp(a.shelfFolder, b.shelfFolder) ||
      cmp(a.kindFolder, b.kindFolder) ||
      cmp(a.title.toLowerCase(), b.title.toLowerCase()) ||
      a.rec.createdAt - b.rec.createdAt ||
      cmp(a.rec.id, b.rec.id),
  );
  const taken = new Set<string>();
  for (const n of notes) {
    n.name = unique(safeName(n.title, NAME_MAX), NAME_MAX, taken);
    n.path = `${n.shelfFolder}/${n.kindFolder}/${n.name}.md`;
  }
  const byId = new Map(notes.map((n) => [n.rec.id, n]));

  // Outgoing links from the links table, plus "Replaced by" for superseded records (the stored link points
  // from the new record to the old one).
  const outLinks = new Map<string, OutLink[]>();
  for (const n of notes) {
    const out: OutLink[] = brain
      .links(n.rec.id)
      .filter((l) => l.direction === 'out')
      .map((l) => ({ rel: l.rel, to: l.id }));
    const by = n.rec.supersededBy;
    if (by && !out.some((l) => l.to === by)) out.push({ rel: 'superseded_by', to: by });
    outLinks.set(n.rec.id, out);
  }
  const outsideTitles = new Map<string, string | null>();
  const outsideTitle = (id: string): string | null => {
    if (!outsideTitles.has(id)) {
      const rec = brain.get(id);
      outsideTitles.set(id, rec ? redactSecrets(oneLine(rec.title)).text : null);
    }
    return outsideTitles.get(id) ?? null;
  };

  // Render; a note whose finished file still looks like it holds a secret is left out, and links to it are
  // dropped, so render again until nothing more is left out.
  const exported = new Set(notes.map((n) => n.rec.id));
  let rendered = new Map<string, { content: string; links: number }>();
  for (;;) {
    rendered = new Map();
    let leftOut = false;
    for (const n of notes) {
      if (!exported.has(n.rec.id)) continue;
      const r = renderNote(n, outLinks.get(n.rec.id) ?? [], byId, exported, outsideTitle);
      if (detectSecrets(`${n.path}\n${r.content}`).length) {
        exported.delete(n.rec.id);
        leftOut = true;
        continue;
      }
      rendered.set(n.rec.id, r);
    }
    if (!leftOut) break;
  }

  const kept = notes.filter((n) => exported.has(n.rec.id));
  const files = kept
    .map((n) => ({ path: n.path, content: rendered.get(n.rec.id)?.content ?? '' }))
    .sort((a, b) => cmp(a.path, b.path));
  return {
    files,
    notes: files.length,
    links: kept.reduce((sum, n) => sum + (rendered.get(n.rec.id)?.links ?? 0), 0),
    shelves: [...new Set(kept.map((n) => n.shelfFolder))].sort(cmp),
    redacted: kept.filter((n) => n.redacted).length,
    skipped: notes.length - kept.length,
  };
}

function renderNote(
  n: Note,
  out: OutLink[],
  byId: Map<string, Note>,
  exported: Set<string>,
  outsideTitle: (id: string) => string | null,
): { content: string; links: number } {
  const r = n.rec;
  const fm: string[] = ['---'];
  const put = (key: string, value: string): void => {
    fm.push(`${key}: ${value}`);
  };
  put('id', yamlString(r.id));
  put('kind', yamlString(r.kind));
  put('shelf', yamlString(n.shelfFolder));
  put('status', n.status);
  put('trust', yamlString(r.trust));
  put('owner', yamlString(n.owner));
  if (n.source !== null) put('source', yamlString(n.source));
  put('created', isoDate(r.createdAt));
  put('updated', isoDate(r.updatedAt));
  put('version', String(r.version));
  if (r.confidence !== null && Number.isFinite(r.confidence)) put('confidence', String(r.confidence));
  put('valid_from', isoDate(r.validFrom));
  if (r.validTo !== null) put('valid_to', isoDate(r.validTo));
  put('importance', String(Math.round(r.importance * 1000) / 1000));
  if (n.redacted) put('redacted', 'true');
  fm.push('tags:', `  - ${yamlString(`insectoids/${r.kind}`)}`, `  - ${yamlString(`insectoids/trust/${r.trust}`)}`);
  if (n.status !== 'current') fm.push('  - insectoids/archived');
  if (n.name !== n.title) fm.push('aliases:', `  - ${yamlString(n.title)}`);
  fm.push('---');

  const lines = new Set<string>();
  const sorted: Array<{ key: string; line: string }> = [];
  let links = 0;
  for (const l of out) {
    const words = relWords(l.rel);
    const target = byId.get(l.to);
    let line: string;
    if (target && exported.has(l.to)) {
      const shown = linkText(target.title);
      line = `- ${words}: ${shown === target.name ? `[[${target.name}]]` : `[[${target.name}|${shown}]]`}`;
    } else if (target) {
      continue; // left out because it still looked like a secret: no trace of it
    } else {
      const title = outsideTitle(l.to);
      if (title === null) continue;
      line = `- ${words}: ${linkText(title)} (not exported)`;
    }
    if (lines.has(line)) continue;
    lines.add(line);
    if (line.includes('[[')) links++;
    sorted.push({ key: `${words}\u0000${line}`, line });
  }
  sorted.sort((a, b) => cmp(a.key, b.key));

  const parts = [fm.join('\n'), ''];
  const body = n.body.trimEnd();
  if (body) parts.push(body, '');
  if (sorted.length) parts.push('## Links', '', ...sorted.map((s) => s.line), '');
  return { content: parts.join('\n'), links };
}

// ---- writing ---------------------------------------------------------------------------------------

/**
 * Writes into `<dir>/EXPORT_FOLDER_NAME`. Refuses (throws an Error in plain words) if that folder exists without
 * the marker; otherwise removes only files the previous marker lists, writes the new files and README.md, then
 * the marker. Returns the vault folder.
 */
export function writeObsidianVault(dir: string, build: VaultBuild, o: { now: number }): { path: string } {
  const root = resolve(dir, EXPORT_FOLDER_NAME);
  const markerPath = join(root, EXPORT_MARKER);
  let previous: string[] = [];
  if (existsSync(root)) {
    if (!lstatSync(root).isDirectory()) {
      throw new Error(`"${root}" already exists and is not a folder, so nothing was exported. Pick another folder.`);
    }
    if (!existsSync(markerPath)) {
      throw new Error(
        `The folder "${root}" already exists and was not made by The Insectoids, so nothing was changed. Move or rename it, or pick another folder.`,
      );
    }
    previous = readMarker(markerPath, root);
  }

  const files: VaultFile[] = [...build.files, { path: 'README.md', content: readme(build, o.now) }];
  for (const f of files) {
    if (!insidePath(root, f.path)) throw new Error(`"${f.path}" is not a safe place inside the export folder; nothing was changed.`);
  }
  const ours = new Set(previous.map((p) => p.toLowerCase()));
  const clashes = files.filter((f) => !ours.has(f.path.toLowerCase()) && existsSync(join(root, f.path)));
  if (clashes.length) {
    const first = clashes[0]?.path ?? '';
    throw new Error(
      `${clashes.length === 1 ? 'A file' : `${clashes.length} files`} in "${root}" that the export didn't make would be replaced (for example "${first}"), so nothing was changed. Move or rename ${clashes.length === 1 ? 'it' : 'them'} and export again.`,
    );
  }

  // Remove what the last export wrote, then any folders that left empty (a folder with the user's own files stays).
  const emptied = new Set<string>();
  for (const p of previous) {
    const full = join(root, p);
    if (!existsSync(full)) continue;
    const st = lstatSync(full);
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    unlinkSync(full);
    emptied.add(dirname(full));
  }
  for (const d of [...emptied].sort((a, b) => b.length - a.length)) {
    for (let cur = d; cur !== root && cur.startsWith(root + sep); cur = dirname(cur)) {
      if (!existsSync(cur) || readdirSync(cur).length) break;
      rmdirSync(cur);
    }
  }

  const marker = `${JSON.stringify({ version: 1, exportedAt: o.now, files: files.map((f) => f.path) }, null, 2)}\n`;
  mkdirSync(root, { recursive: true });
  // Written first as well, so an export cut short still knows which files are its own next time.
  writeFileSync(markerPath, marker, 'utf8');
  for (const f of files) {
    const full = join(root, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content, 'utf8');
  }
  writeFileSync(markerPath, marker, 'utf8');
  return { path: root };
}

function readMarker(markerPath: string, root: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    parsed = undefined;
  }
  const files = (parsed as { files?: unknown } | undefined)?.files;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(files)) {
    throw new Error(
      `The export record "${EXPORT_MARKER}" in "${root}" is damaged, so nothing was changed. Delete that folder or pick another one.`,
    );
  }
  // Only plain relative paths inside the folder; anything else is ignored, never removed.
  return files.filter((p): p is string => typeof p === 'string' && insidePath(root, p) && p !== EXPORT_MARKER);
}

function insidePath(root: string, p: string): boolean {
  if (!p || isAbsolute(p) || p.includes('\u0000') || p.split(/[\\/]/).some((s) => s === '..' || s === '')) return false;
  const rel = relative(root, resolve(root, p));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function readme(build: VaultBuild, now: number): string {
  const perShelf = new Map<string, number>();
  for (const f of build.files) {
    const shelf = f.path.split('/')[0] ?? '';
    perShelf.set(shelf, (perShelf.get(shelf) ?? 0) + 1);
  }
  const lines = [
    '# Insectoids Brain',
    '',
    'This is a read-only copy of the Brain, made by The Insectoids. You can open this folder as an Obsidian vault.',
    'Edits you make here do not flow back into The Insectoids, and the next export replaces the notes it wrote.',
    'Your own files in this folder are left alone.',
    '',
    `Made on ${localTime(now)}.`,
    '',
    `- Notes: ${build.notes}`,
    `- Links between notes: ${build.links}`,
    `- Shelves: ${build.shelves.length}`,
  ];
  if (build.redacted) lines.push(`- Notes that had a secret removed: ${build.redacted}`);
  if (build.skipped) lines.push(`- Notes left out because they still looked like they held a secret: ${build.skipped}`);
  lines.push('', '## Shelves', '');
  if (build.shelves.length) {
    for (const s of build.shelves) {
      const count = perShelf.get(s) ?? 0;
      lines.push(`- ${s}: ${count} ${count === 1 ? 'note' : 'notes'}`);
    }
  } else {
    lines.push('- None yet.');
  }
  lines.push('');
  return lines.join('\n');
}

// ---- names and text ----------------------------------------------------------------------------------

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\.|$)/i;

/** Obsidian- and Windows-safe file or folder name (no extension). */
export function safeName(text: string, max = NAME_MAX): string {
  let n = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[*"\\/<>:|?#^[\]]/g, ' ')
    .replace(/\s+/g, ' ');
  n = trimName(n);
  const chars = Array.from(n);
  if (chars.length > max) n = trimName(chars.slice(0, max).join(''));
  if (!n) n = 'Untitled';
  const reserved = RESERVED.exec(n);
  if (reserved?.[1]) n = `${reserved[1]}_${n.slice(reserved[1].length)}`;
  return n;
}

/** No leading dots (hidden files), no trailing dots or spaces (Windows drops them). */
function trimName(n: string): string {
  return n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
}

function unique(base: string, max: number, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    const chars = Array.from(base);
    const head = chars.length + suffix.length > max ? trimName(chars.slice(0, max - suffix.length).join('')) : base;
    name = `${head}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function folderNames(shelves: string[], label: (shelf: string) => string): Map<string, string> {
  const taken = new Set(['readme.md', EXPORT_MARKER.toLowerCase()]);
  const named = shelves
    .map((shelf) => ({ shelf, name: safeName(redactSecrets(oneLine(label(shelf))).text, SHELF_MAX) }))
    .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.shelf, b.shelf));
  return new Map(named.map(({ shelf, name }) => [shelf, unique(name, SHELF_MAX, taken)]));
}

function relWords(rel: string): string {
  return REL_WORDS[rel] ?? capitalise(oneLine(rel.replaceAll('_', ' ')).replace(/[[\]|:]/g, ' ').trim() || 'Related');
}

/** Alias text inside [[name|text]]: no brackets or pipes. */
function linkText(title: string): string {
  return title.replace(/\[/g, '(').replace(/\]/g, ')').replace(/\|/g, '/').trim() || 'Untitled';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (local time)`;
}

const PLAIN = /^[A-Za-z_][A-Za-z0-9 _./-]*$/;
const YAML_WORDS = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;

/** A YAML scalar: plain when that is unambiguous, otherwise double-quoted (JSON escapes plus YAML's non-printables). */
export function yamlString(s: string): string {
  if (PLAIN.test(s) && !s.endsWith(' ') && !YAML_WORDS.test(s)) return s;
  return JSON.stringify(s).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
