import { ALWAYS_ASK, type ChecklistItem, PRESETS, type Preset, type SetupState } from '@insectoids/shared';
import { Check, Circle, Clock, Copy, FolderOpen, RotateCcw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { ChoiceGroup } from '@/components/ui/onboarding';
import { setupActions } from '@/lib/setup-store';
import { cn } from '@/lib/utils';

const PRESET_ORDER: readonly Preset[] = ['careful', 'balanced', 'hands-off'];

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);

// ---- safety presets ----------------------------------------------------------------------------

/** The three safety presets (08-D7) as radio cards. Selecting one saves it at once. */
export function PresetCards({ value, compact = false }: { value: Preset; compact?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Preset | null>(null);

  const choose = async (p: string): Promise<void> => {
    const preset = p as Preset;
    if (preset === value) return;
    setSaving(preset);
    setError(null);
    const r = await setupActions.setPreset(preset);
    setSaving(null);
    if (!r.ok) setError(r.error);
  };

  return (
    <div className="flex flex-col gap-3">
      <ChoiceGroup
        aria-label="Safety preset"
        className={cn('grid gap-3', compact ? 'grid-cols-[repeat(auto-fit,minmax(200px,1fr))]' : 'grid-cols-[repeat(auto-fit,minmax(210px,1fr))]')}
        name="safety-preset"
        onValueChange={(v) => void choose(v)}
        value={value}
      >
        {PRESET_ORDER.map((id) => {
          const p = PRESETS[id];
          const selected = id === value;
          return (
            <ChoiceGroup.Item
              className={cn(
                'flex flex-col gap-2 rounded-2xl border p-4 transition-colors',
                selected ? 'border-honey bg-honey/10' : 'border-line bg-surface hover:bg-surface-2',
              )}
              data-testid={`preset-${id}`}
              inputLabel={`${p.label}${id === 'balanced' ? ' (recommended)' : ''}`}
              key={id}
              value={id}
            >
              {/* Wraps on narrow cards so "Recommended" and "Selected" never spill outside the card. */}
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  aria-hidden="true"
                  className={cn('grid size-[18px] shrink-0 place-items-center rounded-full border-2', selected ? 'border-honey bg-honey' : 'border-line')}
                >
                  {selected ? <Check className="size-3 text-honey-ink" strokeWidth={3} /> : null}
                </span>
                <span className="font-display text-[17px] font-semibold text-text">{p.label}</span>
                {id === 'balanced' ? (
                  <span className="rounded-full border border-honey/50 px-2 py-0.5 text-[11px] font-semibold text-honey-text">Recommended</span>
                ) : null}
                {selected ? <span className="ml-auto text-xs font-medium text-honey-text">{saving === id ? 'Saving…' : 'Selected'}</span> : null}
                {saving === id && !selected ? <span className="ml-auto text-xs text-muted">Saving…</span> : null}
              </span>
              {!compact ? <span className="text-sm text-muted">{p.summary}</span> : null}
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                <dt className="text-muted">Insects at once</dt>
                <dd className="m-0 text-text">{p.insectCap}</dd>
                <dt className="text-muted">Budget per goal</dt>
                <dd className="m-0 text-text">{formatTokens(p.goalBudgetTokens)} tokens</dd>
                <dt className="text-muted">Plans you approve</dt>
                <dd className="m-0 text-text">{p.approveEveryPlan ? 'Every plan' : 'Big plans (more than one wave)'}</dd>
              </dl>
            </ChoiceGroup.Item>
          );
        })}
      </ChoiceGroup>
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Could not change the preset" tone="error" /> : null}
      <AlwaysAsk />
    </div>
  );
}

export function AlwaysAsk() {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="m-0 flex items-center gap-2 text-sm font-semibold text-text">
        <ShieldCheck aria-hidden="true" className="size-4 text-honey-text" />
        Always asks you, in every preset
      </p>
      <ul className="m-0 mt-2 grid list-none gap-1 p-0 text-sm text-muted sm:grid-cols-2">
        {ALWAYS_ASK.map((a) => (
          <li className="flex items-center gap-2" key={a}>
            <Check aria-hidden="true" className="size-3.5 shrink-0 text-st-done" />
            {a}
          </li>
        ))}
      </ul>
      <p className="m-0 mt-2 text-xs text-muted">The command guard is always on, too.</p>
    </div>
  );
}

// ---- Brain folder ------------------------------------------------------------------------------

/** Where the Brain lives (01-D4, D8): the default, or a folder the user picks. */
export function BrainFolder({ state, showNote = true }: { state: SetupState; showNote?: boolean }) {
  const [busy, setBusy] = useState<'pick' | 'default' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDefault = state.brainDir === state.defaultBrainDir;

  const act = async (kind: 'pick' | 'default'): Promise<void> => {
    setBusy(kind);
    setError(null);
    const r = kind === 'pick' ? await setupActions.pickBrainFolder() : await setupActions.useDefaultBrainFolder();
    setBusy(null);
    if (!r.ok) setError(r.error);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 rounded-2xl border border-line bg-surface p-4">
        <span className="text-xs font-medium text-muted">{isDefault ? 'Brain folder (default)' : 'Brain folder (your choice)'}</span>
        <code className="break-all font-mono text-[13px] text-text" data-testid="brain-dir">
          {state.brainDir}
        </code>
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Button disabled={busy !== null} onClick={() => void act('pick')} variant="outline">
          <FolderOpen aria-hidden="true" />
          {busy === 'pick' ? 'Choosing…' : 'Choose another folder…'}
        </Button>
        {!isDefault ? (
          <Button disabled={busy !== null} onClick={() => void act('default')} variant="ghost">
            <RotateCcw aria-hidden="true" />
            {busy === 'default' ? 'Switching…' : 'Back to default'}
          </Button>
        ) : null}
      </div>
      {showNote ? (
        <p className="m-0 text-sm text-muted">
          If the folder already holds a Brain, it is used as it is: nothing is overwritten. The Brain stays on this PC.
        </p>
      ) : null}
      {error ? <InlineAlert message={error} onDismiss={() => setError(null)} title="Could not change the Brain folder" tone="error" /> : null}
    </div>
  );
}

// ---- checklist ---------------------------------------------------------------------------------

/** The "finish setup" checklist (08-D2): what's done, what's left, what comes in a later phase. */
export function Checklist({ items }: { items: readonly ChecklistItem[] }) {
  return (
    <ul aria-label="Setup checklist" className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((item) => {
        const later = !item.done && item.phase > 1;
        return (
          <li
            className="flex min-h-10 items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-2"
            data-done={item.done}
            data-testid={`checklist-${item.id}`}
            key={item.id}
          >
            {item.done ? (
              <Check aria-hidden="true" className="size-4 shrink-0 text-st-done" />
            ) : later ? (
              <Clock aria-hidden="true" className="size-4 shrink-0 text-muted" />
            ) : (
              <Circle aria-hidden="true" className="size-4 shrink-0 text-st-waiting" />
            )}
            <span className={cn('flex-1 text-sm', item.done ? 'text-text' : 'text-text')}>{item.label}</span>
            <span className={cn('text-xs font-medium', item.done ? 'text-st-done' : later ? 'text-muted' : 'text-st-waiting')}>
              {item.done ? 'Done' : later ? `Later · Phase ${item.phase}` : 'Not done'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---- copyable command --------------------------------------------------------------------------

/** A command the user runs themselves, with a copy button. We never run it for them. */
export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied('yes');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied(null), 2500);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-line bg-ground py-1.5 pr-1.5 pl-3.5">
        <code className="flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-text">{command}</code>
        <Button aria-label={`Copy: ${command}`} onClick={() => void copy()} size="sm" variant="outline">
          {copied === 'yes' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Select and copy' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
