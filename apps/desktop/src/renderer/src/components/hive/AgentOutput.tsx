import type { AgentView } from '@insectoids/shared';
import { Hand } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { StatusDot } from '@/components/StatusDot';
import { LANE_LABEL, agentName, formatTokens, formatUsd, laneDot, modelLabel, roleLabel } from './format';

/**
 * Selected agent: task, what actually ran, and its live output (read-only).
 * Follows new lines while the user is at the bottom; stops following once they scroll up.
 */
export function AgentOutput({ agent }: { agent: AgentView }) {
  const logRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lines = agent.output.length;

  useLayoutEffect(() => {
    follow.current = true;
  }, [agent.runId]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines, agent.runId]);

  return (
    <aside aria-label="Selected agent" className="flex min-w-0 flex-[1_1_380px] flex-col gap-3 border-l border-line bg-rail p-5">
      <div className="flex items-center gap-2">
        <StatusDot status={laneDot(agent.status)} />
        <h2 className="m-0 truncate font-display text-lg font-semibold">{agentName(agent)}</h2>
        <span className="ml-auto text-xs text-muted">{roleLabel(agent)}</span>
      </div>
      <div className="text-muted">{agent.title}</div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>{LANE_LABEL[agent.status]}</span>
        <span className="text-muted">·</span>
        <span className="font-mono">{modelLabel(agent)}</span>
        <span className="text-muted">·</span>
        <span className="font-mono">{formatTokens(agent.tokens)} tokens</span>
        <span className="text-muted">·</span>
        <span className="font-mono">{formatUsd(agent.costUsd)}</span>
      </div>
      <p className="m-0 text-xs text-muted">Model as reported by the engine; effort is what the hive asked for (engines don't report it).</p>

      <div id="agent-output-label" className="text-xs text-muted">
        Live output (read-only)
      </div>
      <div
        ref={logRef}
        role="log"
        aria-labelledby="agent-output-label"
        // Lines are announced by the throttled summary instead (never per line).
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-[220px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-[#0a0907] p-3.5 font-mono text-xs leading-relaxed text-[#d9d1bf]"
      >
        {lines === 0 ? <span className="text-[#8a8270]">No output yet.</span> : agent.output.join('\n')}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled
          aria-describedby="take-over-later"
          className="inline-flex min-h-10 items-center gap-2 rounded-[10px] border border-line bg-surface-2 px-3.5 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Hand size={16} aria-hidden="true" />
          Take over
        </button>
        <span id="take-over-later" className="text-xs text-muted">
          Phase 2: drive an insect yourself, then hand it back.
        </span>
      </div>
    </aside>
  );
}
