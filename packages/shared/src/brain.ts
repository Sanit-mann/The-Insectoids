import { z } from 'zod';

/** Kinds of Brain records (Memory 01, "Proposed design" tables). */
export const RecordKindSchema = z.enum(['file', 'decision', 'task', 'update', 'fact', 'agent_memory', 'outcome']);
export type RecordKind = z.infer<typeof RecordKindSchema>;

/** Trust levels (Memory 01-D3). */
export const TrustSchema = z.enum(['confirmed', 'unconfirmed', 'proposed']);
export type Trust = z.infer<typeof TrustSchema>;
