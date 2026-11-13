import { useEffect, useState } from 'react';
import type { BrainStatus } from '@insectoids/shared';

/** The Brain host's health: re-read on every status push from main, plus a slow poll as a safety net. */
export function useBrainStatus(): BrainStatus | null {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = (): void => {
      window.insectoids
        .brainStatus()
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          timer = setTimeout(poll, s.state === 'ready' ? 10_000 : 1_000);
        })
        .catch(() => {
          if (alive) timer = setTimeout(poll, 2_000);
        });
    };
    poll();
    // Main pushes every Brain status change: re-read at once instead of waiting for the next poll.
    const off = window.insectoids.hive.onEvent((e) => {
      if (e.type === 'changed' && e.reason.startsWith('brain-')) {
        clearTimeout(timer);
        poll();
      }
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, []);
  return status;
}
