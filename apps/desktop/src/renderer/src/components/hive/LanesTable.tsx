import type { AgentView } from '@insectoids/shared';
import type { KeyboardEvent } from 'react';
import { StatusDot } from '@/components/StatusDot';
import { engineName } from '@/components/connections/engine-names';
import { cn } from '@/lib/utils';
import { LANE_LABEL, agentName, formatDuration, formatTokens, formatUsd, laneDot, modelLabel, roleLabel } from './format';

interface LanesTableProps {
  agents: AgentView[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
  now: number;
}

/** Lanes table (Hive prototype): agent, role, task, model + effort that actually ran, tokens, cost, status, duration. */
export function LanesTable({ agents, selectedId, onSelect, now }: LanesTableProps) {
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = agents[Math.max(0, Math.min(to, agents.length - 1))];
    if (next) {
      onSelect(next.runId);
      document.getElementById(`lane-${next.runId}`)?.focus();
    }
  };

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <caption className="sr-only">Agents in the hive. Select one to see its live output.</caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th scope="col" className="px-3.5 py-2.5 font-normal">Agent</th>
            <th scope="col" className="px-3 py-2.5 font-normal">Task</th>
            <th scope="col" className="px-3 py-2.5 font-normal">Engine · model · effort</th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">Tokens</th>
            <th scope="col" className="px-3 py-2.5 text-right font-normal">Cost</th>
            <th scope="col" className="px-3 py-2.5 font-normal">Status</th>
            <th scope="col" className="px-3.5 py-2.5 text-right font-normal">Time</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a, i) => {
            const selected = a.runId === selectedId;
            return (
              <tr
                key={a.runId}
                onClick={() => onSelect(a.runId)}
                className={cn('cursor-pointer border-b border-line last:border-b-0', selected ? 'bg-active' : 'hover:bg-surface-2')}
              >
                <th scope="row" className="px-3.5 py-2.5 font-normal">
                  <button
                    id={`lane-${a.runId}`}
                    type="button"
                    aria-pressed={selected}
                    tabIndex={selected || (!selectedId && i === 0) ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(a.runId);
                    }}
                    onKeyDown={(e) => onKey(e, i)}
                    className="flex min-h-10 items-center gap-2 text-left"
                  >
                    <StatusDot status={laneDot(a.status)} />
                    <span className={cn('font-semibold', selected && 'text-honey-text')}>{agentName(a)}</span>
                    <span className="sr-only">, {roleLabel(a)}</span>
                  </button>
                </th>
                <td className="max-w-[280px] truncate px-3 py-2.5 text-muted" title={a.title}>
                  {a.title}
                </td>
                <td className="px-3 py-2.5 text-xs text-muted">
                  {engineName(a.engine) ? <span className="mr-1.5 rounded border border-line px-1.5 py-0.5 font-sans text-[11px]">{engineName(a.engine)}</span> : null}
                  <span className="font-mono">{modelLabel(a)}</span>
                </td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">{formatTokens(a.tokens)}</td>
                <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums">{formatUsd(a.costUsd)}</td>
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-1.5">
                    <StatusDot status={laneDot(a.status)} />
                    {LANE_LABEL[a.status]}
                  </span>
                </td>
                <td className="px-3.5 py-2.5 text-right font-mono text-xs tabular-nums text-muted">{formatDuration((a.endedAt ?? now) - a.startedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
