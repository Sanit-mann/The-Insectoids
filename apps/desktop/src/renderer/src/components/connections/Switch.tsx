import { cn } from '@/lib/utils';

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name, e.g. "Use Gemini CLI". The visible state label is shown next to the track. */
  label: string;
  disabled?: boolean | undefined;
  id?: string | undefined;
}

/**
 * Accessible on/off switch (custom: Kokonut UI's `switch-button` is a theme toggle, not a general switch).
 * role="switch" with aria-checked; Space and Enter toggle (native button). The state is also written
 * out ("On"/"Off") so it is never conveyed by colour or position alone. Target ≥ 40 px.
 */
export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="group inline-flex min-h-10 items-center gap-2 rounded-[10px] px-1 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      id={id}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors motion-reduce:transition-none',
          checked ? 'border-honey bg-honey' : 'border-line bg-surface-2',
        )}
      >
        <span
          className={cn(
            'absolute size-[18px] rounded-full shadow-sm transition-transform motion-reduce:transition-none',
            checked ? 'translate-x-[19px] bg-honey-ink' : 'translate-x-[2px] bg-muted',
          )}
        />
      </span>
      <span aria-hidden="true" className={cn('min-w-[2ch] font-medium', checked ? 'text-text' : 'text-muted')}>
        {checked ? 'On' : 'Off'}
      </span>
    </button>
  );
}
