import { type ReactNode, useEffect, useState } from 'react';
import type { AppInfo } from '@insectoids/shared';
import { AwayDigestDialog } from '@/components/digest/AwayDigestDialog';
import { PlaceholderScreen } from '@/components/PlaceholderScreen';
import { Rail } from '@/components/Rail';
import { ApprovalsScreen } from '@/components/screens/ApprovalsScreen';
import { BrainScreen } from '@/components/screens/BrainScreen';
import { BudgetsScreen } from '@/components/screens/BudgetsScreen';
import { CadenceScreen } from '@/components/screens/CadenceScreen';
import { ChangesScreen } from '@/components/screens/ChangesScreen';
import { ConnectionsScreen } from '@/components/screens/ConnectionsScreen';
import { HiveScreen } from '@/components/screens/HiveScreen';
import { LibraryScreen } from '@/components/screens/LibraryScreen';
import { QueenScreen } from '@/components/screens/QueenScreen';
import { SettingsScreen } from '@/components/screens/SettingsScreen';
import { SetupGate } from '@/components/setup/SetupGate';
import { TaskboardScreen } from '@/components/screens/TaskboardScreen';
import { SidePanel } from '@/components/SidePanel';
import { TopBar } from '@/components/TopBar';
import { pendingApprovals, useHive } from '@/lib/hive-store';
import { type Theme, applyTheme, initialTheme } from '@/lib/theme';
import { SCREENS, type ScreenId } from '@/screens';

/** Screens that are live in Phase 1; the rest show their roadmap placeholder. */
const LIVE: Partial<Record<ScreenId, () => ReactNode>> = {
  queen: () => <QueenScreen />,
  approvals: () => <ApprovalsScreen />,
  taskboard: () => <TaskboardScreen />,
  hive: () => <HiveScreen />,
  changes: () => <ChangesScreen />,
  brain: () => <BrainScreen />,
  settings: () => <SettingsScreen />,
  connections: () => <ConnectionsScreen />,
  library: () => <LibraryScreen />,
  budgets: () => <BudgetsScreen />,
  cadence: () => <CadenceScreen />,
};

export function App() {
  const { snapshot } = useHive();
  const [screenId, setScreenId] = useState<ScreenId>('queen');
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => applyTheme(theme), [theme]);

  // Any screen can switch screens: window.dispatchEvent(new CustomEvent('insectoids:navigate', { detail: 'approvals' })).
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail;
      if (SCREENS.some((s) => s.id === id)) setScreenId(id as ScreenId);
    };
    window.addEventListener('insectoids:navigate', onNavigate);
    return () => window.removeEventListener('insectoids:navigate', onNavigate);
  }, []);

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
    <SetupGate>
    <div className="flex min-h-full flex-wrap items-stretch">
      <Rail active={screenId} onSelect={setScreenId} approvals={pendingApprovals(snapshot).length} />
      <main className="flex min-w-0 flex-[999_1_560px] flex-col">
        <TopBar
          title={screen.label}
          info={info}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        />
        {LIVE[screenId]?.() ?? <PlaceholderScreen screen={screen} />}
      </main>
      {screenId === 'queen' && <SidePanel />}
      <AwayDigestDialog />
    </div>
    </SetupGate>
  );
}
