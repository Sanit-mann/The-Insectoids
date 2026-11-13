import { CirclePause } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * "Paused by the Watchdog" (C2, breaker step "pause the card"): the card is held until the Foreman
 * decides. Icon + words, never colour alone. Custom (a status chip in the app's own style).
 */
export function HeldBadge({ reason, compact = false }: { reason: string; compact?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-start gap-1.5 rounded-[10px] border border-st-paused/60 bg-surface text-text',
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1.5 text-xs',
      )}
      data-testid="card-held"
      title={compact ? reason : undefined}
    >
      <CirclePause aria-hidden="true" className={cn('mt-px shrink-0 text-st-paused', compact ? 'size-3' : 'size-3.5')} />
      <span className={cn('min-w-0', compact && 'truncate')}>
        <span className="font-semibold">Paused by the Watchdog</span>
        {compact ? null : <span className="text-muted">: {reason}</span>}
      </span>
    </span>
  );
}
