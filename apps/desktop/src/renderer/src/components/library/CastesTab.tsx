import type { CasteView } from '@insectoids/shared';
import { useEffect, useState } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { cn } from '@/lib/utils';
import { NETWORK } from './vocab';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; castes: CasteView[] };

/** The 8 insect castes (Capabilities 03-D3): what each is for, what it always carries, what it may reach. */
export function CastesTab({ onOpenItem }: { onOpenItem: (name: string) => void }) {
  const [result, setResult] = useState<{ attempt: number; load: Load } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const load: Load = result?.attempt === attempt ? result.load : { state: 'loading' };

  useEffect(() => {
    let alive = true;
    window.insectoids.hive
      .libraryCastes()
      .then((castes) => alive && setResult({ attempt, load: { state: 'ready', castes } }))
      .catch((err: unknown) => alive && setResult({ attempt, load: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
    return () => {
      alive = false;
    };
  }, [attempt]);

  if (load.state === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading the castes" className="grid gap-4 md:grid-cols-2" role="status">
        {[0, 1, 2, 3].map((i) => (
          <div className="h-40 rounded-2xl bg-surface-2 motion-safe:animate-pulse" key={i} />
        ))}
      </div>
    );
  }
  if (load.state === 'error') {
    return <InlineAlert actions={[{ label: 'Try again', onClick: () => setAttempt((a) => a + 1), primary: true }]} message={load.message} title="Couldn't load the castes" tone="error" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[720px] text-sm text-muted">
        Each card goes to an insect of one caste. A fresh insect starts every card with the Brain&rsquo;s brief, its caste&rsquo;s default skills,
        and at most a few more skills switched on just for that card.
      </p>
      <ul aria-label="Castes" className="m-0 grid list-none gap-4 p-0 md:grid-cols-2">
        {load.castes.map((c) => {
          const net = NETWORK[c.network];
          const NetIcon = net.icon;
          return (
            <li
              className={cn('flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4', !c.enabled && 'opacity-75')}
              data-caste={c.caste}
              data-testid="caste-card"
              key={c.caste}
            >
              <div className="flex items-center gap-2">
                <h3 className="m-0 font-display text-base font-semibold">{c.label}</h3>
                {!c.enabled ? <span className="rounded-full border border-line px-2 text-xs leading-5 text-muted">Off</span> : null}
              </div>
              <p className="m-0 text-sm text-muted">{c.role}</p>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted">Always carries</span>
                {c.defaultSkills.length === 0 ? (
                  <span className="text-xs text-muted">No default skills</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {c.defaultSkills.map((s) => (
                      <button
                        className="min-h-8 rounded-full border border-line px-3 text-xs hover:border-honey focus-visible:ring-2 focus-visible:ring-honey focus-visible:outline-none"
                        key={s}
                        onClick={() => onOpenItem(s)}
                        type="button"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="m-0 mt-auto flex items-center gap-2 text-sm" data-testid="caste-network" title={net.hint}>
                <NetIcon aria-hidden="true" className="size-4 shrink-0 text-honey" />
                <span>{net.label}</span>
                <span className="sr-only">: {net.hint}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
