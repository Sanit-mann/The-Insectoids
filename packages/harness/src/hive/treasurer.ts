import type { EngineId } from '@insectoids/shared';
import type { OutcomeStat } from '@insectoids/brain';
import type { Effort } from '../claude/args';
import { EFFORTS, type ModelTiers, type Route, type RouteInput, TIERS, type Tier, budgetForTier } from './router';

/**
 * The Treasurer's learning router (Hive 02-D9 P1; Phase 2 A5).
 *
 * Starts from the rule route and looks one step around it (tier ±1, effort ±1) on every engine allowed to
 * take the work. For each way of running a caste's cards it keeps a Beta(successes + 1, failures + 1) belief
 * and samples it (Thompson sampling, seeded so tests are repeatable):
 * - a way needs at least `minSamples` finished runs before it's trusted; until then the rule route stands;
 * - among the ways whose sampled success is at least `threshold`, the cheapest wins;
 * - if none is good enough, the most likely to succeed wins.
 * Retries keep the rule route (it escalates effort, then the model tier), and the Queen and the Inspector keep
 * theirs: the learner never lowers effort or tier on a retry and never touches planning or verification.
 */
export interface LearnEngine {
  id: EngineId;
  /** Shown in reasons, e.g. "Claude Code". */
  name: string;
  models: ModelTiers;
  /** Effort levels it understands; null = no effort control (only the rule's effort is tried). */
  efforts: readonly Effort[] | null;
  /** Near the user's cap: only chosen when nothing else qualifies. */
  near?: boolean;
}

export interface LearnOptions {
  input: RouteInput;
  /** The rule route (already on the first allowed engine). */
  rule: Route;
  /** Engines allowed to take this role, in the user's order (see allowedEngines). */
  engines: readonly LearnEngine[];
  stats: readonly OutcomeStat[];
  rng: () => number;
  minSamples?: number;
  threshold?: number;
}

export const MIN_SAMPLES = 5;
export const GOOD_ENOUGH = 0.8;

/** mulberry32: a small, fast, seedable RNG (deterministic tests, varied choices in real use). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  // Box–Muller; avoid log(0).
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape ≥ 1, 1) by Marsaglia–Tsang. */
function gamma(shape: number, rng: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(Math.max(u, Number.EPSILON)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** A draw from Beta(a, b) with a, b ≥ 1. */
export function sampleBeta(a: number, b: number, rng: () => number): number {
  const x = gamma(a, rng);
  const y = gamma(b, rng);
  return x / (x + y);
}

interface Way {
  engine: LearnEngine;
  tier: Tier;
  effort: Effort;
  successes: number;
  failures: number;
  avgCost: number | null;
  isRule: boolean;
}

/** Relative cost when real costs aren't known yet: stronger tiers and more effort cost more. */
const proxyCost = (tier: Tier, effort: Effort): number => [0.2, 1, 5][TIERS.indexOf(tier)]! * [0.6, 1, 1.6, 2.4][EFFORTS.indexOf(effort)]!;

const money = (usd: number): string => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

export function learnRoute(o: LearnOptions): Route {
  const { input, rule } = o;
  const minSamples = o.minSamples ?? MIN_SAMPLES;
  const threshold = o.threshold ?? GOOD_ENOUGH;
  if (input.role === 'queen' || input.role === 'inspector' || input.attempts > 0 || !o.engines.length) return rule;

  const ti = TIERS.indexOf(rule.tier);
  const ei = EFFORTS.indexOf(rule.effort);
  const stat = (engine: EngineId, tier: Tier, effort: Effort): OutcomeStat | undefined =>
    o.stats.find((s) => s.engine === engine && s.tier === tier && s.effort === effort);

  const ways: Way[] = [];
  for (const engine of o.engines) {
    for (const t of [ti - 1, ti, ti + 1]) {
      if (t < 0 || t >= TIERS.length) continue;
      const efforts = engine.efforts ? [ei - 1, ei, ei + 1].filter((e) => e >= 0 && e < EFFORTS.length && engine.efforts!.includes(EFFORTS[e]!)) : [ei];
      for (const e of efforts) {
        const tier = TIERS[t]!;
        const effort = EFFORTS[e]!;
        const s = stat(engine.id, tier, effort);
        ways.push({
          engine,
          tier,
          effort,
          successes: s?.successes ?? 0,
          failures: s?.failures ?? 0,
          avgCost: s?.avgCostPerSuccess ?? null,
          isRule: engine.id === rule.engine && tier === rule.tier && effort === rule.effort,
        });
      }
    }
  }
  const trusted = ways.filter((w) => w.successes + w.failures >= minSamples);
  if (!trusted.length) return rule;

  const sampled = trusted.map((w) => ({ w, p: sampleBeta(w.successes + 1, w.failures + 1, o.rng) }));
  const realCosts = sampled.every((x) => x.w.avgCost !== null);
  const cost = (w: Way): number => (realCosts ? w.avgCost! : proxyCost(w.tier, w.effort));
  const good = sampled.filter((x) => x.p >= threshold);
  const pool = good.filter((x) => !x.w.engine.near).length ? good.filter((x) => !x.w.engine.near) : good;
  const chosen = pool.length
    ? pool.reduce((best, x) => (cost(x.w) < cost(best.w) ? x : best))
    : sampled.reduce((best, x) => (x.p > best.p ? x : best));
  const w = chosen.w;
  const n = w.successes + w.failures;
  const caste = input.role;
  const record = `passed ${w.successes}/${n} ${caste} cards${w.avgCost !== null ? ` (avg ${money(w.avgCost)})` : ''}`;
  const reason = pool.length
    ? `learned: ${w.engine.name} ${w.engine.models[w.tier]}·${w.effort} ${record}${w.isRule ? '' : ', cheaper than the rule route'}`
    : `learned: nothing reached ${Math.round(threshold * 100)}% yet; ${w.engine.name} ${w.engine.models[w.tier]}·${w.effort} is the best so far (${record})`;
  return {
    ...rule,
    engine: w.engine.id,
    tier: w.tier,
    model: w.engine.models[w.tier],
    effort: w.effort,
    maxBudgetUsd: budgetForTier(w.tier),
    reason,
  };
}
