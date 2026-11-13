import { BookOpenCheck, Bot, CheckCircle2, FileText, Gavel, type LucideIcon, ListChecks, Megaphone, Trophy } from 'lucide-react';
import type { RecordKind, Trust } from '@insectoids/shared';

export const KINDS: ReadonlyArray<{ kind: RecordKind; label: string; icon: LucideIcon }> = [
  { kind: 'decision', label: 'Decision', icon: Gavel },
  { kind: 'fact', label: 'Fact', icon: CheckCircle2 },
  { kind: 'task', label: 'Task', icon: ListChecks },
  { kind: 'outcome', label: 'Outcome', icon: Trophy },
  { kind: 'file', label: 'File', icon: FileText },
  { kind: 'update', label: 'Update', icon: Megaphone },
  { kind: 'agent_memory', label: 'Agent memory', icon: Bot },
  { kind: 'lesson', label: 'Lesson', icon: BookOpenCheck },
];

export const kindInfo = (k: RecordKind) => KINDS.find((x) => x.kind === k) ?? KINDS[0]!;

/** Trust as words plus a status colour (Memory 01-D3; never colour-only). */
export const TRUST: Record<Trust, { label: string; hint: string; className: string }> = {
  confirmed: { label: 'Confirmed', hint: 'You confirmed this, or you wrote it.', className: 'border-st-done/50 text-st-done' },
  unconfirmed: { label: 'Unconfirmed', hint: 'An agent noted this; it is waiting for you to confirm.', className: 'border-st-waiting/50 text-st-waiting' },
  proposed: { label: 'Proposed', hint: 'An agent proposed this decision; it needs your approval.', className: 'border-st-paused/50 text-st-paused' },
};
