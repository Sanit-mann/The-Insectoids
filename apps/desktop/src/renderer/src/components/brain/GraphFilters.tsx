/**
 * The Brain graph's filters (Phase 2 B5), shared by the 2D graph and the globe (Phase 4 A2): which shelf,
 * kinds, how recent, and whether archived records show. Reuses our connections `Switch`.
 */
import { type ReactNode, useState } from 'react';
import type { BrainGraphRequest, RecordKind } from '@insectoids/shared';
import { Switch } from '@/components/connections/Switch';
import { cn } from '@/lib/utils';
import { KINDS, KIND_MARK, shapePath } from './kinds';

const DAY = 24 * 60 * 60_000;

export type GraphScope = NonNullable<BrainGraphRequest['scope']>;
export const SCOPES: Array<{ id: GraphScope; label: string }> = [
  { id: 'project', label: 'This project' },
  { id: 'global', label: 'Global' },
  { id: 'all', label: 'All' },
];
export const DATES: Array<{ days: number; label: string }> = [
  { days: 0, label: 'Any time' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/** A small mark for the legend and the list: the kind's shape in its colour. */
export function KindMark({ kind, dashed = false, size = 16 }: { kind: RecordKind; dashed?: boolean; size?: number }) {
  const m = KIND_MARK[kind];
  return (
    <svg aria-hidden="true" className="shrink-0" height={size} viewBox="-10 -10 20 20" width={size}>
      <path
        d={shapePath(m.shape, 6.5)}
        fill={m.color}
        fillOpacity={dashed ? 0.25 : 0.9}
        stroke={m.color}
        strokeDasharray={dashed ? '2.5 2' : undefined}
        strokeWidth={dashed ? 1.6 : 1}
      />
    </svg>
  );
}

export interface GraphFilterState {
  scope: GraphScope;
  setScope: (s: GraphScope) => void;
  kinds: RecordKind[];
  toggleKind: (k: RecordKind) => void;
  days: number;
  pickDays: (d: number) => void;
  archived: boolean;
  setArchived: (v: boolean) => void;
  /** The request these filters make (without `limit`). */
  req: BrainGraphRequest;
}

export function useGraphFilters(): GraphFilterState {
  const [scope, setScope] = useState<GraphScope>('project');
  const [kinds, setKinds] = useState<RecordKind[]>([]);
  const [days, setDays] = useState(0);
  const [archived, setArchived] = useState(false);
  // "since" is fixed when the date filter is picked, so the request (and the layout) stays stable.
  const [since, setSince] = useState<number | undefined>(undefined);
  const req: BrainGraphRequest = {
    scope,
    ...(kinds.length ? { kinds } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(archived ? { includeArchived: true } : {}),
  };
  return {
    scope,
    setScope,
    kinds,
    toggleKind: (k) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k])),
    days,
    pickDays: (d) => {
      setDays(d);
      setSince(d ? Date.now() - d * DAY : undefined);
    },
    archived,
    setArchived,
    req,
  };
}

/** The filter rows. `extra` sits at the end of the first row (e.g. a view toggle). */
export function GraphFilters({ f, dateTestId, extra }: { f: GraphFilterState; dateTestId: string; extra?: ReactNode }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div aria-label="Which shelf" className="flex gap-1" role="group">
          {SCOPES.map((s) => (
            <button
              aria-pressed={f.scope === s.id}
              className={cn(
                'min-h-10 rounded-[10px] border px-3 text-sm',
                f.scope === s.id ? 'border-honey bg-active font-medium text-honey-text' : 'border-line text-muted hover:text-text',
              )}
              key={s.id}
              onClick={() => f.setScope(s.id)}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          <span>Changed</span>
          <select
            className="min-h-10 rounded-[10px] border border-line bg-surface px-2 text-text focus-visible:outline-2 focus-visible:outline-honey"
            data-testid={dateTestId}
            onChange={(e) => f.pickDays(Number(e.target.value))}
            value={f.days}
          >
            {DATES.map((d) => (
              <option key={d.days} value={d.days}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <Switch checked={f.archived} label="Include archived" onChange={f.setArchived} />
          <span className="text-xs text-muted">Include archived</span>
        </div>
        {extra}
      </div>
      <div aria-label="Filter by kind" className="flex flex-wrap gap-1.5" role="group">
        {KINDS.map(({ kind, label }) => {
          const on = f.kinds.includes(kind);
          return (
            <button
              aria-pressed={on}
              className={cn('inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs', on ? 'border-honey text-honey-text' : 'border-line text-muted hover:text-text')}
              key={kind}
              onClick={() => f.toggleKind(kind)}
              type="button"
            >
              <KindMark kind={kind} size={12} />
              {label}
            </button>
          );
        })}
      </div>
    </>
  );
}
