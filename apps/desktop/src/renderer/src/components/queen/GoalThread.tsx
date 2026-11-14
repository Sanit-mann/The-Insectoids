import { useState } from 'react';
import type { ActivityView, ApprovalView, GoalView, HiveSnapshot } from '@insectoids/shared';
import { Crown, User } from 'lucide-react';
import { KIND_META, ago, decide } from '@/components/approvals/kinds';
import { ApprovalCard, DecisionLine } from '@/components/kokonutui/ai-tool-approval';
import { StatusDot } from '@/components/StatusDot';
import { FromCadence } from '@/components/cadence/FromCadence';
import { GOAL_STATUS, goalProgress, tokens, usd } from './goal-status';
import { PlanBody } from './PlanView';

/** Activity types worth a line in the thread; raw engine chatter lives in the Hive monitor. */
const QUIET = new Set(['engine']);
const SHOWN = 6;

function Bubble({ who, children }: { who: 'you' | 'queen'; children: React.ReactNode }) {
  const you = who === 'you';
  return (
    <div className={you ? 'flex justify-end' : 'flex'}>
      <div className={you ? 'flex max-w-[85%] items-start gap-2.5' : 'flex w-full max-w-[720px] items-start gap-2.5'}>
        {!you && (
          <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-honey/15 text-honey-text">
            <Crown className="size-3.5" />
          </span>
        )}
        <div className={you ? 'rounded-[14px] rounded-tr-sm bg-active px-3.5 py-2.5' : 'min-w-0 flex-1'}>
          <span className="sr-only">{you ? 'You said:' : 'The Queen:'}</span>
          {children}
        </div>
        {you && (
          <span aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
            <User className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}

function Activity({ lines }: { lines: ActivityView[] }) {
  const [all, setAll] = useState(false);
  if (lines.length === 0) return null;
  const shown = all ? lines : lines.slice(-SHOWN);
  return (
    <div className="mt-2">
      <ul aria-label="Recent activity" className="m-0 flex list-none flex-col gap-0.5 border-l border-line p-0 pl-3">
        {shown.map((a) => (
          <li className="flex gap-2 text-[12.5px] text-muted" key={a.id}>
            <span className="min-w-0 flex-1">{a.message}</span>
            <time className="shrink-0 text-[11px]" dateTime={new Date(a.at).toISOString()}>
              {ago(a.at)}
            </time>
          </li>
        ))}
      </ul>
      {lines.length > SHOWN && (
        <button className="mt-1 min-h-8 text-xs text-honey-text hover:underline" onClick={() => setAll((v) => !v)} type="button">
          {all ? 'Show less' : `Show all ${lines.length} updates`}
        </button>
      )}
    </div>
  );
}

function Progress({ goal, snap }: { goal: GoalView; snap: HiveSnapshot }) {
  const p = goalProgress(goal, snap.cards, snap);
  const status = GOAL_STATUS[goal.status];
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div className="mt-3 rounded-[14px] border border-line bg-surface p-3.5" data-testid="goal-progress">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <StatusDot status={status.dot} />
        <span className="font-semibold" data-testid="goal-status">
          {status.label}
        </span>
        {p.waves > 0 && goal.status === 'running' && (
          <span className="text-muted">
            Wave {Math.max(p.wave, 1)} of {p.waves}
          </span>
        )}
        <span className="ml-auto text-xs text-muted">
          {tokens(goal.spentTokens)} tokens · {usd(goal.spentUsd)}
        </span>
      </div>
      <div
        aria-label={`${p.done} of ${p.total} cards done`}
        aria-valuemax={p.total || 1}
        aria-valuemin={0}
        aria-valuenow={p.done}
        className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
      >
        <div className="h-full rounded-full bg-st-done transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="m-0 mt-1.5 text-xs text-muted">
        {p.done} of {p.total} cards done
        {p.working > 0 && ` · ${p.working} ${p.working === 1 ? 'insect' : 'insects'} working`}
        {p.blocked > 0 && ` · ${p.blocked} blocked`}
        {goal.merge === 'merged' && ' · merged into your branch'}
        {goal.merge === 'undone' && ' · merge undone'}
      </p>
    </div>
  );
}

interface GoalThreadProps {
  goal: GoalView;
  snap: HiveSnapshot;
  /** Plan "Adjust": deny the plan and put the goal text back in the composer. */
  onAdjust: (goal: GoalView, approval: ApprovalView) => void;
  onError: (message: string) => void;
}

/** One goal in the Queen thread: your message, the Queen's plan, progress, and anything that needs you. */
export function GoalThread({ goal, snap, onAdjust, onError }: GoalThreadProps) {
  const approvals = snap.approvals.filter((a) => a.goalId === goal.id);
  const waiting = approvals.filter((a) => a.status === 'waiting');
  const planApproval = waiting.find((a) => a.kind === 'plan');
  const decided = approvals.filter((a) => a.status !== 'waiting');
  const activity = snap.activity.filter((a) => a.goalId === goal.id && !QUIET.has(a.type));
  const run = (a: ApprovalView, approve: boolean) => decide(a, approve).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  // A decided card leaves the thread: keep keyboard focus on this goal instead of losing it to the page.
  const focusGoal = () => document.querySelector<HTMLElement>(`[data-goal-id="${CSS.escape(goal.id)}"]`)?.focus();

  return (
    <article aria-label={`Goal: ${goal.title}`} className="flex flex-col gap-3 rounded-xl outline-offset-4" data-goal-id={goal.id} tabIndex={-1}>
      <FromCadence cadenceId={goal.cadenceId} className="self-end" snap={snap} />
      <Bubble who="you">
        <p className="m-0 whitespace-pre-wrap text-[14px]">{goal.text}</p>
      </Bubble>
      <Bubble who="queen">
        {goal.status === 'planning' && !goal.plan && (
          <p className="m-0 flex items-center gap-2 text-[13.5px] text-muted">
            <StatusDot className="motion-safe:animate-pulse" status="working" />
            Planning in waves…
          </p>
        )}
        {goal.plan && planApproval ? (
          <ApprovalCard
            destructive={planApproval.destructive}
            extraAction={{ label: 'Adjust', hint: 'Deny this plan and put your goal back in the composer to edit', onClick: () => onAdjust(goal, planApproval) }}
            from={planApproval.from}
            icon={KIND_META.plan.icon}
            id={planApproval.id}
            ifYouSayYes={planApproval.ifYouSayYes}
            kindLabel={KIND_META.plan.label}
            onApprove={() => run(planApproval, true)}
            onDeny={() => run(planApproval, false)}
            approveLabel="Approve plan"
            title={planApproval.title}
            onSettled={focusGoal}
            whyItNeedsYou={planApproval.whyItNeedsYou}
          >
            <PlanBody plan={goal.plan} />
          </ApprovalCard>
        ) : (
          goal.plan && (
            <div className="rounded-[14px] border border-line bg-surface p-3.5">
              <p className="m-0 text-xs text-muted">Plan</p>
              <PlanBody plan={goal.plan} {...(goal.status === 'running' ? { currentWave: goal.currentWave } : {})} />
            </div>
          )
        )}
        {(goal.status === 'running' || goal.status === 'done' || goal.status === 'stuck' || goal.status === 'cancelled') && <Progress goal={goal} snap={snap} />}
        {waiting
          .filter((a) => a !== planApproval)
          .map((a) => {
            const meta = KIND_META[a.kind];
            return (
              <ApprovalCard
                className="mt-3"
                destructive={a.destructive}
                from={a.from}
                icon={meta.icon}
                id={a.id}
                ifYouSayYes={a.ifYouSayYes}
                key={a.id}
                kindLabel={meta.label}
                onApprove={() => run(a, true)}
                onDeny={() => run(a, false)}
                title={a.title}
                onSettled={focusGoal}
                whyItNeedsYou={a.whyItNeedsYou}
              />
            );
          })}
        {decided.length > 0 && (
          <div className="mt-2">
            {decided.map((a) => (
              <DecisionLine approved={a.status === 'approved'} at={a.decidedAt ? ago(a.decidedAt) : undefined} key={a.id} title={a.title} />
            ))}
          </div>
        )}
        <Activity lines={activity} />
      </Bubble>
    </article>
  );
}
