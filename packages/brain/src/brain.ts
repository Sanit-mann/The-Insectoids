import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { RecordKind, Trust } from '@insectoids/shared';
import { ApprovalStore } from './approvals';
import { CodeMapStore } from './codemap';
import { LibraryStore } from './library';
import { ForemanLog, IncidentStore } from './managers';
import { transaction } from './db';
import { GoalStore } from './goals';
import { CadenceStore } from './cadences';
import { ConflictError, SecretError, TrustError } from './errors';
import { importance, rankScore } from './importance';
import { OutcomeStore } from './outcomes';
import { migrate } from './schema';
import { detectSecrets } from './secrets';
import { Taskboard } from './taskboard';
import { STOP_WORDS, cosine, packI8, rrf, unpackI8 } from './vectors';

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
  /**
   * Replace this record (time-aware facts, 01-E9; B2): the old one stops being current and stays as history.
   * If the user confirmed it, an agent's write becomes a proposal instead and the old one stays current.
   */
  supersedes?: string;
  /** The new record's meaning vector, when the host made one: used for the near-duplicate check, then stored. */
  vector?: { vector: Float32Array; model: string };
}

export interface WriteResult {
  id: string;
  created: boolean;
  /** A near-duplicate of an agent record was folded into it as a new version (01-E5). */
  merged?: boolean;
  /** Plain words for the caller, e.g. "already known as …" or "saved as a proposal". */
  note?: string;
}

export interface UpdateInput {
  title?: string;
  body?: string;
  /** null clears it. */
  summary?: string | null;
  trust?: Trust;
  /**
   * The version the change was made from (the user's edit in the Brain screen, 01-D12; B5). If the record
   * has moved on since (an agent changed it), nothing is saved: ConflictError.
   */
  expectedVersion?: number;
}

/** Graph view (01-D13; B5): records as nodes, edges only from real links. */
export interface GraphOptions {
  /** A project shelf (plus global, like search), 'global' alone, or undefined for every shelf. */
  shelf?: string;
  kinds?: RecordKind[];
  /** Only records updated at or after this time (ms). */
  since?: number;
  /** Also records that are not current (archived or replaced); they are marked `archived`. */
  includeArchived?: boolean;
  limit: number;
}

export interface GraphNode {
  id: string;
  kind: RecordKind;
  title: string;
  trust: Trust;
  shelf: string;
  /** Not current: archived, or replaced by a newer record. */
  archived: boolean;
  importance: number;
  updatedAt: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string; rel: string }>;
  /** Matched the filters but left out by `limit` (the least important). */
  hidden: number;
}

/** Dashboard numbers (01-D13 phase 2; B5) for a shelf (a project's includes global, like the health score). */
export interface Dashboard {
  shelf: string;
  totals: { records: number; archived: number; confirmed: number; links: number };
  byKind: Array<{ kind: RecordKind; count: number }>;
  weeks: Array<{ weekStart: number; added: number; reads: number }>;
  mostUsed: Array<{ id: string; kind: RecordKind; title: string; reads: number; helped: number; importance: number }>;
  timeline: Array<{ id: string; kind: RecordKind; title: string; version: number; change: string; changedBy: string; changedAt: number }>;
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
  /** How agents use it (B2): reads, card passes it helped, last use; importance 0..1 (see importance.ts). */
  reads: number;
  helped: number;
  lastUsedAt: number | null;
  importance: number;
  /** Time-aware facts (01-E9): current while validTo is null. */
  validFrom: number;
  validTo: number | null;
  supersededBy: string | null;
  /** Why it was archived ("faded: …", "merged into …", "by you"); null when not archived. */
  archivedReason: string | null;
}

export interface RecordVersion {
  version: number;
  change: 'create' | 'update' | 'archive' | 'supersede' | 'unarchive' | 'merge';
  title: string;
  body: string;
  trust: Trust;
  changedBy: string;
  changedAt: number;
}

export type RecordStatus = 'current' | 'superseded' | 'archived';

export interface SearchHit {
  id: string;
  kind: RecordKind;
  shelf: string;
  title: string;
  summary: string | null;
  /** Ranking score, higher is better: fused relevance (RRF over words and meaning) scaled by importance (B2). */
  score: number;
  /** How it was found (Phase 2 B1): by its words, by meaning, or both. */
  match: 'words' | 'meaning' | 'both';
  /** Current, or (only with includeHistory) superseded / archived. */
  status: RecordStatus;
}

export interface SearchOptions {
  /** Project shelf. The global shelf is always included; other projects never are (Memory 01-D2). */
  shelf?: string;
  kinds?: RecordKind[];
  limit?: number;
  /**
   * Meaning search (Phase 2 B1): the query's unit vector, made by the Brain host's embedder, and the model
   * that made it. Only vectors from the same model and for the record's current content are compared.
   * Absent: words only.
   */
  queryVector?: Float32Array;
  vectorModel?: string;
  /** Lowest cosine similarity for a meaning match. Default DEFAULT_MIN_SIMILARITY. */
  minSimilarity?: number;
  /** Also superseded and archived records, marked with their status (B2). Default: current only. */
  includeHistory?: boolean;
}

/** A record that needs a (new) vector for a model: its text to embed and the content hash it belongs to. */
export interface PendingVector {
  id: string;
  text: string;
  contentHash: string;
}

export interface LinkView {
  id: string;
  rel: string;
  direction: 'in' | 'out';
}

/** Raw counts behind the Brain health score (B3). */
export interface HealthCounts {
  total: number;
  stale: number;
  waiting: number;
  orphans: number;
  unused: number;
  lessons: number;
}

export interface FadedRecord {
  id: string;
  title: string;
  days: number;
}

export interface BrainOptions {
  now?: () => number;
  newId?: () => string;
}

/** Default answer size (Memory 01-D7). */
export const DEFAULT_TOKEN_BUDGET = 800;
const GLOBAL_SHELF = 'global';
/** Kinds an agent can only write as unconfirmed/proposed; only the user confirms them (01-D3). Lessons too (B3). */
const NEEDS_CONFIRMATION: ReadonlySet<RecordKind> = new Set(['fact', 'decision', 'lesson']);
const DAY = 86_400_000;

/**
 * Near-duplicate thresholds (01-E5; B2). Chosen so that genuinely different facts never merge: besides the
 * similarity, the numbers in both texts must be the same ("port 3000" vs "port 3001" never merge).
 */
export const NEAR_DUPLICATE = { cosine: 0.95, jaccard: 0.9, candidates: 500, textChars: 4000 } as const;

/**
 * Decay (01-E7; B2): what fades into the archive, and when. Only agent-made records nobody confirmed;
 * never decisions, tasks or files, never anything the user wrote, edited or confirmed.
 */
export const DECAY = {
  /** update, agent_memory, outcome: unused this long. */
  notesDays: 60,
  /** facts and lessons an agent wrote that are still unconfirmed this long after creation, and unused as long. */
  factsDays: 90,
  /** Fade only below this importance. */
  minImportance: 0.15,
  kinds: ['update', 'agent_memory', 'outcome', 'fact', 'lesson'] as const,
};

/** The read key for one card attempt's runs: what they read, so a pass can credit what helped (B2). */
export const cardReadKey = (cardId: string, attempt: number): string => `card:${cardId}:a${attempt}`;

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const actorName = (a: Actor): string => (a.type === 'user' ? 'user' : a.id);
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The numbers in a text (as written), so near-duplicates that differ only in a number never merge. */
const numbersIn = (s: string): string => [...s.matchAll(/\d+(?:[.,:]\d+)*/g)].map((m) => m[0]).sort().join('|');

/** Character-trigram Jaccard similarity of two normalised texts. */
function trigramJaccard(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    // Punctuation and case don't make a different note: compare letters and digits only.
    const t = ` ${norm(s.replace(/[^\p{L}\p{N}]+/gu, ' '))} `;
    const out = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

const OPERATOR = /^(OR|AND|NOT)$/;

/**
 * Turn free text into a safe FTS5 query.
 * - Plain text matches **any** meaningful word (stop words dropped): records matching more of the words
 *   rank higher (bm25). Requiring every word (the Phase 1 behaviour) found nothing for a natural sentence
 *   phrased differently from the record (0% on the B1 spike's paraphrase queries).
 * - If the user typed OR / AND / NOT, their query is kept as written (FTS5's implicit AND between words).
 * Punctuation splits words the way the FTS tokenizer does ("hello.txt" -> "hello" "txt").
 */
function toFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .flatMap((t) => (OPERATOR.test(t) ? [t] : t.split(/[^\p{L}\p{N}_]+/u)))
    .filter(Boolean);
  if (tokens.some((t) => OPERATOR.test(t))) {
    const parts = tokens.map((t) => (OPERATOR.test(t) ? t : `"${t}"`));
    while (parts.length && OPERATOR.test(parts[0]!)) parts.shift();
    while (parts.length && OPERATOR.test(parts.at(-1)!)) parts.pop();
    return parts.join(' ');
  }
  const meaningful = tokens.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  const words = [...new Set((meaningful.length ? meaningful : tokens).map((t) => t.toLowerCase()))];
  return words.map((t) => `"${t}"`).join(' OR ');
}

/** Lowest cosine similarity a record needs to count as a meaning match (MiniLM: unrelated text sits below ~0.2). */
export const DEFAULT_MIN_SIMILARITY = 0.25;
/** How many candidates each list (words, meaning) contributes before the two are fused and re-ranked. */
const FUSION_DEPTH = 50;
/** Text a record is embedded from: its title, summary and the start of its body. */
const VECTOR_TEXT_CHARS = 2000;

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
  reads: number;
  helped: number;
  last_used_at: number | null;
  valid_from: number | null;
  valid_to: number | null;
  superseded_by: string | null;
  archived_reason: string | null;
}

/** The columns a search hit needs: what to show, its status, and what importance is computed from. */
const HIT_COLUMNS =
  'r.id, r.kind, r.shelf, r.title, r.summary, r.archived, r.valid_to, r.trust, r.confidence, r.reads, r.helped, r.last_used_at, r.updated_at';

interface HitRow {
  id: string;
  kind: string;
  shelf: string;
  title: string;
  summary: string | null;
  archived: number;
  valid_to: number | null;
  trust: string;
  confidence: number | null;
  reads: number;
  helped: number;
  last_used_at: number | null;
  updated_at: number;
}

const statusOf = (r: { archived: number; valid_to: number | null }): RecordStatus =>
  r.archived === 1 ? 'archived' : r.valid_to !== null ? 'superseded' : 'current';

const importanceOf = (r: HitRow | RecordRow, now: number): number =>
  importance(
    { trust: r.trust as Trust, confidence: r.confidence, reads: r.reads, helped: r.helped, lastUsedAt: r.last_used_at, updatedAt: r.updated_at },
    now,
  );

const toRecord = (r: RecordRow, now: number): BrainRecord => ({
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
  reads: r.reads,
  helped: r.helped,
  lastUsedAt: r.last_used_at,
  importance: importanceOf(r, now),
  validFrom: r.valid_from ?? r.created_at,
  validTo: r.valid_to,
  supersededBy: r.superseded_by,
  archivedReason: r.archived_reason,
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

  #code: CodeMapStore | undefined;

  /** The code map (Memory 01-E3; Phase 2 B4), in the same database behind the same single writer. */
  get code(): CodeMapStore {
    this.#code ??= new CodeMapStore(this.#db, this.#now);
    return this.#code;
  }

  #library: LibraryStore | undefined;

  /** The library catalog and skill activations (Capabilities 03-D8; Phase 2 C1), same database and writer. */
  get library(): LibraryStore {
    this.#library ??= new LibraryStore(this.#db, this.#now);
    return this.#library;
  }

  #incidents: IncidentStore | undefined;
  #foreman: ForemanLog | undefined;

  /** The Watchdog's incidents (Hive 02-D9 P3; Phase 2 C2). */
  get incidents(): IncidentStore {
    this.#incidents ??= new IncidentStore(this.#db, this.#now);
    return this.#incidents;
  }

  /** The Foreman's decisions on stuck cards (Hive 02-D8; Phase 2 C2). */
  get foreman(): ForemanLog {
    this.#foreman ??= new ForemanLog(this.#db, this.#now);
    return this.#foreman;
  }

  #outcomes: OutcomeStore | undefined;

  /** Run outcomes: the Treasurer's memory (Phase 2 A5). */
  get outcomes(): OutcomeStore {
    this.#outcomes ??= new OutcomeStore(this.#db, this.#now);
    return this.#outcomes;
  }

  #cadences: CadenceStore | undefined;

  /** Cadences and their run log (Cadence 05; Phase 3 A1). */
  get cadences(): CadenceStore {
    this.#cadences ??= new CadenceStore(this.#db, this.#now, this.#newId);
    return this.#cadences;
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

  /**
   * Save a record. Exact duplicates (same shelf, same normalised content) return the existing record.
   * B2: an agent's near-duplicate of an agent record is folded into it as a new version (the incoming text
   * is kept as an archived record "merged into …"); a near-duplicate of something the user confirmed changes
   * nothing. `supersedes` replaces an older record (time-aware facts).
   */
  write(input: WriteInput, actor: Actor): WriteResult {
    this.#assertNoSecrets(input.title, input.body, input.summary, input.source);
    let trust = this.#initialTrust(input, actor);
    const hash = this.#hash(input.kind, input.title, input.body);

    return this.#tx(() => {
      const existing = this.#db
        .prepare('SELECT id FROM records WHERE shelf = ? AND content_hash = ? AND archived = 0 AND valid_to IS NULL')
        .get(input.shelf, hash) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };

      let replace: BrainRecord | undefined;
      let proposalFor: BrainRecord | undefined;
      if (input.supersedes) {
        const old = this.#mustGet(input.supersedes);
        this.#assertSupersedable(old, input.shelf);
        if (actor.type === 'agent' && this.#userConfirmed(old)) {
          // The user's record stays current; the agent's becomes a proposal the user decides on.
          proposalFor = old;
          if (NEEDS_CONFIRMATION.has(input.kind)) trust = 'proposed';
        } else {
          replace = old;
        }
      } else if (actor.type === 'agent') {
        const dup = this.#nearDuplicate(input);
        if (dup) {
          if (this.#userConfirmed(dup)) {
            return { id: dup.id, created: false, merged: false, note: `Already known as "${dup.title}" (${dup.id}), which the user confirmed; nothing changed.` };
          }
          this.#foldInto(dup, input, trust, hash, actor);
          return { id: dup.id, created: false, merged: true, note: `Already known as "${dup.title}" (${dup.id}); your version was folded in as a new version.` };
        }
      }

      const id = this.#insert(input, trust, hash, actor, false, null);
      if (input.vector) this.#storeVector(id, input.vector.model, input.vector.vector, hash);
      if (replace) {
        this.#markSuperseded(replace, id, actor);
      }
      if (proposalFor) {
        this.link(id, proposalFor.id, 'proposes_to_supersede');
        return {
          id,
          created: true,
          note: `${proposalFor.id} ("${proposalFor.title}") was confirmed by the user, so it stays current; your record is saved as a proposal to replace it, and the user decides.`,
        };
      }
      return { id, created: true };
    });
  }

  /**
   * Replace `oldId` with `newId` (time-aware facts, 01-E9): the old record stops being current (validTo,
   * supersededBy) and stays readable as history; `newId -supersedes-> oldId` links them. Agents can't
   * supersede what the user confirmed (ConflictError: propose instead).
   */
  supersede(oldId: string, newId: string, actor: Actor): void {
    this.#tx(() => {
      const old = this.#mustGet(oldId);
      const next = this.#mustGet(newId);
      if (old.id === next.id) throw new ConflictError('A record cannot supersede itself.');
      this.#assertSupersedable(old, next.shelf);
      if (actor.type === 'agent' && this.#userConfirmed(old)) {
        throw new ConflictError(`${old.id} was confirmed by the user; propose a replacement instead of superseding it.`);
      }
      this.#markSuperseded(old, next.id, actor);
    });
  }

  /** Saves the change as a new version; the old one stays in history. Returns the new version number. */
  update(id: string, changes: UpdateInput, actor: Actor): number {
    this.#assertNoSecrets(changes.title, changes.body, changes.summary);
    return this.#tx(() => {
      const cur = this.#mustGet(id);
      if (cur.archived) throw new ConflictError(`${id} is archived`);
      if (changes.expectedVersion !== undefined && cur.version !== changes.expectedVersion) {
        throw new ConflictError(`${id} changed since version ${changes.expectedVersion} (now version ${cur.version}).`);
      }
      this.#assertAgentMayChange(cur, actor);
      if (actor.type === 'agent' && changes.trust === 'confirmed' && NEEDS_CONFIRMATION.has(cur.kind)) {
        throw new TrustError(`Only the user can confirm a ${cur.kind}.`);
      }

      const next = {
        title: changes.title ?? cur.title,
        body: changes.body ?? cur.body,
        summary: changes.summary === undefined ? cur.summary : changes.summary,
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
  archive(id: string, actor: Actor, reason?: string): void {
    this.#tx(() => {
      const cur = this.#mustGet(id);
      if (cur.archived) return;
      this.#assertAgentMayChange(cur, actor);
      this.#archiveRow(cur, actor, reason ?? (actor.type === 'user' ? 'by you' : `by ${actor.id}`));
    });
  }

  /** Bring an archived (e.g. faded) record back, as a new version. Only the user can (B2). */
  unarchive(id: string, actor: Actor): void {
    if (actor.type !== 'user') throw new TrustError('Only the user can bring an archived record back.');
    this.#tx(() => {
      const cur = this.#mustGet(id);
      if (!cur.archived) return;
      const version = cur.version + 1;
      const at = this.#now();
      this.#db.prepare('UPDATE records SET archived = 0, archived_reason = NULL, version = ?, updated_at = ? WHERE id = ?').run(version, at, id);
      this.#addVersion(id, version, 'unarchive', cur.title, cur.body, cur.summary, cur.trust, actor, at);
    });
  }

  link(fromId: string, toId: string, rel: string): void {
    this.#mustGet(fromId);
    this.#mustGet(toId);
    this.#db
      .prepare('INSERT OR IGNORE INTO links (from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?)')
      .run(fromId, toId, rel, this.#now());
  }

  /** The record, without counting a read (internal lookups and the app's reader use this). */
  get(id: string): BrainRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined;
    return row ? toRecord(row, this.#now()) : undefined;
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

  // ---- use (B2) --------------------------------------------------------------------------------

  /**
   * Count a read: the record was handed to an agent (get, read(), boot card, Queen lookups). Search hits
   * alone don't count, or ranking would feed itself. With a read key (one card attempt), a later pass of
   * that attempt credits the record as having helped.
   */
  noteRead(ids: string[], readKey?: string): void {
    if (!ids.length) return;
    const at = this.#now();
    this.#tx(() => {
      const bump = this.#db.prepare('UPDATE records SET reads = reads + 1, last_used_at = ? WHERE id = ?');
      const key = readKey ? this.#db.prepare('INSERT OR IGNORE INTO record_reads (read_key, record_id, at) VALUES (?, ?, ?)') : null;
      for (const id of new Set(ids)) {
        bump.run(at, id);
        key?.run(readKey!, id, at);
      }
    });
  }

  /** A card attempt passed inspection: every record its runs read helped (each counted once). Returns how many. */
  creditHelped(readKey: string): number {
    return this.#tx(() => {
      const r = this.#db
        .prepare(`UPDATE records SET helped = helped + 1 WHERE id IN (SELECT record_id FROM record_reads WHERE read_key = ? AND credited = 0)`)
        .run(readKey);
      this.#db.prepare('UPDATE record_reads SET credited = 1 WHERE read_key = ?').run(readKey);
      return Number(r.changes);
    });
  }

  /**
   * Decay (01-E7; B2): fade unused, unimportant agent notes into the archive ("faded: unused for N days").
   * Never decisions, tasks or files; never anything the user wrote, edited or confirmed. Restorable by the
   * user (unarchive). Returns what faded.
   */
  fade(opts: { now?: number; minImportance?: number } = {}): FadedRecord[] {
    const now = opts.now ?? this.#now();
    const min = opts.minImportance ?? DECAY.minImportance;
    const rows = this.#db
      .prepare(
        `SELECT * FROM records r WHERE r.archived = 0 AND r.owner != 'user' AND r.kind IN (${DECAY.kinds.map(() => '?').join(', ')})
         AND NOT EXISTS (SELECT 1 FROM record_versions v WHERE v.record_id = r.id AND v.changed_by = 'user')`,
      )
      .all(...DECAY.kinds) as unknown as RecordRow[];
    const faded: FadedRecord[] = [];
    this.#tx(() => {
      for (const row of rows) {
        const rec = toRecord(row, now);
        if (this.#userConfirmed(rec)) continue;
        const days = Math.floor((now - Math.max(rec.lastUsedAt ?? 0, rec.updatedAt)) / DAY);
        if (rec.kind === 'fact' || rec.kind === 'lesson') {
          if (rec.trust === 'confirmed' || now - rec.createdAt < DECAY.factsDays * DAY || days < DECAY.factsDays) continue;
        } else if (days < DECAY.notesDays) {
          continue;
        }
        if (importanceOf(row, now) >= min) continue;
        this.#archiveRow(rec, { type: 'agent', id: 'brain-tidy' }, `faded: unused for ${days} days`, now);
        faded.push({ id: rec.id, title: rec.title, days });
      }
    });
    return faded;
  }

  // ---- search ----------------------------------------------------------------------------------

  /**
   * Search (Memory 01-D7, E11; Phase 2 B1, B2).
   * - Words: FTS5 over title, body and summary, matching any meaningful word, ranked by bm25.
   * - With a query vector: also the records whose meaning is closest (cosine over current vectors from the
   *   same model). Both lists are fused with Reciprocal Rank Fusion, then scaled by importance (B2).
   * - Current records only, unless includeHistory (then superseded and archived ones too, with their status).
   * Shelf scoping is the same for both: the given project shelf plus global, never other projects.
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const depth = Math.max(limit, FUSION_DEPTH);
    const hybrid = Boolean(opts.queryVector && opts.vectorModel);
    const words = this.#wordHits(query, opts, depth);
    const meaning = hybrid ? this.#meaningHits(opts.queryVector!, opts.vectorModel!, opts, depth) : [];
    const rows = new Map<string, HitRow>();
    for (const r of [...words, ...meaning]) if (!rows.has(r.id)) rows.set(r.id, r);
    const inWords = new Set(words.map((r) => r.id));
    const inMeaning = new Set(meaning.map((r) => r.id));
    const lists = meaning.length ? [words.map((r) => r.id), meaning.map((r) => r.id)] : [words.map((r) => r.id)];
    const now = this.#now();
    return rrf(lists)
      .map(({ id, score }) => {
        const r = rows.get(id)!;
        return {
          id,
          kind: r.kind as RecordKind,
          shelf: r.shelf,
          title: r.title,
          summary: r.summary,
          score: rankScore(score, importanceOf(r, now)),
          match: (inWords.has(id) && inMeaning.has(id) ? 'both' : inWords.has(id) ? 'words' : 'meaning') as SearchHit['match'],
          status: statusOf(r),
        };
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  #scope(opts: SearchOptions, alias: string): { where: string[]; params: Array<string | number> } {
    const where: string[] = opts.includeHistory ? ['1 = 1'] : [`${alias}.archived = 0`, `${alias}.valid_to IS NULL`];
    const params: Array<string | number> = [];
    if (opts.shelf) {
      where.push(`${alias}.shelf IN (?, ?)`);
      params.push(opts.shelf, GLOBAL_SHELF);
    }
    if (opts.kinds?.length) {
      where.push(`${alias}.kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      params.push(...opts.kinds);
    }
    return { where, params };
  }

  #wordHits(query: string, opts: SearchOptions, limit: number): HitRow[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const scope = this.#scope(opts, 'r');
    return this.#db
      .prepare(
        `SELECT ${HIT_COLUMNS}, bm25(records_fts, 5.0, 1.0, 2.0) AS bm
         FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
         WHERE records_fts MATCH ? AND ${scope.where.join(' AND ')} ORDER BY bm LIMIT ?`,
      )
      .all(fts, ...scope.params, limit) as unknown as HitRow[];
  }

  /** Brute-force cosine over the scope's current vectors (fast far beyond Brain sizes, 01-R7). */
  #meaningHits(query: Float32Array, model: string, opts: SearchOptions, limit: number): HitRow[] {
    const min = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    const scope = this.#scope(opts, 'r');
    const rows = this.#db
      .prepare(
        `SELECT ${HIT_COLUMNS}, v.vec
         FROM record_vectors v JOIN records r ON r.id = v.record_id
         WHERE v.model = ? AND v.content_hash = r.content_hash AND ${scope.where.join(' AND ')}`,
      )
      .all(model, ...scope.params) as unknown as Array<HitRow & { vec: Uint8Array }>;
    return rows
      .map((r) => ({ row: r, sim: cosine(query, unpackI8(r.vec)) }))
      .filter((x) => x.sim >= min)
      .sort((a, b) => b.sim - a.sim || a.row.id.localeCompare(b.row.id))
      .slice(0, limit)
      .map(({ row: { vec: _v, ...row } }) => row);
  }

  // ---- meaning-search vectors (Phase 2 B1) ------------------------------------------------------

  /**
   * Records that need a vector for `model`: none yet, or made from older content. Archived records are
   * skipped (they leave search). Newest first, so fresh notes become findable by meaning soonest.
   */
  pendingVectors(model: string, limit = 1): PendingVector[] {
    const rows = this.#db
      .prepare(
        `SELECT r.id, r.title, r.summary, r.body, r.content_hash FROM records r
         LEFT JOIN record_vectors v ON v.record_id = r.id AND v.model = ?
         WHERE r.archived = 0 AND (v.record_id IS NULL OR v.content_hash != r.content_hash)
         ORDER BY r.updated_at DESC, r.id LIMIT ?`,
      )
      .all(model, limit) as Array<{ id: string; title: string; summary: string | null; body: string; content_hash: string }>;
    return rows.map((r) => ({
      id: r.id,
      text: clip([r.title, r.summary, r.body].filter(Boolean).join('\n'), VECTOR_TEXT_CHARS),
      contentHash: r.content_hash,
    }));
  }

  /**
   * Stores a record's vector. Ignored (returns false) when the record changed since `contentHash` was read,
   * so a slow embedding never overwrites a newer one with an outdated vector.
   */
  setVector(id: string, model: string, vector: Float32Array, contentHash: string): boolean {
    const cur = this.#db.prepare('SELECT content_hash FROM records WHERE id = ?').get(id) as { content_hash: string } | undefined;
    if (!cur || cur.content_hash !== contentHash) return false;
    this.#storeVector(id, model, vector, contentHash);
    return true;
  }

  /** Searchable records with a current vector for `model`, out of all searchable (non-archived) records. */
  vectorProgress(model: string): { indexed: number; total: number } {
    const total = (this.#db.prepare('SELECT COUNT(*) AS n FROM records WHERE archived = 0').get() as { n: number }).n;
    const indexed = (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM records r JOIN record_vectors v ON v.record_id = r.id AND v.model = ?
           WHERE r.archived = 0 AND v.content_hash = r.content_hash`,
        )
        .get(model) as { n: number }
    ).n;
    return { indexed, total };
  }

  /**
   * Tiered read (Memory 01-D7): the best current matches packed as one-line summaries within a token
   * budget. What it returns counts as read (B2); `readKey` ties the reads to one card attempt.
   */
  read(query: string, opts: SearchOptions & { tokenBudget?: number; readKey?: string } = {}): { text: string; ids: string[]; truncated: boolean } {
    const budget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    // read() hands records to an agent: current ones only, never history.
    const { readKey, ...searchOpts } = opts;
    const hits = this.search(query, { ...searchOpts, includeHistory: false, limit: opts.limit ?? 50 });
    const lines: string[] = [];
    const ids: string[] = [];
    for (const h of hits) {
      const rec = this.get(h.id)!;
      const line = `- [${rec.kind}] ${rec.title}: ${clip(rec.summary ?? rec.body.replace(/\s+/g, ' '), 160)} (${rec.id})`;
      if (estimateTokens([...lines, line].join('\n')) > budget) break;
      lines.push(line);
      ids.push(rec.id);
    }
    this.noteRead(ids, readKey);
    return { text: lines.join('\n'), ids, truncated: ids.length < hits.length };
  }

  /** Newest records on a shelf (plus global), for browsing without a search query (App 07, Brain screen). */
  recent(opts: { shelf: string; kinds?: RecordKind[]; limit?: number; includeHistory?: boolean }): SearchHit[] {
    const params: Array<string | number> = [opts.shelf, GLOBAL_SHELF];
    const current = opts.includeHistory ? '' : 'AND r.archived = 0 AND r.valid_to IS NULL';
    const kinds = opts.kinds?.length ? `AND r.kind IN (${opts.kinds.map(() => '?').join(', ')})` : '';
    if (opts.kinds?.length) params.push(...opts.kinds);
    params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
    const rows = this.#db
      .prepare(`SELECT ${HIT_COLUMNS} FROM records r WHERE r.shelf IN (?, ?) ${current} ${kinds} ORDER BY r.updated_at DESC, r.id LIMIT ?`)
      .all(...params) as unknown as HitRow[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as RecordKind,
      shelf: r.shelf,
      title: r.title,
      summary: r.summary,
      score: 0,
      match: 'words' as const,
      status: statusOf(r),
    }));
  }

  /**
   * The few hundred tokens every agent loads first (Memory 01, tiered reading step 1). Current records only;
   * the records it lists count as read (B2).
   */
  bootCard(shelf: string, readKey?: string): string {
    const pick = (kind: RecordKind, trust: Trust | null, limit: number): BrainRecord[] =>
      (this.#db
        .prepare(
          `SELECT * FROM records WHERE kind = ? AND shelf IN (?, ?) AND archived = 0 AND valid_to IS NULL ${trust ? 'AND trust = ?' : ''}
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...(trust ? [kind, shelf, GLOBAL_SHELF, trust, limit] : [kind, shelf, GLOBAL_SHELF, limit])) as unknown as RecordRow[]).map((r) =>
        toRecord(r, this.#now()),
      );

    const waiting = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM records WHERE shelf IN (?, ?) AND archived = 0 AND valid_to IS NULL AND trust IN ('proposed', 'unconfirmed')`,
      )
      .get(shelf, GLOBAL_SHELF) as { n: number };

    const decisions = pick('decision', 'confirmed', 5);
    const facts = pick('fact', 'confirmed', 5);
    const outcomes = pick('outcome', null, 3);
    // Lessons (01-E10, B3): the ones the user confirmed first, then a few recent unconfirmed ones.
    const confirmedLessons = pick('lesson', 'confirmed', 5);
    const newLessons = pick('lesson', 'unconfirmed', 3);
    const section = (title: string, recs: BrainRecord[]): string =>
      recs.length ? `${title}:\n${recs.map((r) => `- ${clip(r.title, 80)}`).join('\n')}` : '';
    const card = [
      `Shelf: ${shelf}`,
      section('Decisions', decisions),
      section('Facts', facts),
      section('Lessons (avoid these)', [...confirmedLessons, ...newLessons]),
      section('Recent outcomes', outcomes),
      waiting.n ? `Waiting for the user: ${waiting.n} proposal(s) or unconfirmed fact(s).` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.noteRead([...decisions, ...facts, ...confirmedLessons, ...newLessons, ...outcomes].map((r) => r.id), readKey);
    return clip(card, 1200);
  }

  // ---- lessons, merges and audits (B3) ---------------------------------------------------------

  /**
   * Learn a lesson (01-E10): an agent-written "Don't … because …" record (unconfirmed until the user
   * confirms it). A near-duplicate folds into the existing lesson (B2 dedupe); every call counts as one
   * more time the hive saw it.
   */
  learn(input: { shelf: string; title: string; body: string; source?: string }, actor: Actor): { id: string; created: boolean; seen: number } {
    const r = this.write({ kind: 'lesson', shelf: input.shelf, title: input.title, body: input.body, ...(input.source ? { source: input.source } : {}) }, actor);
    this.#db.prepare('INSERT INTO lesson_hits (record_id, at) VALUES (?, ?)').run(r.id, this.#now());
    return { id: r.id, created: r.created, seen: this.lessonSeen(r.id) };
  }

  /** How many times the hive ran into this lesson (at least 1). */
  lessonSeen(id: string): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM lesson_hits WHERE record_id = ?').get(id) as { n: number };
    return Math.max(1, row.n);
  }

  /** Current lessons on a project shelf and the global shelf, newest first. */
  lessons(shelf: string, limit = 50): Array<BrainRecord & { seen: number }> {
    const rows = this.#db
      .prepare(
        `SELECT * FROM records WHERE kind = 'lesson' AND shelf IN (?, ?) AND archived = 0 AND valid_to IS NULL
         ORDER BY created_at DESC, id LIMIT ?`,
      )
      .all(shelf, GLOBAL_SHELF, limit) as unknown as RecordRow[];
    return rows.map((r) => ({ ...toRecord(r, this.#now()), seen: this.lessonSeen(r.id) }));
  }

  /**
   * Fold one record into another, as the user (a Librarian proposal the user approved): `foldId` is
   * archived "merged into …" and linked to `keepId`; nothing is deleted. Only the user can.
   */
  mergeRecords(keepId: string, foldId: string, actor: Actor): void {
    if (actor.type !== 'user') throw new TrustError('Only the user can merge records this way.');
    this.#tx(() => {
      const keep = this.#mustGet(keepId);
      const fold = this.#mustGet(foldId);
      if (keep.id === fold.id) throw new ConflictError('A record cannot be merged into itself.');
      if (keep.shelf !== fold.shelf || keep.kind !== fold.kind) throw new ConflictError('Only records of the same kind on the same shelf can be merged.');
      if (keep.archived || fold.archived) throw new ConflictError('Archived records cannot be merged.');
      this.#archiveRow(fold, actor, `merged into ${keep.id}`);
      this.#db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?)').run(fold.id, keep.id, 'merged_into', this.#now());
    });
  }

  /**
   * Near-duplicate pairs among a shelf's current records (the Librarian's audit, B3). B2 already folds an
   * agent's near-duplicate of an agent record on write; what remains here involves a record the user wrote
   * or confirmed (`userInvolved`), which only the user may merge. Same rules as on write: same kind, same
   * numbers, cosine >= 0.95 with vectors, else trigram Jaccard >= 0.9. Checks the newest `limit` records.
   */
  duplicatePairs(shelf: string, limit = 300): Array<{ a: BrainRecord; b: BrainRecord; similarity: number; userInvolved: boolean }> {
    const now = this.#now();
    const rows = this.#db
      .prepare('SELECT * FROM records WHERE shelf = ? AND archived = 0 AND valid_to IS NULL ORDER BY updated_at DESC, id LIMIT ?')
      .all(shelf, limit) as unknown as RecordRow[];
    const vecs = new Map<string, Float32Array>();
    for (const v of this.#db
      .prepare('SELECT v.record_id, v.vec FROM record_vectors v JOIN records r ON r.id = v.record_id WHERE r.shelf = ? AND v.content_hash = r.content_hash')
      .all(shelf) as Array<{ record_id: string; vec: Uint8Array }>) {
      vecs.set(v.record_id, unpackI8(v.vec));
    }
    const prepared = rows.map((r) => ({ row: r, text: clip(`${r.title}\n${r.body}`, NEAR_DUPLICATE.textChars), numbers: numbersIn(`${r.title} ${r.body}`) }));
    const pairs: Array<{ a: BrainRecord; b: BrainRecord; similarity: number; userInvolved: boolean }> = [];
    for (let i = 0; i < prepared.length; i++) {
      for (let j = i + 1; j < prepared.length; j++) {
        const x = prepared[i]!;
        const y = prepared[j]!;
        if (x.row.kind !== y.row.kind || x.numbers !== y.numbers) continue;
        const vx = vecs.get(x.row.id);
        const vy = vecs.get(y.row.id);
        const sim = vx && vy ? cosine(vx, vy) : trigramJaccard(x.text, y.text);
        if (sim < (vx && vy ? NEAR_DUPLICATE.cosine : NEAR_DUPLICATE.jaccard)) continue;
        const a = toRecord(x.row, now);
        const b = toRecord(y.row, now);
        pairs.push({ a, b, similarity: sim, userInvolved: this.#userConfirmed(a) || this.#userConfirmed(b) });
      }
    }
    return pairs;
  }

  /**
   * Fold agent-only near-duplicates together (01-E5; Cadence 05-D7, Phase 3 A5 `consolidate`). For each pair
   * `duplicatePairs` finds that no user wrote, edited or confirmed, the one read less (else the older) is archived
   * "merged into <kept id>" and linked `merged_into`, like a fade: nothing is deleted and the user can bring it
   * back. Records involving the user are never touched; those pairs wait for the user. Returns what was folded.
   */
  foldDuplicates(shelf: string): Array<{ id: string; title: string; into: string }> {
    const pairs = this.duplicatePairs(shelf).filter((p) => !p.userInvolved);
    if (!pairs.length) return [];
    const editedByUser = this.#db.prepare("SELECT 1 FROM record_versions WHERE record_id = ? AND changed_by = 'user' LIMIT 1");
    const folded: Array<{ id: string; title: string; into: string }> = [];
    const gone = new Set<string>();
    const actor = { type: 'agent', id: 'brain-tidy' } as const;
    this.#tx(() => {
      for (const { a, b } of pairs) {
        if (gone.has(a.id) || gone.has(b.id)) continue;
        if (editedByUser.get(a.id) || editedByUser.get(b.id)) continue;
        const keepA = a.reads !== b.reads ? a.reads > b.reads : a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : a.id < b.id;
        const [keep, fold] = keepA ? [a, b] : [b, a];
        const cur = this.#mustGet(fold.id);
        if (cur.archived) continue;
        this.#archiveRow(cur, actor, `merged into ${keep.id}`);
        this.#db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?)').run(fold.id, keep.id, 'merged_into', this.#now());
        gone.add(fold.id);
        folded.push({ id: fold.id, title: fold.title, into: keep.id });
      }
    });
    return folded;
  }

  /**
   * A consistent copy of the whole Brain in a new file (Memory 01-D8; Phase 3 A5 `backup`), with SQLite
   * `VACUUM INTO`: safe while the Brain is in use, and the copy opens as a Brain of its own. The file must not
   * exist yet. Returns its size in bytes.
   */
  backupTo(file: string): number {
    this.#db.prepare('VACUUM INTO ?').run(file);
    return statSync(file).size;
  }

  /** Counts for the health score (01-E12, B3): current records on a project shelf and global. */
  healthCounts(shelf: string, now = this.#now()): HealthCounts {
    const current = 'r.archived = 0 AND r.valid_to IS NULL AND r.shelf IN (?, ?)';
    const count = (where: string, ...params: Array<string | number>): number =>
      (this.#db.prepare(`SELECT COUNT(*) AS n FROM records r WHERE ${current} AND ${where}`).get(shelf, GLOBAL_SHELF, ...params) as { n: number }).n;
    return {
      total: count('1 = 1'),
      stale: count('COALESCE(r.last_used_at, r.created_at) < ?', now - 90 * DAY),
      waiting: count("r.kind IN ('fact', 'decision') AND r.trust IN ('proposed', 'unconfirmed')"),
      orphans: count('r.reads = 0 AND r.created_at < ? AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_id = r.id OR l.to_id = r.id)', now - 30 * DAY),
      unused: count('r.reads = 0 AND r.created_at < ?', now - 30 * DAY),
      lessons: count("r.kind = 'lesson' AND r.trust != 'confirmed' AND r.created_at < ?", now - 14 * DAY),
    };
  }

  // ---- Brain screens (B5) ----------------------------------------------------------------------

  /**
   * The graph view (01-D13): the records that match, most important first, and the links among them.
   * Edges come only from the links table (real connections), never from similarity.
   */
  graph(opts: GraphOptions, now = this.#now()): Graph {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.shelf !== undefined) {
      if (opts.shelf === GLOBAL_SHELF) where.push('r.shelf = ?');
      else where.push('r.shelf IN (?, ?)');
      params.push(...(opts.shelf === GLOBAL_SHELF ? [GLOBAL_SHELF] : [opts.shelf, GLOBAL_SHELF]));
    }
    if (!opts.includeArchived) where.push('r.archived = 0 AND r.valid_to IS NULL');
    if (opts.kinds?.length) {
      where.push(`r.kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      params.push(...opts.kinds);
    }
    if (opts.since !== undefined) {
      where.push('r.updated_at >= ?');
      params.push(opts.since);
    }
    const rows = this.#db
      .prepare(`SELECT ${HIT_COLUMNS} FROM records r ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
      .all(...params) as unknown as HitRow[];
    const ranked = rows
      .map((r) => ({ r, importance: importanceOf(r, now) }))
      .sort((x, y) => y.importance - x.importance || y.r.updated_at - x.r.updated_at || (x.r.id < y.r.id ? -1 : 1));
    const limit = Math.max(1, Math.floor(opts.limit));
    const chosen = ranked.slice(0, limit);
    const ids = new Set(chosen.map((c) => c.r.id));
    const edges: Graph['edges'] = [];
    if (ids.size) {
      // Links touching the chosen nodes, in chunks (SQLite parameter limits); kept only when both ends are in.
      const list = [...ids];
      const seen = new Set<string>();
      for (let i = 0; i < list.length; i += 400) {
        const chunk = list.slice(i, i + 400);
        const marks = chunk.map(() => '?').join(', ');
        const links = this.#db
          .prepare(`SELECT from_id, to_id, rel FROM links WHERE from_id IN (${marks}) ORDER BY created_at, rowid`)
          .all(...chunk) as Array<{ from_id: string; to_id: string; rel: string }>;
        for (const l of links) {
          const key = `${l.from_id}\u0000${l.to_id}\u0000${l.rel}`;
          if (!ids.has(l.to_id) || seen.has(key)) continue;
          seen.add(key);
          edges.push({ from: l.from_id, to: l.to_id, rel: l.rel });
        }
      }
    }
    return {
      nodes: chosen.map(({ r, importance: imp }) => ({
        id: r.id,
        kind: r.kind as RecordKind,
        title: r.title,
        trust: r.trust as Trust,
        shelf: r.shelf,
        archived: r.archived === 1 || r.valid_to !== null,
        importance: imp,
        updatedAt: r.updated_at,
      })),
      edges,
      hidden: ranked.length - chosen.length,
    };
  }

  /**
   * Dashboard numbers (01-D13 phase 2) for a shelf. A project shelf includes the global one, like search
   * and the health score. Weekly `reads` come from the per-card read log (record_reads): reads made for a
   * card attempt. Reads without a card (e.g. the Queen's lookups) only raise each record's total, so they
   * can't be placed in a week and are not in these bars.
   */
  dashboard(shelf: string, now = this.#now()): Dashboard {
    const shelves = shelf === GLOBAL_SHELF ? [GLOBAL_SHELF] : [shelf, GLOBAL_SHELF];
    const on = `r.shelf IN (${shelves.map(() => '?').join(', ')})`;
    const current = 'r.archived = 0 AND r.valid_to IS NULL';
    const one = (sql: string, ...extra: Array<string | number>): number => (this.#db.prepare(sql).get(...shelves, ...extra) as { n: number }).n;

    const totals = {
      records: one(`SELECT COUNT(*) AS n FROM records r WHERE ${on}`),
      archived: one(`SELECT COUNT(*) AS n FROM records r WHERE ${on} AND r.archived = 1`),
      confirmed: one(`SELECT COUNT(*) AS n FROM records r WHERE ${on} AND ${current} AND r.trust = 'confirmed'`),
      links: one(
        `SELECT COUNT(*) AS n FROM links l WHERE EXISTS (SELECT 1 FROM records r WHERE ${on} AND (r.id = l.from_id OR r.id = l.to_id))`,
      ),
    };
    const byKind = (
      this.#db.prepare(`SELECT r.kind AS kind, COUNT(*) AS n FROM records r WHERE ${on} AND ${current} GROUP BY r.kind ORDER BY n DESC, r.kind`).all(...shelves) as Array<{
        kind: string;
        n: number;
      }>
    ).map((k) => ({ kind: k.kind as RecordKind, count: k.n }));

    const WEEK = 7 * DAY;
    const weeks: Dashboard['weeks'] = [];
    for (let i = 7; i >= 0; i--) {
      const start = now - (i + 1) * WEEK;
      // The newest bucket includes "now" itself.
      const end = i === 0 ? now + 1 : now - i * WEEK;
      weeks.push({
        weekStart: start,
        added: one(`SELECT COUNT(*) AS n FROM records r WHERE ${on} AND r.created_at >= ? AND r.created_at < ?`, start, end),
        reads: one(`SELECT COUNT(*) AS n FROM record_reads x JOIN records r ON r.id = x.record_id WHERE ${on} AND x.at >= ? AND x.at < ?`, start, end),
      });
    }

    const mostUsed = (this.#db.prepare(`SELECT ${HIT_COLUMNS} FROM records r WHERE ${on} AND ${current}`).all(...shelves) as unknown as HitRow[])
      .map((r) => ({ id: r.id, kind: r.kind as RecordKind, title: r.title, reads: r.reads, helped: r.helped, importance: importanceOf(r, now) }))
      .sort((a, b) => b.importance - a.importance || b.reads - a.reads || (a.id < b.id ? -1 : 1))
      .slice(0, 5);

    const timeline = (
      this.#db
        .prepare(
          `SELECT v.record_id AS id, r.kind AS kind, v.title AS title, v.version AS version, v.change AS change, v.changed_by AS changed_by, v.changed_at AS changed_at
           FROM record_versions v JOIN records r ON r.id = v.record_id
           WHERE ${on} ORDER BY v.changed_at DESC, v.rowid DESC LIMIT 30`,
        )
        .all(...shelves) as Array<{ id: string; kind: string; title: string; version: number; change: string; changed_by: string; changed_at: number }>
    ).map((t) => ({ id: t.id, kind: t.kind as RecordKind, title: t.title, version: t.version, change: t.change, changedBy: t.changed_by, changedAt: t.changed_at }));

    return { shelf, totals, byKind, weeks, mostUsed, timeline };
  }

  // ---- internals -------------------------------------------------------------------------------

  #initialTrust(input: WriteInput, actor: Actor): Trust {
    if (actor.type === 'user') return input.trust ?? 'confirmed';
    // An agent may always write at a lower trust than the default (e.g. the Scout's survey, C2).
    if (!NEEDS_CONFIRMATION.has(input.kind)) return input.trust && input.trust !== 'confirmed' ? input.trust : 'confirmed';
    if (input.trust === 'confirmed') throw new TrustError(`Only the user can confirm a ${input.kind}.`);
    return input.trust ?? (input.kind === 'decision' ? 'proposed' : 'unconfirmed');
  }

  #assertAgentMayChange(cur: BrainRecord, actor: Actor): void {
    if (actor.type === 'agent' && cur.trust === 'confirmed' && NEEDS_CONFIRMATION.has(cur.kind)) {
      throw new ConflictError(`${cur.id} was confirmed by the user; propose a change instead of editing it.`);
    }
  }

  /**
   * What the user owns or confirmed: anything the user wrote (owner "user", which includes the hive's own
   * outcome notes), and any fact or decision the user confirmed. Agents never merge away, supersede or fade these.
   */
  #userConfirmed(r: BrainRecord): boolean {
    return r.owner === 'user' || (r.trust === 'confirmed' && NEEDS_CONFIRMATION.has(r.kind));
  }

  #assertSupersedable(old: BrainRecord, shelf: string): void {
    if (old.shelf !== shelf) throw new ConflictError(`${old.id} is on the ${old.shelf} shelf; a record can only supersede one on its own shelf.`);
    if (old.archived) throw new ConflictError(`${old.id} is archived.`);
    if (old.validTo !== null) throw new ConflictError(`${old.id} was already superseded by ${old.supersededBy ?? 'another record'}.`);
  }

  /** The best near-duplicate of `input` among current records of the same shelf and kind, if any (01-E5). */
  #nearDuplicate(input: WriteInput): BrainRecord | undefined {
    const rows = this.#db
      .prepare(
        `SELECT * FROM records WHERE shelf = ? AND kind = ? AND archived = 0 AND valid_to IS NULL ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(input.shelf, input.kind, NEAR_DUPLICATE.candidates) as unknown as RecordRow[];
    if (!rows.length) return undefined;
    const text = clip(`${input.title}\n${input.body}`, NEAR_DUPLICATE.textChars);
    const numbers = numbersIn(`${input.title} ${input.body}`);
    const vectors = new Map<string, Float32Array>();
    if (input.vector) {
      const stmt = this.#db.prepare(
        `SELECT v.record_id, v.vec FROM record_vectors v JOIN records r ON r.id = v.record_id
         WHERE v.model = ? AND v.content_hash = r.content_hash AND r.shelf = ? AND r.kind = ?`,
      );
      for (const v of stmt.all(input.vector.model, input.shelf, input.kind) as Array<{ record_id: string; vec: Uint8Array }>) {
        vectors.set(v.record_id, unpackI8(v.vec));
      }
    }
    let best: { row: RecordRow; sim: number } | undefined;
    for (const row of rows) {
      if (numbersIn(`${row.title} ${row.body}`) !== numbers) continue;
      const theirs = vectors.get(row.id);
      const sim =
        input.vector && theirs
          ? cosine(input.vector.vector, theirs)
          : trigramJaccard(text, clip(`${row.title}\n${row.body}`, NEAR_DUPLICATE.textChars));
      const enough = input.vector && theirs ? sim >= NEAR_DUPLICATE.cosine : sim >= NEAR_DUPLICATE.jaccard;
      if (enough && (!best || sim > best.sim)) best = { row, sim };
    }
    return best ? toRecord(best.row, this.#now()) : undefined;
  }

  /**
   * Fold an agent's near-duplicate into an agent record: the incoming text is kept as an archived record
   * ("merged into …", linked merged_into), and the existing record takes it as a new version.
   */
  #foldInto(dup: BrainRecord, input: WriteInput, trust: Trust, hash: string, actor: Actor): void {
    const at = this.#now();
    this.#insert(input, trust, hash, actor, true, `merged into ${dup.id}`, dup.id);
    const version = dup.version + 1;
    const nextHash = this.#hash(dup.kind, input.title, input.body);
    this.#db
      .prepare('UPDATE records SET title = ?, body = ?, summary = ?, content_hash = ?, version = ?, updated_at = ? WHERE id = ?')
      .run(input.title, input.body, input.summary ?? dup.summary, nextHash, version, at, dup.id);
    this.#addVersion(dup.id, version, 'merge', input.title, input.body, input.summary ?? dup.summary, dup.trust, actor, at);
    if (input.vector) this.#storeVector(dup.id, input.vector.model, input.vector.vector, nextHash);
  }

  /** Inserts a record (archived when folded into another one). Returns its id. */
  #insert(input: WriteInput, trust: Trust, hash: string, actor: Actor, archived: boolean, archivedReason: string | null, mergedInto?: string): string {
    const id = this.#newId();
    const at = this.#now();
    // A folded-in duplicate never enters the exact-duplicate index of current records: give it its own hash.
    const contentHash = archived ? `${hash}:merged:${id}` : hash;
    this.#db
      .prepare(
        `INSERT INTO records (id, kind, shelf, owner, title, body, summary, trust, source, confidence, content_hash, version,
           archived, archived_reason, valid_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, input.shelf, actorName(actor), input.title, input.body, input.summary ?? null, trust,
        input.source ?? null, input.confidence ?? null, contentHash, archived ? 1 : 0, archivedReason, at, at, at);
    this.#addVersion(id, 1, 'create', input.title, input.body, input.summary ?? null, trust, actor, at);
    if (mergedInto) {
      this.#db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?)').run(id, mergedInto, 'merged_into', at);
    }
    return id;
  }

  #markSuperseded(old: BrainRecord, newId: string, actor: Actor): void {
    const at = this.#now();
    const version = old.version + 1;
    this.#db.prepare('UPDATE records SET valid_to = ?, superseded_by = ?, version = ?, updated_at = ? WHERE id = ?').run(at, newId, version, at, old.id);
    this.#addVersion(old.id, version, 'supersede', old.title, old.body, old.summary, old.trust, actor, at);
    this.#db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, rel, created_at) VALUES (?, ?, ?, ?)').run(newId, old.id, 'supersedes', at);
  }

  #archiveRow(cur: BrainRecord, actor: Actor, reason: string, at = this.#now()): void {
    const version = cur.version + 1;
    this.#db.prepare('UPDATE records SET archived = 1, archived_reason = ?, version = ?, updated_at = ? WHERE id = ?').run(reason, version, at, cur.id);
    this.#addVersion(cur.id, version, 'archive', cur.title, cur.body, cur.summary, cur.trust, actor, at);
  }

  #storeVector(id: string, model: string, vector: Float32Array, contentHash: string): void {
    this.#db
      .prepare(
        `INSERT INTO record_vectors (record_id, model, dim, vec, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (record_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
      )
      .run(id, model, vector.length, packI8(vector), contentHash, this.#now());
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
