/**
 * Brain dashboard (Memory 01-D13 phase 2, E12; Phase 2 B5): how big the Brain is and what it holds,
 * how it grew and how much agents read it these 8 weeks, what gets used most, and a timeline of what
 * changed, when and by whom. Health, the Librarian and lessons are the B3 panels, reused as they are.
 *
 * Charts follow the dataviz method: one measure per chart (added and reads are two charts, never two
 * axes), one hue (honey), values written on the bars, and every chart is also a plain list for screen
 * readers. Reuses: BrainCare panels (shadcn `button`, Kokonut UI `hold-button`, `inline-alert`) and
 * `InlineError`; shadcn `button` for "See the full timeline" (Phase 4 A3). Custom: the tiles and bar lists.
 */
import { Activity, ArrowRight, BarChart3, Clock, Link2, NotebookText, ShieldCheck, Archive } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BrainDashboardView } from '@insectoids/shared';
import { InlineError } from '@/components/changes/CardChanges';
import { Button } from '@/components/ui/button';
import { useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { HealthPanel, LessonsPanel, LibrarianCard } from './BrainCare';
import { KindMark } from './GraphView';
import { kindInfo } from './kinds';
import { ago } from './RecordLife';
import { useLive } from './useLive';

const card = 'flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4';

const CHANGE_WORDS: Record<string, string> = {
  create: 'added',
  update: 'edited',
  archive: 'archived',
  unarchive: 'brought back',
  supersede: 'replaced',
  merge: 'merged',
};
const changeWord = (c: string): string => CHANGE_WORDS[c] ?? c;
const byWho = (by: string): string => (by === 'user' ? 'You' : by);
const weekLabel = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function DashboardView({ onOpen, onSeeTimeline, refreshKey }: { onOpen: (id: string) => void; onSeeTimeline?: () => void; refreshKey: number }) {
  const { snapshot } = useHive();
  const { live, reload } = useLive<BrainDashboardView>(`dash#${refreshKey}`, () => window.insectoids.hive.brainDashboard(), 600);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="brain-dashboard">
      {live.state === 'loading' && <div aria-busy="true" className="h-40 animate-pulse rounded-2xl border border-line bg-surface" />}
      {live.state === 'error' && <InlineError message={`Could not load the dashboard: ${live.message}`} onRetry={reload} />}
      {live.state === 'ready' && <Numbers d={live.data} onOpen={onOpen} onSeeTimeline={onSeeTimeline} />}
      {snapshot?.brainHealth && snapshot.librarian && (
        <div aria-label="How the Brain looks after itself" className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4" role="region">
          <HealthPanel health={snapshot.brainHealth} />
          <LibrarianCard librarian={snapshot.librarian} />
          <LessonsPanel lessons={snapshot.lessons ?? []} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface px-4 py-3">
      <dt className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </dt>
      <dd className="m-0 font-display text-2xl font-semibold tabular-nums">{value.toLocaleString()}</dd>
    </div>
  );
}

function Numbers({ d, onOpen, onSeeTimeline }: { d: BrainDashboardView; onOpen: (id: string) => void; onSeeTimeline?: (() => void) | undefined }) {
  const kindMax = Math.max(1, ...d.byKind.map((k) => k.count));
  const kinds = [...d.byKind].filter((k) => k.count > 0).sort((a, b) => b.count - a.count);
  // "Most used" only lists what agents actually used; importance alone is not use.
  const used = d.mostUsed.filter((m) => m.reads > 0 || m.helped > 0);
  return (
    <>
      <p className="m-0 text-xs text-muted">
        Shelf: <span className="font-mono text-text">{d.shelf}</span>
      </p>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3" data-testid="dash-totals">
        <Tile icon={<NotebookText aria-hidden="true" className="size-3.5" />} label="Records" value={d.totals.records} />
        <Tile icon={<ShieldCheck aria-hidden="true" className="size-3.5" />} label="Confirmed by you" value={d.totals.confirmed} />
        <Tile icon={<Link2 aria-hidden="true" className="size-3.5" />} label="Links" value={d.totals.links} />
        <Tile icon={<Archive aria-hidden="true" className="size-3.5" />} label="Archived" value={d.totals.archived} />
      </dl>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <section aria-labelledby="dash-kinds-title" className={card} data-testid="dash-kinds">
          <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="dash-kinds-title">
            <BarChart3 aria-hidden="true" className="size-4 text-honey" /> What the Brain holds
          </h2>
          {kinds.length === 0 ? (
            <p className="m-0 text-sm text-muted">Nothing yet. Records appear as you and the hive work.</p>
          ) : (
            <ul aria-label="Records by kind" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {kinds.map((k) => (
                <li className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2 text-sm" key={k.kind} title={`${kindInfo(k.kind).label}: ${k.count}`}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <KindMark kind={k.kind} size={12} />
                    <span className="truncate">{kindInfo(k.kind).label}</span>
                  </span>
                  <span aria-hidden="true" className="h-3 rounded-r bg-surface-2">
                    <span className="block h-full rounded-r bg-honey" style={{ width: `${(k.count / kindMax) * 100}%` }} />
                  </span>
                  <span className="text-right tabular-nums text-muted">{k.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="dash-weeks-title" className={card} data-testid="dash-weeks">
          <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="dash-weeks-title">
            <Activity aria-hidden="true" className="size-4 text-honey" /> The last 8 weeks
          </h2>
          <WeekBars label="Records added" values={d.weeks.map((w) => ({ at: w.weekStart, n: w.added }))} />
          <WeekBars label="Agent reads" values={d.weeks.map((w) => ({ at: w.weekStart, n: w.reads }))} />
        </section>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <section aria-labelledby="dash-used-title" className={card} data-testid="dash-most-used">
          <h2 className="m-0 font-display text-base font-semibold" id="dash-used-title">
            Most used
          </h2>
          {used.length === 0 ? (
            <p className="m-0 text-sm text-muted">Agents haven't read anything yet. Records they read for their work show up here.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-1 p-0">
              {used.map((m) => (
                <li key={m.id}>
                  <button className="flex min-h-10 w-full items-center gap-2 rounded-[10px] px-2 text-left text-sm hover:bg-surface-2" onClick={() => onOpen(m.id)} type="button">
                    <KindMark kind={m.kind} />
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">
                      read {m.reads} · helped {m.helped}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby="dash-timeline-title" className={card} data-testid="dash-timeline">
          <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="dash-timeline-title">
            <Clock aria-hidden="true" className="size-4 text-honey" /> Timeline
          </h2>
          {onSeeTimeline && (
            <Button className="self-start" data-testid="dash-timeline-all" onClick={onSeeTimeline} size="sm" variant="link">
              See the full timeline
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Button>
          )}
          {d.timeline.length === 0 ? (
            <p className="m-0 text-sm text-muted">No changes yet.</p>
          ) : (
            <ol aria-label="Latest changes, newest first" className="m-0 flex max-h-96 list-none flex-col gap-0.5 overflow-auto p-0">
              {d.timeline.map((t) => (
                <li key={`${t.id}-${t.version}`}>
                  <button
                    className="flex min-h-10 w-full items-start gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                    data-testid="dash-timeline-item"
                    onClick={() => onOpen(t.id)}
                    type="button"
                  >
                    <KindMark kind={t.kind} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('font-medium', t.changedBy === 'user' && 'text-honey-text')}>{byWho(t.changedBy)}</span> {changeWord(t.change)}{' '}
                      <span className="break-words">“{t.title}”</span>
                      <span className="block text-xs text-muted">
                        version {t.version} · {ago(t.changedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}

/** One measure per week as columns, with the value on each (no axis needed). */
function WeekBars({ label, values }: { label: string; values: Array<{ at: number; n: number }> }) {
  const max = Math.max(1, ...values.map((v) => v.n));
  const total = values.reduce((s, v) => s + v.n, 0);
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <figcaption className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="text-xs tabular-nums text-muted">{total} in all</span>
      </figcaption>
      <ol aria-label={`${label} per week, oldest first`} className="m-0 grid list-none grid-cols-8 items-end gap-1 p-0">
        {values.map((v) => (
          <li className="flex min-w-0 flex-col items-center gap-0.5" key={v.at} title={`Week of ${weekLabel(v.at)}: ${v.n}`}>
            <span className="text-[11px] tabular-nums text-muted">{v.n}</span>
            <span aria-hidden="true" className="flex h-14 w-full items-end">
              <span className="block w-full rounded-t bg-honey" style={{ height: v.n ? `${Math.max(6, (v.n / max) * 100)}%` : '2px', opacity: v.n ? 1 : 0.35 }} />
            </span>
            <span className="text-[10px] text-muted">
              <span className="sr-only">Week of </span>
              {weekLabel(v.at)}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
