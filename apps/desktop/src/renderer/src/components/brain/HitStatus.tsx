import type { BrainHitView } from '@insectoids/shared';

/**
 * A search hit that is no longer current (Phase 2 B2): a fact replaced by a newer one, or a note that
 * faded into the archive. Shown as words, never colour alone.
 */
export function HitStatusBadge({ status }: { status: BrainHitView['status'] | undefined }) {
  if (!status || status === 'current') return null;
  const replaced = status === 'superseded';
  return (
    <span
      className="shrink-0 rounded-full border border-dashed border-line px-1.5 py-px text-[10.5px] font-medium text-muted"
      data-status={status}
      data-testid="hit-status"
      title={replaced ? 'Replaced by a newer record; kept as history' : 'Faded into the archive; kept as history'}
    >
      {replaced ? 'replaced' : 'faded'}
    </span>
  );
}
