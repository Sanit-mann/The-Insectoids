import type { ScreenDef } from '@/screens';

/** Empty state for screens that arrive in a later roadmap phase. */
export function PlaceholderScreen({ screen }: { screen: ScreenDef }) {
  const Icon = screen.icon;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon size={40} strokeWidth={1.5} className="text-honey" aria-hidden="true" />
      <p className="m-0 max-w-[460px] text-muted">{screen.blurb}</p>
      <span className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
        Arrives in Phase {screen.phase}
      </span>
    </div>
  );
}
