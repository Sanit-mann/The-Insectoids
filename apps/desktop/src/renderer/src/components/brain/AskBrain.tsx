/**
 * Ask the Brain (Memory 01; Phase 4 A1): a plain-words question answered only from Brain records, with each
 * citation [n] a link that opens the record in the reader. Before the first question of a session it says what one
 * question roughly costs and on which engine (`brainAskEstimate`); an answer can be kept as an unconfirmed note
 * (`saveBrainAnswer`).
 *
 * Reuses: shadcn `button`, Kokonut UI `inline-alert` (errors), lucide icons, the Brain's kinds and trust words.
 * Custom: the panel, the answer with citation links, and the source lists.
 * While it works, Ask stays focusable (`aria-disabled`, not `disabled`, which drops keyboard focus).
 */
import { Bookmark, BookmarkCheck, CircleAlert, CircleCheck, CircleHelp, Coins, MessageCircleQuestion, Send } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { BrainAskEstimate, BrainAskResult, BrainAskSource } from '@insectoids/shared';
import { formatTokens, formatUsd } from '@/components/hive/format';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { runCommand } from '@/lib/hive-store';
import { cn } from '@/lib/utils';
import { TRUST, kindInfo } from './kinds';

const MIN_QUESTION = 3;
const MAX_QUESTION = 500;

type Estimate = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; estimate: BrainAskEstimate };
type Save = { state: 'idle' } | { state: 'saving' } | { state: 'saved' } | { state: 'error'; message: string };

/** Whether a question has been asked in this app session (the estimate shows only before the first one). */
let askedThisSession = false;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function AskBrain({ onOpen }: { onOpen: (id: string) => void }) {
  const [question, setQuestion] = useState('');
  const [estimate, setEstimate] = useState<Estimate>({ state: 'loading' });
  const [asked, setAsked] = useState(askedThisSession);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BrainAskResult | null>(null);
  const [save, setSave] = useState<Save>({ state: 'idle' });
  const alive = useRef(true);
  const inputId = useId();
  const hintId = useId();
  const estimateId = useId();

  useEffect(() => {
    alive.current = true;
    window.insectoids.hive
      .brainAskEstimate()
      .then((e) => alive.current && setEstimate({ state: 'ready', estimate: e }))
      .catch((err: unknown) => alive.current && setEstimate({ state: 'error', message: errorText(err) }));
    return () => {
      alive.current = false;
    };
  }, []);

  const q = question.trim();
  const cannotAsk = estimate.state === 'ready' && !estimate.estimate.canAsk;
  const tooShort = q.length < MIN_QUESTION;
  const blocked = busy || cannotAsk || tooShort;
  const showEstimate = !asked || cannotAsk;

  const ask = async (): Promise<void> => {
    if (blocked) return;
    askedThisSession = true;
    setAsked(true);
    setBusy(true);
    setSave({ state: 'idle' });
    let r: BrainAskResult;
    try {
      r = await window.insectoids.hive.brainAsk({ question: q.slice(0, MAX_QUESTION) });
    } catch (err) {
      r = { status: 'error', question: q, message: errorText(err) };
    }
    if (!alive.current) return;
    setResult(r);
    setBusy(false);
  };

  const keep = async (r: Extract<BrainAskResult, { status: 'answered' }>): Promise<void> => {
    if (save.state === 'saving' || save.state === 'saved') return;
    setSave({ state: 'saving' });
    const res = await runCommand({ type: 'saveBrainAnswer', question: r.question, answer: r.answer, citationIds: r.citations.map((c) => c.id) });
    if (!alive.current) return;
    setSave(res.ok ? { state: 'saved' } : { state: 'error', message: res.error });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void ask();
  };

  const status = busy ? 'Asking the Brain…' : result?.status === 'answered' ? 'The Brain answered.' : result?.status === 'unknown' ? "The Brain doesn't know." : '';

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex w-full flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-testid="brain-ask">
      <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id={`${inputId}-title`}>
        <MessageCircleQuestion aria-hidden="true" className="size-4 text-honey" /> Ask the Brain
      </h2>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm text-muted" htmlFor={inputId}>
          Ask the Brain a question
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <textarea
            aria-describedby={`${hintId}${showEstimate ? ` ${estimateId}` : ''}`}
            className="min-h-16 min-w-0 flex-[1_1_320px] resize-y rounded-[10px] border border-line bg-ground px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus-visible:border-honey focus-visible:ring-2 focus-visible:ring-honey/40"
            data-testid="brain-ask-input"
            id={inputId}
            maxLength={MAX_QUESTION}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Why did we pick SQLite for the Brain?"
            rows={2}
            value={question}
          />
          <Button
            aria-describedby={`${hintId}${cannotAsk ? ` ${estimateId}` : ''}`}
            aria-disabled={blocked || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            data-testid="brain-ask-submit"
            onClick={() => void ask()}
          >
            <Send aria-hidden="true" /> Ask
          </Button>
        </div>
        <p className="m-0 text-xs text-muted" id={hintId}>
          Enter asks, Shift+Enter starts a new line. Answers come only from the Brain&apos;s records, with the records they used.
        </p>
      </div>

      {showEstimate && <EstimateLine estimate={estimate} id={estimateId} />}

      {/* Always in the page (visually hidden while empty), so screen readers hear progress and the outcome. */}
      <p aria-live="polite" className={cn('m-0 text-sm text-muted', !busy && 'sr-only')} data-testid="brain-ask-status" role="status">
        {status}
      </p>

      {!busy && result && (
        <div className="flex flex-col gap-3" data-status={result.status} data-testid="brain-ask-result">
          {result.status === 'error' ? (
            <InlineAlert message={result.message} title="The Brain couldn't answer" tone="error" />
          ) : result.status === 'unknown' ? (
            <UnknownAnswer onOpen={onOpen} result={result} />
          ) : (
            <Answered onKeep={() => void keep(result)} onOpen={onOpen} result={result} save={save} />
          )}
        </div>
      )}
    </section>
  );
}

function EstimateLine({ estimate, id }: { estimate: Estimate; id: string }) {
  if (estimate.state === 'loading') {
    return (
      <p className="m-0 text-xs text-muted" data-testid="brain-ask-estimate" id={id}>
        Working out what a question costs…
      </p>
    );
  }
  if (estimate.state === 'error') {
    return (
      <p className="m-0 flex items-start gap-1.5 text-xs text-muted" data-testid="brain-ask-estimate" id={id}>
        <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>Couldn&apos;t work out what a question costs: {estimate.message}</span>
      </p>
    );
  }
  const e = estimate.estimate;
  const Icon = e.canAsk ? Coins : CircleAlert;
  return (
    <p
      className={cn('m-0 flex items-start gap-1.5 text-xs', e.canAsk ? 'text-muted' : 'text-st-blocked')}
      data-can-ask={e.canAsk}
      data-testid="brain-ask-estimate"
      id={id}
    >
      <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span>
        {e.canAsk ? '' : "Can't ask right now. "}
        {e.message}
      </span>
    </p>
  );
}

/** The answer text with each [n] turned into a small button that opens source n in the reader. */
function AnswerText({ answer, citations, onOpen }: { answer: string; citations: BrainAskSource[]; onOpen: (id: string) => void }) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const parts: ReactNode[] = [];
  const re = /\[(\d+)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const src = byN.get(Number(m[1]));
    if (!src) continue;
    if (m.index > last) parts.push(answer.slice(last, m.index));
    parts.push(
      <button
        aria-label={`Source ${src.n}: ${src.title}`}
        className="mx-px inline-flex min-h-6 items-center rounded-md border border-line bg-surface px-1 align-baseline font-mono text-xs text-honey-text hover:border-honey focus-visible:outline-2 focus-visible:outline-honey"
        data-testid="brain-ask-cite"
        key={`${m.index}-${src.n}`}
        onClick={() => onOpen(src.id)}
        title={src.title}
        type="button"
      >
        [{src.n}]
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < answer.length) parts.push(answer.slice(last));
  return <div className="whitespace-pre-wrap break-words rounded-[10px] border border-line bg-ground p-3 text-sm leading-6">{parts}</div>;
}

function SourceList({ label, sources, onOpen }: { label: string; sources: BrainAskSource[]; onOpen: (id: string) => void }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3 className="m-0 font-display text-sm font-semibold" id={headingId}>
        {label}
      </h3>
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
        {sources.map((s) => {
          const k = kindInfo(s.kind);
          const t = TRUST[s.trust];
          const Icon = k.icon;
          return (
            <li key={s.id}>
              <button
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-2"
                data-testid="brain-ask-source"
                onClick={() => onOpen(s.id)}
                type="button"
              >
                <span className="w-7 shrink-0 font-mono text-xs text-muted">[{s.n}]</span>
                <Icon aria-hidden="true" className="size-4 shrink-0 text-honey" />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="shrink-0 text-xs text-muted">
                  {k.label}
                  {s.shelf === 'global' ? ' · global' : ''}
                </span>
                <span className={cn('shrink-0 rounded-full border px-2 text-xs leading-5', t.className)} title={t.hint}>
                  {t.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Answered({
  result,
  save,
  onOpen,
  onKeep,
}: {
  result: Extract<BrainAskResult, { status: 'answered' }>;
  save: Save;
  onOpen: (id: string) => void;
  onKeep: () => void;
}) {
  const cost = `${result.costEstimated ? '≈' : ''}${formatUsd(result.costUsd)}`;
  const keeping = save.state === 'saving';
  const kept = save.state === 'saved';
  return (
    <>
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1 rounded-full border border-st-done/50 px-2 text-xs leading-5 text-st-done">
          <CircleCheck aria-hidden="true" className="size-3.5" /> Answered
        </span>
        <span className="min-w-0 text-muted">{result.question}</span>
      </p>
      <AnswerText answer={result.answer} citations={result.citations} onOpen={onOpen} />
      <SourceList label="Sources" onOpen={onOpen} sources={result.citations} />
      <p className="m-0 text-xs text-muted" data-testid="brain-ask-meta">
        {result.engine}
        {result.model ? ` · ${result.model}` : ''} · {formatTokens(result.tokens)} tokens · {cost}
        {result.costEstimated ? ' (estimated)' : ''} · cites {result.citations.length} of the {result.sourcesGiven} {result.sourcesGiven === 1 ? 'record' : 'records'} it was given
      </p>
      <p className="m-0 text-xs text-muted">Answers come only from the Brain&apos;s records. Open a source to check it before you rely on the answer.</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          aria-disabled={keeping || kept || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          data-testid="brain-ask-keep"
          onClick={onKeep}
          size="sm"
          variant="outline"
        >
          {kept ? <BookmarkCheck aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
          {keeping ? 'Keeping…' : 'Keep as a note'}
        </Button>
        <p aria-live="polite" className="m-0 text-sm" data-testid="brain-ask-kept" role="status">
          {kept ? 'Kept as an unconfirmed note.' : ''}
        </p>
      </div>
      {save.state === 'error' && <InlineAlert message={save.message} title="The answer wasn't kept" tone="error" />}
    </>
  );
}

function UnknownAnswer({ result, onOpen }: { result: Extract<BrainAskResult, { status: 'unknown' }>; onOpen: (id: string) => void }) {
  return (
    <>
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1 rounded-full border border-st-waiting/50 px-2 text-xs leading-5 text-st-waiting">
          <CircleHelp aria-hidden="true" className="size-3.5" /> Doesn&apos;t know
        </span>
        <span className="min-w-0 text-muted">{result.question}</span>
      </p>
      <p className="m-0 text-sm" data-testid="brain-ask-message">
        {result.message}
      </p>
      {result.sources.length > 0 && <SourceList label="Closest records" onOpen={onOpen} sources={result.sources} />}
      {result.tokens > 0 && (
        <p className="m-0 text-xs text-muted" data-testid="brain-ask-meta">
          {formatTokens(result.tokens)} tokens · {formatUsd(result.costUsd)}
        </p>
      )}
    </>
  );
}
