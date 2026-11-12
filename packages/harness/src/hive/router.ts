import type { Caste, Priority } from '@insectoids/shared';
import type { Effort } from '../claude/args';
import type { Usage } from '../claude/stream';

/** The user's models by tier, in the engine's own names (e.g. Claude Code aliases). */
export interface ModelTiers {
  strongest: string;
  standard: string;
  light: string;
}

export interface RouteInput {
  role: 'queen' | 'inspector' | Caste;
  priority: Priority;
  /** Failed attempts so far on this card. */
  attempts: number;
}

export interface Route {
  model: string;
  effort: Effort;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
}

const TIERS = ['light', 'standard', 'strongest'] as const;
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'max'];
const MIN = 60_000;

/**
 * Treasurer's model + effort router (Hive 02-D9 P1), rule-based for Phase 1:
 * pick by role and priority, then on each retry raise effort first and the model tier next.
 * Learning from outcomes comes in Phase 2.
 */
export function routeCard(input: RouteInput, models: ModelTiers): Route {
  if (input.role === 'queen') return { model: models.strongest, effort: 'high', maxTurns: 30, maxBudgetUsd: 3, timeoutMs: 15 * MIN };

  let tier: number;
  let effort: number;
  if (input.role === 'inspector') {
    tier = 1;
    effort = input.priority === 'critical' || input.priority === 'high' ? 2 : 1;
  } else {
    [tier, effort] = ({ critical: [2, 2], high: [1, 2], normal: [1, 1], low: [0, 0] } as const)[input.priority];
  }
  for (let a = 0; a < input.attempts; a++) {
    if (effort < 2) effort++;
    else if (tier < 2) tier++;
    else if (effort < 3) effort++;
  }
  const tierName = TIERS[tier]!;
  return {
    model: models[tierName],
    effort: EFFORTS[effort]!,
    maxTurns: input.role === 'inspector' ? 30 : 40,
    maxBudgetUsd: tierName === 'strongest' ? 5 : tierName === 'standard' ? 2 : 0.5,
    timeoutMs: 20 * MIN,
  };
}

/** Tokens a run used for budgeting. Cache reads are a small fraction of the price and are left out. */
export function runTokens(u: Usage): number {
  return u.input + u.output + u.cacheWrite;
}

export type BudgetState = 'ok' | 'warn' | 'stop';

/** Treasurer reflex: warn at 75% of the goal's budget, stop new work at 100%. */
export function budgetState(spent: number, budget: number | null): BudgetState {
  if (!budget) return 'ok';
  if (spent >= budget) return 'stop';
  if (spent >= budget * 0.75) return 'warn';
  return 'ok';
}
