import type { EngineCard, EngineId } from '@insectoids/shared';
import type { Effort } from '../claude/args';
import type { Engine, EngineRequest, EngineResult, EngineRun } from '../hive/engine';
import type { OutcomeStat } from '@insectoids/brain';
import { type EngineCandidate, type GuardKind, type ModelTiers, type Route, type RouteInput, allowedEngines, freeEngineFor, pickEngine } from '../hive/router';
import { learnRoute } from '../hive/treasurer';

/** What an engine can do (Connections 04-D2). The router and the UI read this; nothing is assumed. */
export interface EngineCapabilities {
  /** How the command guard protects its runs; null while the engine is unsupported in this build. */
  guard: GuardKind | null;
  /** Can it load the hive's MCP servers (the Brain door, later the hive tools)? */
  mcp: boolean;
  /** Effort levels it understands; null if it has no effort control. */
  effort: readonly Effort[] | null;
  /** Does it report cost itself? Otherwise the hive estimates it from tokens. */
  reportsCost: boolean;
  /**
   * Free to run: a model on this computer (e.g. OpenCode with Ollama). The Treasurer sends light work there
   * first (02-D9 P1: the cheapest model that can do it).
   */
  free?: boolean;
}

/** Result of checking an engine on this computer. */
export interface EngineDetection {
  state: Exclude<EngineCard['state'], 'checking' | 'unsupported'>;
  version: string | null;
  /** Plain words, including the fix when not ready. */
  message: string;
}

/** One AI engine the hive can use (Claude Code, Gemini CLI, …) or knows about but can't use yet. */
export interface EngineAdapter {
  id: EngineId;
  name: string;
  vendor: string;
  capabilities: EngineCapabilities;
  /** The engine's model names by tier; null when unsupported. */
  models: ModelTiers | null;
  /** e.g. "Phase 2 · step A2" when this build has no adapter yet. Such engines are never detected or run. */
  availableIn: string | null;
  /** Why it can't run, in plain words, shown instead of the generic "not supported yet" line (e.g. no guard). */
  unavailableReason?: string;
  install: { command: string; note: string } | null;
  signIn: { command: string; note: string } | null;
  privacyNote: string | null;
  /** Check the engine on this computer (never spends tokens). Absent for unsupported engines. */
  detect?(): Promise<EngineDetection>;
  /** The engine for runs; only called after a detection said ready (or fake). */
  create?(): Engine;
}

/** An engine's subscription state from the Treasurer (04-D7). */
export interface LimitState {
  exhausted: boolean;
  near: boolean;
  /** Plain words, e.g. "Claude Code is at its usage limit until 3:00 PM". */
  message: string;
}

/** What the learning router needs: outcome stats per role and a random source. */
export interface Learning {
  stats(role: string): readonly OutcomeStat[];
  rng: () => number;
}

export interface EnginePrefs {
  /** Preference order; first = default. */
  order: EngineId[];
  /** Engines the user switched off. */
  disabled: EngineId[];
}

const isReady = (state: EngineCard['state']): boolean => state === 'ready' || state === 'fake';

/**
 * The hive's engines in the user's order, with on/off switches and the last detection of each.
 * The hive asks it which engine runs what (`route`), and runs go through `engine()`.
 */
export class EngineRegistry {
  readonly #adapters = new Map<EngineId, EngineAdapter>();
  #order: EngineId[];
  readonly #disabled = new Set<EngineId>();
  readonly #detections = new Map<EngineId, EngineDetection>();
  readonly #checking = new Set<EngineId>();
  #limitState: (id: EngineId) => LimitState | null = () => null;
  #learning: Learning | null = null;

  constructor(adapters: readonly EngineAdapter[], prefs: Partial<EnginePrefs> = {}) {
    for (const a of adapters) this.#adapters.set(a.id, a);
    this.#order = adapters.map((a) => a.id);
    if (prefs.order) this.setOrder(prefs.order);
    for (const id of prefs.disabled ?? []) if (this.#adapters.has(id)) this.#disabled.add(id);
    for (const a of adapters) if (a.detect) this.#checking.add(a.id);
  }

  get order(): EngineId[] {
    return [...this.#order];
  }

  prefs(): EnginePrefs {
    return { order: this.order, disabled: this.#order.filter((id) => this.#disabled.has(id)) };
  }

  adapter(id: EngineId): EngineAdapter | undefined {
    return this.#adapters.get(id);
  }

  isEnabled(id: EngineId): boolean {
    return this.#adapters.has(id) && !this.#disabled.has(id);
  }

  setEnabled(id: EngineId, enabled: boolean): void {
    if (!this.#adapters.has(id)) throw new Error(`Unknown engine ${id}.`);
    if (enabled) this.#disabled.delete(id);
    else this.#disabled.add(id);
  }

  /** New preference order. Unknown ids are ignored; engines left out keep their relative place at the end. */
  setOrder(order: readonly EngineId[]): void {
    const known = order.filter((id, i) => this.#adapters.has(id) && order.indexOf(id) === i);
    this.#order = [...known, ...this.#order.filter((id) => !known.includes(id))];
  }

  isReady(id: EngineId): boolean {
    const d = this.#detections.get(id);
    return Boolean(d && isReady(d.state) && this.#adapters.get(id)?.create);
  }

  /** Check every supported engine. Returns true if any state changed. */
  async detectAll(): Promise<boolean> {
    const results = await Promise.all(
      [...this.#adapters.values()].filter((a) => a.detect).map(async (a): Promise<[EngineId, EngineDetection]> => {
        try {
          return [a.id, await a.detect!()];
        } catch (err) {
          return [a.id, { state: 'missing', version: null, message: `Could not check ${a.name}: ${err instanceof Error ? err.message : String(err)}` }];
        }
      }),
    );
    let changed = false;
    for (const [id, d] of results) {
      const before = this.#detections.get(id);
      if (!before || before.state !== d.state || before.version !== d.version || before.message !== d.message || this.#checking.has(id)) changed = true;
      this.#detections.set(id, d);
      this.#checking.delete(id);
    }
    return changed;
  }

  /** True while any enabled, supported engine is not ready (keep re-checking). */
  get anyEnabledNotReady(): boolean {
    return this.#order.some((id) => this.#adapters.get(id)?.detect && this.isEnabled(id) && !this.isReady(id));
  }

  /** The engine work goes to by default: the first enabled, ready one in the user's order. */
  defaultEngine(): EngineAdapter | null {
    const id = this.#order.find((e) => this.isEnabled(e) && this.isReady(e));
    return id ? this.#adapters.get(id)! : null;
  }

  /** The Treasurer's view of each engine's subscription (exhausted / near a cap). */
  setLimitState(fn: (id: EngineId) => LimitState | null): void {
    this.#limitState = fn;
  }

  /** Turns on learning from outcomes (Phase 2 A5). Without it, routes are the rule routes. */
  setLearning(learning: Learning | null): void {
    this.#learning = learning;
  }

  limitState(id: EngineId): LimitState | null {
    return this.#limitState(id);
  }

  /** What the router sees, in the user's order. */
  candidates(): EngineCandidate[] {
    return this.#order.map((id) => {
      const limit = this.#limitState(id);
      return {
        id,
        enabled: this.isEnabled(id),
        ready: this.isReady(id),
        guard: this.#adapters.get(id)!.capabilities.guard,
        ...(this.#adapters.get(id)!.capabilities.free ? { free: true } : {}),
        ...(limit?.exhausted ? { exhausted: true } : {}),
        ...(limit?.near ? { near: true } : {}),
      };
    });
  }

  /** Can some engine take this role right now (enabled, ready, guarded, not exhausted)? */
  canRoute(role: RouteInput['role']): boolean {
    return allowedEngines(role, this.candidates()).length > 0;
  }

  /**
   * The route for a run: the engine from `pickEngine`, the model and effort from that engine's tiers.
   * With no engine able to take it, the route names the first supported engine; the run then fails as
   * "not ready" and the hive pauses, as before.
   */
  route(input: RouteInput, routeCard: (i: RouteInput, m: ModelTiers, e: EngineId) => Route): Route {
    const candidates = this.candidates();
    // Light work goes to a free engine first (02-D9 P1: the cheapest model that can do it). Retries and
    // anything heavier keep the user's order, so a stronger model takes over when the local one struggles.
    const free = freeEngineFor(input, candidates, routeCard);
    if (free) {
      const a = this.#adapters.get(free)!;
      const r = routeCard(input, a.models!, free);
      return { ...r, reason: `rule: light work goes to the free model on this computer (${a.name}); ${r.reason.replace(/^rule: /, '')}` };
    }
    const picked = pickEngine(input.role, candidates);
    const fallback = this.#order.find((id) => this.#adapters.get(id)?.models) ?? this.#order[0]!;
    const id = picked ?? fallback;
    const models = this.#adapters.get(id)?.models ?? { strongest: 'unknown', standard: 'unknown', light: 'unknown' };
    let rule = routeCard(input, models, id);
    // Say so when the user's first choice is resting at a limit and another engine stands in.
    const first = candidates.find((c) => c.enabled && c.ready && c.guard);
    if (picked && first && first.id !== picked && first.exhausted) {
      const why = (this.#limitState(first.id)?.message ?? `${first.id} is at its usage limit`).replace(/\.$/, '');
      rule = { ...rule, reason: `fallback: ${why}; ${rule.reason}` };
    }
    if (!picked || !this.#learning) return rule;
    const engines = allowedEngines(input.role, candidates).flatMap((c) => {
      const a = this.#adapters.get(c.id);
      return a?.models ? [{ id: c.id, name: a.name, models: a.models, efforts: a.capabilities.effort, ...(c.near ? { near: true } : {}) }] : [];
    });
    const learned = learnRoute({ input, rule, engines, stats: this.#learning.stats(input.role), rng: this.#learning.rng });
    // Keep a fallback note in front of a learned reason too.
    return learned === rule || !rule.reason.startsWith('fallback:') ? learned : { ...learned, reason: `${rule.reason.split('; ')[0]}; ${learned.reason}` };
  }

  cards(): Array<Omit<EngineCard, 'usage'>> {
    return this.#order.map((id): Omit<EngineCard, 'usage'> => {
      const a = this.#adapters.get(id)!;
      const d = this.#detections.get(id);
      const base = {
        id,
        name: a.name,
        vendor: a.vendor,
        enabled: this.isEnabled(id),
        availableIn: a.availableIn,
        guard: a.capabilities.guard,
        reportsCost: a.capabilities.reportsCost,
        models: a.models,
        install: a.install,
        signIn: a.signIn,
        privacyNote: a.privacyNote,
      };
      if (!a.detect) {
        const message = a.unavailableReason ?? `${a.name} isn't supported in this version yet${a.availableIn ? ` (coming in ${a.availableIn})` : ''}.`;
        return { ...base, state: 'unsupported', version: null, message };
      }
      if (!d || this.#checking.has(id)) return { ...base, state: 'checking', version: d?.version ?? null, message: `Checking for ${a.name}…` };
      return { ...base, state: d.state, version: d.version, message: d.message };
    });
  }

  /** The engine the hive runs everything through: each run goes to the adapter its route names. */
  engine(): Engine {
    return new RegistryEngine(this);
  }
}

/** Dispatches each run to the adapter named in its route; a not-ready engine fails the run as signed out. */
export class RegistryEngine implements Engine {
  constructor(private readonly registry: EngineRegistry) {}

  run(req: EngineRequest): EngineRun {
    const id = req.route.engine;
    const adapter = this.registry.adapter(id);
    if (adapter?.create && this.registry.isEnabled(id) && this.registry.isReady(id)) return adapter.create().run(req);
    const name = adapter?.name ?? id;
    const why = !adapter ? 'is unknown' : !this.registry.isEnabled(id) ? 'is switched off' : 'is not ready';
    const result: EngineResult = {
      ok: false, error: 'auth', model: req.route.model, models: [], sessionId: null, text: '', stderrTail: `${name} ${why}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, numTurns: 0, durationMs: 0, exitCode: null,
    };
    return { done: Promise.resolve(result), stop: () => {} };
  }
}
