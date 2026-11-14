/**
 * Export to Obsidian (Memory 01-D11, E13; Phase 3 C2): a read-only copy of the Brain as Markdown notes that opens
 * as an Obsidian vault. main shows the folder picker; the Brain host writes the notes, with secrets removed.
 *
 * Reuses: shadcn `button`, Kokonut UI `inline-alert` (errors). Custom: the row, the checkbox and the result line.
 * While it works, the button stays focusable (`aria-disabled`, not `disabled`, which drops keyboard focus).
 */
import { FolderOpen, FolderOutput } from 'lucide-react';
import { useId, useState } from 'react';
import type { ObsidianExportResult } from '@insectoids/shared';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Done = Extract<ObsidianExportResult, { ok: true }>;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function ObsidianExport() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const hintId = useId();
  const checkId = useId();

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.insectoids.brainExport.exportObsidian({ includeArchived });
      if (r.ok) setDone(r);
      else if (!r.cancelled) setError({ title: "The export didn't finish", message: r.error });
    } catch (err) {
      setError({ title: "The export didn't finish", message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const showFolder = (path: string): void => {
    setError(null);
    window.insectoids.brainExport.showFolder(path).catch((err: unknown) => setError({ title: "The folder didn't open", message: errorText(err) }));
  };

  const status = busy ? 'Exporting the Brain…' : (done?.message ?? '');

  return (
    <section aria-labelledby="obsidian-export-title" className="flex w-full flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="obsidian-export">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
          <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="obsidian-export-title">
            <FolderOutput aria-hidden="true" className="size-4 text-honey" /> Export to Obsidian
          </h2>
          <p className="m-0 text-xs text-muted" id={hintId}>
            A read-only copy of the Brain as Markdown notes for Obsidian. Edits there don't come back. Secrets are never written.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm" htmlFor={checkId}>
            <input
              checked={includeArchived}
              className="size-4 accent-honey"
              data-testid="export-include-archived"
              id={checkId}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              type="checkbox"
            />
            Include archived notes
          </label>
          <Button
            aria-describedby={hintId}
            aria-disabled={busy || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            data-testid="export-obsidian"
            onClick={() => void run()}
            size="sm"
            variant="outline"
          >
            <FolderOutput aria-hidden="true" className="size-4" />
            {busy ? 'Exporting…' : 'Export to Obsidian'}
          </Button>
        </div>
      </div>
      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', !status && 'sr-only')}>
        {/* Always in the page (visually hidden while empty), so screen readers hear the result when it arrives. */}
        <p aria-live="polite" className={cn('m-0 min-w-0 flex-[1_1_320px] text-sm break-words', busy && 'text-muted')} data-testid="export-result" role="status">
          {status}
        </p>
        {!busy && done ? (
          <Button data-testid="export-show-folder" onClick={() => showFolder(done.path)} size="sm" variant="ghost">
            <FolderOpen aria-hidden="true" className="size-4" /> Show folder
          </Button>
        ) : null}
      </div>
      {error ? <InlineAlert message={error.message} onDismiss={() => setError(null)} title={error.title} tone="error" /> : null}
    </section>
  );
}
