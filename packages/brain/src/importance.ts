import type { Trust } from '@insectoids/shared';

/**
 * How much a record matters right now (Memory 01-E7; Phase 2 B2), 0..1. One documented formula:
 *
 *   base       = 0.5 · recency + 0.3 · frequency + 0.2 · helped
 *   recency    = 0.5 ^ (days since last use or last change / HALF_LIFE_DAYS)      (freshness half-life)
 *   frequency  = min(1, log2(1 + reads) / log2(1 + FREQUENT_READS))               (log-scaled reads)
 *   helped     = 1 − 0.5 ^ helped                                                  (1 → 0.5, 2 → 0.75, 3 → 0.875)
 *   importance = base · trust weight · confidence
 *   trust weight: confirmed 1.0, unconfirmed 0.8, proposed 0.7; confidence 0..1 when set, else 1.
 *
 * Ideas from the ruvector review (Phase 2 research note): importance = recency + frequency + fit, and a
 * trust weight = confidence × reliability × freshness half-life.
 */
export const HALF_LIFE_DAYS = 30;
/** Reads at which frequency saturates. */
export const FREQUENT_READS = 32;
const DAY = 86_400_000;

const TRUST_WEIGHT: Record<Trust, number> = { confirmed: 1, unconfirmed: 0.8, proposed: 0.7 };

export interface ImportanceInput {
  trust: Trust;
  confidence: number | null;
  reads: number;
  helped: number;
  lastUsedAt: number | null;
  updatedAt: number;
}

export function importance(r: ImportanceInput, now: number): number {
  const last = Math.max(r.lastUsedAt ?? 0, r.updatedAt);
  const days = Math.max(0, (now - last) / DAY);
  const recency = 0.5 ** (days / HALF_LIFE_DAYS);
  const frequency = Math.min(1, Math.log2(1 + Math.max(0, r.reads)) / Math.log2(1 + FREQUENT_READS));
  const helped = 1 - 0.5 ** Math.max(0, r.helped);
  const base = 0.5 * recency + 0.3 * frequency + 0.2 * helped;
  const confidence = r.confidence === null ? 1 : Math.min(1, Math.max(0, r.confidence));
  return Math.min(1, Math.max(0, base * TRUST_WEIGHT[r.trust] * confidence));
}

/**
 * Search ranking (B2): the fused relevance score scaled by importance, so relevance still leads and,
 * between similarly relevant records, the one that is used, fresh and trusted comes first.
 */
export const rankScore = (relevance: number, imp: number): number => relevance * (0.7 + 0.3 * imp);
