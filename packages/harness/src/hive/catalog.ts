import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Caste, CasteSchema } from '@insectoids/shared';
import type { LibraryItemInput } from '@insectoids/brain';
import { ROLE_SKILLS } from './prompts';

/**
 * The library catalog and skill activation rules (Capabilities 03-D3, D7, D8; Phase 2 C1).
 *
 * Status, from what the hive actually does with an item:
 * - active: always on. The 8 caste agents, the agents the hive runs every time (Queen, Inspector, Librarian),
 *   and every role's default skills (ROLE_SKILLS): the warm set.
 * - ready: rewritten and safety-reviewed, on disk, switched on for a card only when that card needs it.
 * - dormant: listed in the catalog only (not rewritten or safety-scanned yet). Never switched on.
 * - draft: proposed by the hive and waiting for the user (skill proposals, C3); never comes from the folder.
 */

/** What each caste may reach on the network: none, documentation sites, or the open web (read-only). */
export const CASTE_NETWORK: Record<Caste, 'none' | 'docs' | 'web'> = {
  coder: 'docs',
  tester: 'docs',
  reviewer: 'docs',
  documenter: 'docs',
  designer: 'docs',
  researcher: 'web',
  analyst: 'web',
  writer: 'web',
};

/** All castes the hive gives cards to (all 8 since C1, 03-D3). */
export const ALL_CASTES: readonly Caste[] = CasteSchema.options;

/** The most skills an insect carries at once (03-D8 budget rule), its caste's defaults included. */
export const MAX_ACTIVE_SKILLS = 5;
/** The most skills found by searching the card's own text. */
export const MAX_FOUND_SKILLS = 2;

const ALWAYS_ON_AGENTS = new Set<string>([...ALL_CASTES, 'queen', 'inspector', 'librarian']);
const DEFAULT_SKILLS = new Set(Object.values(ROLE_SKILLS).flat());

interface CatalogFileItem {
  name: string;
  kind: 'agent' | 'skill' | 'tool';
  castes?: string[];
  description?: string;
  rewritten?: boolean;
  file?: string;
  sources?: Array<{ repo?: string; path?: string; license?: string }>;
}

/**
 * The catalog the Brain keeps, built from the library folder: `catalog/catalog.json` for every entry, the
 * files on disk for the rewritten ones. An entry marked rewritten whose file is missing is treated as dormant.
 */
export function loadCatalog(libraryDir: string): LibraryItemInput[] {
  const raw = JSON.parse(readFileSync(join(libraryDir, 'catalog', 'catalog.json'), 'utf8')) as { items?: CatalogFileItem[] };
  const licenses = readNoticeLicenses(libraryDir);
  const out: LibraryItemInput[] = [];
  for (const it of raw.items ?? []) {
    if (!it.name || !['agent', 'skill', 'tool'].includes(it.kind)) continue;
    const onDisk = Boolean(it.rewritten && it.file && existsSync(join(libraryDir, it.file)));
    let status: LibraryItemInput['status'] = 'dormant';
    if (onDisk) status = (it.kind === 'agent' && ALWAYS_ON_AGENTS.has(it.name)) || (it.kind === 'skill' && DEFAULT_SKILLS.has(it.name)) ? 'active' : 'ready';
    out.push({
      name: it.name,
      kind: it.kind,
      status,
      castes: it.castes ?? [],
      // A rewritten item's own frontmatter is the source of truth; the catalog copy is the fallback.
      description: (onDisk && fileDescription(join(libraryDir, it.file!))) || cleanDescription(it.description ?? ''),
      safety: onDisk ? 'vetted' : 'unscanned',
      file: onDisk ? it.file! : null,
      sources: (it.sources ?? [])
        .filter((s) => s.repo && s.path)
        .map((s) => ({ repo: s.repo!, path: s.path!, license: s.license ?? licenseFor(licenses, s.repo!) })),
    });
  }
  return out;
}

/** The description from a library file's frontmatter, or '' when it has none or can't be read. */
function fileDescription(path: string): string {
  try {
    return frontmatterDescription(readFileSync(path, 'utf8'));
  } catch {
    return '';
  }
}

/** This project's own design notes, which some library items were written from: the repo's own license. */
const OWN_REPO = /^the-insectoids\//i;

/**
 * Each source repo's license, from the table in THIRD-PARTY-NOTICES.md ("| owner/repo | copyright | License |
 * ..."), as its SPDX id (e.g. "MIT", "Apache-2.0"). The project's own notes are MIT, like the project.
 */
export function readNoticeLicenses(libraryDir: string): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(join(libraryDir, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('|').map((c) => c.trim());
    // ["", repo, copyright, license, file, ""]
    if (cells.length < 5 || !/^[\w.-]+\/[\w.-]+$/.test(cells[1] ?? '')) continue;
    const spdx = /^[A-Za-z0-9.+-]+/.exec(cells[3] ?? '')?.[0];
    if (spdx) out.set(cells[1]!, spdx);
  }
  return out;
}

/** A source repo's license: from the notices, or MIT for this project's own notes; null when not recorded. */
export function licenseFor(licenses: ReadonlyMap<string, string>, repo: string): string | null {
  return licenses.get(repo) ?? (OWN_REPO.test(repo) ? 'MIT' : null);
}

/**
 * A description as plain text. Catalog text copied from YAML can keep its quoting: a wrapping pair of quotes,
 * or (from an older catalog build) a lone closing quote. Both go, and YAML escapes inside are undone.
 */
export function cleanDescription(raw: string): string {
  let t = raw.trim();
  const open = t[0];
  const close = t.at(-1);
  let quote: string | null = null;
  if (t.length >= 2 && (open === '"' || open === "'") && close === open) {
    quote = open;
    t = t.slice(1, -1);
  } else if ((close === '"' || close === "'") && open !== close && (t.split(close).length - 1) % 2 === 1) {
    // A lone closing quote (its opening one was already stripped).
    quote = close;
    t = t.slice(0, -1);
  }
  if (quote === '"') t = t.replace(/\\(["\\])/g, '$1');
  if (quote === "'") t = t.replace(/''/g, "'");
  return t.trim();
}

/**
 * The skills one insect carries on one card (03-D8 "Activate"): its caste's defaults first, then the Queen's
 * picks, then the best matches for the card's own text; deduplicated and capped at MAX_ACTIVE_SKILLS.
 */
export function chooseSkills(o: { defaults: readonly string[]; picked?: readonly string[]; found?: readonly string[]; max?: number }): string[] {
  const max = o.max ?? MAX_ACTIVE_SKILLS;
  const out: string[] = [];
  for (const n of [...o.defaults, ...(o.picked ?? []), ...(o.found ?? [])]) {
    if (out.length >= max) break;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The `description` line from a Markdown file's YAML frontmatter, or ''. */
export function frontmatterDescription(md: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? '';
  return cleanDescription(/^description:\s*(.*)$/m.exec(fm)?.[1] ?? '');
}

/** The first sentence of a description, for one-line summaries. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return (m ? m[1]! : t).trim();
}
