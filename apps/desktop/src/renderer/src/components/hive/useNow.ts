import { useEffect, useState } from 'react';

/** Current time, re-rendering every `ms` (durations, lease countdowns). Stops while the window is hidden. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const startTimer = (): void => {
      if (id === null) id = setInterval(() => setNow(Date.now()), ms);
    };
    const stopTimer = (): void => {
      if (id !== null) clearInterval(id);
      id = null;
    };
    const onVisibility = (): void => {
      if (document.hidden) stopTimer();
      else {
        setNow(Date.now());
        startTimer();
      }
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms]);
  return now;
}
