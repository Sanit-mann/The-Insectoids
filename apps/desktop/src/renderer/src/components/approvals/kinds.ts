import type { ApprovalKind, ApprovalView } from '@insectoids/shared';
import { Archive, CalendarClock, Download, FileCheck2, GitMerge, Lightbulb, type LucideIcon, Map as MapIcon, ShieldAlert, Sparkles, Webhook } from 'lucide-react';
import { runCommand } from '@/lib/hive-store';

/** Plain labels and icons for each approval kind (App 07 approval inbox filter chips). */
export const KIND_META: Record<ApprovalKind, { label: string; plural: string; icon: LucideIcon }> = {
  plan: { label: 'Plan', plural: 'Plans', icon: MapIcon },
  risky_action: { label: 'Risky action', plural: 'Risky actions', icon: ShieldAlert },
  merge: { label: 'Merge', plural: 'Merges', icon: GitMerge },
  decision: { label: 'Decision', plural: 'Decisions', icon: Lightbulb },
  fact: { label: 'Fact', plural: 'Facts', icon: FileCheck2 },
  schedule: { label: 'Schedule', plural: 'Schedules', icon: CalendarClock },
  skill_proposal: { label: 'New skill from repeated work', plural: 'New skills', icon: Sparkles },
  skill_import: { label: 'Imported skill or agent', plural: 'Imports', icon: Download },
  skill_retirement: { label: 'Retire a skill', plural: 'Retirements', icon: Archive },
  webhook: { label: 'Webhook call', plural: 'Webhook calls', icon: Webhook },
};

/** Approvals about a library item: they get an "Open in the Library" link (C3). */
export const LIBRARY_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>(['skill_proposal', 'skill_import', 'skill_retirement']);

export const KIND_ORDER: ApprovalKind[] = ['plan', 'risky_action', 'merge', 'decision', 'fact', 'schedule', 'skill_proposal', 'skill_import', 'skill_retirement', 'webhook'];

/** Approvals from a webhook cadence (A4): they get an "Open Cadence" link. */
export const CADENCE_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>(['webhook']);

/** Approve or deny; throws with the hive's message so the caller can show it. */
export async function decide(a: Pick<ApprovalView, 'id'>, approve: boolean): Promise<void> {
  const r = await runCommand(approve ? { type: 'approve', approvalId: a.id } : { type: 'deny', approvalId: a.id });
  if (!r.ok) throw new Error(r.error);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
/** "2 min ago", "yesterday". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.round((at - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86_400), 'day');
}
