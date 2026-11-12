import type { Caste, EngineId, Priority } from '@insectoids/shared';
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
  /** Which engine runs it (Connections 04-D2). */
  engine: EngineId;
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
export function routeCard(input: RouteInput, models: ModelTiers, engine: EngineId = 'claude'): Route {
  if (input.role === 'queen') return { engine, model: models.strongest, effort: 'high', maxTurns: 30, maxBudgetUsd: 3, timeoutMs: 15 * MIN };

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
    engine,
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

/** How an engine's runs are kept behind the command guard (see EngineCard.guard). */
export type GuardKind = 'hook' | 'policy-and-tools' | 'read-only';

/** One engine as the router sees it, in the user's preference order. */
export interface EngineCandidate {
  id: EngineId;
  enabled: boolean;
  /** Ready to run now (signed in, supported version), or the scripted test engine. */
  ready: boolean;
  guard: GuardKind | null;
}

/** Roles that never change files or run side-effecting commands: an engine limited to read-only work may take them. */
const READ_ONLY_ROLES: ReadonlySet<RouteInput['role']> = new Set(['queen', 'reviewer', 'researcher', 'analyst']);

export const isReadOnlyRole = (role: RouteInput['role']): boolean => READ_ONLY_ROLES.has(role);

/**
 * Which engine runs a card (Phase 2 A1: the first enabled, ready engine in the user's order;
 * per-caste routing and learning from outcomes come in A5).
 * Never a disabled or not-ready engine, never one without a guard, and never a read-only engine for work
 * that changes files. Null when no engine qualifies.
 */
export function pickEngine(role: RouteInput['role'], candidates: readonly EngineCandidate[]): EngineId | null {
  for (const c of candidates) {
    if (!c.enabled || !c.ready || !c.guard) continue;
    if (c.guard === 'read-only' && !isReadOnlyRole(role)) continue;
    return c.id;
  }
  return null;
}
