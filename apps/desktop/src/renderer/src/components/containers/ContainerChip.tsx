import type { CardContainer } from '@insectoids/shared';
import { Box, Hourglass, type LucideIcon, ShieldQuestion } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHIP_WORDS, SOURCE_WORDS, STATE_MEANS } from './words';

const ICON: Record<CardContainer['state'], LucideIcon> = { container: Box, waiting: Hourglass, suggested: ShieldQuestion };
/** The border and icon carry the state's colour; the words always say it too (never colour alone). */
const TONE: Record<CardContainer['state'], { border: string; icon: string }> = {
  container: { border: 'border-honey/60', icon: 'text-honey-text' },
  waiting: { border: 'border-st-waiting/60', icon: 'text-st-waiting' },
  suggested: { border: 'border-line', icon: 'text-muted' },
};

/**
 * "In a container" / "Waiting for containers" / "Container suggested" (Phase 4 D2): a status chip in the app's own
 * style, next to HeldBadge on the card (custom, like HeldBadge). The words are the chip's content, so a screen
 * reader reads them as they are; on the Taskboard the card face is hidden from screen readers and the card button's
 * name carries the same words instead (see containerLabel).
 */
export function ContainerChip({ container, compact = false }: { container: CardContainer; compact?: boolean }) {
  const Icon = ICON[container.state];
  const tone = TONE[container.state];
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 self-start rounded-[10px] border bg-surface text-text',
        tone.border,
        compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
      )}
      data-source={container.source}
      data-state={container.state}
      data-testid="card-container"
      title={compact ? container.reason : undefined}
    >
      <Icon aria-hidden="true" className={cn('shrink-0', tone.icon, compact ? 'size-3' : 'size-3.5')} />
      <span className="min-w-0 truncate font-semibold">{CHIP_WORDS[container.state]}</span>
    </span>
  );
}

/** The sentence a card button's accessible name gets, e.g. "In a container: The Queen marked it: it installs packages." */
export const containerLabel = (c: CardContainer | null): string => (c ? ` ${CHIP_WORDS[c.state]}: ${c.reason}` : '');

/** The detail view: the chip, the hive's reason in its words, who asked, and what it means for the card. */
export function ContainerDetail({ container }: { container: CardContainer }) {
  return (
    <section aria-label="Container" className="flex flex-col gap-1.5" data-testid="card-container-detail">
      <div className="text-xs text-muted">Container</div>
      <ContainerChip container={container} />
      <p className="m-0 text-sm" data-testid="card-container-reason">
        {container.reason}
      </p>
      <p className="m-0 text-xs text-muted">
        {SOURCE_WORDS[container.source]}. {STATE_MEANS[container.state]}
      </p>
    </section>
  );
}
