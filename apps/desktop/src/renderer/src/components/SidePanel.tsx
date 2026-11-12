import type { ReactNode } from 'react';
import type { BrainStatus, LaneStatus } from '@insectoids/shared';
import { ChevronRight } from 'lucide-react';
import { KIND_META } from '@/components/approvals/kinds';
import { openScreen } from '@/components/changes/navigate';
import { StatusDot } from '@/components/StatusDot';
import { currentGoal, tokens, usd } from '@/components/queen/goal-status';
import { pendingApprovals, useHive } from '@/lib/hive-store';
import { useBrainStatus } from '@/lib/useBrainStatus';

const BRAIN_DOT: Record<BrainStatus['state'], LaneStatus> = { starting: 'waiting', ready: 'done', failed: 'blocked' };
const BRAIN_LABEL: Record<BrainStatus['state'], string> = { starting: 'starting', ready: 'ready', failed: 'not running' };
const LIVE: ReadonlySet<LaneStatus> = new Set(['working', 'waiting', 'blocked', 'paused']);

function BrainRow() {
  const status = useBrainStatus();
  const state = status?.state ?? 'starting';
  return (
    <div className="flex flex-col gap-1" data-state={state} data-testid="brain-status">
      <div className="flex items-center gap-2.5 text-xs" title={status?.message}>
        <StatusDot status={BRAIN_DOT[state]} />
        Brain
        <span className="ml-auto text-muted">{BRAIN_LABEL[state]}</span>
      </div>
      {state === 'failed' && status && <p className="m-0 text-xs text-muted">{status.message}</p>}
    </div>
  );
}

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="m-0 font-display text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Right panel on the Queen screen (App 07 shell): approvals, hive now, budget. */
export function SidePanel() {
  const { snapshot: snap } = useHive();
  const pending = pendingApprovals(snap);
  const live = snap ? snap.agents.filter((a) => LIVE.has(a.status)) : [];
  const goal = currentGoal(snap);

  return (
    <aside aria-label="Hive status" className="flex flex-[1_1_300px] flex-col gap-4 border-l border-line bg-rail p-[18px]">
      <Card
        action={
          pending.length > 0 ? (
            <button className="ml-auto inline-flex min-h-8 items-center text-xs text-honey-text hover:underline" onClick={() => openScreen('approvals')} type="button">
              Open inbox
              <ChevronRight aria-hidden="true" className="size-3.5" />
            </button>
          ) : null
        }
        title="Approvals"
      >
        {pending.length === 0 ? (
          <p className="m-0 text-xs text-muted">Nothing is waiting for you.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {pending.slice(0, 4).map((a) => {
              const Icon = KIND_META[a.kind].icon;
              return (
                <li key={a.id}>
                  <button
                    className="flex min-h-10 w-full items-center gap-2 rounded-[10px] px-2 text-left text-xs hover:bg-surface-2"
                    onClick={() => openScreen('approvals')}
                    type="button"
                  >
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-st-waiting" />
                    <span className="min-w-0 flex-1 truncate">{a.title}</span>
                    <span className="shrink-0 text-st-waiting">{a.destructive ? 'hold' : 'needs you'}</span>
                  </button>
                </li>
              );
            })}
            {pending.length > 4 && <li className="px-2 text-xs text-muted">and {pending.length - 4} more</li>}
          </ul>
        )}
      </Card>
      <Card title="Hive now">
        {snap?.hive.paused && (
          <div className="flex items-center gap-2.5 text-xs">
            <StatusDot status="paused" />
            Hive
            <span className="ml-auto text-muted">paused</span>
          </div>
        )}
        {live.length === 0 ? (
          <div className="flex items-center gap-2.5 text-xs">
            <StatusDot status={goal?.status === 'planning' ? 'working' : 'idle'} />
            Queen
            <span className="ml-auto text-muted">{goal?.status === 'planning' ? 'planning' : 'idle'}</span>
          </div>
        ) : (
          <ul aria-label="Agents working" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {live.slice(0, 6).map((a) => (
              <li className="flex items-center gap-2.5 text-xs" key={a.runId}>
                <StatusDot status={a.status} />
                <span className="min-w-0 flex-1 truncate" title={a.title}>
                  {a.agentId} · {a.title}
                </span>
                <span className="shrink-0 text-muted">{a.status}</span>
              </li>
            ))}
          </ul>
        )}
        <BrainRow />
      </Card>
      <Card title="Budget">
        {!goal ? (
          <p className="m-0 text-xs text-muted">No goals yet, so nothing spent.</p>
        ) : (
          <div className="flex flex-col gap-1.5" data-testid="budget">
            <p className="m-0 truncate text-xs" title={goal.title}>
              {goal.title}
            </p>
            {goal.budgetTokens ? (
              <>
                <div
                  aria-label={`${tokens(goal.spentTokens)} of ${tokens(goal.budgetTokens)} tokens used`}
                  aria-valuemax={goal.budgetTokens}
                  aria-valuemin={0}
                  aria-valuenow={Math.min(goal.spentTokens, goal.budgetTokens)}
                  className="h-1.5 overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                >
                  <div
                    className={goal.spentTokens / goal.budgetTokens >= 0.75 ? 'h-full bg-st-blocked' : 'h-full bg-honey'}
                    style={{ width: `${Math.min(100, (goal.spentTokens / goal.budgetTokens) * 100)}%` }}
                  />
                </div>
                <p className="m-0 text-xs text-muted">
                  {tokens(goal.spentTokens)} of {tokens(goal.budgetTokens)} tokens · {usd(goal.spentUsd)}
                </p>
              </>
            ) : (
              <p className="m-0 text-xs text-muted">
                {tokens(goal.spentTokens)} tokens · {usd(goal.spentUsd)} · no cap
              </p>
            )}
          </div>
        )}
      </Card>
    </aside>
  );
}
