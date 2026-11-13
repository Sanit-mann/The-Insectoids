import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db';
import { STOP_WORDS } from './vectors';

/**
 * The library catalog (Capabilities 03-D8 "Catalog in the Brain"; Phase 2 C1): one row per agent, skill or
 * tool the hive could use, synced from the library folder, with usage numbers that survive syncs. The hive
 * searches it to switch a few skills on for one card attempt; activations log what each insect carried and
 * how that attempt ended. Search is keyword (FTS5) for now; meaning search over the catalog can come later
 * on the same vectors as records.
 */
export type LibraryItemStatus = 'active' | 'ready' | 'dormant' | 'draft';
export type LibraryItemKind = 'agent' | 'skill' | 'tool';

export interface LibraryItemInput {
  name: string;
  kind: LibraryItemKind;
  /** active = always on for its castes; ready = on disk, switched on per card; dormant = listed only; draft = proposed (C3). */
  status: LibraryItemStatus;
  castes: string[];
  description: string;
  safety: 'vetted' | 'unscanned';
  /** Path inside the library folder (e.g. "skills/accessibility/SKILL.md"); null when it isn't on disk. */
  file: string | null;
  sources: Array<{ repo: string; path: string; license: string | null }>;
}

export interface LibraryItem extends LibraryItemInput {
  uses: number;
  passed: number;
  failed: number;
  /** Estimated prompt tokens it has cost across all its activations. */
  tokens: number;
  lastUsedAt: number | null;
}

export interface LibraryQuery {
  /** All words must match (prefixes), in name or description. Empty = everything. */
  query?: string;
  kinds?: LibraryItemKind[];
  statuses?: LibraryItemStatus[];
  /** Items for this caste (or for "all"). */
  caste?: string;
  limit?: number;
  offset?: number;
}

export type ActivationOutcome = 'running' | 'passed' | 'failed';

interface ItemRow {
  name: string;
  kind: LibraryItemKind;
  status: LibraryItemStatus;
  castes: string;
  description: string;
  safety: 'vetted' | 'unscanned';
  file: string | null;
  sources: string;
  uses: number;
  passed: number;
  failed: number;
  tokens: number;
  last_used_at: number | null;
}

/**
 * Words almost every card uses ("write the file", "add a check"): they say nothing about which skill helps,
 * so activation search ignores them (the Library screen's search doesn't).
 */
const GENERIC_TASK_WORDS: ReadonlySet<string> = new Set(
  (
    'add added adds adding build builds change changes changed check checks create creates do done edit file files fix fixes ' +
    'get make makes need needs new note notes run runs set short small task tasks card cards update updates use uses using ' +
    'work works write writes writing written code project change one two way ways thing things sure keep'
  ).split(' '),
);

const STATUS_ORDER = "CASE i.status WHEN 'active' THEN 0 WHEN 'ready' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END";
const ACTIVATABLE = "i.kind = 'skill' AND i.status IN ('active', 'ready') AND i.file IS NOT NULL";

/** Lower-case words of a query, for FTS and for counting matches. */
export function queryWords(text: string, opts: { meaningful?: boolean } = {}): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !opts.meaningful || (w.length >= 3 && !STOP_WORDS.has(w)));
  return [...new Set(words)].slice(0, 24);
}

const ftsTerms = (words: string[], join: ' ' | ' OR '): string => words.map((w) => `"${w.replace(/"/g, '')}"*`).join(join);

const toItem = (r: ItemRow): LibraryItem => ({
  name: r.name,
  kind: r.kind,
  status: r.status,
  castes: JSON.parse(r.castes) as string[],
  description: r.description,
  safety: r.safety,
  file: r.file,
  sources: JSON.parse(r.sources) as LibraryItem['sources'],
  uses: r.uses,
  passed: r.passed,
  failed: r.failed,
  tokens: r.tokens,
  lastUsedAt: r.last_used_at,
});

export class LibraryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  /**
   * Bring the catalog in line with the library folder: insert or update every item (usage is kept), and drop
   * rows that are no longer in the library (drafts stay: they come from the hive, not the folder).
   */
  sync(items: readonly LibraryItemInput[]): { added: number; updated: number; removed: number } {
    return transaction(this.db, () => {
      const at = this.now();
      const existing = new Set((this.db.prepare('SELECT name FROM library_items').all() as Array<{ name: string }>).map((r) => r.name));
      const upsert = this.db.prepare(`
        INSERT INTO library_items (name, kind, status, castes, description, safety, file, sources, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, status = excluded.status, castes = excluded.castes,
          description = excluded.description, safety = excluded.safety, file = excluded.file, sources = excluded.sources,
          synced_at = excluded.synced_at`);
      let added = 0;
      const seen = new Set<string>();
      for (const it of items) {
        if (seen.has(it.name)) continue;
        seen.add(it.name);
        upsert.run(it.name, it.kind, it.status, JSON.stringify(it.castes), it.description, it.safety, it.file, JSON.stringify(it.sources), at);
        if (!existing.has(it.name)) added++;
      }
      const stale = [...existing].filter((n) => !seen.has(n));
      const drop = this.db.prepare("DELETE FROM library_items WHERE name = ? AND status != 'draft'");
      let removed = 0;
      for (const n of stale) removed += Number(drop.run(n).changes);
      return { added, updated: seen.size - added, removed };
    });
  }

  get(name: string): LibraryItem | undefined {
    const row = this.db.prepare('SELECT * FROM library_items WHERE name = ?').get(name) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  /** Whether an insect may carry it: a skill that is active or ready and on disk. Dormant items never are. */
  isActivatable(name: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM library_items i WHERE i.name = ? AND ${ACTIVATABLE}`).get(name));
  }

  /**
   * Catalog search for the Library screen: all words must match (as prefixes, in name or description).
   * Order: the exact name, then names holding the words, then text-only matches; within each,
   * active, ready, draft, dormant, then text relevance. Without words: by status, then name.
   */
  search(q: LibraryQuery = {}): { items: LibraryItem[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const words = queryWords(q.query ?? '');
    let from = 'library_items i';
    let order = `${STATUS_ORDER}, i.name`;
    if (words.length) {
      from = 'library_fts f JOIN library_items i ON i.rowid = f.rowid';
      where.push('library_fts MATCH ?');
      params.push(ftsTerms(words, ' '));
      order = `bm25(library_fts, 10.0, 1.0), i.name`;
    }
    if (q.kinds?.length) {
      where.push(`i.kind IN (${q.kinds.map(() => '?').join(', ')})`);
      params.push(...q.kinds);
    }
    if (q.statuses?.length) {
      where.push(`i.status IN (${q.statuses.map(() => '?').join(', ')})`);
      params.push(...q.statuses);
    }
    if (q.caste) {
      where.push("EXISTS (SELECT 1 FROM json_each(i.castes) j WHERE j.value IN (?, 'all'))");
      params.push(q.caste);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    if (!words.length) {
      const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${clause}`).get(...params) as { n: number }).n;
      const rows = this.db.prepare(`SELECT i.* FROM ${from} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as ItemRow[];
      return { items: rows.map(toItem), total };
    }
    // With words: every match is ranked in code (the catalog is a few thousand rows at most), so a name match
    // can lead even when the text rank alone would put it lower.
    const rows = this.db.prepare(`SELECT i.* FROM ${from} ${clause} ORDER BY ${order}`).all(...params) as unknown as ItemRow[];
    const phrase = words.join('-');
    // 0 = the exact name; 1 = the words are in the name (start of it, or each a word of it); 2 = text only.
    // Within a tier status decides, so an active "code-review" leads a dormant "review-team-deliverables".
    const nameTier = (name: string): number => {
      const n = name.toLowerCase();
      if (n === phrase) return 0;
      const parts = queryWords(n);
      return n.startsWith(phrase) || words.every((w) => parts.some((p) => p.startsWith(w))) ? 1 : 2;
    };
    const statusRank: Record<LibraryItemStatus, number> = { active: 0, ready: 1, draft: 2, dormant: 3 };
    const ranked = rows
      .map((r, textRank) => ({ r, tier: nameTier(r.name), status: statusRank[r.status] ?? 4, textRank }))
      .sort((a, b) => a.tier - b.tier || a.status - b.status || a.textRank - b.textRank);
    return { items: ranked.slice(offset, offset + limit).map((x) => toItem(x.r)), total: ranked.length };
  }

  /** The whole catalog by status (for filter chips). */
  counts(): Record<LibraryItemStatus, number> {
    const out: Record<LibraryItemStatus, number> = { active: 0, ready: 0, dormant: 0, draft: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM library_items GROUP BY status').all() as Array<{ status: LibraryItemStatus; n: number }>) {
      if (r.status in out) out[r.status] = r.n;
    }
    return out;
  }

  /**
   * The skills that best fit a piece of work (03-D8 "Find"), among those an insect may carry. Any meaningful
   * word may match; a skill counts only when at least `minTerms` distinct words appear in its name or
   * description (a word in its name counts twice), so a single common word doesn't switch a skill on.
   * Skills for the given caste win ties.
   */
  activatable(text: string, opts: { caste?: string; limit?: number; exclude?: readonly string[]; minTerms?: number } = {}): LibraryItem[] {
    const words = queryWords(text, { meaningful: true }).filter((w) => !GENERIC_TASK_WORDS.has(w));
    if (!words.length) return [];
    const rows = this.db
      .prepare(`SELECT i.* FROM library_fts f JOIN library_items i ON i.rowid = f.rowid WHERE library_fts MATCH ? AND ${ACTIVATABLE} ORDER BY bm25(library_fts, 10.0, 1.0) LIMIT 40`)
      .all(ftsTerms(words, ' OR ')) as unknown as ItemRow[];
    const exclude = new Set(opts.exclude ?? []);
    const minTerms = opts.minTerms ?? 2;
    const scored = rows
      .filter((r) => !exclude.has(r.name))
      .map((r, rank) => {
        const nameWords = queryWords(r.name);
        const descWords = queryWords(r.description);
        let terms = 0;
        for (const w of words) {
          if (nameWords.some((n) => n.startsWith(w))) terms += 2;
          else if (descWords.some((d) => d.startsWith(w))) terms += 1;
        }
        const castes = JSON.parse(r.castes) as string[];
        const forCaste = opts.caste ? castes.includes(opts.caste) || castes.includes('all') : false;
        return { r, rank, terms, forCaste };
      })
      .filter((s) => s.terms >= minTerms)
      .sort((a, b) => b.terms - a.terms || Number(b.forCaste) - Number(a.forCaste) || a.rank - b.rank);
    return scored.slice(0, opts.limit ?? 3).map((s) => toItem(s.r));
  }

  /**
   * Switch skills on for one card attempt (03-D8 "Activate"). Idempotent per attempt: a resumed run of the
   * same attempt doesn't count a second use. `tokens` is each skill's estimated prompt cost.
   */
  activate(cardId: string, attempt: number, items: ReadonlyArray<{ name: string; tokens: number }>): void {
    if (!items.length) return;
    transaction(this.db, () => {
      const at = this.now();
      const insert = this.db.prepare('INSERT OR IGNORE INTO library_activations (card_id, attempt, item, at) VALUES (?, ?, ?, ?)');
      const used = this.db.prepare('UPDATE library_items SET uses = uses + 1, tokens = tokens + ?, last_used_at = ? WHERE name = ?');
      for (const it of items) {
        if (Number(insert.run(cardId, attempt, it.name, at).changes) === 1) used.run(Math.max(0, Math.round(it.tokens)), at, it.name);
      }
    });
  }

  /** The skills switched on for one attempt, in the order they were chosen. */
  activated(cardId: string, attempt: number): string[] {
    return (this.db.prepare('SELECT item FROM library_activations WHERE card_id = ? AND attempt = ? ORDER BY rowid').all(cardId, attempt) as Array<{ item: string }>).map((r) => r.item);
  }

  /** Each card's skills from its latest attempt that had any (for the taskboard). */
  latestByCard(cardIds: readonly string[]): Map<string, string[]> {
    const out = new Map<string, { attempt: number; items: string[] }>();
    if (!cardIds.length) return new Map();
    for (let i = 0; i < cardIds.length; i += 400) {
      const chunk = cardIds.slice(i, i + 400);
      const rows = this.db
        .prepare(`SELECT card_id, attempt, item FROM library_activations WHERE card_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY card_id, attempt, rowid`)
        .all(...chunk) as Array<{ card_id: string; attempt: number; item: string }>;
      for (const r of rows) {
        const cur = out.get(r.card_id);
        if (!cur || r.attempt > cur.attempt) out.set(r.card_id, { attempt: r.attempt, items: [r.item] });
        else if (r.attempt === cur.attempt) cur.items.push(r.item);
      }
    }
    return new Map([...out].map(([k, v]) => [k, v.items]));
  }

  /**
   * How a card attempt ended (03-D8 "Deactivate": the skills are already gone with the insect; this only
   * records the outcome). Updates each carried skill's passed/failed once.
   */
  settle(cardId: string, attempt: number, outcome: 'passed' | 'failed'): void {
    transaction(this.db, () => {
      const items = (this.db.prepare("SELECT item FROM library_activations WHERE card_id = ? AND attempt = ? AND outcome = 'running'").all(cardId, attempt) as Array<{ item: string }>).map((r) => r.item);
      if (!items.length) return;
      this.db.prepare("UPDATE library_activations SET outcome = ? WHERE card_id = ? AND attempt = ? AND outcome = 'running'").run(outcome, cardId, attempt);
      const bump = this.db.prepare(`UPDATE library_items SET ${outcome === 'passed' ? 'passed = passed + 1' : 'failed = failed + 1'} WHERE name = ?`);
      for (const n of items) bump.run(n);
    });
  }

  /** The latest cards an item was carried on, newest first, one row per card (its latest attempt). */
  recentCards(name: string, limit = 10): Array<{ cardId: string; title: string; outcome: ActivationOutcome; at: number }> {
    const rows = this.db
      .prepare('SELECT a.card_id, a.outcome, a.at, t.title FROM library_activations a LEFT JOIN tasks t ON t.id = a.card_id WHERE a.item = ? ORDER BY a.at DESC, a.rowid DESC LIMIT ?')
      .all(name, limit * 4) as Array<{ card_id: string; outcome: ActivationOutcome; at: number; title: string | null }>;
    const out: Array<{ cardId: string; title: string; outcome: ActivationOutcome; at: number }> = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.card_id)) continue;
      seen.add(r.card_id);
      out.push({ cardId: r.card_id, title: r.title ?? r.card_id, outcome: r.outcome, at: r.at });
      if (out.length >= limit) break;
    }
    return out;
  }
}
