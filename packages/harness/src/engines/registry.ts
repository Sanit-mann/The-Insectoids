import type { EngineCard, EngineId } from '@insectoids/shared';
import type { Effort } from '../claude/args';
import type { Engine, EngineRequest, EngineResult, EngineRun } from '../hive/engine';
import { type EngineCandidate, type GuardKind, type ModelTiers, type Route, type RouteInput, pickEngine } from '../hive/router';

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
  install: { command: string; note: string } | null;
  signIn: { command: string; note: string } | null;
  privacyNote: string | null;
  /** Check the engine on this computer (never spends tokens). Absent for unsupported engines. */
  detect?(): Promise<EngineDetection>;
  /** The engine for runs; only called after a detection said ready (or fake). */
  create?(): Engine;
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

  /** What the router sees, in the user's order. */
  candidates(): EngineCandidate[] {
    return this.#order.map((id) => ({
      id,
      enabled: this.isEnabled(id),
      ready: this.isReady(id),
      guard: this.#adapters.get(id)!.capabilities.guard,
    }));
  }

  /**
   * The route for a run: the engine from `pickEngine`, the model and effort from that engine's tiers.
   * With no engine able to take it, the route names the first supported engine; the run then fails as
   * "not ready" and the hive pauses, as before.
   */
  route(input: RouteInput, routeCard: (i: RouteInput, m: ModelTiers, e: EngineId) => Route): Route {
    const picked = pickEngine(input.role, this.candidates());
    const fallback = this.#order.find((id) => this.#adapters.get(id)?.models) ?? this.#order[0]!;
    const id = picked ?? fallback;
    const models = this.#adapters.get(id)?.models ?? { strongest: 'unknown', standard: 'unknown', light: 'unknown' };
    return routeCard(input, models, id);
  }

  cards(): EngineCard[] {
    return this.#order.map((id): EngineCard => {
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
        return { ...base, state: 'unsupported', version: null, message: `${a.name} isn't supported in this version yet${a.availableIn ? ` (coming in ${a.availableIn})` : ''}.` };
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
