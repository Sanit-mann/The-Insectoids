import type { EngineCard } from '@insectoids/shared';
import { ArrowDown, ArrowUp, ShieldCheck } from 'lucide-react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { StatusDot } from '@/components/StatusDot';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CopyCommand } from './CopyCommand';
import { EngineInstall } from './EngineInstall';
import { GUARD_TEXT, STATE_DOT, STATE_LABEL } from './engine-names';
import { EngineUsageView } from './EngineUsage';
import { Switch } from './Switch';

interface EngineCardViewProps {
  engine: EngineCard;
  isDefault: boolean;
  /** Position in the user's order (0 = first). */
  index: number;
  count: number;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  onDismissError: () => void;
}

/**
 * One engine on the Connections screen (Connections 04-D2, D6; prototype Connections.dc.html).
 * Card layout follows the prototype; the status line always pairs a colour dot with words (App 07).
 */
export function EngineCardView({ engine: e, isDefault, index, count, busy, error, onToggle, onMove, onDismissError }: EngineCardViewProps) {
  const unsupported = e.state === 'unsupported';
  const headingId = `engine-${e.id}-name`;
  return (
    <article
      aria-labelledby={headingId}
      // Unsupported engines look set apart (dashed border, second surface) without fading their text below 4.5:1 (C1).
      className={cn('flex flex-col gap-3 rounded-2xl border p-4', unsupported ? 'border-dashed border-line bg-surface-2' : 'border-line bg-surface')}
      data-engine={e.id}
      data-testid={`engine-${e.id}`}
    >
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono text-xs text-muted tabular-nums" aria-hidden="true">
          {index + 1}.
        </span>
        <h3 className="m-0 font-display text-base font-semibold" id={headingId}>
          {e.name}
        </h3>
        <span className="text-xs text-muted">{e.vendor}</span>
        {isDefault ? (
          <span className="rounded-full border border-honey/50 px-2 py-0.5 text-[11px] font-semibold text-honey-text" data-testid="default-badge">
            Default
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5 text-sm" data-state={e.state} data-testid={`engine-${e.id}-state`}>
          <StatusDot status={STATE_DOT[e.state]} />
          {STATE_LABEL[e.state]}
          {e.version ? <span className="font-mono text-xs text-muted">v{e.version}</span> : null}
        </span>
      </header>

      <p className="m-0 text-sm text-muted">{e.message}</p>

      {!unsupported ? (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {e.guard ? (
            <>
              <dt className="flex items-center gap-1 text-muted">
                <ShieldCheck aria-hidden="true" className="size-3.5" />
                Safety
              </dt>
              <dd className="m-0">{GUARD_TEXT[e.guard]}</dd>
            </>
          ) : null}
          <dt className="text-muted">Cost</dt>
          <dd className="m-0">{e.reportsCost ? 'Reported by the engine' : 'Estimated by the hive from token counts'}</dd>
          {e.models ? (
            <>
              <dt className="text-muted">Models</dt>
              <dd className="m-0 font-mono text-xs leading-5">
                strongest {e.models.strongest} · standard {e.models.standard} · light {e.models.light}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {!unsupported ? <EngineUsageView engine={e} /> : null}

      {e.privacyNote ? <p className="m-0 rounded-[10px] border border-st-waiting/30 bg-st-waiting/10 px-3 py-2 text-xs">{e.privacyNote}</p> : null}

      {/* One click with consent (04-D6, C4): the dialog shows the exact command and asks first. It stays
          mounted after a successful install (the card's state changes) so the result stays on screen. */}
      {e.install && !unsupported ? <EngineInstall engine={e} offer={e.state === 'missing' || e.state === 'outdated'} /> : null}
      {e.install && (e.state === 'missing' || e.state === 'outdated' || unsupported) ? (
        <CopyCommand command={e.install.command} label={e.state === 'outdated' ? 'Update' : 'Install'} note={e.install.note} testId={`engine-${e.id}-install`} />
      ) : null}
      {e.signIn && e.state === 'signed-out' ? (
        <CopyCommand command={e.signIn.command} label="Sign in" note={e.signIn.note} testId={`engine-${e.id}-signin`} />
      ) : null}

      {error ? <InlineAlert message={error} onDismiss={onDismissError} title={`Couldn't change ${e.name}`} tone="error" /> : null}

      <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-sm text-muted">Use for hive work</span>
        <Switch checked={e.enabled} disabled={busy || unsupported} label={`Use ${e.name} for hive work`} onChange={onToggle} />
        <div className="ml-auto flex items-center gap-1" role="group" aria-label={`Order of ${e.name}`}>
          <Button aria-label={`Move ${e.name} up`} disabled={busy || index === 0} id={`engine-${e.id}-up`} onClick={() => onMove(-1)} size="icon" type="button" variant="ghost">
            <ArrowUp aria-hidden="true" className="size-4" />
          </Button>
          <Button
            aria-label={`Move ${e.name} down`}
            disabled={busy || index === count - 1}
            id={`engine-${e.id}-down`}
            onClick={() => onMove(1)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ArrowDown aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </footer>
    </article>
  );
}
