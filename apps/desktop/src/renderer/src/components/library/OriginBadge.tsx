import type { LibraryItemView } from '@insectoids/shared';
import { ORIGIN } from './vocab';

/** Where an item came from (C3): Built in / Learned by the hive / Imported by you, as icon + words. */
export function OriginBadge({ origin }: { origin: LibraryItemView['origin'] }) {
  const o = ORIGIN[origin];
  const Icon = o.icon;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 text-xs leading-5 text-muted" data-origin={origin} data-testid="origin-badge">
      <Icon aria-hidden="true" className="size-3" />
      {o.label}
    </span>
  );
}
