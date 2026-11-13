import { z } from 'zod';

/** Kinds of Brain records (Memory 01, "Proposed design" tables). */
/** 'lesson' (Phase 2 B3, Memory 01-E10): "don't do X because Y", learned from failed or retried work. */
export const RecordKindSchema = z.enum(['file', 'decision', 'task', 'update', 'fact', 'agent_memory', 'outcome', 'lesson']);
export type RecordKind = z.infer<typeof RecordKindSchema>;

/** Trust levels (Memory 01-D3). */
export const TrustSchema = z.enum(['confirmed', 'unconfirmed', 'proposed']);
export type Trust = z.infer<typeof TrustSchema>;
