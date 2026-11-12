import type { PlanView as Plan } from '@insectoids/shared';

const castes = (cards: Plan['waves'][number]['cards']): string => {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c.caste, (counts.get(c.caste) ?? 0) + 1);
  return [...counts].map(([caste, n]) => `${n} ${caste}${n > 1 ? 's' : ''}`).join(', ');
};

/** The Queen's plan: summary, then each wave with its cards (App 07 Queen chat plan card). */
export function PlanBody({ plan, currentWave }: { plan: Plan; currentWave?: number }) {
  const cardCount = plan.waves.reduce((n, w) => n + w.cards.length, 0);
  return (
    <div className="mt-3 flex flex-col gap-2.5" data-testid="plan">
      <p className="m-0 text-[13.5px]">{plan.summary}</p>
      <p className="m-0 text-xs text-muted">
        {plan.waves.length} {plan.waves.length === 1 ? 'wave' : 'waves'} · {cardCount} {cardCount === 1 ? 'card' : 'cards'}
      </p>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {plan.waves.map((w) => (
          <li className="rounded-[10px] border border-line bg-ground/40 px-3 py-2" key={w.n}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold">Wave {w.n}</span>
              <span className="text-muted">{castes(w.cards)}</span>
              {currentWave === w.n && <span className="ml-auto text-honey-text">current</span>}
            </div>
            <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-[13px]">
              {w.cards.map((c) => (
                <li className="flex items-center gap-2" key={c.id}>
                  <span aria-hidden="true" className="text-muted">
                    ·
                  </span>
                  <span className="min-w-0 truncate">{c.title}</span>
                  <span className="ml-auto shrink-0 rounded-full bg-surface-2 px-2 text-[11px] text-muted">{c.caste}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
