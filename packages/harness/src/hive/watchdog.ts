import type { BreakerStep, Sensor } from '@insectoids/brain';
import type { ClaudeEvent } from '../claude/stream';
import type { AgentRole } from './router';

/**
 * The Watchdog's reflexes (Hive 02-D8, D9 P3; Phase 2 C2): plain code, no LLM in the fast path. It reads one
 * run's engine events and says when a sensor trips and which breaker step applies. The hive acts on it.
 *
 * Ladder per run: the first trip of a sensor is a warning; the same sensor tripping again on that run (twice
 * the repeat count, or a second stall window) pauses the card (the run stops, the card is held until the
 * Foreman decides). For the Queen, the second step pauses the hive and alerts the user instead (02-D12).
 * Hard limits (a run far over its token cap, a second crash on one card) are decided by the hive at the end
 * of a run: see `overspend` and the crash rule in the hive. Several serious trips at once pause the hive.
 */
export interface WatchdogThresholds {
  /** Same tool call with the same arguments this many times in one run: warn; twice as many: pause the card. */
  loopRepeats: number;
  /** Same tool error text this many times in one run: warn; twice as many: pause the card. */
  errorRepeats: number;
  /** No engine event for this long: warn; another window: pause the card. */
  stallMs: number;
  /** A run using more than this many times its card's per-attempt share of the goal budget: warn. */
  overspendFactor: number;
  /** A run using more tokens than this is stopped as a hard limit (its work is not kept). */
  hardRunTokens: number;
  /** This many serious trips (pause-card or worse) within `hiveWindowMs` pause the whole hive. */
  hiveTrips: number;
  hiveWindowMs: number;
  /** The same agent is not warned twice for the same sensor within this time. */
  warnCooldownMs: number;
}

export const WATCHDOG_DEFAULTS: WatchdogThresholds = {
  loopRepeats: 5,
  errorRepeats: 4,
  stallMs: 5 * 60_000,
  overspendFactor: 3,
  hardRunTokens: 1_500_000,
  hiveTrips: 3,
  hiveWindowMs: 10 * 60_000,
  warnCooldownMs: 10 * 60_000,
};

export interface Trip {
  sensor: Sensor;
  step: BreakerStep;
  /** Plain words with counts. */
  evidence: string;
  /** Sensor + caste/role + what repeated: two incidents with the same signature are "the same problem". */
  signature: string;
}

export interface WatchedRun {
  runId: string;
  agentId: string;
  role: AgentRole;
  goalId: string | null;
  cardId: string | null;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A tool call as words: its name and the most telling argument (a command, a path, a pattern). */
export function describeCall(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const main = o['command'] ?? o['file_path'] ?? o['path'] ?? o['pattern'] ?? o['url'] ?? o['query'];
  return typeof main === 'string' && main ? `${name}: ${clip(oneLine(main), 120)}` : name;
}

/** One run under watch. */
export class RunWatch {
  readonly #t: WatchdogThresholds;
  readonly #now: () => number;
  readonly #calls = new Map<string, number>();
  readonly #errors = new Map<string, number>();
  #lastEventAt: number;
  #stallWindows = 0;
  /** Breaker level reached per sensor on this run: 1 = warned, 2 = paused (or the Queen's hive pause). */
  readonly #level = new Map<Sensor, number>();
  #stopped = false;

  constructor(
    readonly run: WatchedRun,
    t: WatchdogThresholds,
    now: () => number,
    private readonly mayWarn: (sensor: Sensor) => boolean,
  ) {
    this.#t = t;
    this.#now = now;
    this.#lastEventAt = now();
  }

  /** Set once the run was stopped by a breaker: later events are ignored. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** A loop or a repeated error. */
  event(e: ClaudeEvent): Trip | null {
    if (this.#stopped) return null;
    this.#lastEventAt = this.#now();
    this.#stallWindows = 0;
    if (e.kind === 'tool_use') {
      const key = `${e.name}:${JSON.stringify(e.input ?? null)}`;
      const n = (this.#calls.get(key) ?? 0) + 1;
      this.#calls.set(key, n);
      const call = describeCall(e.name, e.input);
      return this.#count('loop', n, this.#t.loopRepeats, `Ran the same tool call ${n} times: ${call}.`, call);
    }
    if (e.kind === 'tool_result' && e.isError) {
      const text = clip(oneLine(e.content), 160);
      // The guard's own "needs approval" answers are the approval flow, not a broken agent.
      if (/Needs the user's approval/.test(text)) return null;
      const n = (this.#errors.get(text) ?? 0) + 1;
      this.#errors.set(text, n);
      return this.#count('error-repeat', n, this.#t.errorRepeats, `Got the same error ${n} times: ${text}`, text);
    }
    return null;
  }

  /** No engine event for a stall window (checked on a timer by the hive). */
  idle(): Trip | null {
    if (this.#stopped) return null;
    const quiet = this.#now() - this.#lastEventAt;
    const windows = Math.floor(quiet / this.#t.stallMs);
    if (windows <= this.#stallWindows) return null;
    this.#stallWindows = windows;
    const minutes = Math.max(1, Math.round(quiet / 60_000));
    const evidence = `No progress for ${quiet < 60_000 ? `${Math.round(quiet / 1000)} seconds` : `${minutes} minute${minutes === 1 ? '' : 's'}`} (no tool calls or output).`;
    return this.#escalate('stall', windows >= 2 ? 2 : 1, evidence, '');
  }

  /** The run was stopped by the breaker (no more trips from it). */
  markStopped(): void {
    this.#stopped = true;
  }

  #count(sensor: Sensor, n: number, limit: number, evidence: string, what: string): Trip | null {
    if (n === limit) return this.#escalate(sensor, 1, evidence, what);
    if (n === limit * 2) return this.#escalate(sensor, 2, evidence, what);
    return null;
  }

  #escalate(sensor: Sensor, level: 1 | 2, evidence: string, what: string): Trip | null {
    const had = this.#level.get(sensor) ?? 0;
    if (level <= had) return null;
    this.#level.set(sensor, level);
    const signature = `${sensor}|${this.run.role}|${clip(what, 120)}`;
    if (level === 1) {
      // Same agent, same reason, within the cooldown: no second warning (the ladder still counts it).
      if (!this.mayWarn(sensor)) return null;
      return { sensor, step: 'warn', evidence, signature };
    }
    // The Queen has no card to hold: the next step for her is pausing the hive with an alert (02-D12).
    const step: BreakerStep = this.run.role === 'queen' ? 'pause-hive' : 'pause-card';
    return { sensor, step, evidence, signature };
  }
}

/** The Watchdog across runs: per-agent warning cooldowns and the hive-wide breaker. */
export class Watchdog {
  readonly t: WatchdogThresholds;
  readonly #now: () => number;
  readonly #warned = new Map<string, number>();
  #serious: number[] = [];

  constructor(t: Partial<WatchdogThresholds> = {}, now: () => number = Date.now) {
    this.t = { ...WATCHDOG_DEFAULTS, ...t };
    this.#now = now;
  }

  watch(run: WatchedRun): RunWatch {
    return new RunWatch(run, this.t, this.#now, (sensor) => this.#mayWarn(run.agentId, sensor));
  }

  #mayWarn(agentId: string, sensor: Sensor): boolean {
    const key = `${agentId}|${sensor}`;
    const at = this.#now();
    const last = this.#warned.get(key);
    if (last !== undefined && at - last < this.t.warnCooldownMs) return false;
    this.#warned.set(key, at);
    return true;
  }

  /**
   * A run's token use at its end: over the hard cap is a hard stop; over `overspendFactor` times its share
   * is a warning. `share` is the card's per-attempt share of the goal budget (null = unknown: no soft check).
   */
  overspend(run: WatchedRun, tokens: number, share: number | null): Trip | null {
    if (tokens > this.t.hardRunTokens) {
      return {
        sensor: 'overspend',
        step: 'stop-agent',
        evidence: `Used ${tokens.toLocaleString('en-US')} tokens in one run, over the hard limit of ${this.t.hardRunTokens.toLocaleString('en-US')}. Its work is not kept.`,
        signature: `overspend|${run.role}|hard`,
      };
    }
    if (share !== null && share > 0 && tokens > share * this.t.overspendFactor) {
      return {
        sensor: 'overspend',
        step: 'warn',
        evidence: `Used ${tokens.toLocaleString('en-US')} tokens in one run, ${Math.round(tokens / share)} times its share of the goal budget.`,
        signature: `overspend|${run.role}|soft`,
      };
    }
    return null;
  }

  /**
   * Note a serious trip (pause-card or worse). True when it makes `hiveTrips` within the window: the hive
   * should pause. The count starts over after a hive trip, so one burst pauses once.
   */
  serious(): boolean {
    const at = this.#now();
    this.#serious = [...this.#serious.filter((t) => at - t < this.t.hiveWindowMs), at];
    if (this.#serious.length < this.t.hiveTrips) return false;
    this.#serious = [];
    return true;
  }
}
