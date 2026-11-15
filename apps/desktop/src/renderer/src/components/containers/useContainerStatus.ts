import type { ContainerStatus } from '@insectoids/shared';
import { useEffect, useState } from 'react';

/**
 * The container status from the Brain host, read on mount and again whenever the host says container mode changed
 * (a check, a download, a save). Null until the first read, or when it can't be read: callers then say nothing
 * about readiness rather than guess.
 */
export function useContainerStatus(): ContainerStatus | null {
  const [status, setStatus] = useState<ContainerStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      window.insectoids.containers
        .status()
        .then((s) => {
          if (live) setStatus(s);
        })
        .catch(() => {
          // Readiness is a hint here (Settings shows the real error); keep the last known status.
        });
    };
    read();
    const off = window.insectoids.hive.onEvent((e) => {
      if (e.type === 'changed' && e.reason === 'containers') read();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}
