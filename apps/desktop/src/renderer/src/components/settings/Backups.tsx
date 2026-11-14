import { type BackupEntry, type BackupResult, type BackupState, maintenanceCadenceId } from '@insectoids/shared';
import { DatabaseBackup, FolderOpen, History, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { whenWords } from '@/components/cadence/cadence-words';
import { useNow } from '@/components/hive/useNow';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { runCommand, useHive } from '@/lib/hive-store';
import { refreshSetup, useSetup } from '@/lib/setup-store';

const BACKUP_JOB_ID = maintenanceCadenceId('backup');

/** "640 KB", "2.1 MB", "1.2 GB". */
function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

type Busy = 'pick' | 'default' | 'now' | 'restore' | null;
type Note = { tone: 'error' | 'ok'; title: string; message: string };

/**
 * Brain backups (Memory 01-D8; Phase 3 A5): where they go, what's there, "Back up now" (the `backup` job's Run now)
 * and Restore, which opens a copy as the Brain in a new folder and leaves the current Brain where it is.
 */
export function BackupsSetting() {
  const [state, setState] = useState<BackupState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [confirm, setConfirm] = useState<BackupEntry | null>(null);
  const now = useNow(60_000);
  const { snapshot } = useHive();
  const setup = useSetup().state;
  const job = snapshot?.cadences.find((c) => c.id === BACKUP_JOB_ID) ?? null;
  const lastRun = job?.lastRun ?? null;

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await window.insectoids.backups.state());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Read on open, and again whenever the backup job finishes a run (a new copy may be there).
  const lastRunId = lastRun?.id ?? null;
  useEffect(() => {
    let live = true;
    window.insectoids.backups
      .state()
      .then((s) => {
        if (live) {
          setState(s);
          setLoadError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [lastRunId]);

  const apply = (r: BackupResult, failTitle: string): boolean => {
    setState(r.state);
    if (!r.ok) setNote({ tone: 'error', title: failTitle, message: r.error });
    return r.ok;
  };

  const act = async (kind: 'pick' | 'default'): Promise<void> => {
    setBusy(kind);
    setNote(null);
    try {
      const r = kind === 'pick' ? await window.insectoids.backups.pickFolder() : await window.insectoids.backups.useDefaultFolder();
      apply(r, 'Could not change the backups folder');
    } catch (err) {
      setNote({ tone: 'error', title: 'Could not change the backups folder', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const backUpNow = async (): Promise<void> => {
    setBusy('now');
    setNote(null);
    const r = await runCommand({ type: 'runCadenceNow', id: BACKUP_JOB_ID });
    if (!r.ok) setNote({ tone: 'error', title: 'Could not back up', message: r.error });
    await load();
    setBusy(null);
  };

  const restore = async (entry: BackupEntry): Promise<void> => {
    setConfirm(null);
    setBusy('restore');
    setNote(null);
    const before = setup?.brainDir ?? null;
    try {
      const r = await window.insectoids.backups.restore(entry.file);
      if (apply(r, 'Could not restore the backup')) {
        setNote({
          tone: 'ok',
          title: 'Backup restored',
          message: `The Brain now runs from the copy of ${whenWords(entry.at, Date.now())}.${
            before ? ` Your previous Brain is still in ${before}; to go back, choose that folder under Brain folder.` : ''
          }`,
        });
      }
    } catch (err) {
      setNote({ tone: 'error', title: 'Could not restore the backup', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      // The Brain folder changed (or not): the Brain folder section reads it fresh.
      void refreshSetup();
    }
  };

  if (!state) {
    return loadError ? (
      <InlineAlert actions={[{ label: 'Try again', onClick: () => void load(), primary: true }]} message={loadError} title="Could not read the backups" tone="error" />
    ) : (
      <div aria-busy="true" aria-label="Loading backups" className="h-24 w-full rounded-2xl bg-surface-2 motion-safe:animate-pulse" role="status" />
    );
  }

  const isDefault = state.dir === state.defaultDir;
  return (
    <div className="flex flex-col gap-3" data-testid="backups">
      <div className="flex flex-col gap-1.5 rounded-2xl border border-line bg-surface p-4">
        <span className="text-xs font-medium text-muted">{isDefault ? 'Backups folder (default)' : 'Backups folder (your choice)'}</span>
        <code className="break-all font-mono text-[13px] text-text" data-testid="backups-dir">
          {state.dir}
        </code>
        <p aria-live="polite" className="m-0 pt-1 text-sm text-text" data-testid="backups-status">
          {state.message}
        </p>
        {lastRun ? (
          <p className="m-0 flex items-center gap-2 text-sm text-muted" data-testid="backups-last-run">
            <History aria-hidden="true" className="size-4" />
            Last backup run {whenWords(lastRun.at, now)}: {lastRun.message}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Button disabled={busy !== null || !job} onClick={() => void backUpNow()} title={job ? undefined : 'The Brain is not running yet.'}>
          <DatabaseBackup aria-hidden="true" />
          {busy === 'now' ? 'Backing up…' : 'Back up now'}
        </Button>
        <Button disabled={busy !== null} onClick={() => void act('pick')} variant="outline">
          <FolderOpen aria-hidden="true" />
          {busy === 'pick' ? 'Choosing…' : 'Choose folder'}
        </Button>
        {!isDefault ? (
          <Button disabled={busy !== null} onClick={() => void act('default')} variant="ghost">
            <RotateCcw aria-hidden="true" />
            {busy === 'default' ? 'Switching…' : 'Use the default'}
          </Button>
        ) : null}
      </div>
      {lastRun?.outcome === 'failed' && !note ? <InlineAlert message={lastRun.message} title="The last backup failed" tone="error" /> : null}
      {note ? <InlineAlert message={note.message} onDismiss={() => setNote(null)} title={note.title} tone={note.tone} /> : null}
      {busy === 'restore' ? <InlineAlert busy message="The Brain restarts on the copy. This takes a few seconds." title="Restoring…" tone="waiting" /> : null}
      {state.backups.length > 0 ? (
        <ul aria-label="Backups" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {state.backups.map((b) => (
            <li className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3.5 py-2" data-file={b.file} data-testid="backup-row" key={b.file}>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-text">{whenWords(b.at, now)}</span>
                <span className="text-xs text-muted">{sizeWords(b.sizeBytes)}</span>
              </span>
              <Button disabled={busy !== null} onClick={() => setConfirm(b)} size="sm" variant="outline">
                Restore
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }} open={confirm !== null}>
        <DialogContent closeLabel="Cancel" data-testid="backup-restore-dialog">
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              {confirm
                ? `This opens a copy of the Brain from ${whenWords(confirm.at, now)} as your Brain. Your current Brain stays in its folder, so you can switch back.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirm(null)} variant="ghost">
              Keep my Brain
            </Button>
            <Button onClick={() => (confirm ? void restore(confirm) : undefined)}>Restore</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
