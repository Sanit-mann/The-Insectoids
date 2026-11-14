import type { HiveSnapshot } from '@insectoids/shared';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Name of the cadence that started a goal, or null for the user's own goals (and deleted cadences). */
export function cadenceName(snap: HiveSnapshot | null, cadenceId: string | null): string | null {
  if (!cadenceId) return null;
  return snap?.cadences.find((c) => c.id === cadenceId)?.name ?? 'a removed cadence';
}

/** "From cadence: Weekly report": marks goals the hive started on a schedule (Phase 3 A1). */
export function FromCadence({ snap, cadenceId, className }: { snap: HiveSnapshot | null; cadenceId: string | null; className?: string }) {
  const name = cadenceName(snap, cadenceId);
  if (!name) return null;
  return (
    <span
      className={cn('inline-flex min-h-6 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 text-xs text-muted', className)}
      data-testid="from-cadence"
    >
      <Clock aria-hidden="true" className="size-3.5 text-honey-text" />
      From cadence: <span className="font-medium text-text">{name}</span>
    </span>
  );
}
