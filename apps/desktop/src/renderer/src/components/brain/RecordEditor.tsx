/**
 * Edit a Brain record (Memory 01-D12; Phase 2 B5). Every save is a new version (history kept) and a
 * user edit counts as confirmed. If an agent changed the record while the user was editing, nothing is
 * overwritten: the user sees both texts side by side and picks "Keep mine" or "Use theirs".
 *
 * Reuses: shadcn `button`, Kokonut UI `inline-alert` (save errors). Custom: the form and the
 * side-by-side conflict view.
 */
import { GitCompareArrows, Save, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { BrainEditResult, BrainRecordView } from '@insectoids/shared';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { ago } from './RecordLife';

type Conflict = Extract<BrainEditResult, { status: 'conflict' }>['current'];
interface Draft {
  title: string;
  summary: string;
  body: string;
}

const field = 'w-full rounded-[10px] border border-line bg-ground px-3 py-2 text-sm text-text outline-none focus-visible:border-honey focus-visible:ring-2 focus-visible:ring-honey/40';

export function RecordEditor({ record, onSaved, onCancel }: { record: BrainRecordView; onSaved: () => void; onCancel: () => void }) {
  const ids = useId();
  const [draft, setDraft] = useState<Draft>({ title: record.title, summary: record.summary ?? '', body: record.body });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const save = async (baseVersion: number): Promise<void> => {
    if (!draft.title.trim()) {
      setError('A record needs a title.');
      return;
    }
    setBusy(true);
    setError(null);
    let r: BrainEditResult;
    try {
      r = await window.insectoids.hive.brainEdit({
        id: record.id,
        baseVersion,
        title: draft.title.trim(),
        body: draft.body,
        summary: draft.summary.trim() ? draft.summary.trim() : null,
      });
    } catch (err) {
      r = { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    setBusy(false);
    if (r.status === 'saved') onSaved();
    else if (r.status === 'conflict') setConflict(r.current);
    else setError(r.message);
  };

  if (conflict) {
    return (
      <section aria-labelledby={`${ids}-c`} className="flex flex-col gap-3 rounded-[10px] border border-st-waiting/60 bg-st-waiting/5 p-3" data-testid="record-conflict" role="region">
        <h3 className="m-0 flex items-center gap-2 font-display text-sm font-semibold" id={`${ids}-c`}>
          <GitCompareArrows aria-hidden="true" className="size-4 text-st-waiting" /> Changed while you were editing
        </h3>
        <p className="m-0 text-sm">
          {conflict.changedBy === 'user' ? 'You' : conflict.changedBy} saved version {conflict.version} {ago(conflict.changedAt)}. Nothing of yours
          was saved yet: pick which text to keep. Either way, both stay in the history.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <Side heading={`Theirs (version ${conflict.version})`} summary={conflict.summary} title={conflict.title} body={conflict.body} testId="conflict-theirs" />
          <Side heading="Yours (not saved)" summary={draft.summary || null} title={draft.title} body={draft.body} testId="conflict-yours" />
        </div>
        {error && <InlineAlert message={error} onDismiss={() => setError(null)} title="That didn't save" tone="error" />}
        <div className="flex flex-wrap gap-2">
          <Button data-testid="conflict-keep-mine" disabled={busy} onClick={() => void save(conflict.version)}>
            <Save aria-hidden="true" /> Keep mine
          </Button>
          <Button
            data-testid="conflict-use-theirs"
            disabled={busy}
            onClick={() => {
              setConflict(null);
              onCancel();
            }}
            variant="outline"
          >
            Use theirs
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form
      aria-labelledby={`${ids}-h`}
      className="flex flex-col gap-3 rounded-[10px] border border-honey/50 p-3"
      data-testid="record-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save(record.version);
      }}
    >
      <h3 className="m-0 font-display text-sm font-semibold" id={`${ids}-h`}>
        Edit this record
      </h3>
      <p className="m-0 text-xs text-muted">Your edit is saved as a new version and counts as confirmed.</p>
      <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={`${ids}-t`}>
        Title
        <input className={field} id={`${ids}-t`} maxLength={300} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} required value={draft.title} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={`${ids}-s`}>
        Summary (optional)
        <input className={field} id={`${ids}-s`} maxLength={1000} onChange={(e) => setDraft((d) => ({ ...d, summary: e.target.value }))} value={draft.summary} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={`${ids}-b`}>
        Text
        <textarea className={`${field} min-h-40 font-mono`} id={`${ids}-b`} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} value={draft.body} />
      </label>
      {error && <InlineAlert message={error} onDismiss={() => setError(null)} title="That didn't save" tone="error" />}
      <div className="flex flex-wrap gap-2">
        <Button data-testid="record-save" disabled={busy} type="submit">
          <Save aria-hidden="true" /> {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button disabled={busy} onClick={onCancel} variant="outline">
          <X aria-hidden="true" /> Cancel
        </Button>
      </div>
    </form>
  );
}

function Side({ heading, title, summary, body, testId }: { heading: string; title: string; summary: string | null; body: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-line bg-surface p-3" data-testid={testId}>
      <h4 className="m-0 text-xs font-semibold text-muted">{heading}</h4>
      <p className="m-0 font-medium">{title}</p>
      {summary && <p className="m-0 text-xs text-muted">{summary}</p>}
      <div className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-sm">{body}</div>
    </div>
  );
}
