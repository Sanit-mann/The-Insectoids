import { type CadenceView, isScheduled } from '@insectoids/shared';
import { Clock, History, Pencil, Play, Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { type CadenceFields, CadenceForm } from '@/components/cadence/CadenceForm';
import { CadenceHistory } from '@/components/cadence/CadenceHistory';
import { WebhookPanel } from '@/components/cadence/WebhookPanel';
import { AUTONOMY, OUTCOME, PENDING_ICON, nextRunWords, runTime } from '@/components/cadence/cadence-words';
import { Switch } from '@/components/connections/Switch';
import { formatTokens } from '@/components/hive/format';
import { useNow } from '@/components/hive/useNow';
import { EmptyState } from '@/components/kokonutui/empty-state';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

/**
 * Cadence (Cadence 05; App 07; Phase 3 A1, A4): the hive works without being asked. Each cadence is
 * when + what + limits on this project; every run goes through the Queen like the user's own goals.
 * The list shows what is set up and when it runs next; the side shows the form or a cadence's runs (and, for a
 * webhook cadence, its address and secret).
 */

type Side = { kind: 'none' } | { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'history'; id: string };

function CadenceRow({
  c,
  now,
  selected,
  onEdit,
  onHistory,
  onError,
}: {
  c: CadenceView;
  now: number;
  selected: boolean;
  onEdit: () => void;
  onHistory: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (cmd: Parameters<typeof runCommand>[0]) => {
    setBusy(true);
    const r = await runCommand(cmd);
    setBusy(false);
    if (!r.ok) onError(r.error);
  };
  const last = c.lastRun ? OUTCOME[c.lastRun.outcome] : null;
  const LastIcon = last?.icon;

  return (
    <li
      aria-label={c.name}
      className={cn('flex flex-col gap-3 rounded-2xl border bg-surface p-4', selected ? 'border-honey' : 'border-line')}
      data-cadence-id={c.id}
      data-testid="cadence-row"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="m-0 truncate font-display text-[15px] font-semibold">{c.name}</h3>
          <p className="m-0 text-sm text-text" data-testid="cadence-when">
            {c.whenText}
          </p>
          <p className="m-0 font-mono text-xs text-muted" data-testid="cadence-next">
            {nextRunWords(c.when, c.nextRunAt, c.enabled, now)}
          </p>
        </div>
        <Switch
          checked={c.enabled}
          disabled={busy}
          label={isScheduled(c.when) ? `Run "${c.name}" on its schedule` : `Run "${c.name}" when it is triggered`}
          onChange={(on) => void act({ type: 'setCadenceEnabled', id: c.id, enabled: on })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5" data-testid="cadence-autonomy">
          <ShieldCheck aria-hidden="true" className="size-3.5 text-honey-text" />
          {AUTONOMY[c.autonomy].short}
        </span>
        <span>Budget {formatTokens(c.budgetTokens)} tokens a run</span>
        {c.pending ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-st-waiting" data-testid="cadence-pending">
            <PENDING_ICON aria-hidden="true" className="size-3.5" />
            Waiting to run
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5" data-testid="cadence-last-run">
          {last && LastIcon && c.lastRun ? (
            <>
              <LastIcon aria-hidden="true" className={cn('size-3.5', last.className)} />
              <span>
                Last run: <span className={cn('font-medium', last.className)}>{last.label}</span>, {runTime(c.lastRun.at, now)}
              </span>
            </>
          ) : (
            'Not run yet'
          )}
        </span>
      </div>

      <p className="m-0 line-clamp-2 text-sm text-muted">{c.goal}</p>

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void act({ type: 'runCadenceNow', id: c.id })} size="sm" variant="outline">
          <Play aria-hidden="true" />
          Run now
        </Button>
        <Button aria-pressed={selected} onClick={onHistory} size="sm" variant="ghost">
          <History aria-hidden="true" />
          Runs
        </Button>
        <Button onClick={onEdit} size="sm" variant="ghost">
          <Pencil aria-hidden="true" />
          Edit
        </Button>
      </div>
    </li>
  );
}

export function CadenceScreen() {
  const { snapshot, error, loading } = useHive();
  const now = useNow(30_000);
  const [side, setSide] = useState<Side>({ kind: 'none' });
  const [actionError, setActionError] = useState<string | null>(null);
  const cadences = snapshot?.cadences ?? [];
  const sideCadence = side.kind === 'edit' || side.kind === 'history' ? (cadences.find((c) => c.id === side.id) ?? null) : null;

  // A deleted cadence's panel simply stops showing (it needs sideCadence below).
  if (loading && !snapshot) return <p className="m-0 p-6 text-sm text-muted">Loading cadences…</p>;
  if (error && !snapshot) return <InlineAlert className="m-6" message={error} title="Couldn't read the hive" tone="error" />;

  if (!snapshot?.project) {
    return (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="cadence-screen">
        <EmptyState
          description="Cadences belong to a project: they run while it is the open project. Choose one on the Queen screen first."
          icon={Clock}
          title="Pick a project first"
        />
      </div>
    );
  }

  const save = async (input: CadenceFields, id: string | null): Promise<string | null> => {
    const r = await runCommand(id ? { type: 'updateCadence', id, cadence: input } : { type: 'createCadence', cadence: input });
    if (!r.ok) return r.error;
    setSide({ kind: 'none' });
    return null;
  };

  const del = async (id: string) => {
    const r = await runCommand({ type: 'deleteCadence', id });
    if (!r.ok) setActionError(r.error);
    else setSide({ kind: 'none' });
  };

  const showForm = side.kind === 'new' || (side.kind === 'edit' && sideCadence);

  return (
    <div className="flex min-h-0 flex-1 flex-wrap" data-testid="cadence-screen">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 max-w-[60ch] text-sm text-muted">
            The hive works on its own schedule here. Each run is handed to the Queen as a goal, within its budget, and waits for you where it should.
          </p>
          {cadences.length > 0 ? (
            <Button className="ml-auto" onClick={() => setSide({ kind: 'new' })}>
              <Plus aria-hidden="true" />
              New cadence
            </Button>
          ) : null}
        </div>
        {actionError ? <InlineAlert message={actionError} onDismiss={() => setActionError(null)} title="That didn't work" tone="error" /> : null}

        {cadences.length === 0 && side.kind !== 'new' ? (
          <div className="flex flex-1 items-center justify-center" data-testid="cadence-empty">
            <EmptyState
              description={
                <>
                  A cadence is <strong>when</strong> (a schedule) + <strong>what</strong> (a goal for the Queen) + <strong>limits</strong> (a token budget, and
                  how much may start without you). Every run goes through the Queen, like your own goals, and merging into your branch always waits for you.
                </>
              }
              icon={Clock}
              primary={{ label: 'New cadence', onClick: () => setSide({ kind: 'new' }), icon: Plus }}
              title="Nothing runs on a schedule yet"
            />
          </div>
        ) : (
          <ul aria-label="Cadences" className="m-0 flex list-none flex-col gap-3 p-0">
            {cadences.map((c) => (
              <CadenceRow
                c={c}
                key={c.id}
                now={now}
                onEdit={() => setSide({ kind: 'edit', id: c.id })}
                onError={setActionError}
                onHistory={() => setSide(side.kind === 'history' && side.id === c.id ? { kind: 'none' } : { kind: 'history', id: c.id })}
                selected={(side.kind === 'history' || side.kind === 'edit') && side.id === c.id}
              />
            ))}
          </ul>
        )}
      </div>

      {showForm || (side.kind === 'history' && sideCadence) ? (
        <aside aria-label={showForm ? 'Cadence form' : 'Cadence runs'} className="flex min-w-0 flex-[1_1_380px] flex-col gap-4 border-l border-line p-4">
          {showForm ? (
            <CadenceForm
              cadence={side.kind === 'edit' ? sideCadence : null}
              key={side.kind === 'edit' ? side.id : 'new'}
              onCancel={() => setSide({ kind: 'none' })}
              onDelete={side.kind === 'edit' && sideCadence ? () => del(sideCadence.id) : undefined}
              onSave={(input) => save(input, side.kind === 'edit' ? side.id : null)}
              others={cadences
                .filter((o) => o.when.type !== 'event' && !(side.kind === 'edit' && o.id === side.id))
                .map((o) => ({ id: o.id, name: o.name }))}
            />
          ) : sideCadence ? (
            <>
              {sideCadence.when.type === 'webhook' ? <WebhookPanel cadence={sideCadence} key={sideCadence.id} /> : null}
              <CadenceHistory cadence={sideCadence} now={now} />
            </>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
