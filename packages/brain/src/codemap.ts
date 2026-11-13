import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db';

/**
 * The code map's storage (Memory 01-E3, D6; Phase 2 B4): per project shelf, every mapped file (with its
 * content hash, so only changed files are re-read), its symbols, and its calls. Written only by the Brain
 * host (single writer); read by agents through `brain_code` and by the app.
 */
export type CodeSymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable' | 'module';

export interface CodeFileInput {
  /** Relative to the project root, forward slashes. */
  path: string;
  language: string;
  contentHash: string;
  size: number;
  imports: string[];
  symbols: Array<{ name: string; qualified: string; kind: CodeSymbolKind; line: number; endLine: number; signature: string; doc: string | null; parent: string | null }>;
  /** `from` = the caller's qualified name ("" at module level); `toPath` = the file it resolved to, if known. */
  edges: Array<{ from: string; callee: string; toPath: string | null; line: number }>;
}

export interface CodeHit {
  path: string;
  name: string;
  kind: CodeSymbolKind;
  line: number;
  endLine: number;
  signature: string;
  doc: string | null;
  parent: string | null;
}

export interface CodeLookup {
  hits: CodeHit[];
  imports: string[];
  truncated: boolean;
  message: string;
}

export interface CodeMapStats {
  files: number;
  symbols: number;
  languages: Array<{ language: string; files: number }>;
  skipped: number;
  lastBuiltAt: number | null;
}

interface SymbolRow {
  path: string;
  name: string;
  qualified: string;
  kind: string;
  line: number;
  end_line: number;
  signature: string;
  doc: string | null;
  parent: string | null;
}

const toHit = (r: SymbolRow): CodeHit => ({
  path: r.path,
  name: r.name,
  kind: r.kind as CodeSymbolKind,
  line: r.line,
  endLine: r.end_line,
  signature: r.signature,
  doc: r.doc,
  parent: r.parent,
});

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export class CodeMapStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  /** path -> content hash of every mapped file on the shelf (to skip unchanged files). */
  hashes(shelf: string): Map<string, string> {
    const rows = this.db.prepare('SELECT path, content_hash FROM code_files WHERE shelf = ?').all(shelf) as Array<{ path: string; content_hash: string }>;
    return new Map(rows.map((r) => [r.path, r.content_hash]));
  }

  /** Replace one file's map (all or nothing). */
  putFile(shelf: string, f: CodeFileInput): void {
    transaction(this.db, () => {
      this.#delete(shelf, [f.path]);
      this.db
        .prepare('INSERT INTO code_files (shelf, path, language, content_hash, size, imports, parsed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(shelf, f.path, f.language, f.contentHash, f.size, JSON.stringify(f.imports), this.now());
      const sym = this.db.prepare(
        'INSERT INTO code_symbols (shelf, path, name, qualified, kind, line, end_line, signature, doc, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const s of f.symbols) sym.run(shelf, f.path, s.name, s.qualified, s.kind, s.line, s.endLine, s.signature, s.doc, s.parent);
      const edge = this.db.prepare('INSERT INTO code_edges (shelf, from_path, from_symbol, callee, to_path, line) VALUES (?, ?, ?, ?, ?, ?)');
      for (const e of f.edges) edge.run(shelf, f.path, e.from, e.callee, e.toPath, e.line);
    });
  }

  /** Forget files that are no longer in the project. */
  removeFiles(shelf: string, paths: string[]): void {
    if (!paths.length) return;
    transaction(this.db, () => this.#delete(shelf, paths));
  }

  setBuilt(shelf: string, o: { skipped: number; at?: number }): void {
    this.db
      .prepare(
        `INSERT INTO code_map_state (shelf, last_built_at, skipped) VALUES (?, ?, ?)
         ON CONFLICT(shelf) DO UPDATE SET last_built_at = excluded.last_built_at, skipped = excluded.skipped`,
      )
      .run(shelf, o.at ?? this.now(), o.skipped);
  }

  stats(shelf: string): CodeMapStats {
    const files = (this.db.prepare('SELECT COUNT(*) AS n FROM code_files WHERE shelf = ?').get(shelf) as { n: number }).n;
    const symbols = (this.db.prepare('SELECT COUNT(*) AS n FROM code_symbols WHERE shelf = ?').get(shelf) as { n: number }).n;
    const languages = this.db
      .prepare('SELECT language, COUNT(*) AS files FROM code_files WHERE shelf = ? GROUP BY language ORDER BY files DESC, language')
      .all(shelf) as Array<{ language: string; files: number }>;
    const state = this.db.prepare('SELECT last_built_at, skipped FROM code_map_state WHERE shelf = ?').get(shelf) as
      | { last_built_at: number | null; skipped: number }
      | undefined;
    return { files, symbols, languages, skipped: state?.skipped ?? 0, lastBuiltAt: state?.last_built_at ?? null };
  }

  /**
   * Symbols by name, case-insensitive: exact name or qualified name first, then prefix, then contains.
   * `Class.method` matches the qualified name.
   */
  findSymbols(shelf: string, query: string, limit = DEFAULT_LIMIT): CodeLookup {
    const q = query.trim();
    const n = Math.min(Math.max(1, limit), MAX_LIMIT);
    const like = likeEscape(q);
    const rows = this.db
      .prepare(
        `SELECT path, name, qualified, kind, line, end_line, signature, doc, parent,
                CASE WHEN name = ? COLLATE NOCASE OR qualified = ? COLLATE NOCASE THEN 0
                     WHEN name LIKE ? ESCAPE '\\' OR qualified LIKE ? ESCAPE '\\' THEN 1
                     ELSE 2 END AS rank
         FROM code_symbols
         WHERE shelf = ? AND (name LIKE ? ESCAPE '\\' OR qualified LIKE ? ESCAPE '\\')
         ORDER BY rank, length(name), path, line
         LIMIT ?`,
      )
      .all(q, q, `${like}%`, `${like}%`, shelf, `%${like}%`, `%${like}%`, n + 1) as unknown as SymbolRow[];
    const truncated = rows.length > n;
    const hits = rows.slice(0, n).map(toHit);
    return { hits, imports: [], truncated, message: hits.length ? `${hits.length} symbol(s) match "${q}".` : `No symbol matches "${q}".` };
  }

  /** A file's outline (symbols in order) and its imports. Accepts the full path or a unique ending ("text.ts"). */
  outline(shelf: string, query: string): CodeLookup {
    const q = query.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const exact = this.db.prepare('SELECT path, imports FROM code_files WHERE shelf = ? AND path = ?').get(shelf, q) as
      | { path: string; imports: string }
      | undefined;
    let file = exact;
    let note = '';
    if (!file) {
      const matches = this.db
        .prepare(`SELECT path, imports FROM code_files WHERE shelf = ? AND (path LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') ORDER BY length(path), path LIMIT 6`)
        .all(shelf, `%/${likeEscape(q)}`, likeEscape(q)) as Array<{ path: string; imports: string }>;
      file = matches[0];
      if (matches.length > 1) note = ` Other files also end in "${q}": ${matches.slice(1).map((m) => m.path).join(', ')}.`;
    }
    if (!file) return { hits: [], imports: [], truncated: false, message: `No mapped file "${q}".` };
    const rows = this.db.prepare('SELECT * FROM code_symbols WHERE shelf = ? AND path = ? ORDER BY line').all(shelf, file.path) as unknown as SymbolRow[];
    return {
      hits: rows.map(toHit),
      imports: JSON.parse(file.imports) as string[],
      truncated: false,
      message: `${file.path}: ${rows.length} symbol(s).${note}`,
    };
  }

  /** Who calls the named symbol(s): calls resolved to its file, or unresolved calls of the same name. */
  callers(shelf: string, query: string, limit = DEFAULT_LIMIT): CodeLookup {
    const targets = this.#targets(shelf, query);
    if (!targets.length) return { hits: [], imports: [], truncated: false, message: `No symbol named "${query.trim()}".` };
    const n = Math.min(Math.max(1, limit), MAX_LIMIT);
    const seen = new Set<string>();
    const hits: CodeHit[] = [];
    let truncated = false;
    for (const t of targets) {
      const edges = this.db
        .prepare(
          `SELECT from_path, from_symbol, line FROM code_edges
           WHERE shelf = ? AND callee = ? COLLATE NOCASE AND (to_path = ? OR to_path IS NULL)
           ORDER BY from_path, line`,
        )
        .all(shelf, t.name, t.path) as Array<{ from_path: string; from_symbol: string; line: number }>;
      for (const e of edges) {
        const key = `${e.from_path}#${e.from_symbol || `@${e.line}`}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (hits.length >= n) {
          truncated = true;
          break;
        }
        hits.push(this.#symbolAt(shelf, e.from_path, e.from_symbol, e.line));
      }
    }
    const what = targets.length === 1 ? `${targets[0]!.qualified} (${targets[0]!.path})` : `${targets.length} symbols named "${query.trim()}"`;
    return { hits, imports: [], truncated, message: hits.length ? `${hits.length} caller(s) of ${what}.` : `Nothing in the map calls ${what}.` };
  }

  /** What the named symbol(s) call, among the project's own symbols (library calls are counted, not listed). */
  callees(shelf: string, query: string, limit = DEFAULT_LIMIT): CodeLookup {
    const targets = this.#targets(shelf, query);
    if (!targets.length) return { hits: [], imports: [], truncated: false, message: `No symbol named "${query.trim()}".` };
    const n = Math.min(Math.max(1, limit), MAX_LIMIT);
    const seen = new Set<string>();
    const hits: CodeHit[] = [];
    let outside = 0;
    let truncated = false;
    for (const t of targets) {
      const edges = this.db
        .prepare('SELECT callee, to_path FROM code_edges WHERE shelf = ? AND from_path = ? AND from_symbol = ? ORDER BY line')
        .all(shelf, t.path, t.qualified) as Array<{ callee: string; to_path: string | null }>;
      for (const e of edges) {
        const where = e.to_path ?? t.path;
        let row = this.db
          .prepare('SELECT * FROM code_symbols WHERE shelf = ? AND path = ? AND name = ? ORDER BY line LIMIT 1')
          .get(shelf, where, e.callee) as unknown as SymbolRow | undefined;
        if (!row && !e.to_path) {
          // Not imported and not in this file: use it only when exactly one project symbol has that name.
          const any = this.db.prepare('SELECT * FROM code_symbols WHERE shelf = ? AND name = ? LIMIT 2').all(shelf, e.callee) as unknown as SymbolRow[];
          if (any.length === 1) row = any[0];
        }
        if (!row) {
          outside++;
          continue;
        }
        const key = `${row.path}#${row.qualified}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (hits.length >= n) {
          truncated = true;
          break;
        }
        hits.push(toHit(row));
      }
    }
    const extra = outside ? ` ${outside} call(s) go to libraries or code outside the map.` : '';
    return { hits, imports: [], truncated, message: `${hits.length} project symbol(s) called.${extra}` };
  }

  /** Symbols a callers/callees query is about: by qualified name, else by exact name (case-insensitive). */
  #targets(shelf: string, query: string): SymbolRow[] {
    const q = query.trim();
    const byQualified = this.db
      .prepare('SELECT * FROM code_symbols WHERE shelf = ? AND qualified = ? COLLATE NOCASE ORDER BY path, line LIMIT 10')
      .all(shelf, q) as unknown as SymbolRow[];
    if (byQualified.length) return byQualified;
    return this.db.prepare('SELECT * FROM code_symbols WHERE shelf = ? AND name = ? COLLATE NOCASE ORDER BY path, line LIMIT 10').all(shelf, q) as unknown as SymbolRow[];
  }

  /** The caller symbol for an edge, or a module-level placeholder when the call is outside any symbol. */
  #symbolAt(shelf: string, path: string, qualified: string, line: number): CodeHit {
    if (qualified) {
      const row = this.db.prepare('SELECT * FROM code_symbols WHERE shelf = ? AND path = ? AND qualified = ? LIMIT 1').get(shelf, path, qualified) as unknown as
        | SymbolRow
        | undefined;
      if (row) return toHit(row);
    }
    return { path, name: '(module)', kind: 'module', line, endLine: line, signature: '(top level of the file)', doc: null, parent: null };
  }

  #delete(shelf: string, paths: string[]): void {
    for (const table of ['code_symbols', 'code_files']) {
      const stmt = this.db.prepare(`DELETE FROM ${table} WHERE shelf = ? AND path = ?`);
      for (const p of paths) stmt.run(shelf, p);
    }
    const edges = this.db.prepare('DELETE FROM code_edges WHERE shelf = ? AND from_path = ?');
    for (const p of paths) edges.run(shelf, p);
  }
}
