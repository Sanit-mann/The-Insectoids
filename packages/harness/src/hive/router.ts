import type { Caste, EngineId, Priority } from '@insectoids/shared';
import type { Effort } from '../claude/args';
import type { Usage } from '../claude/stream';

/** The user's models by tier, in the engine's own names (e.g. Claude Code aliases). */
export interface ModelTiers {
  strongest: string;
  standard: string;
  light: string;
}

/**
 * Who runs: the Queen, the Inspector, a manager's brain (the Librarian, B3; the Scout and the Foreman, C2),
 * or an insect of a caste.
 */
export type AgentRole = 'queen' | 'inspector' | 'librarian' | 'scout' | 'foreman' | Caste;

const NOT_INSECTS: ReadonlySet<string> = new Set(['queen', 'inspector', 'librarian', 'scout', 'foreman']);

/** Insects work on cards; the Queen, the Inspector and the managers don't. */
export const isInsectRole = (role: AgentRole): boolean => !NOT_INSECTS.has(role);

/** The managers' brains (B3, C2): short read-only runs that never touch a card's work. */
export const isManagerRole = (role: AgentRole): boolean => role === 'librarian' || role === 'scout' || role === 'foreman';

export interface RouteInput {
  role: AgentRole;
  priority: Priority;
  /** Failed attempts so far on this card. */
  attempts: number;
  /** At least this model tier (the Foreman asked for a stronger model, C2). */
  minTier?: Tier;
}

export type Tier = 'light' | 'standard' | 'strongest';

export interface Route {
  /** Which engine runs it (Connections 04-D2). */
  engine: EngineId;
  /** Which of the engine's model tiers `model` is. */
  tier: Tier;
  model: string;
  effort: Effort;
  /** Why the Treasurer chose this, in plain words (shown on the Hive monitor lane). */
  reason: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
}

export const TIERS: readonly Tier[] = ['light', 'standard', 'strongest'];
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'max'];
const MIN = 60_000;

/** Per-run spending cap by tier (the engine stops the run past it). */
export const budgetForTier = (tier: Tier): number => (tier === 'strongest' ? 5 : tier === 'standard' ? 2 : 0.5);

function ruleReason(input: RouteInput): string {
  if (input.role === 'queen') return 'rule: the Queen plans on the strongest model';
  if (input.role === 'inspector') return `rule: inspecting a ${input.priority} priority card`;
  if (input.role === 'librarian') return 'rule: the Librarian reviews the Brain on the standard model, low effort';
  if (input.role === 'scout') return 'rule: the Scout surveys the code on the light model';
  if (input.role === 'foreman') return 'rule: the Foreman decides on the standard model, low effort';
  if (input.minTier) return `rule: the Foreman asked for the ${input.minTier} model`;
  if (input.attempts > 0) return `rule: retry ${input.attempts}, so more effort or a stronger model`;
  return `rule: ${input.priority} priority card`;
}

/**
 * Treasurer's model + effort router (Hive 02-D9 P1), rule-based for Phase 1:
 * pick by role and priority, then on each retry raise effort first and the model tier next.
 * Learning from outcomes comes in Phase 2.
 */
export function routeCard(input: RouteInput, models: ModelTiers, engine: EngineId = 'claude'): Route {
  if (input.role === 'queen') {
    return { engine, tier: 'strongest', model: models.strongest, effort: 'high', reason: ruleReason(input), maxTurns: 30, maxBudgetUsd: 3, timeoutMs: 15 * MIN };
  }

  if (input.role === 'librarian') {
    // A short, read-only review of a compact audit summary: the standard tier at low effort is plenty.
    return { engine, tier: 'standard', model: models.standard, effort: 'low', reason: ruleReason(input), maxTurns: 12, maxBudgetUsd: 1, timeoutMs: 10 * MIN };
  }

  if (input.role === 'scout') {
    // A read-only survey from a code-map outline: the light tier is enough (scout AGENT.md: min_tier light).
    return { engine, tier: 'light', model: models.light, effort: 'medium', reason: ruleReason(input), maxTurns: 15, maxBudgetUsd: 0.5, timeoutMs: 10 * MIN };
  }
  if (input.role === 'foreman') {
    // One short decision or review over a compact summary.
    return { engine, tier: 'standard', model: models.standard, effort: 'low', reason: ruleReason(input), maxTurns: 6, maxBudgetUsd: 1, timeoutMs: 10 * MIN };
  }

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
  if (input.minTier) tier = Math.max(tier, TIERS.indexOf(input.minTier));
  const tierName = TIERS[tier]!;
  return {
    engine,
    tier: tierName,
    model: models[tierName],
    effort: EFFORTS[effort]!,
    reason: ruleReason(input),
    maxTurns: input.role === 'inspector' ? 30 : 40,
    maxBudgetUsd: budgetForTier(tierName),
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
  /** Its subscription hit a limit (the vendor's, or the user's own cap): don't route to it (04-D7). */
  exhausted?: boolean;
  /** Near the user's cap: use it only when no other engine qualifies. */
  near?: boolean;
}

/** Roles that never change files or run side-effecting commands: an engine limited to read-only work may take them. */
const READ_ONLY_ROLES: ReadonlySet<RouteInput['role']> = new Set(['queen', 'librarian', 'scout', 'foreman', 'reviewer', 'researcher', 'analyst']);

export const isReadOnlyRole = (role: RouteInput['role']): boolean => READ_ONLY_ROLES.has(role);

/**
 * Which engine runs a card (Phase 2 A1: the first enabled, ready engine in the user's order;
 * per-caste routing and learning from outcomes come in A5).
 * Never a disabled or not-ready engine, never one without a guard, and never a read-only engine for work
 * that changes files. Null when no engine qualifies.
 */
export function pickEngine(role: RouteInput['role'], candidates: readonly EngineCandidate[]): EngineId | null {
  const usable = allowedEngines(role, candidates);
  return (usable.find((c) => !c.near) ?? usable[0])?.id ?? null;
}

/**
 * Engines that may take a role at all, in the user's order: enabled, ready, guarded, not exhausted, and not
 * read-only for work that changes files. The learning router only ever chooses among these.
 */
export function allowedEngines(role: RouteInput['role'], candidates: readonly EngineCandidate[]): EngineCandidate[] {
  return candidates.filter((c) => c.enabled && c.ready && c.guard && !c.exhausted && !(c.guard === 'read-only' && !isReadOnlyRole(role)));
}
