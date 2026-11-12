import { Moon, Sun } from 'lucide-react';
import type { AppInfo } from '@insectoids/shared';
import type { Theme } from '@/lib/theme';

interface TopBarProps {
  title: string;
  info: AppInfo | null;
  theme: Theme;
  onToggleTheme: () => void;
}

export function TopBar({ title, info, theme, onToggleTheme }: TopBarProps) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-6 py-3.5">
      <h1 className="m-0 font-display text-xl font-semibold">{title}</h1>
      <span className="ml-auto inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] text-muted">
        {info ? `v${info.version} · Electron ${info.electron}` : 'Connecting…'}
      </span>
      <button
        type="button"
        onClick={onToggleTheme}
        aria-label={`Switch to ${next} theme`}
        className="inline-flex size-10 items-center justify-center rounded-full border border-line bg-surface text-muted hover:text-text"
      >
        {theme === 'dark' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
      </button>
    </header>
  );
}
