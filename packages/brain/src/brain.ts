import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { RecordKind, Trust } from '@insectoids/shared';
import { ApprovalStore } from './approvals';
import { transaction } from './db';
import { GoalStore } from './goals';
import { ConflictError, SecretError, TrustError } from './errors';
import { migrate } from './schema';
import { detectSecrets } from './secrets';
import { Taskboard } from './taskboard';

export type Actor = { type: 'user' } | { type: 'agent'; id: string };

export interface WriteInput {
  kind: RecordKind;
  shelf: string;
  title: string;
  body: string;
  summary?: string;
  source?: string;
  confidence?: number;
  trust?: Trust;
}

export interface UpdateInput {
  title?: string;
  body?: string;
  summary?: string;
  trust?: Trust;
}

export interface BrainRecord {
  id: string;
  kind: RecordKind;
  shelf: string;
  owner: string;
  title: string;
  body: string;
  summary: string | null;
  trust: Trust;
  source: string | null;
  confidence: number | null;
  version: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RecordVersion {
  version: number;
  change: 'create' | 'update' | 'archive';
  title: string;
  body: string;
  trust: Trust;
  changedBy: string;
  changedAt: number;
}

export interface SearchHit {
  id: string;
  kind: RecordKind;
  shelf: string;
  title: string;
  summary: string | null;
  score: number;
}

export interface SearchOptions {
  /** Project shelf. The global shelf is always included; other projects never are (Memory 01-D2). */
  shelf?: string;
  kinds?: RecordKind[];
  limit?: number;
}

export interface LinkView {
  id: string;
  rel: string;
  direction: 'in' | 'out';
}

export interface BrainOptions {
  now?: () => number;
  newId?: () => string;
}

/** Default answer size (Memory 01-D7). */
export const DEFAULT_TOKEN_BUDGET = 800;
const GLOBAL_SHELF = 'global';
const NEEDS_CONFIRMATION: ReadonlySet<RecordKind> = new Set(['fact', 'decision']);

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const actorName = (a: Actor): string => (a.type === 'user' ? 'user' : a.id);
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Turn free text into a safe FTS5 query: words become quoted terms; OR/AND/NOT stay operators. */
function toFtsQuery(query: string): string {
  const parts = query
    .split(/\s+/)
    .map((t) => (/^(OR|AND|NOT)$/.test(t) ? t : t.replace(/[^\p{L}\p{N}_]/gu, '')))
    .filter(Boolean)
    .map((t) => (/^(OR|AND|NOT)$/.test(t) ? t : `"${t}"`));
  while (parts.length && /^(OR|AND|NOT)$/.test(parts[0]!)) parts.shift();
  while (parts.length && /^(OR|AND|NOT)$/.test(parts.at(-1)!)) parts.pop();
  return parts.join(' ');
}

interface RecordRow {
  id: string;
  kind: string;
  shelf: string;
  owner: string;
  title: string;
  body: string;
  summary: string | null;
  trust: string;
  source: string | null;
  confidence: number | null;
  version: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: RecordRow): BrainRecord => ({
  id: r.id,
  kind: r.kind as RecordKind,
  shelf: r.shelf,
  owner: r.owner,
  title: r.title,
  body: r.body,
  summary: r.summary,
  trust: r.trust as Trust,
  source: r.source,
  confidence: r.confidence,
  version: r.version,
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * The Brain (Memory 01). One instance is the single writer for its database file (01-D14).
 * Nothing is ever deleted: changes become versions, removals become archives.
 */
export class Brain {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(path: string, opts: BrainOptions = {}) {
    this.#db = new DatabaseSync(path);
    // busy_timeout first: switching to WAL needs a lock, and must wait for other connections instead of failing.
    this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    migrate(this.#db);
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? (() => randomUUID());
  }

  #taskboard: Taskboard | undefined;
  #goals: GoalStore | undefined;
  #approvals: ApprovalStore | undefined;

  /** The taskboard lives in the same database, behind the same single writer. */
  get taskboard(): Taskboard {
    this.#taskboard ??= new Taskboard(this.#db, this.#now);
    return this.#taskboard;
  }

  get goals(): GoalStore {
    this.#goals ??= new GoalStore(this.#db, this.#now, this.#newId);
    return this.#goals;
  }

  /** The user's approval inbox. */
  get approvals(): ApprovalStore {
    this.#approvals ??= new ApprovalStore(this.#db, this.#now, this.#newId);
    return this.#approvals;
  }

  close(): void {
    this.#db.close();
  }

  write(input: WriteInput, actor: Actor): { id: string; created: boolean } {
    this.#assertNoSecrets(input.title, input.body, input.summary);
    const trust = this.#initialTrust(input, actor);
    const hash = this.#hash(input.kind, input.title, input.body);

    return this.#tx(() => {
      const existing = this.#db
        .prepare('SELECT id FROM records WHERE shelf = ? AND content_hash = ? AND archived = 0')
        .get(input.shelf, hash) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };

      const id = this.#newId();
      const at = this.#now();
      this.#db
        .prepare(
          `INSERT INTO records (id, kind, shelf, owner, title, body, summary, trust, source, confidence, content_hash, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, input.kind, input.shelf, actorName(actor), input.title, input.body, input.summary ?? null, trust,
          input.source ?? null, input.confidence ?? null, hash, at, at);
      this.#addVersion(id, 1, 'create', input.title, input.body, input.summary ?? null, trust, actor, at);
      return { id, created: true };
    });
  }

  /** Saves the change as a new version; the old one stays in history. Returns the new version number. */
  update(id: string, changes: UpdateInput, actor: Actor): number {
    this.#assertNoSecrets(changes.title, changes.body, changes.summary);
    return this.#tx(() => {
      const cur = this.#mustGet(id);
      if (cur.archived) throw new ConflictError(`${id} is archived`);
      this.#assertAgentMayChange(cur, actor);
      if (actor.type === 'agent' && changes.trust === 'confirmed' && NEEDS_CONFIRMATION.has(cur.kind)) {
        throw new TrustError(`Only the user can confirm a ${cur.kind}.`);
      }

      const next = {
        title: changes.title ?? cur.title,
        body: changes.body ?? cur.body,
        summary: changes.summary ?? cur.summary,
        trust: changes.trust ?? cur.trust,
      };
      const version = cur.version + 1;
      const at = this.#now();
      this.#db
        .prepare('UPDATE records SET title = ?, body = ?, summary = ?, trust = ?, content_hash = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(next.title, next.body, next.summary, next.trust, this.#hash(cur.kind, next.title, next.body), version, at, id);
      this.#addVersion(id, version, 'update', next.title, next.body, next.summary, next.trust, actor, at);
      return version;
    });
  }

  /** Archive instead of delete: the record leaves search but stays readable with its history. */
  archive(id: string, actor: Actor): void {
    this.#tx(() => {
      const cur = this.#mustGet(id);
      if (cur.archived) return;
      this.#assertAgentMayChange(cur, actor);
      const version = cur.version + 1;
      const at = this.#now();
      this.#db.prepare('UPDATE records SET archived = 1, version = ?, updated_at = ? WHERE id = ?').run(version, at, id);
      this.#addVersion(id, version, 'archive', cur.title, cur.body, cur.summary, cur.trust, actor, at);
    });
  }

  link(fromId: string, toId: string, rel: string): void {
    this.#mustGet(fromId);
    this.#mustGet(toId);
    this.#db
      .prepare('INSERT OR IGNORE INTO links (from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?)')
      .run(fromId, toId, rel, this.#now());
  }

  get(id: string): BrainRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  history(id: string): RecordVersion[] {
    const rows = this.#db
      .prepare('SELECT version, change, title, body, trust, changed_by, changed_at FROM record_versions WHERE record_id = ? ORDER BY version')
      .all(id) as Array<{ version: number; change: RecordVersion['change']; title: string; body: string; trust: Trust; changed_by: string; changed_at: number }>;
    return rows.map((r) => ({ version: r.version, change: r.change, title: r.title, body: r.body, trust: r.trust, changedBy: r.changed_by, changedAt: r.changed_at }));
  }

  links(id: string): LinkView[] {
    const out = this.#db.prepare('SELECT to_id AS id, rel FROM links WHERE from_id = ? ORDER BY created_at').all(id) as Array<{ id: string; rel: string }>;
    const inn = this.#db.prepare('SELECT from_id AS id, rel FROM links WHERE to_id = ? ORDER BY created_at').all(id) as Array<{ id: string; rel: string }>;
    return [...out.map((l) => ({ ...l, direction: 'out' as const })), ...inn.map((l) => ({ ...l, direction: 'in' as const }))];
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const where: string[] = ['records_fts MATCH ?', 'r.archived = 0'];
    const params: Array<string | number> = [fts];
    if (opts.shelf) {
      where.push('r.shelf IN (?, ?)');
      params.push(opts.shelf, GLOBAL_SHELF);
    }
    if (opts.kinds?.length) {
      where.push(`r.kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      params.push(...opts.kinds);
    }
    params.push(opts.limit ?? 20);
    const rows = this.#db
      .prepare(
        `SELECT r.id, r.kind, r.shelf, r.title, r.summary, bm25(records_fts, 5.0, 1.0, 2.0) AS score
         FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
         WHERE ${where.join(' AND ')} ORDER BY score LIMIT ?`,
      )
      .all(...params) as unknown as Array<SearchHit & { kind: string }>;
    return rows.map((r) => ({ ...r, kind: r.kind as RecordKind }));
  }

  /** Tiered read (Memory 01-D7): the best matches packed as one-line summaries within a token budget. */
  read(query: string, opts: SearchOptions & { tokenBudget?: number } = {}): { text: string; ids: string[]; truncated: boolean } {
    const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const hits = this.search(query, { ...opts, limit: opts.limit ?? 50 });
    const lines: string[] = [];
    const ids: string[] = [];
    for (const h of hits) {
      const rec = this.get(h.id)!;
      const line = `- [${rec.kind}] ${rec.title}: ${clip(rec.summary ?? rec.body.replace(/\s+/g, ' '), 160)} (${rec.id})`;
      if (estimateTokens([...lines, line].join('\n')) > budget) break;
      lines.push(line);
      ids.push(rec.id);
    }
    return { text: lines.join('\n'), ids, truncated: ids.length < hits.length };
  }

  /** The few hundred tokens every agent loads first (Memory 01, tiered reading step 1). */
  bootCard(shelf: string): string {
    const pick = (kind: RecordKind, trust: Trust | null, limit: number): BrainRecord[] =>
      (this.#db
        .prepare(
          `SELECT * FROM records WHERE kind = ? AND shelf IN (?, ?) AND archived = 0 ${trust ? 'AND trust = ?' : ''}
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...(trust ? [kind, shelf, GLOBAL_SHELF, trust, limit] : [kind, shelf, GLOBAL_SHELF, limit])) as unknown as RecordRow[]).map(toRecord);

    const waiting = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM records WHERE shelf IN (?, ?) AND archived = 0 AND trust IN ('proposed', 'unconfirmed')`,
      )
      .get(shelf, GLOBAL_SHELF) as { n: number };

    const section = (title: string, recs: BrainRecord[]): string =>
      recs.length ? `${title}:\n${recs.map((r) => `- ${clip(r.title, 80)}`).join('\n')}` : '';
    const card = [
      `Shelf: ${shelf}`,
      section('Decisions', pick('decision', 'confirmed', 5)),
      section('Facts', pick('fact', 'confirmed', 5)),
      section('Recent outcomes', pick('outcome', null, 3)),
      waiting.n ? `Waiting for the user: ${waiting.n} proposal(s) or unconfirmed fact(s).` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return clip(card, 1200);
  }

  #initialTrust(input: WriteInput, actor: Actor): Trust {
    if (actor.type === 'user') return input.trust ?? 'confirmed';
    if (!NEEDS_CONFIRMATION.has(input.kind)) return 'confirmed';
    if (input.trust === 'confirmed') throw new TrustError(`Only the user can confirm a ${input.kind}.`);
    return input.trust ?? (input.kind === 'decision' ? 'proposed' : 'unconfirmed');
  }

  #assertAgentMayChange(cur: BrainRecord, actor: Actor): void {
    if (actor.type === 'agent' && cur.trust === 'confirmed' && NEEDS_CONFIRMATION.has(cur.kind)) {
      throw new ConflictError(`${cur.id} was confirmed by the user; propose a change instead of editing it.`);
    }
  }

  #assertNoSecrets(...texts: Array<string | null | undefined>): void {
    const kinds = [...new Set(texts.flatMap((t) => (t ? detectSecrets(t) : [])))];
    if (kinds.length) throw new SecretError(kinds);
  }

  #hash(kind: string, title: string, body: string): string {
    return createHash('sha256').update(`${kind}\n${norm(title)}\n${norm(body)}`).digest('hex');
  }

  #mustGet(id: string): BrainRecord {
    const rec = this.get(id);
    if (!rec) throw new Error(`No Brain record ${id}`);
    return rec;
  }

  #addVersion(id: string, version: number, change: RecordVersion['change'], title: string, body: string, summary: string | null, trust: Trust, actor: Actor, at: number): void {
    this.#db
      .prepare(
        'INSERT INTO record_versions (record_id, version, change, title, body, summary, trust, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, version, change, title, body, summary, trust, actorName(actor), at);
  }

  #tx<T>(fn: () => T): T {
    return transaction(this.#db, fn);
  }
}

export function openBrain(path: string, opts: BrainOptions = {}): Brain {
  return new Brain(path, opts);
}
