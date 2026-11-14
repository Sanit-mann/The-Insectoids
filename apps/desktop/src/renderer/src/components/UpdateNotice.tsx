import { CircleArrowDown, RotateCw } from 'lucide-react';
import { openUpdatesSettings, useUpdates } from '@/lib/update-store';

/**
 * The small top-bar notice for a new version (Phase 3 C4): "Update ready" once it's downloaded, "Update available"
 * before that. It only opens Settings → Updates; it is never a modal and never in the way. The sr-only live region
 * stays in the page so screen readers hear it when it appears.
 */
export function UpdateNotice() {
  const { state } = useUpdates();
  const kind = state?.status === 'ready' ? 'ready' : state?.status === 'available' ? 'available' : null;
  const label = kind === 'ready' ? 'Update ready' : 'Update available';
  return (
    <>
      <span aria-live="polite" className="sr-only">
        {kind ? `${label}. Open it in Settings, Updates.` : ''}
      </span>
      {kind ? (
        <button
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-honey/60 bg-surface px-3.5 text-[13px] text-text outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-honey"
          data-status={kind}
          data-testid="update-notice"
          onClick={openUpdatesSettings}
          title={state?.message}
          type="button"
        >
          {kind === 'ready' ? <RotateCw aria-hidden="true" size={14} /> : <CircleArrowDown aria-hidden="true" size={14} />}
          {label}
        </button>
      ) : null}
    </>
  );
}
