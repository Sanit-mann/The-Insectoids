import { z } from 'zod';

/** What the user is asked to approve (Hive 02-D7, Memory 01-D3, Cadence 05-D3, Workspace 06-D3). */
export const ApprovalKindSchema = z.enum(['plan', 'risky_action', 'merge', 'decision', 'fact', 'schedule']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum(['waiting', 'approved', 'denied']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  kind: ApprovalKindSchema,
  title: z.string().min(1),
  from: z.string().min(1),
  whyItNeedsYou: z.string().min(1),
  ifYouSayYes: z.string().min(1),
  /** Destructive approvals use hold-to-approve in the UI. */
  destructive: z.boolean().default(false),
  status: ApprovalStatusSchema.default('waiting'),
  createdAt: z.number().int(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
