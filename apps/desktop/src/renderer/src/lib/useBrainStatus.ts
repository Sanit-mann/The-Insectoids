import { useEffect, useState } from 'react';
import type { BrainStatus } from '@insectoids/shared';

/** Polls the Brain host's health: often while it starts or retries, rarely once it runs. */
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
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}
