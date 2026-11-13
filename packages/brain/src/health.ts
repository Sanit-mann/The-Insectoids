import type { BrainHealth } from '@insectoids/shared';
import type { HealthCounts } from './brain';

/**
 * Brain health score (Memory 01-E12; Phase 2 B3): 100 minus capped penalties, floored at 0.
 * Each part costs at most its cap, so one problem can't hide the others.
 *
 * | Part       | Counts                                                          | Penalty                 | Cap |
 * |------------|-----------------------------------------------------------------|-------------------------|-----|
 * | stale      | current records unused for 90+ days                             | 0.4 per % of records    | 25  |
 * | waiting    | proposals and unconfirmed facts/decisions waiting for the user  | 2 per item              | 20  |
 * | orphans    | never read, no links, older than 30 days                        | 0.3 per % of records    | 15  |
 * | unused     | never read, older than 30 days                                  | 0.25 per % of records   | 15  |
 * | duplicates | near-duplicate pairs only the user can merge                    | 3 per pair              | 15  |
 * | lessons    | unconfirmed lessons older than 14 days                          | 2 per lesson            | 10  |
 */
export const HEALTH_WEIGHTS = {
  stale: { perPercent: 0.4, cap: 25 },
  waiting: { perItem: 2, cap: 20 },
  orphans: { perPercent: 0.3, cap: 15 },
  unused: { perPercent: 0.25, cap: 15 },
  duplicates: { perItem: 3, cap: 15 },
  lessons: { perItem: 2, cap: 10 },
} as const;

const capped = (v: number, cap: number): number => Math.min(cap, Math.round(v * 10) / 10);
const pct = (n: number, total: number): number => (total ? (n / total) * 100 : 0);

export function brainHealth(counts: HealthCounts, duplicates: number, lastAuditAt: number | null): BrainHealth {
  if (lastAuditAt === null) {
    return { score: null, parts: [], total: counts.total, lastAuditAt: null, message: 'The Librarian has not checked the Brain yet.' };
  }
  const w = HEALTH_WEIGHTS;
  const parts: BrainHealth['parts'] = [
    {
      id: 'stale',
      label: 'Not used in 90 days',
      count: counts.stale,
      penalty: capped(pct(counts.stale, counts.total) * w.stale.perPercent, w.stale.cap),
      hint: 'Old notes nobody reads. Agent notes fade on their own; check whether your own ones are still true.',
    },
    {
      id: 'waiting',
      label: 'Waiting for you',
      count: counts.waiting,
      penalty: capped(counts.waiting * w.waiting.perItem, w.waiting.cap),
      hint: 'Facts and decisions agents proposed. Confirm the true ones so every agent can rely on them.',
    },
    {
      id: 'orphans',
      label: 'Unlinked and unread',
      count: counts.orphans,
      penalty: capped(pct(counts.orphans, counts.total) * w.orphans.perPercent, w.orphans.cap),
      hint: 'Notes with no links that no agent has read. Often safe to archive.',
    },
    {
      id: 'unused',
      label: 'Never read',
      count: counts.unused,
      penalty: capped(pct(counts.unused, counts.total) * w.unused.perPercent, w.unused.cap),
      hint: 'Saved but never used by an agent in a month or more.',
    },
    {
      id: 'duplicates',
      label: 'Near-duplicates',
      count: duplicates,
      penalty: capped(duplicates * w.duplicates.perItem, w.duplicates.cap),
      hint: 'Almost the same note twice, one of them yours. The Librarian can propose merging them.',
    },
    {
      id: 'lessons',
      label: 'Lessons to check',
      count: counts.lessons,
      penalty: capped(counts.lessons * w.lessons.perItem, w.lessons.cap),
      hint: 'Lessons learned from failed work. Confirm the useful ones; retire the rest.',
    },
  ];
  const score = Math.max(0, Math.round(100 - parts.reduce((sum, p) => sum + p.penalty, 0)));
  const worst = [...parts].sort((a, b) => b.penalty - a.penalty)[0];
  const message =
    score >= 90 || !worst || worst.penalty === 0
      ? 'The Brain is in good shape.'
      : score >= 70
        ? `Mostly tidy. Biggest item: ${worst.label.toLowerCase()} (${worst.count}).`
        : `Needs some care. Biggest item: ${worst.label.toLowerCase()} (${worst.count}).`;
  return { score, parts, total: counts.total, lastAuditAt, message };
}
