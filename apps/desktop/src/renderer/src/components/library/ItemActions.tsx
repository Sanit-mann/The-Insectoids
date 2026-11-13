import type { HiveCommand, LibraryItemView } from '@insectoids/shared';
import { Archive, Check, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { decide } from '@/components/approvals/kinds';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand } from '@/lib/hive-store';

/**
 * What the user can do with one item (C3):
 * - a draft (learned or imported) waiting for approval: Approve / Deny. A clean scan needs a click; a scan
 *   that needs a look needs a deliberate hold; a blocked one can't be approved at all (only turned down).
 * - a retirement the hive proposed: Retire it / Keep it.
 * - a ready item: Retire (hold). A retired one: Bring it back.
 * Caste defaults (active) and dormant items have no actions here.
 */
export function ItemActions({ item, onChanged }: { item: LibraryItemView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (fn: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    fn()
      .then(onChanged)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const command = (cmd: HiveCommand) => async (): Promise<void> => {
    const r = await runCommand(cmd);
    if (!r.ok) throw new Error(r.error);
  };
  const approval = (approve: boolean) => async (): Promise<void> => {
    if (item.approvalId) await decide({ id: item.approvalId }, approve);
  };

  let body: ReactNode = null;
  let note: string | null = null;
  if (item.status === 'draft') {
    const verdict = item.scan?.verdict ?? 'clean';
    if (!item.approvalId) {
      note = verdict === 'blocked' ? 'It stays here so you can see why. Nothing will ever switch it on.' : 'Not waiting for an approval.';
    } else if (verdict === 'blocked') {
      note = 'It stays here so you can see why. Nothing will ever switch it on.';
      body = (
        <Button data-testid="draft-deny" disabled={busy} onClick={() => act(approval(false))} variant="outline">
          <X aria-hidden="true" /> Turn it down
        </Button>
      );
    } else {
      body = (
        <div className="flex flex-wrap items-center gap-2">
          {verdict === 'warn' ? (
            <HoldButton
              aria-label={`Hold to approve ${item.name}`}
              completeLabel="Approved"
              data-testid="draft-approve"
              disabled={busy}
              holdingLabel="Keep holding"
              icon={ShieldCheck}
              onHoldComplete={() => act(approval(true))}
              resetAfter={1500}
            >
              Hold to approve
            </HoldButton>
          ) : (
            <Button data-testid="draft-approve" disabled={busy} onClick={() => act(approval(true))}>
              <Check aria-hidden="true" /> Approve
            </Button>
          )}
          <Button data-testid="draft-deny" disabled={busy} onClick={() => act(approval(false))} variant="outline">
            <X aria-hidden="true" /> Deny
          </Button>
        </div>
      );
      note = verdict === 'warn' ? 'Read the findings first: approving needs a hold.' : 'Approving makes it Ready: the hive may switch it on for a card that needs it.';
    }
  } else if (item.approvalId && (item.status === 'ready' || item.status === 'active')) {
    note = 'The hive proposes retiring it. It also waits for your OK in Approvals.';
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <Button data-testid="draft-approve" disabled={busy} onClick={() => act(approval(true))} variant="outline">
          <Archive aria-hidden="true" /> Retire it
        </Button>
        <Button data-testid="draft-deny" disabled={busy} onClick={() => act(approval(false))} variant="outline">
          <X aria-hidden="true" /> Keep it
        </Button>
      </div>
    );
  } else if (item.status === 'ready') {
    note = 'Retired items are never switched on; you can bring them back.';
    body = (
      <HoldButton
        aria-label={`Hold to retire ${item.name}`}
        className="self-start"
        completeLabel="Retired"
        data-testid="item-retire"
        disabled={busy}
        holdingLabel="Keep holding"
        icon={Archive}
        onHoldComplete={() => act(command({ type: 'retireLibraryItem', name: item.name }))}
        resetAfter={1500}
        variant="danger"
      >
        Hold to retire
      </HoldButton>
    );
  } else if (item.status === 'retired') {
    body = (
      <Button className="self-start" data-testid="item-restore" disabled={busy} onClick={() => act(command({ type: 'restoreLibraryItem', name: item.name }))} variant="outline">
        <RotateCcw aria-hidden="true" /> Bring it back
      </Button>
    );
  }

  if (!body && !note && !error) return null;
  return (
    <section aria-label="Actions" className="flex flex-col gap-2">
      {body}
      {note ? <p className="m-0 text-xs text-muted">{note}</p> : null}
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="That didn't work" tone="error" /> : null}
    </section>
  );
}
