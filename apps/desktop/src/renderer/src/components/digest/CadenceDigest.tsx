import { ChevronDown, Sunrise } from 'lucide-react';
import { useId, useState } from 'react';
import { useNow } from '@/components/hive/useNow';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { AwayDigest } from './AwayDigest';
import { useDigest } from './useDigest';

/**
 * The Cadence screen's digest view (App 07; Phase 3 B1): the same "while you were away" digest as the dialog,
 * folded open under a button. "Got it" here marks it read too.
 */
export function CadenceDigest() {
  const { snapshot } = useHive();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const digest = useDigest(expanded);
  const now = useNow(30_000);
  const panelId = useId();
  const unseen = digest.view?.unseen ?? snapshot?.digest.unseen ?? false;

  const gotIt = async (): Promise<void> => {
    setBusy(true);
    const r = await runCommand({ type: 'markDigestSeen' });
    setBusy(false);
    setMarkError(r.ok ? null : r.error);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-controls={panelId}
          aria-expanded={expanded}
          data-testid="cadence-digest-toggle"
          data-unseen={unseen}
          onClick={() => setExpanded((e) => !e)}
          variant="outline"
        >
          <Sunrise aria-hidden="true" />
          While you were away
          {unseen ? (
            <>
              <span aria-hidden="true" className="size-2 rounded-full bg-honey" />
              <span className="sr-only"> (new)</span>
            </>
          ) : null}
          <ChevronDown aria-hidden="true" className={cn('transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
        </Button>
        {!expanded && snapshot?.digest.headline ? <span className="min-w-0 text-sm text-muted">{snapshot.digest.headline}</span> : null}
      </div>

      {expanded ? (
        <section aria-label="While you were away" className="flex flex-col gap-3 rounded-2xl border border-line bg-rail p-4" data-testid="cadence-digest" id={panelId}>
          {digest.error ? (
            <InlineAlert actions={[{ label: 'Try again', onClick: digest.retry, primary: true }]} message={digest.error} title="Couldn't read the digest" tone="error" />
          ) : null}
          {digest.view ? (
            <AwayDigest now={now} view={digest.view} />
          ) : !digest.error ? (
            <p aria-busy="true" className="m-0 text-sm text-muted" role="status">
              Reading what happened…
            </p>
          ) : null}
          {markError ? <InlineAlert message={markError} onDismiss={() => setMarkError(null)} title="Couldn't mark it as read" tone="error" /> : null}
          {unseen ? (
            <div className="flex justify-end">
              <Button disabled={busy} onClick={() => void gotIt()}>
                Got it
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
