import type { CardView } from '@insectoids/shared';
import { X } from 'lucide-react';
import { StatusDot } from '@/components/StatusDot';
import { CARD_STATUS, casteLabel, formatDuration } from '@/components/hive/format';

interface CardDetailProps {
  card: CardView;
  /** Every card of the goal, to show dependency titles. */
  cards: CardView[];
  now: number;
  onClose: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="m-0 break-words">{children}</dd>
    </div>
  );
}

/** Card detail side panel (Taskboard prototype): brief, done means, dependencies, holder, lease, attempts, result. */
export function CardDetail({ card, cards, now, onClose }: CardDetailProps) {
  const st = CARD_STATUS[card.status];
  const deps = card.dependsOn.map((id) => cards.find((c) => c.id === id || c.id.endsWith(`.${id}`)));
  const leaseLeft = card.leaseExpiresAt !== null ? card.leaseExpiresAt - now : null;

  return (
    <aside aria-label="Card details" className="flex min-w-0 flex-[1_1_320px] flex-col gap-3 border-l border-line bg-rail p-5 md:max-w-[420px]">
      <div className="flex items-center gap-2">
        <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs">{casteLabel(card.caste)}</span>
        <span className="font-mono text-xs text-muted">{card.id}</span>
        <button type="button" onClick={onClose} aria-label="Close card details" className="ml-auto flex size-10 items-center justify-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-text">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <h2 className="m-0 font-display text-[19px] font-semibold">{card.title}</h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusDot status={st.dot} />
        <span>{st.label}</span>
        {card.undone && <span className="rounded-full border border-st-paused/60 px-2 py-0.5 text-xs">Undone</span>}
        {card.escalated && <span className="rounded-full border border-st-blocked/60 px-2 py-0.5 text-xs">Escalated to you</span>}
      </div>

      <section aria-label="Brief">
        <div className="text-xs text-muted">Brief (built by the Brain)</div>
        <p className="m-0 whitespace-pre-wrap">{card.brief || '—'}</p>
      </section>

      <section aria-label="Done means">
        <div className="text-xs text-muted">Done means</div>
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5">
          {card.acceptance.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </section>

      <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Field label="Depends on">
          {deps.length === 0
            ? 'Nothing'
            : deps.map((d, i) => (
                <span key={card.dependsOn[i]} className="block">
                  {d ? d.title : card.dependsOn[i]}
                </span>
              ))}
        </Field>
        {card.integrations.length ? (
          <Field label="Services">
            <span data-testid="card-services">Services: {card.integrations.join(', ')}</span>
          </Field>
        ) : null}
        <Field label="Priority">{casteLabel(card.priority)}</Field>
        <Field label="Held by">{card.claimedBy ?? 'Nobody'}</Field>
        <Field label="Lease">
          {leaseLeft === null ? '—' : leaseLeft > 0 ? `${formatDuration(leaseLeft)} left` : 'Expired, returning to Open'}
        </Field>
        <Field label="Attempts">
          {card.attempts} of {card.maxAttempts}
        </Field>
        <Field label="Wave">{card.wave}</Field>
      </dl>

      {card.result && (
        <section aria-label="Result">
          <div className="text-xs text-muted">Result</div>
          <p className="m-0 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface p-2.5 font-mono text-xs">{card.result}</p>
        </section>
      )}

      <p className="m-0 text-xs text-muted">If an insect crashes, its lease runs out and the card returns to Open by itself.</p>
    </aside>
  );
}
