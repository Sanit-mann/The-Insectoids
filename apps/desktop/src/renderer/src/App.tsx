import { type ReactNode, useEffect, useRef, useState } from 'react';
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
import { SCREEN_TITLE_ID, TopBar } from '@/components/TopBar';
import { openGoal } from '@/lib/goal-nav';
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

  // A desktop notification or a tray item was clicked (B2): main asks for a screen, and for the Queen maybe a goal.
  useEffect(
    () =>
      window.insectoids.hive.onEvent((e) => {
        if (e.type !== 'open-screen') return;
        if (e.screen === 'queen' && e.goalId) openGoal(e.goalId);
        else setScreenId(e.screen);
      }),
    [],
  );

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

  // After a screen switch, focus the new screen's heading so screen-reader users hear where they are (WCAG 2.4.3).
  // Only when the switch came from the Main navigation or left focus nowhere: a screen (or openGoal) that already
  // put focus somewhere useful keeps it.
  const shownScreen = useRef(screenId);
  useEffect(() => {
    if (shownScreen.current === screenId) return;
    shownScreen.current = screenId;
    const el = document.activeElement;
    const lost = !el || el === document.body;
    if (lost || el.closest('nav[aria-label="Main"]')) document.getElementById(SCREEN_TITLE_ID)?.focus();
  }, [screenId]);

  const screen = SCREENS.find((s) => s.id === screenId) ?? SCREENS[0]!;

  return (
    <SetupGate>
    <div className="flex min-h-full flex-wrap items-stretch">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:rounded-[10px] focus:border focus:border-line focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-text"
        href={`#${SCREEN_TITLE_ID}`}
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(SCREEN_TITLE_ID)?.focus();
        }}
      >
        Skip to main content
      </a>
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
