import { ABOUT_QUESTIONS, type AboutQuestionId } from '@insectoids/shared';
import { Check, Crown, SendHorizontal, User } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { setupActions } from '@/lib/setup-store';
import { cn } from '@/lib/utils';

type Reply = { kind: 'answer'; text: string } | { kind: 'skipped' };

/**
 * The short "about you" interview (08-D3, D4): the Queen asks one question at a time; every
 * question can be skipped. Each answer is saved straight away as a confirmed fact on the Global
 * shelf. A refused answer (e.g. it looks like a secret) stays in the box so the user can edit it.
 */
export function AboutYou({ answered, onDone }: { answered: readonly AboutQuestionId[]; onDone: () => void }) {
  const [replies, setReplies] = useState<Partial<Record<AboutQuestionId, Reply>>>({});
  const firstOpen = ABOUT_QUESTIONS.findIndex((q) => !answered.includes(q.id));
  const [index, setIndex] = useState(firstOpen < 0 ? ABOUT_QUESTIONS.length : firstOpen);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const finished = index >= ABOUT_QUESTIONS.length;
  const current = ABOUT_QUESTIONS[index];

  useEffect(() => {
    if (!finished) box.current?.focus();
  }, [index, finished]);

  const advance = (): void => {
    setDraft('');
    setError(null);
    setIndex((i) => i + 1);
  };

  const send = async (): Promise<void> => {
    if (!current || saving) return;
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    setError(null);
    const r = await setupActions.saveAbout({ answers: [{ id: current.id, answer: text }] });
    setSaving(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setReplies((m) => ({ ...m, [current.id]: { kind: 'answer', text } }));
    advance();
  };

  const skip = (): void => {
    if (!current) return;
    setReplies((m) => ({ ...m, [current.id]: { kind: 'skipped' } }));
    advance();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const shown = ABOUT_QUESTIONS.slice(0, Math.min(index + 1, ABOUT_QUESTIONS.length));

  return (
    <div className="flex flex-col gap-4">
      <ol aria-label="Questions from the Queen" className="m-0 flex list-none flex-col gap-3 p-0">
        {shown.map((q, i) => {
          const reply = replies[q.id];
          const savedBefore = !reply && answered.includes(q.id);
          return (
            <li className="flex flex-col gap-2" key={q.id}>
              <div className="flex items-start gap-2.5">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-honey/15 text-honey-text">
                  <Crown className="size-4" />
                </span>
                <p className="m-0 max-w-[560px] rounded-2xl rounded-tl-md border border-line bg-surface px-3.5 py-2.5 text-[15px] text-text">
                  <span className="sr-only">Queen asks: </span>
                  {q.question}
                </p>
              </div>
              {reply?.kind === 'answer' ? (
                <div className="flex items-start justify-end gap-2.5">
                  <div className="flex max-w-[520px] flex-col items-end gap-1">
                    <p className="m-0 rounded-2xl rounded-tr-md bg-honey/15 px-3.5 py-2.5 text-[15px] whitespace-pre-wrap text-text">
                      <span className="sr-only">You answered: </span>
                      {reply.text}
                    </p>
                    <span className="flex items-center gap-1 text-xs text-st-done">
                      <Check aria-hidden="true" className="size-3" /> Saved to your Brain
                    </span>
                  </div>
                  <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">
                    <User className="size-4" />
                  </span>
                </div>
              ) : null}
              {reply?.kind === 'skipped' ? <p className="m-0 self-end text-xs text-muted">Skipped</p> : null}
              {savedBefore ? (
                <p className="m-0 flex items-center gap-1 self-end text-xs text-st-done">
                  <Check aria-hidden="true" className="size-3" /> Already saved
                </p>
              ) : null}
              {i === index && !finished ? <span className="sr-only" aria-live="polite">{`Question ${i + 1} of ${ABOUT_QUESTIONS.length}`}</span> : null}
            </li>
          );
        })}
      </ol>

      {!finished && current ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3">
          <label className="text-xs text-muted" htmlFor="about-answer">
            Your answer ({index + 1} of {ABOUT_QUESTIONS.length}) · Enter to send, Shift+Enter for a new line
          </label>
          <textarea
            aria-describedby={error ? 'about-error' : undefined}
            className="min-h-[68px] resize-y rounded-xl border-0 bg-transparent text-[15px] text-text outline-none placeholder:text-muted"
            id="about-answer"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={current.id === 'voice' ? 'Paste a few lines you wrote…' : 'Type your answer…'}
            ref={box}
            rows={current.id === 'voice' ? 4 : 2}
            value={draft}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button disabled={saving} onClick={skip} size="sm" variant="ghost">
              Skip this question
            </Button>
            <Button disabled={saving || !draft.trim()} onClick={() => void send()} size="sm">
              <SendHorizontal aria-hidden="true" />
              {saving ? 'Saving…' : 'Answer'}
            </Button>
          </div>
        </div>
      ) : (
        <div className={cn('flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4')}>
          <p className="m-0 flex-1 text-sm text-text">That&apos;s all the Queen wanted to ask. You can change these answers any time in the Brain.</p>
          <Button onClick={onDone} variant="outline">
            Continue
          </Button>
        </div>
      )}

      {error ? (
        <div id="about-error">
          <InlineAlert message={`${error} Edit your answer and send it again, or skip the question.`} onDismiss={() => setError(null)} title="That answer was not saved" tone="error" />
        </div>
      ) : null}

      <p className="m-0 text-xs text-muted">
        Answers are saved as facts you confirmed, on your Global shelf. They stay on this PC and you can edit them any time in the Brain.
      </p>
    </div>
  );
}
