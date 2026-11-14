import type { Brain, Cadence, CadenceRun, CadenceRunReason, Goal } from '@insectoids/brain';
import { dueCheck, nextRunAt, runReason, whenText } from '@insectoids/harness';
import { type CadenceInput, CadenceInputSchema, type CadenceRunView, type CadenceView } from '@insectoids/shared';

/**
 * The scheduler (Cadence 05; Phase 3 A1). It lives in the Brain host next to the hive, so it keeps running with
 * the window closed. Every run is a normal goal for the Queen (05-D1): the keeper only decides *when*, and hands
 * the goal to the host's `submit`, which goes through the same path as the user's own goals.
 *
 * Only the open project's cadences run. A cadence whose time passed while it couldn't run (the app was closed,
 * its project wasn't open, the computer slept) runs once when it can ("catch up once", 05-D5). While the hive is
 * paused a due run is owed (`pending`) and runs once on resume. A run never piles up on the previous one.
 */
export interface CadenceKeeperDeps {
  brain: Brain;
  now: () => number;
  /** The open project's shelf, or null. */
  shelf: () => string | null;
  /** Why the hive can't start work now (paused by the user, the Watchdog or a limit), or null. */
  blocked: () => string | null;
  /** Hands the goal to the Queen; resolves to the new goal's id (planning carries on in the background). */
  submit: (c: Cadence, reason: CadenceRunReason) => Promise<string>;
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

export class CadenceKeeper {
  #timer: NodeJS.Timeout | null = null;
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
    const c = CadenceInputSchema.parse(input);
    const made = this.d.brain.cadences.create({ ...c, shelf, nextRunAt: c.enabled ? nextRunAt(c.when, this.d.now(), this.#opts) : null });
    this.d.note(`New cadence "${made.name}": ${whenText(made.when)}.`);
    this.arm();
    return made;
  }

  /** A changed schedule starts over from now (an owed run is kept). */
  update(id: string, input: CadenceInput): Cadence {
    this.#own(id);
    const c = CadenceInputSchema.parse(input);
    const made = this.d.brain.cadences.update(id, { ...c, nextRunAt: c.enabled ? nextRunAt(c.when, this.d.now(), this.#opts) : null });
    if (!c.enabled) this.d.brain.cadences.setPending(id, false);
    this.arm();
    return made;
  }

  setEnabled(id: string, enabled: boolean): void {
    const c = this.#own(id);
    if (c.enabled === enabled) return;
    this.d.brain.cadences.setEnabled(id, enabled, enabled ? nextRunAt(c.when, this.d.now(), this.#opts) : null);
    this.d.note(enabled ? `Cadence "${c.name}" is on: next ${whenText(c.when).toLowerCase()}.` : `Cadence "${c.name}" is off; it won't run until you switch it on.`);
    this.arm();
  }

  delete(id: string): void {
    const c = this.#own(id);
    this.d.brain.cadences.delete(id);
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
    await this.#start(c, 'manual');
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
        whenText: whenText(c.when),
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

  async #start(c: Cadence, reason: CadenceRunReason, extra = ''): Promise<void> {
    const why = reason === 'manual' ? 'You ran it now.' : reason === 'catch-up' ? 'Catching up once on a missed run.' : reason === 'wake' ? 'The computer woke up; catching up once on a run it missed while asleep.' : `${whenText(c.when)}.`;
    try {
      const goalId = await this.d.submit(c, reason);
      this.d.brain.cadences.recordRun({ cadenceId: c.id, reason, outcome: 'started', goalId, message: [`Started a goal for the Queen. ${why}`, extra].filter(Boolean).join(' ') });
      this.d.note(`Cadence "${c.name}" started a run (${reason === 'schedule' ? 'on schedule' : reason === 'manual' ? 'run now' : reason === 'wake' ? 'after the computer woke up' : 'catching up once'}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.brain.cadences.recordRun({ cadenceId: c.id, reason, outcome: 'failed', message: `Couldn't start: ${msg}` });
      this.d.note(`Cadence "${c.name}" couldn't start a run: ${msg}`);
      if (reason === 'manual') throw err;
    }
    this.d.changed();
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

const runView = (r: CadenceRun): CadenceRunView => ({ id: r.id, cadenceId: r.cadenceId, at: r.at, reason: r.reason, outcome: r.outcome, goalId: r.goalId, message: r.message });
