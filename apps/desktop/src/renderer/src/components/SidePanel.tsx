import type { ReactNode } from 'react';
import { StatusDot } from '@/components/StatusDot';

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
      </Card>
      <Card title="Budget">
        <p className="m-0 text-xs text-muted">No goals yet, so nothing spent.</p>
      </Card>
    </aside>
  );
}
