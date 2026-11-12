import { AlertTriangle, type LucideIcon } from 'lucide-react';
import { refresh } from '@/lib/hive-store';

/** Loading: skeleton blocks, never a whole-screen spinner (App 07 "States every screen handles"). */
export function SkeletonColumns({ columns = 5, label }: { columns?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="grid grid-cols-[repeat(auto-fit,minmax(176px,1fr))] gap-3 p-4">
      {Array.from({ length: columns }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface/60 p-2.5">
          <div className="h-4 w-24 animate-pulse rounded bg-surface-2" />
          <div className="h-16 animate-pulse rounded-[14px] bg-surface-2" />
          <div className="h-16 animate-pulse rounded-[14px] bg-surface-2 opacity-60" />
        </div>
      ))}
    </div>
  );
}

/** Error: inline alert that can re-run the failed read. */
export function ReadError({ message }: { message: string }) {
  return (
    <div role="alert" className="m-4 flex flex-wrap items-center gap-3 rounded-xl border border-st-blocked/60 bg-surface p-3">
      <AlertTriangle size={18} className="text-st-blocked" aria-hidden="true" />
      <span className="min-w-0 flex-1">Couldn't read the hive: {message}</span>
      <button type="button" onClick={() => void refresh()} className="min-h-10 rounded-[10px] border border-line bg-surface-2 px-3.5 font-semibold">
        Try again
      </button>
    </div>
  );
}

/** Empty: says what will appear here and where to start. */
export function EmptyHint({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon size={36} strokeWidth={1.5} className="text-honey" aria-hidden="true" />
      <h2 className="m-0 font-display text-lg font-semibold">{title}</h2>
      <p className="m-0 max-w-[460px] text-muted">{children}</p>
    </div>
  );
}
