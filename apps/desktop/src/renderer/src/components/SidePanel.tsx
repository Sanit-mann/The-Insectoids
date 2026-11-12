import type { ReactNode } from 'react';
import type { AgentStatus, BrainStatus } from '@insectoids/shared';
import { StatusDot } from '@/components/StatusDot';
import { useBrainStatus } from '@/lib/useBrainStatus';

const BRAIN_DOT: Record<BrainStatus['state'], AgentStatus> = { starting: 'waiting', ready: 'done', failed: 'blocked' };
const BRAIN_LABEL: Record<BrainStatus['state'], string> = { starting: 'starting', ready: 'ready', failed: 'not running' };

function BrainRow() {
  const status = useBrainStatus();
  const state = status?.state ?? 'starting';
  return (
    <div className="flex flex-col gap-1" data-testid="brain-status" data-state={state}>
      <div className="flex items-center gap-2.5 text-xs" title={status?.message}>
        <StatusDot status={BRAIN_DOT[state]} />
        Brain
        <span className="ml-auto text-muted">{BRAIN_LABEL[state]}</span>
      </div>
      {state === 'failed' && status && <p className="m-0 text-xs text-muted">{status.message}</p>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface p-4">
      <h2 className="m-0 font-display text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Right panel on the Queen screen. Live data arrives with the hive in Phase 1. */
export function SidePanel() {
  return (
    <aside aria-label="Hive status" className="flex flex-[1_1_300px] flex-col gap-4 border-l border-line bg-rail p-[18px]">
      <Card title="Approvals">
        <p className="m-0 text-xs text-muted">Nothing is waiting for you.</p>
      </Card>
      <Card title="Hive now">
        <div className="flex items-center gap-2.5 text-xs">
          <StatusDot status="idle" />
          Queen
          <span className="ml-auto text-muted">idle</span>
        </div>
        <BrainRow />
      </Card>
      <Card title="Budget">
        <p className="m-0 text-xs text-muted">No goals yet, so nothing spent.</p>
      </Card>
    </aside>
  );
}
