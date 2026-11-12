import { z } from 'zod';
import { CasteSchema, PrioritySchema } from './hive';

/**
 * Task card lifecycle (Hive 02-D10):
 * open -> claimed -> in_progress -> (blocked) -> review -> done | failed.
 * Only the Inspector's review leads to done.
 */
export const TaskStatusSchema = z.enum(['open', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskCardSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  wave: z.number().int().positive(),
  title: z.string().min(1),
  /** Built by the Brain (Memory 01-E4). */
  brief: z.string(),
  caste: CasteSchema,
  priority: PrioritySchema,
  /** "Done means" criteria; at least one is required. */
  acceptance: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).default([]),
  status: TaskStatusSchema.default('open'),
  claimedBy: z.string().optional(),
  /** Epoch ms when the current lease runs out. */
  leaseExpiresAt: z.number().int().optional(),
  attempts: z.number().int().nonnegative().default(0),
  result: z.string().optional(),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

const ALLOWED: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  open: ['claimed'],
  // back to open = lease expired or released
  claimed: ['in_progress', 'open'],
  in_progress: ['blocked', 'review', 'open', 'failed'],
  blocked: ['in_progress', 'open', 'failed'],
  // back to open = Inspector rejected it, retry
  review: ['done', 'open', 'failed'],
  done: [],
  failed: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Returns a new card in the target status. Throws on an illegal move. */
export function transition(card: TaskCard, to: TaskStatus): TaskCard {
  if (!canTransition(card.status, to)) {
    throw new Error(`Illegal task transition for ${card.id}: ${card.status} -> ${to}`);
  }
  const retry = card.status === 'review' && to === 'open';
  return { ...card, status: to, attempts: retry ? card.attempts + 1 : card.attempts };
}

/** A card can be pulled only when it is open and every dependency is done. */
export function isClaimable(card: TaskCard, doneIds: ReadonlySet<string>): boolean {
  return card.status === 'open' && card.dependsOn.every((id) => doneIds.has(id));
}
