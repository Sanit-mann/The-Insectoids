import { HexMark } from '@/components/HexMark';
import { cn } from '@/lib/utils';
import { SCREENS, type ScreenId } from '@/screens';

interface RailProps {
  active: ScreenId;
  onSelect: (id: ScreenId) => void;
  approvals: number;
}

export function Rail({ active, onSelect, approvals }: RailProps) {
  return (
    <nav
      aria-label="Main"
      className="flex flex-[1_1_220px] flex-col gap-1 border-r border-line bg-rail px-3 py-[18px] md:max-w-[260px]"
    >
      <div className="flex items-center gap-2.5 px-2.5 pb-[18px] font-display text-[17px] font-bold text-honey-text">
        <HexMark />
        The Insectoids
      </div>
      {SCREENS.map(({ id, label, icon: Icon }) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex min-h-10 items-center gap-2.5 rounded-[10px] px-3 text-left font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text',
              isActive && 'bg-active text-honey-text hover:bg-active hover:text-honey-text',
            )}
          >
            <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
            {label}
            {id === 'approvals' && approvals > 0 && (
              <span className="ml-auto rounded-full bg-honey px-2 text-xs font-semibold text-honey-ink">{approvals}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
