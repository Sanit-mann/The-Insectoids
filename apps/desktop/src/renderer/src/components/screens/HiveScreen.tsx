import type { AgentView } from '@insectoids/shared';
import { Hexagon, Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentOutput } from '@/components/hive/AgentOutput';
import { LANE_LABEL, agentName } from '@/components/hive/format';
import { LanesTable } from '@/components/hive/LanesTable';
import { ManagersPanel } from '@/components/hive/ManagersPanel';
import { WatchdogPanel } from '@/components/hive/WatchdogPanel';
import { useNow } from '@/components/hive/useNow';
import { AgentLanesTimeline, type LaneTone, type TimelineLane } from '@/components/kokonutui/ai-agent-lanes';
import { EmptyHint, ReadError } from '@/components/taskboard/states';
import { runCommand, useHive } from '@/lib/hive-store';
import { cn } from '@/lib/utils';

/** Live first (oldest start first), then finished (most recent first). */
const LIVE: ReadonlySet<AgentView['status']> = new Set(['working', 'waiting', 'blocked', 'paused']);
const order = (a: AgentView, b: AgentView): number => {
  const la = LIVE.has(a.status) && a.endedAt === null;
  const lb = LIVE.has(b.status) && b.endedAt === null;
  if (la !== lb) return la ? -1 : 1;
  return la ? a.startedAt - b.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
};

const toneOf = (s: AgentView['status']): LaneTone => (s === 'failed' ? 'blocked' : s);

/** At most one polite announcement every few seconds, never per output line. */
function useThrottled(text: string, ms: number): string {
  const [said, setSaid] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (text === said) return;
    const wait = Math.max(0, last.current + ms - Date.now());
    const id = setTimeout(() => {
      last.current = Date.now();
      setSaid(text);
    }, wait);
    return () => clearTimeout(id);
  }, [text, said, ms]);
  return said;
}

export function HiveScreen() {
  const { snapshot, error, loading } = useHive();
  const now = useNow(1000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const agents = useMemo(() => [...(snapshot?.agents ?? [])].sort(order), [snapshot]);
  const selected = agents.find((a) => a.runId === selectedId) ?? agents[0] ?? null;
  const working = agents.filter((a) => a.status === 'working').length;
  const blocked = agents.filter((a) => a.status === 'blocked').length;
  const paused = snapshot?.hive.paused ?? false;
  // Incidents may carry the short card id ("C-02"); the board's ids are goal-scoped.
  const cardTitle = (id: string): string | null => snapshot?.cards.find((c) => c.id === id || c.id.endsWith(`.${id}`))?.title ?? null;

  const announcement = useThrottled(
    agents.length === 0
      ? 'No insects working.'
      : `${working} working${blocked ? `, ${blocked} blocked` : ''}${paused ? '. The hive is paused.' : '.'}`,
    5000,
  );

  const lanes: TimelineLane[] = agents
    .slice(0, 12)
    .map((a) => ({ id: a.runId, name: agentName(a), task: a.title, start: a.startedAt, end: a.endedAt, tone: toneOf(a.status), statusLabel: LANE_LABEL[a.status] }));

  const togglePause = async (): Promise<void> => {
    setBusy(true);
    setActionError(null);
    const r = await runCommand(paused ? { type: 'resume' } : { type: 'pause', reason: 'Paused by you from the Hive monitor.' });
    if (!r.ok) setActionError(r.error);
    setBusy(false);
  };

  if (error && !snapshot) return <ReadError message={error} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="group" aria-label="Hive controls" className="flex flex-wrap items-center gap-2.5 border-b border-line px-6 py-3">
        <div role="tablist" aria-label="Hive view" className="flex gap-1.5">
          <button type="button" role="tab" aria-selected="true" className="min-h-10 rounded-full border border-honey bg-surface px-3 text-sm text-honey-text">
            Lanes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="false"
            aria-disabled="true"
            disabled
            title="The living hive arrives in Phase 2"
            className="min-h-10 rounded-full border border-line bg-surface px-3 text-sm text-muted disabled:cursor-not-allowed"
          >
            Living hive <span className="ml-1 rounded-full border border-line px-1.5 text-[11px]">Later</span>
          </button>
        </div>
        <span className="ml-auto text-xs text-muted">
          {agents.length} agent{agents.length === 1 ? '' : 's'} · {working} working · insect limit {snapshot?.hive.insectCap ?? '—'} (set by you)
        </span>
        <button
          type="button"
          onClick={() => void togglePause()}
          disabled={busy || !snapshot}
          className={cn(
            'inline-flex min-h-10 items-center gap-2 rounded-[10px] border px-3.5 font-semibold disabled:opacity-50',
            paused ? 'border-honey bg-honey text-honey-ink' : 'border-line bg-surface-2 text-text',
          )}
        >
          {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
          {paused ? 'Resume hive' : 'Pause hive'}
        </button>
      </div>

      {paused && (
        <div role="status" aria-label="Hive paused" className="mx-6 mt-3 flex items-center gap-2 rounded-xl border border-st-paused/60 bg-surface px-3 py-2 text-sm">
          <span aria-hidden="true" className="inline-block size-[9px] rounded-full bg-st-paused" />
          <span>
            Hive paused{snapshot?.hive.pausedReason ? `: ${snapshot.hive.pausedReason}` : '.'} No new cards are started until you resume.
          </span>
        </div>
      )}
      {actionError && (
        <div role="alert" className="mx-6 mt-3 rounded-xl border border-st-blocked/60 bg-surface px-3 py-2 text-sm">
          {actionError}
        </div>
      )}
      {error && <ReadError message={error} />}

      {/* Polite, throttled summary for screen readers (App 07 accessibility). */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {loading && !snapshot ? (
        <div role="status" aria-label="Loading the hive" className="flex flex-col gap-2 p-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <EmptyHint icon={Hexagon} title="No insects working">
          No insects working. Give the Queen a goal.
        </EmptyHint>
      ) : (
        <div className="flex min-h-0 flex-1 flex-wrap">
          <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-3 p-5">
            <AgentLanesTimeline lanes={lanes} now={now} selectedId={selected?.runId ?? null} onSelect={setSelectedId} />
            <LanesTable agents={agents} selectedId={selected?.runId ?? null} onSelect={setSelectedId} now={now} />
            <p className="m-0 text-xs text-muted">Each row is one agent run. Colour shows status; the label always says it too.</p>
          </div>
          {selected && <AgentOutput agent={selected} />}
        </div>
      )}

      {/* C2: the Watchdog's incidents and the managers' brain side, always visible once the hive is loaded. */}
      {snapshot ? (
        <div className="flex flex-wrap items-start gap-4 border-t border-line px-5 py-5">
          <div className="min-w-0 flex-[1_1_380px]">
            <WatchdogPanel cardTitle={cardTitle} incidents={snapshot.incidents} now={now} />
          </div>
          <div className="min-w-0 flex-[1_1_380px]">
            <ManagersPanel managers={snapshot.managers} now={now} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
