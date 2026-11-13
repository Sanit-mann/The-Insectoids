import type { LibraryStatus } from '@insectoids/shared';
import { cn } from '@/lib/utils';
import { STATUS } from './vocab';

/** Status as icon + word (never colour alone). */
export function StatusBadge({ status }: { status: LibraryStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 text-xs leading-5', s.className)} data-testid="library-status" title={s.explain}>
      <Icon aria-hidden="true" className="size-3" />
      {s.label}
    </span>
  );
}
