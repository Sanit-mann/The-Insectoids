import { CasteSchema, type EngineCard, type SampleEstimate } from '@insectoids/shared';
import { SAMPLE_GOAL_TEXT } from './practice-project';

/**
 * The sample goal's cost estimate (Onboarding 08-D8; Phase 2 C5), shown before anything runs. Plain code:
 * from this hive's own past runs when there are enough, or a typical small goal otherwise.
 */
export interface PastRun {
  role: string;
  engine: string | null;
  tokens: number;
  costUsd: number;
}

/** A small goal: one Queen plan, about one insect card and one inspection; the high end allows retries. */
export const TYPICAL_SMALL_GOAL = { low: 30_000, high: 150_000 } as const;
const LOW_FACTOR = 0.8;
const HIGH_FACTOR = 2.5;
/** Past runs needed per role (Queen, insect, Inspector) before the hive trusts its own numbers. */
export const MIN_RUNS_PER_ROLE = 2;
/** Engines on a subscription: no per-token price, the run counts toward the plan's limits. */
const SUBSCRIPTION = new Set(['claude', 'gemini', 'codex']);
const CASTES = new Set<string>(CasteSchema.options);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const roundTo = (n: number, step: number): number => Math.max(step, Math.round(n / step) * step);
const cents = (usd: number): number => Math.round(usd * 100) / 100;

export function estimateSample(i: {
  runs: readonly PastRun[];
  /** The hive's default engine card, or null when none is ready. */
  engine: Pick<EngineCard, 'id' | 'name' | 'state'> | null;
  /** A goal is planning, waiting for approval or running. */
  busy: boolean;
  practicePath: string;
}): SampleEstimate {
  const used = i.runs.filter((r) => r.tokens > 0);
  const byRole = (match: (role: string) => boolean): number[] => used.filter((r) => match(r.role)).map((r) => r.tokens);
  const queen = byRole((r) => r === 'queen');
  // Insect runs are listed by their caste (the Treasurer's routing history), or as "insect".
  const insect = byRole((r) => r === 'insect' || CASTES.has(r));
  const inspector = byRole((r) => r === 'inspector');
  const enough = [queen, insect, inspector].every((xs) => xs.length >= MIN_RUNS_PER_ROLE);

  let low: number = TYPICAL_SMALL_GOAL.low;
  let high: number = TYPICAL_SMALL_GOAL.high;
  let basis = 'a typical small goal (this hive has too few runs of its own to go by yet)';
  if (enough) {
    const base = median(queen) + median(insect) + median(inspector);
    low = roundTo(base * LOW_FACTOR, 1_000);
    high = roundTo(base * HIGH_FACTOR, 1_000);
    const n = queen.length + insect.length + inspector.length;
    basis = `from this hive's last ${n} runs (one plan, one card and one check; the high end allows for retries)`;
  }

  const engine = i.engine;
  let costUsdLow: number | null = null;
  let costUsdHigh: number | null = null;
  let note: string;
  if (!engine) note = 'No AI engine is ready yet, so nothing can run.';
  else if (engine.state === 'fake' || engine.id === 'fake') note = 'The scripted test engine runs this: it spends no tokens and costs nothing.';
  else if (SUBSCRIPTION.has(engine.id)) note = `Uses your ${engine.name} subscription; no extra charge, it counts toward its usage limits.`;
  else {
    // API providers bill per token: price it from this engine's own past runs when they reported a cost.
    const priced = used.filter((r) => r.engine === engine.id && r.costUsd > 0);
    const tokens = priced.reduce((s, r) => s + r.tokens, 0);
    const cost = priced.reduce((s, r) => s + r.costUsd, 0);
    if (tokens > 0 && cost > 0) {
      const perToken = cost / tokens;
      costUsdLow = cents(low * perToken);
      costUsdHigh = Math.max(costUsdLow, cents(high * perToken));
      note = `Billed by your API provider per token, at about $${cents(perToken * 1_000_000)} per million tokens (from past runs).`;
    } else {
      note = 'Billed by your API provider per token. The hive has no past runs on it to price this yet.';
    }
  }

  let reason: string | null = null;
  if (!engine) reason = 'No AI engine is ready yet. Connect one on the Engines step first.';
  else if (i.busy) reason = 'The hive is working on a goal right now. Try the sample goal when it is idle.';

  return {
    goalText: SAMPLE_GOAL_TEXT,
    practicePath: i.practicePath,
    engine: engine?.name ?? null,
    tokensLow: low,
    tokensHigh: Math.max(low, high),
    costUsdLow,
    costUsdHigh,
    basis,
    note,
    canRun: reason === null,
    reason,
  };
}
