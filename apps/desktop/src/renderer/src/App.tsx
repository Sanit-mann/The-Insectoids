import { useEffect, useState } from 'react';
import type { AppInfo } from '@insectoids/shared';
import { PlaceholderScreen } from '@/components/PlaceholderScreen';
import { QueenScreen } from '@/components/QueenScreen';
import { Rail } from '@/components/Rail';
import { SidePanel } from '@/components/SidePanel';
import { TopBar } from '@/components/TopBar';
import { type Theme, applyTheme, initialTheme } from '@/lib/theme';
import { SCREENS, type ScreenId } from '@/screens';

export function App() {
  const [screenId, setScreenId] = useState<ScreenId>('queen');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    let alive = true;
    window.insectoids
      .appInfo()
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, []);

  const screen = SCREENS.find((s) => s.id === screenId) ?? SCREENS[0]!;

  return (
    <div className="flex min-h-full flex-wrap items-stretch">
      <Rail active={screenId} onSelect={setScreenId} approvals={0} />
      <main className="flex min-w-0 flex-[999_1_560px] flex-col">
        <TopBar
          title={screen.label}
          info={info}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        />
        {screenId === 'queen' ? <QueenScreen /> : <PlaceholderScreen screen={screen} />}
      </main>
      {screenId === 'queen' && <SidePanel />}
    </div>
  );
}
