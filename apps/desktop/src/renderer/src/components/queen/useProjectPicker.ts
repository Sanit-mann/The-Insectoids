import { useState } from 'react';
import { runCommand } from '@/lib/hive-store';

/** Opens the folder picker, then makes the chosen folder the hive's project. */
export function useProjectPicker(): { pick: () => Promise<void>; picking: boolean; error: string | null; clearError: () => void } {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (): Promise<void> => {
    setPicking(true);
    setError(null);
    try {
      const project = await window.insectoids.hive.pickProject();
      if (!project) return; // cancelled
      const r = await runCommand({ type: 'setProject', path: project.path });
      if (!r.ok) setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };
  return { pick, picking, error, clearError: () => setError(null) };
}
