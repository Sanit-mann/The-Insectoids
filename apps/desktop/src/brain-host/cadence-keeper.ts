import { type FSWatcher, existsSync, statSync, watch } from 'node:fs';
import { basename, matchesGlob, relative, resolve, sep } from 'node:path';
import type { Brain, Cadence, CadenceRun, CadenceRunReason, Goal } from '@insectoids/brain';
import { dueCheck, nextRunAt, runReason, whenText } from '@insectoids/harness';
import {
  type CadenceFields,
  type CadenceInput,
  CadenceInputSchema,
  type CadenceRunView,
  type CadenceView,
  FILE_SETTLE_MS,
  type HiveEventTrigger,
  MAX_LISTED_FILES,
  isScheduled,
} from '@insectoids/shared';

/**
 * The scheduler (Cadence 05; Phase 3 A1). It lives in the Brain host next to the hive, so it keeps running with
 * the window closed. Every run is a normal goal for the Queen (05-D1): the keeper only decides *when*, and hands
 * the goal to the host's `submit`, which goes through the same path as the user's own goals.
 *
 * Only the open project's cadences run. A cadence whose time passed while it couldn't run (the app was closed,
 * its project wasn't open, the computer slept) runs once when it can ("catch up once", 05-D5). While the hive is
 * paused a due run is owed (`pending`) and runs once on resume. A run never piles up on the previous one.
 *
 * File and event cadences (A3) have no time: they wait for files to change in a project folder, or for something
 * in the hive (a goal finished, a goal used 75% of its budget). What happened goes into the run's goal under
 * "What triggered this run:". When one can't run yet (paused, or its last run is still going) it is owed once and
 * runs when it can, with everything that happened meanwhile. Loop guard: goals started by an event cadence never
 * trigger event cadences, and a cadence never triggers on its own goals.
 */
export interface CadenceKeeperDeps {
  brain: Brain;
  now: () => number;
  /** The open project's shelf, or null. */
  shelf: () => string | null;
  /** Why the hive can't start work now (paused by the user, the Watchdog or a limit), or null. */
  blocked: () => string | null;
  /**
   * Hands the goal to the Queen; resolves to the new goal's id (planning carries on in the background).
   * `trigger` (file and event cadences) is what happened, in words, added to the goal.
   */
  submit: (c: Cadence, reason: CadenceRunReason, trigger?: string) => Promise<string>;
  /** The open project's folder: file cadences watch inside it. */
  root?: () => string | null;
  /** Folders never watched, even inside the project (the app's own data). */
  ignore?: () => readonly string[];
  /** How long file changes settle before one run starts (tests pass a few ms). */
  settleMs?: number;
  /** One Queen activity line (02-D4). */
  note: (text: string) => void;
  changed: () => void;
  /** Milliseconds per interval "minute" (the e2e hook passes 1 000). */
  intervalUnitMs?: number;
  /** Longest wait between checks (a safety net for clock jumps and anything that unblocks the hive). */
  recheckMs?: number;
  log?: (line: string) => void;
}

const ACTIVE: ReadonlySet<Goal['status']> = new Set(['planning', 'awaiting_approval', 'running']);
const RECHECK_MS = 60_000;

const clockTime = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

interface Watch {
  /** root|folder|pattern: a changed cadence gets a new watcher. */
  key: string;
  watcher: FSWatcher;
  files: Set<string>;
  timer: NodeJS.Timeout | null;
  firstAt: number | null;
}

/** What happened while a file or event cadence couldn't run yet; it all goes into its next run. */
interface Owed {
  files: Set<string>;
  events: string[];
}

/** Names that are never watched anywhere in the project. */
const NEVER_WATCHED: ReadonlySet<string> = new Set(['.git', 'node_modules']);

export class CadenceKeeper {
  #timer: NodeJS.Timeout | null = null;
  readonly #watches = new Map<string, Watch>();
  /** File cadences whose folder is gone: one failed run was recorded; watching starts again when it is back. */
  readonly #gone = new Set<string>();
  readonly #owed = new Map<string, Owed>();
  /** File and event runs are handled one at a time, so two quick triggers never start two goals. */
  #queue: Promise<void> = Promise.resolve();
  #checking = false;
  #again = false;
  #stopped = false;
  /** Set by wake(): the next pass labels late runs as 'wake' instead of schedule or catch-up. */
  #afterWake = false;

  constructor(private readonly d: CadenceKeeperDeps) {}

  get #opts() {
    return this.d.intervalUnitMs ? { intervalUnitMs: this.d.intervalUnitMs } : {};
  }

  // ---- the user's commands ------------------------------------------------------------------------

  create(input: CadenceInput): Cadence {
    const shelf = this.#shelf();
    const c = this.#valid(CadenceInputSchema.parse(input), null);
    const made = this.d.brain.cadences.create({ ...c, shelf, nextRunAt: c.enabled ? nextRunAt(c.when, this.d.now(), this.#opts) : null });
    this.d.note(`New cadence "${made.name}": ${this.#words(made.when)}.`);
    this.arm();
    return made;
  }

  /** A changed schedule starts over from now (an owed run is kept). */
  update(id: string, input: CadenceInput): Cadence {
    this.#own(id);
    const c = this.#valid(CadenceInputSchema.parse(input), id);
    const made = this.d.brain.cadences.update(id, { ...c, nextRunAt: c.enabled ? nextRunAt(c.when, this.d.now(), this.#opts) : null });
    if (!c.enabled) this.d.brain.cadences.setPending(id, false);
    // An edit starts watching afresh (a gone folder is tried again); what was owed belonged to the old setup.
    this.#unwatch(id);
    this.#gone.delete(id);
    this.#owed.delete(id);
    this.arm();
    return made;
  }

  setEnabled(id: string, enabled: boolean): void {
    const c = this.#own(id);
    if (c.enabled === enabled) return;
    this.d.brain.cadences.setEnabled(id, enabled, enabled ? nextRunAt(c.when, this.d.now(), this.#opts) : null);
    if (!enabled) this.#owed.delete(id);
    const on = isScheduled(c.when) ? `next ${lowerFirst(this.#words(c.when))}` : `it runs ${lowerFirst(this.#words(c.when))}`;
    this.d.note(enabled ? `Cadence "${c.name}" is on: ${on}.` : `Cadence "${c.name}" is off; it won't run until you switch it on.`);
    this.arm();
  }

  delete(id: string): void {
    const c = this.#own(id);
    this.d.brain.cadences.delete(id);
    this.#unwatch(id);
    this.#gone.delete(id);
    this.#owed.delete(id);
    this.d.note(`Deleted the cadence "${c.name}" (its run history stays in the Brain).`);
    this.arm();
  }

  /** Run once now, outside the schedule. Refused (with the reason) when it can't start. */
  async runNow(id: string): Promise<void> {
    const c = this.#own(id);
    const blocked = this.d.blocked();
    if (blocked) throw new Error(`The hive can't start work now: ${blocked}`);
    const busy = this.#activeGoal(c.id);
    if (busy) throw new Error(`The last run of "${c.name}" is still going ("${busy.title}"). Wait for it to finish, or cancel it first.`);
    await this.#start(c, 'manual', '', isScheduled(c.when) ? undefined : 'You ran it now.');
  }

  // ---- views ---------------------------------------------------------------------------------------

  views(): CadenceView[] {
    const shelf = this.d.shelf();
    if (!shelf) return [];
    return this.d.brain.cadences.list(shelf).map((c) => {
      const last = this.d.brain.cadences.lastRun(c.id);
      return {
        id: c.id,
        name: c.name,
        when: c.when,
        whenText: this.#words(c.when),
        goal: c.goal,
        budgetTokens: c.budgetTokens,
        autonomy: c.autonomy,
        enabled: c.enabled,
        shelf: c.shelf,
        nextRunAt: c.enabled ? c.nextRunAt : null,
        pending: c.pending,
        lastRun: last ? runView(last) : null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  }

  runs(cadenceId: string, limit = 50): CadenceRunView[] {
    return this.d.brain.cadences.runs(cadenceId, limit).map(runView);
  }

  // ---- the clock -----------------------------------------------------------------------------------

  /** Re-arms the timer for the soonest due time (at most `recheckMs` away). Call after any change. */
  arm(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#syncWatches();
    const shelf = this.d.shelf();
    if (!shelf) return;
    const now = this.d.now();
    let wait = this.d.recheckMs ?? RECHECK_MS;
    for (const c of this.d.brain.cadences.list(shelf)) {
      if (!c.enabled) continue;
      if (c.pending) wait = Math.min(wait, this.d.recheckMs ?? RECHECK_MS);
      if (c.nextRunAt !== null) wait = Math.min(wait, Math.max(0, c.nextRunAt - now));
    }
    this.#timer = setTimeout(() => void this.check(), wait);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const id of [...this.#watches.keys()]) this.#unwatch(id);
  }

  /**
   * The computer woke from sleep (05-D5). Timers may have been held up while it slept (on some systems they
   * don't count sleep at all), so check now instead of waiting for the next re-check. Runs that came due while
   * it slept happen once, labelled "after waking up".
   */
  wake(): void {
    this.#afterWake = true;
    void this.check();
  }

  /** Runs whatever is due or owed on the open project, then re-arms. Safe to call any time. */
  async check(): Promise<void> {
    if (this.#stopped) return;
    if (this.#checking) {
      this.#again = true;
      return;
    }
    this.#checking = true;
    try {
      do {
        this.#again = false;
        await this.#checkOnce();
      } while (this.#again && !this.#stopped);
    } catch (err) {
      this.d.log?.(`[cadence] check failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    } finally {
      this.#checking = false;
      this.arm();
    }
  }

  async #checkOnce(): Promise<void> {
    const shelf = this.d.shelf();
    const afterWake = this.#afterWake;
    this.#afterWake = false;
    if (!shelf) return;
    const now = this.d.now();
    let touched = false;
    for (const c of this.d.brain.cadences.list(shelf)) {
      if (this.#stopped || this.d.shelf() !== shelf) return;
      if (!c.enabled) continue;
      if (!isScheduled(c.when)) {
        // File and event cadences only run when something happened; here they run what they still owe.
        if (c.pending && !this.d.blocked() && !this.#activeGoal(c.id)) {
          await this.#enqueue(() => this.#runOwed(c.id));
          touched = true;
        }
        continue;
      }
      let reason: CadenceRunReason | null = null;
      let late = '';
      if (c.nextRunAt !== null && c.nextRunAt <= now) {
        const check = dueCheck(c.when, c.nextRunAt, now, this.#opts);
        reason = runReason(check, c.nextRunAt, now);
        late = check.occurrences > 1 ? `${check.occurrences} scheduled times passed while it couldn't run; it catches up once.` : '';
        this.d.brain.cadences.setNextRun(c.id, check.nextRunAt);
        touched = true;
      } else if (c.pending) {
        reason = 'catch-up';
      }
      if (!reason) continue;
      if (afterWake) reason = 'wake';
      const blocked = this.d.blocked();
      if (blocked) {
        if (!c.pending) {
          this.d.brain.cadences.setPending(c.id, true);
          this.d.brain.cadences.recordRun({ cadenceId: c.id, reason, outcome: 'deferred', message: `Waiting: ${blocked} It runs once when the hive can work again.` });
          this.d.note(`Cadence "${c.name}" is due, but ${lowerFirst(blocked)} It runs once when the hive can work again.`);
          touched = true;
        }
        continue;
      }
      if (c.pending) this.d.brain.cadences.setPending(c.id, false);
      const busy = this.#activeGoal(c.id);
      if (busy) {
        const waits = this.#waitingOn(busy);
        this.d.brain.cadences.recordRun({
          cadenceId: c.id,
          reason,
          outcome: 'skipped',
          goalId: busy.id,
          message: `Skipped: the run from ${clockTime(busy.createdAt)} ("${busy.title}") is still going${waits ? `; it is waiting for you to ${waits}` : ''}.`,
        });
        this.d.note(`Cadence "${c.name}" skipped a run: the last one is still going${waits ? ` (waiting for you to ${waits})` : ''}.`);
        touched = true;
        continue;
      }
      await this.#start(c, reason, late);
      touched = true;
    }
    if (touched) this.d.changed();
  }

  async #start(c: Cadence, reason: CadenceRunReason, extra = '', trigger?: string): Promise<void> {
    const why =
      reason === 'manual'
        ? 'You ran it now.'
        : reason === 'catch-up'
          ? 'Catching up once on a missed run.'
          : reason === 'wake'
            ? 'The computer woke up; catching up once on a run it missed while asleep.'
            : reason === 'file' || reason === 'event'
              ? `${this.#words(c.when)}: ${trigger ? firstLine(trigger) : 'something happened.'}`
              : `${this.#words(c.when)}.`;
    try {
      const goalId = await this.d.submit(c, reason, trigger);
      this.d.brain.cadences.recordRun({ cadenceId: c.id, reason, outcome: 'started', goalId, message: [`Started a goal for the Queen. ${why}`, extra].filter(Boolean).join(' ') });
      this.d.note(`Cadence "${c.name}" started a run (${STARTED_BY[reason]}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.brain.cadences.recordRun({ cadenceId: c.id, reason, outcome: 'failed', message: `Couldn't start: ${msg}` });
      this.d.note(`Cadence "${c.name}" couldn't start a run: ${msg}`);
      if (reason === 'manual') throw err;
    }
    this.d.changed();
  }

  // ---- file and event cadences (A3) ---------------------------------------------------------------

  /**
   * Something happened in the hive (A3): `goal-done` when a goal finished (merged or not), `budget-warning` when a
   * goal first used 75% of its token budget. Matching event cadences of the open project run (or are owed a run).
   */
  hiveEvent(e: { on: HiveEventTrigger; goalId: string; merged?: boolean }): void {
    if (this.#stopped) return;
    const shelf = this.d.shelf();
    const g = this.d.brain.goals.get(e.goalId);
    if (!shelf || !g || g.shelf !== shelf) return;
    // Loop guard: a goal an event cadence started never triggers event cadences.
    const source = g.cadenceId ? this.d.brain.cadences.get(g.cadenceId) : null;
    if (source?.when.type === 'event') return;
    const line =
      e.on === 'goal-done'
        ? `The goal "${g.title}" finished${e.merged === true ? ' and was merged into main' : e.merged === false ? ' without merging' : ''}.`
        : `The goal "${g.title}" has used ${g.spentTokens.toLocaleString('en-US')} of its ${g.budgetTokens?.toLocaleString('en-US') ?? '?'} token budget.`;
    for (const c of this.d.brain.cadences.list(shelf)) {
      if (!c.enabled || c.when.type !== 'event' || c.when.on !== e.on) continue;
      if (g.cadenceId === c.id) continue;
      if (e.on === 'goal-done' && c.when.cadenceId && g.cadenceId !== c.when.cadenceId) continue;
      this.#owe(c.id).events.push(line);
      void this.#enqueue(() => this.#fire(c.id, 'event'));
    }
  }

  /** Starts the run now, or records (once) why it waits and keeps what happened for the next run. */
  async #fire(id: string, reason: 'file' | 'event'): Promise<void> {
    const c = this.d.brain.cadences.get(id);
    if (this.#stopped || !c || !c.enabled || c.shelf !== this.d.shelf()) {
      this.#owed.delete(id);
      return;
    }
    const blocked = this.d.blocked();
    if (blocked) {
      if (!c.pending) {
        this.d.brain.cadences.setPending(id, true);
        this.d.brain.cadences.recordRun({
          cadenceId: id,
          reason,
          outcome: 'deferred',
          message: `Waiting: ${blocked} It runs once when the hive can work again, with everything that happened meanwhile.`,
        });
        this.d.note(`Cadence "${c.name}" was triggered, but ${lowerFirst(blocked)} It runs once when the hive can work again.`);
        this.d.changed();
      }
      return;
    }
    const busy = this.#activeGoal(id);
    if (busy) {
      if (!c.pending) {
        const waits = this.#waitingOn(busy);
        this.d.brain.cadences.setPending(id, true);
        this.d.brain.cadences.recordRun({
          cadenceId: id,
          reason,
          outcome: 'skipped',
          goalId: busy.id,
          message: `Not yet: the run from ${clockTime(busy.createdAt)} ("${busy.title}") is still going${waits ? `; it is waiting for you to ${waits}` : ''}. What happened meanwhile goes into the next run.`,
        });
        this.d.note(`Cadence "${c.name}" was triggered while its last run is still going; it runs once that one is done.`);
        this.d.changed();
      }
      return;
    }
    await this.#runOwed(id);
  }

  /** Runs a file or event cadence with everything it is owed. */
  async #runOwed(id: string): Promise<void> {
    const c = this.d.brain.cadences.get(id);
    if (!c || !c.enabled || isScheduled(c.when)) return;
    if (this.d.blocked() || this.#activeGoal(id)) return;
    if (c.pending) this.d.brain.cadences.setPending(id, false);
    await this.#start(c, c.when.type === 'file' ? 'file' : 'event', '', this.#takeTrigger(id));
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(job).catch((err: unknown) => this.d.log?.(`[cadence] trigger failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    this.#queue = next;
    return next;
  }

  #owe(id: string): Owed {
    let o = this.#owed.get(id);
    if (!o) {
      o = { files: new Set(), events: [] };
      this.#owed.set(id, o);
    }
    return o;
  }

  /** What happened, in words, for the run's goal; clears what was owed. */
  #takeTrigger(id: string): string {
    const o = this.#owed.get(id);
    this.#owed.delete(id);
    const lines: string[] = [];
    if (o?.files.size) {
      const files = [...o.files].sort();
      lines.push(`${files.length === 1 ? 'A file was' : `${files.length} files were`} added or changed:`);
      for (const f of files.slice(0, MAX_LISTED_FILES)) lines.push(`- ${f}`);
      if (files.length > MAX_LISTED_FILES) lines.push(`- …and ${files.length - MAX_LISTED_FILES} more`);
    }
    if (o?.events.length) lines.push(...o.events.slice(-MAX_LISTED_FILES));
    // Owed from before the app restarted: the details weren't kept.
    return lines.length ? lines.join('\n') : "Something it waits for happened while it couldn't run (the details were not kept).";
  }

  /** One watcher per enabled file cadence of the open project; closes the rest. Called on every arm(). */
  #syncWatches(): void {
    const shelf = this.#stopped ? null : this.d.shelf();
    const root = shelf ? (this.d.root?.() ?? null) : null;
    const want = new Map<string, Cadence>();
    if (shelf && root) for (const c of this.d.brain.cadences.list(shelf)) if (c.enabled && c.when.type === 'file') want.set(c.id, c);
    for (const [id, w] of [...this.#watches]) {
      const c = want.get(id);
      if (!c || !root || w.key !== watchKey(root, c)) this.#unwatch(id);
    }
    if (!root) return;
    for (const c of want.values()) {
      if (c.when.type !== 'file') continue;
      const dir = resolve(root, c.when.folder);
      if (!isDir(dir)) {
        this.#folderGone(c);
        continue;
      }
      this.#gone.delete(c.id);
      if (!this.#watches.has(c.id)) this.#watchFolder(c, root, dir);
    }
  }

  #watchFolder(c: Cadence, root: string, dir: string): void {
    if (c.when.type !== 'file') return;
    const pattern = c.when.pattern;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { recursive: true }, (_type, name) => {
        if (name) this.#changedFile(c.id, root, resolve(dir, name.toString()), pattern);
      });
    } catch (err) {
      this.d.log?.(`[cadence] can't watch ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      this.#folderGone(c);
      return;
    }
    watcher.on('error', () => {
      const now = this.d.brain.cadences.get(c.id);
      this.#unwatch(c.id);
      if (now) this.#folderGone(now);
    });
    this.#watches.set(c.id, { key: watchKey(root, c), watcher, files: new Set(), timer: null, firstAt: null });
  }

  #changedFile(id: string, root: string, full: string, pattern: string | null): void {
    const w = this.#watches.get(id);
    if (!w || this.#stopped) return;
    const rel = relative(root, full);
    if (!rel || rel.startsWith('..')) return;
    if (rel.split(sep).some((part) => NEVER_WATCHED.has(part))) return;
    if ((this.d.ignore?.() ?? []).some((p) => full === p || full.startsWith(p + sep))) return;
    // Deleted files, and folders, never trigger.
    let file: boolean;
    try {
      file = statSync(full).isFile();
    } catch {
      file = false;
    }
    if (!file) return;
    if (pattern && !matchesGlob(basename(full), pattern)) return;
    w.files.add(rel.split(sep).join('/'));
    // Changes settle, then ONE run; a steady stream still runs after at most four settle periods.
    const settle = this.d.settleMs ?? FILE_SETTLE_MS;
    const now = this.d.now();
    w.firstAt ??= now;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => this.#settled(id), Math.max(0, Math.min(settle, w.firstAt + 4 * settle - now)));
    w.timer.unref?.();
  }

  #settled(id: string): void {
    const w = this.#watches.get(id);
    if (!w) return;
    w.timer = null;
    w.firstAt = null;
    if (!w.files.size) return;
    const owed = this.#owe(id);
    for (const f of w.files) owed.files.add(f);
    w.files = new Set();
    void this.#enqueue(() => this.#fire(id, 'file'));
  }

  /** The watched folder is gone: one failed run says so; watching starts again when it is back or the cadence is edited. */
  #folderGone(c: Cadence): void {
    this.#unwatch(c.id);
    if (this.#gone.has(c.id) || c.when.type !== 'file') return;
    this.#gone.add(c.id);
    this.d.brain.cadences.recordRun({
      cadenceId: c.id,
      reason: 'file',
      outcome: 'failed',
      message: `The folder "${c.when.folder}" is gone, so it stopped watching. It starts again when the folder is back, or when you edit the cadence.`,
    });
    this.d.note(`Cadence "${c.name}" stopped watching: the folder "${c.when.folder}" is gone.`);
    this.d.changed();
  }

  #unwatch(id: string): void {
    const w = this.#watches.get(id);
    if (!w) return;
    this.#watches.delete(id);
    if (w.timer) clearTimeout(w.timer);
    try {
      w.watcher.close();
    } catch {
      // Already closed.
    }
  }

  /** What a file or event cadence needs before it is saved (the shape itself is checked by the schema). */
  #valid(c: CadenceFields, id: string | null): CadenceFields {
    if (c.when.type === 'file') {
      const root = this.d.root?.() ?? null;
      if (!root) throw new Error('Pick a project folder first: a file cadence watches a folder in it.');
      const dir = resolve(root, c.when.folder);
      const rel = relative(root, dir);
      if (rel.startsWith('..')) throw new Error('The folder must be inside the project.');
      if (!isDir(dir)) throw new Error(`There's no folder "${c.when.folder}" in this project. Create it first, or pick another folder.`);
    }
    if (c.when.type === 'event') {
      if (c.when.on !== 'goal-done') return { ...c, when: { ...c.when, cadenceId: null } };
      const target = c.when.cadenceId;
      if (target) {
        if (target === id) throw new Error("A cadence can't run after its own runs: pick another cadence, or any goal.");
        const t = this.d.brain.cadences.get(target);
        if (!t || t.shelf !== this.d.shelf()) throw new Error('No such cadence in this project to run after.');
        if (t.when.type === 'event') {
          throw new Error(`"${t.name}" itself waits for a hive event, and runs it starts never trigger other cadences. Pick a cadence that runs on a schedule or on files.`);
        }
      }
    }
    return c;
  }

  #words(when: Cadence['when']): string {
    return whenText(when, (cid) => this.d.brain.cadences.get(cid)?.name ?? null);
  }

  /** The cadence's newest goal, if it is still planning, waiting for plan approval, or running. */
  #activeGoal(cadenceId: string): Goal | null {
    const mine = this.d.brain.goals.list().filter((g) => g.cadenceId === cadenceId);
    const newest = mine.at(-1);
    return newest && ACTIVE.has(newest.status) ? newest : null;
  }

  /** What the user's approval on a goal would unblock, in words ("approve its plan"), or null. */
  #waitingOn(goal: Goal): string | null {
    const kinds = new Set(this.d.brain.approvals.list({ status: 'waiting' }).filter((a) => a.goalId === goal.id).map((a) => a.kind));
    if (kinds.has('plan')) return 'approve its plan';
    if (kinds.has('merge')) return 'approve its merge';
    return kinds.size ? 'answer it in Approvals' : null;
  }

  #shelf(): string {
    const s = this.d.shelf();
    if (!s) throw new Error('Pick a project folder first: cadences belong to a project.');
    return s;
  }

  #own(id: string): Cadence {
    const c = this.d.brain.cadences.get(id);
    if (!c || c.shelf !== this.d.shelf()) throw new Error('No such cadence in this project.');
    return c;
  }
}

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const firstLine = (s: string): string => s.split('\n')[0]!;

const STARTED_BY: Record<CadenceRunReason, string> = {
  schedule: 'on schedule',
  manual: 'run now',
  wake: 'after the computer woke up',
  'catch-up': 'catching up once',
  file: 'files changed',
  event: 'a hive event',
};

const watchKey = (root: string, c: Cadence): string => (c.when.type === 'file' ? `${root}|${c.when.folder}|${c.when.pattern ?? ''}` : '');

const isDir = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const runView = (r: CadenceRun): CadenceRunView => ({ id: r.id, cadenceId: r.cadenceId, at: r.at, reason: r.reason, outcome: r.outcome, goalId: r.goalId, message: r.message });
