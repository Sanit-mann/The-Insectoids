/**
 * The code map builder (Memory 01-E3, D6; Phase 2 B4), in the Brain host (the Brain's single writer).
 *
 * It only READS the project: the file list comes from `git ls-files` (tracked files plus untracked ones
 * that .gitignore does not exclude), each file is read from disk, parsed with tree-sitter (no AI) and its
 * symbols, imports and calls are stored on the project's shelf. Files are compared by content hash, so a
 * refresh re-reads only what changed and forgets deleted files. Work is done file by file with yields,
 * so the hive and the Brain service never wait on it; a file that fails is counted and logged, never fatal.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Brain, CodeFileInput } from '@insectoids/brain';
import { CodeParser, languageOf, resolveImport } from '@insectoids/codemap';
import type { CodeLookupResult, CodeMapView } from '@insectoids/shared';

const run = promisify(execFile);

/** Bigger files are skipped (generated bundles, data dumps). */
export const MAX_FILE_BYTES = 512 * 1024;
/** Bumped when extraction changes, so every file is read again once. */
const EXTRACT_VERSION = 'codemap-1';
/** Yield to the event loop after this much work. */
const SLICE_MS = 12;
const REFRESH_EVERY_MS = 10 * 60_000;

export const codeMapOffView = (message = 'The code map starts when a project is open.'): CodeMapView => ({
  state: 'off',
  files: 0,
  symbols: 0,
  languages: [],
  skipped: 0,
  lastBuiltAt: null,
  progress: null,
  message,
});

export interface CodeMapBuilderOptions {
  brain: Brain;
  /** @vscode/tree-sitter-wasm's wasm folder. Default: resolved from the installed package (dev and tests). */
  wasmDir?: string;
  /** Called when the view changes (start, progress, done). */
  onChange: () => void;
  /** True when the hive is idle: the periodic refresh waits for it. */
  idle?: () => boolean;
  /** Periodic refresh while idle. Default 10 minutes; 0 turns it off. */
  refreshEveryMs?: number;
  log?: (line: string) => void;
}

interface Target {
  root: string;
  shelf: string;
}

export interface BuildReport {
  files: number;
  parsed: number;
  unchanged: number;
  removed: number;
  skipped: number;
  errors: number;
  ms: number;
}

export class CodeMapBuilder {
  readonly #o: CodeMapBuilderOptions;
  #target: Target | null = null;
  #parser: Promise<CodeParser> | null = null;
  #state: CodeMapView['state'] = 'off';
  #progress: CodeMapView['progress'] = null;
  #error: string | null = null;
  #last: BuildReport | null = null;
  /** Bumped on every project switch and on dispose: a running build for an older generation stops. */
  #gen = 0;
  #running: Promise<void> | null = null;
  #again: { force: boolean } | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastChange = 0;

  constructor(o: CodeMapBuilderOptions) {
    this.#o = o;
    const every = o.refreshEveryMs ?? REFRESH_EVERY_MS;
    if (every > 0) {
      this.#timer = setInterval(() => {
        if (this.#target && !this.#running && (this.#o.idle?.() ?? true)) void this.refresh();
      }, every);
      this.#timer.unref?.();
    }
  }

  /** The project to map (null: none). Starts a refresh in the background. */
  setProject(root: string | null, shelf: string | null): void {
    this.#gen++;
    this.#again = null;
    this.#target = root && shelf ? { root, shelf } : null;
    this.#progress = null;
    this.#error = null;
    this.#last = null;
    this.#state = this.#target ? 'building' : 'off';
    this.#running = null;
    if (this.#target) void this.refresh();
    else this.#o.onChange();
  }

  /**
   * Bring the map up to date. Unchanged files are skipped unless `force` (the user's rebuild). A refresh
   * asked for while one runs is queued once. Resolves when the map is up to date (never rejects).
   */
  refresh(o: { force?: boolean } = {}): Promise<void> {
    if (!this.#target) return Promise.resolve();
    if (this.#running) {
      this.#again = { force: (this.#again?.force ?? false) || !!o.force };
      return this.#running;
    }
    const gen = this.#gen;
    const work = (async () => {
      let force = !!o.force;
      for (;;) {
        await this.#build(gen, force);
        if (gen !== this.#gen || !this.#again) break;
        force = this.#again.force;
        this.#again = null;
      }
    })().finally(() => {
      if (gen === this.#gen) this.#running = null;
    });
    this.#running = work;
    return work;
  }

  /** Resolves when the current refresh (if any) is done, without asking for another. */
  settled(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  view(): CodeMapView {
    const t = this.#target;
    if (!t) return codeMapOffView();
    const s = this.#o.brain.code.stats(t.shelf);
    const base = { files: s.files, symbols: s.symbols, languages: s.languages, skipped: s.skipped, lastBuiltAt: s.lastBuiltAt };
    if (this.#state === 'error') return { ...base, state: 'error', progress: null, message: `The code map could not be built: ${this.#error ?? 'unknown error'}` };
    if (this.#state === 'building') {
      const p = this.#progress;
      return { ...base, state: 'building', progress: p, message: p ? `Mapping code: ${p.done} of ${p.total} files.` : 'Listing the project files…' };
    }
    const errors = this.#last?.errors ? ` ${this.#last.errors} file(s) could not be read.` : '';
    const skipped = s.skipped ? ` (${s.skipped} other file(s) skipped)` : '';
    return { ...base, state: 'ready', progress: null, message: `${s.files} files and ${s.symbols} symbols mapped${skipped}.${errors}` };
  }

  /** The last finished build (timings and counts), for logs and tests. */
  get lastReport(): BuildReport | null {
    return this.#last;
  }

  lookup(req: { query: string; mode: 'symbol' | 'file' | 'callers' | 'callees' }): CodeLookupResult {
    const t = this.#target;
    if (!t) return { hits: [], imports: [], truncated: false, message: 'Pick a project folder first.' };
    const code = this.#o.brain.code;
    const r =
      req.mode === 'file'
        ? code.outline(t.shelf, req.query)
        : req.mode === 'callers'
          ? code.callers(t.shelf, req.query)
          : req.mode === 'callees'
            ? code.callees(t.shelf, req.query)
            : code.findSymbols(t.shelf, req.query);
    if (this.#state === 'building' && !r.hits.length) return { ...r, message: `${r.message} The code map is still being built.` };
    return r;
  }

  async dispose(): Promise<void> {
    this.#gen++;
    this.#target = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const running = this.#running;
    this.#running = null;
    await running?.catch(() => {});
    const p = this.#parser;
    this.#parser = null;
    if (p) await p.then((x) => x.dispose(), () => {});
  }

  // ---- building ------------------------------------------------------------------------------------

  #parserOnce(): Promise<CodeParser> {
    this.#parser ??= CodeParser.create(this.#o.wasmDir ? { wasmDir: this.#o.wasmDir } : {});
    // A failed start may be retried by the next refresh.
    this.#parser.catch(() => (this.#parser = null));
    return this.#parser;
  }

  #notify(force = false): void {
    const now = Date.now();
    if (!force && now - this.#lastChange < 250) return;
    this.#lastChange = now;
    this.#o.onChange();
  }

  async #build(gen: number, force: boolean): Promise<void> {
    const t = this.#target;
    if (!t) return;
    const started = Date.now();
    const stale = (): boolean => gen !== this.#gen;
    this.#state = 'building';
    this.#progress = null;
    this.#notify(true);
    try {
      const parser = await this.#parserOnce();
      const listed = await listProjectFiles(t.root);
      if (stale()) return;
      const candidates = listed.filter((p) => languageOf(p) !== null);
      const known = new Set(candidates);
      const hashes = this.#o.brain.code.hashes(t.shelf);
      const report: BuildReport = { files: 0, parsed: 0, unchanged: 0, removed: 0, skipped: listed.length - candidates.length, errors: 0, ms: 0 };
      const present = new Set<string>();
      this.#progress = { done: 0, total: candidates.length };
      let slice = Date.now();
      for (const path of candidates) {
        if (stale()) return;
        try {
          const r = await this.#mapFile(parser, t, path, known, force ? undefined : hashes.get(path));
          if (r === 'missing') continue;
          if (r === 'skipped') report.skipped++;
          else {
            present.add(path);
            report.files++;
            if (r === 'unchanged') report.unchanged++;
            else report.parsed++;
          }
        } catch (err) {
          // Keep the old map of a file that fails to read or parse; count it and go on.
          if (hashes.has(path)) present.add(path);
          report.errors++;
          this.#o.log?.(`[code-map] ${path}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.#progress = { done: this.#progress.done + 1, total: candidates.length };
        }
        if (Date.now() - slice > SLICE_MS) {
          await new Promise<void>((r) => setImmediate(r));
          slice = Date.now();
          this.#notify();
        }
      }
      if (stale()) return;
      const gone = [...hashes.keys()].filter((p) => !present.has(p));
      this.#o.brain.code.removeFiles(t.shelf, gone);
      report.removed = gone.length;
      this.#o.brain.code.setBuilt(t.shelf, { skipped: report.skipped });
      report.ms = Date.now() - started;
      this.#last = report;
      this.#state = 'ready';
      this.#progress = null;
      this.#o.log?.(
        `[code-map] ${t.shelf}: ${report.files} files (${report.parsed} read, ${report.unchanged} unchanged, ${report.removed} removed, ${report.skipped} skipped, ${report.errors} errors) in ${report.ms} ms`,
      );
    } catch (err) {
      if (stale()) return;
      this.#state = 'error';
      this.#progress = null;
      this.#error = err instanceof Error ? err.message : String(err);
      this.#o.log?.(`[code-map] build failed: ${this.#error}`);
    } finally {
      if (!stale()) this.#notify(true);
    }
  }

  async #mapFile(parser: CodeParser, t: Target, path: string, known: ReadonlySet<string>, oldHash: string | undefined): Promise<'missing' | 'skipped' | 'unchanged' | 'parsed'> {
    const abs = join(t.root, path);
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return 'missing'; // listed by git but deleted from the working tree
    }
    // Symlinks could point outside the project: never followed.
    if (!st.isFile()) return 'skipped';
    if (st.size > MAX_FILE_BYTES) return 'skipped';
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return 'skipped';
    const hash = createHash('sha1').update(EXTRACT_VERSION).update('\0').update(buf).digest('hex');
    if (hash === oldHash) return 'unchanged';
    const source = buf.toString('utf8').replace(/^\uFEFF/, '');
    const map = await parser.parse(path, source);
    if (!map) return 'skipped';
    const local = new Set(map.symbols.map((s) => s.name));
    const input: CodeFileInput = {
      path,
      language: map.language,
      contentHash: hash,
      size: st.size,
      imports: map.imports,
      symbols: map.symbols,
      edges: map.calls.map((c) => ({
        from: c.from,
        callee: c.callee,
        line: c.line,
        toPath: c.module ? resolveImport(path, c.module, known) : local.has(c.callee) ? path : null,
      })),
    };
    this.#o.brain.code.putFile(t.shelf, input);
    return 'parsed';
  }
}

/** Project files as git sees them: tracked, plus untracked ones .gitignore does not exclude. No shell. */
export async function listProjectFiles(root: string): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(stdout.split('\0').filter(Boolean))];
}
