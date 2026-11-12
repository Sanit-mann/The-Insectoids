/**
 * Source: Kokonut UI — AI Prompt v1 (@kokonutui, MIT) https://kokonutui.com
 * Adapted for The Insectoids' Queen composer: our colour tokens, strict TypeScript, and only what the
 * hive needs. Kept from the original: the auto-growing textarea, Enter to send / Shift+Enter for a new
 * line, ↑ in an empty prompt recalls the last message, IME-safe Enter, and the send button whose face
 * crossfades while a send is in flight.
 * Removed: model / effort menus (the Treasurer routes models), attachments, slash commands, promo header.
 */
import { ArrowUp } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useAutoResizeTextarea } from '@/hooks/use-auto-resize-textarea';
import { cn } from '@/lib/utils';

export interface AIPromptProps {
  /** Accessible name of the text field. */
  label: string;
  placeholder?: string;
  /** When set, the prompt is disabled and this says why (shown under the field). */
  disabledReason?: string | null | undefined;
  /** Send the text. Resolve true when it was accepted (the field then clears), false to keep it. */
  onSubmit: (text: string) => Promise<boolean>;
  /** Text to put in the field (e.g. "Adjust" puts a goal back for editing). Changing `seed.key` reapplies it. */
  seed?: { key: number; text: string } | undefined;
  /** Line above the field, e.g. the active project. */
  header?: ReactNode;
  /** Controls left of the send button, e.g. a budget field. */
  footer?: ReactNode;
  className?: string;
}

function SendButton({ sending, canSend, onSend }: { sending: boolean; canSend: boolean; onSend: () => void }) {
  // One button with two faces that crossfade, so "sending" reads as the same control changing state.
  const face = 'absolute inset-0 flex items-center justify-center transition-[opacity,filter] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]';
  return (
    <button
      aria-label={sending ? 'Sending to the Queen' : 'Send to the Queen'}
      className={cn(
        'relative size-10 shrink-0 rounded-full transition-[background-color,color] duration-150',
        sending || canSend ? 'bg-honey text-honey-ink hover:bg-honey/85' : 'bg-surface-2 text-muted',
      )}
      disabled={!canSend || sending}
      onClick={onSend}
      type="button"
    >
      <span aria-hidden="true" className={cn(face, sending ? 'opacity-0 blur-[2px]' : 'opacity-100 blur-0')}>
        <ArrowUp className="size-4" strokeWidth={2.25} />
      </span>
      <span aria-hidden="true" className={cn(face, sending ? 'opacity-100 blur-0' : 'opacity-0 blur-[2px]')}>
        <span className="size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />
      </span>
    </button>
  );
}

export function AIPrompt({ label, placeholder = 'Tell the Queen what you want done', disabledReason, onSubmit, seed, header, footer, className }: AIPromptProps) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [seedKey, setSeedKey] = useState<number | null>(null);
  const lastSentRef = useRef('');
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({ minHeight: 56, maxHeight: 240 });
  const textareaId = useId();
  const reasonId = useId();
  const disabled = Boolean(disabledReason);

  // Apply a new seed once (render-time state sync); the effect below sizes and focuses the field.
  if (seed && seed.key !== seedKey) {
    setSeedKey(seed.key);
    setValue(seed.text);
  }
  useEffect(() => {
    if (seedKey === null) return;
    adjustHeight();
    textareaRef.current?.focus();
  }, [seedKey, adjustHeight, textareaRef]);

  const canSend = value.trim().length >= 3 && !disabled;

  const submit = async () => {
    if (!canSend || sending) return;
    const text = value.trim();
    setSending(true);
    try {
      const accepted = await onSubmit(text);
      if (accepted) {
        lastSentRef.current = text;
        setValue('');
        adjustHeight(true);
      }
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const recallLast = () => {
    setValue(lastSentRef.current);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      adjustHeight();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter during IME composition confirms the candidate; it must not submit.
    if (e.nativeEvent.isComposing) return;
    if (value === '' && e.key === 'ArrowUp' && lastSentRef.current) {
      e.preventDefault();
      recallLast();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className={cn('w-full', className)}>
      <div className="rounded-[18px] border border-line bg-surface p-1">
        {header && <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-1 text-xs text-muted">{header}</div>}
        <div
          className={cn(
            'relative flex flex-col rounded-[14px] bg-ground/40 ring-1 ring-line transition-shadow duration-150 has-[textarea:focus-visible]:ring-honey/60',
            disabled && 'opacity-70',
          )}
        >
          <label className="sr-only" htmlFor={textareaId}>
            {label}
          </label>
          <textarea
            aria-describedby={disabled ? reasonId : undefined}
            className="min-h-[56px] w-full resize-none border-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-text outline-none placeholder:text-muted disabled:cursor-not-allowed"
            disabled={disabled}
            id={textareaId}
            onChange={(e) => {
              setValue(e.target.value);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? (disabledReason ?? placeholder) : placeholder}
            ref={textareaRef}
            value={value}
          />
          <div className="flex items-center gap-2 px-2.5 pt-1 pb-2.5">
            {footer}
            <div className="flex-1" />
            <span className="hidden text-xs text-muted sm:inline">Enter to send · Shift+Enter for a new line</span>
            <SendButton canSend={canSend} onSend={() => void submit()} sending={sending} />
          </div>
        </div>
        {disabled && (
          <p className="m-0 px-3 pt-1.5 pb-1 text-xs text-muted" id={reasonId}>
            {disabledReason}
          </p>
        )}
      </div>
    </div>
  );
}

export default AIPrompt;
