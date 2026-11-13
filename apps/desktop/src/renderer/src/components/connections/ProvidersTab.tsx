import { PROVIDER_PRESETS, type Provider, type ProviderPreset, ProviderSchema, type ProviderView, type SecretMeta } from '@insectoids/shared';
import { HardDrive, ListChecks, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { StatusDot } from '@/components/StatusDot';
import { Button } from '@/components/ui/button';
import { providerAction, refreshProviders, useProviders } from '@/lib/providers-store';
import { cn } from '@/lib/utils';
import { useVault } from '@/lib/vault-store';
import { Switch } from './Switch';

const STATUS_DOT = { ready: 'done', 'needs-key': 'waiting', off: 'idle', error: 'blocked' } as const;
const STATUS_LABEL: Record<ProviderView['status'], string> = { ready: 'Ready', 'needs-key': 'Needs a key', off: 'Off', error: 'Problem' };
const PRESET_ORDER: ProviderPreset[] = ['openrouter', 'anthropic', 'openai', 'freellmapi', 'ollama', 'lmstudio', 'custom'];
const TIERS = [
  { key: 'strongest', label: 'Strongest' },
  { key: 'standard', label: 'Standard' },
  { key: 'light', label: 'Light' },
] as const;
type Tiers = Provider['models'];

const selectCls =
  'min-h-10 rounded-[10px] border border-line bg-ground px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-honey disabled:opacity-50';
const inputCls = 'min-h-10 rounded-[10px] border border-line bg-ground px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-honey';

const toProvider = (p: ProviderView): Provider => ({
  id: p.id,
  label: p.label,
  preset: p.preset,
  baseUrl: p.baseUrl,
  secretRef: p.secretRef,
  models: p.models,
  enabled: p.enabled,
});

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);

/** https for anything remote; plain http only for a server on this computer (Ollama, LM Studio, FreeLLMAPI). */
function addressProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Address: a full web address, e.g. https://openrouter.ai/api/v1.';
  }
  if (url.protocol === 'https:') return null;
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && local) return null;
  return 'Address: use https, or http only for a server on this computer (127.0.0.1 or localhost).';
}

const needsKey = (preset: ProviderPreset): boolean => PROVIDER_PRESETS[preset].needsKey;

/**
 * API providers tab (Connections 04-D3; Phase 2 · A4). Providers run through OpenCode; their keys stay in
 * the Vault and the hive's broker adds them, so neither OpenCode nor the AI ever sees a key.
 * Uses the vendored shadcn button, Kokonut UI hold-button and inline-alert, and our accessible Switch.
 */
export function ProvidersTab({ onOpenVault, onOpenEngines }: { onOpenVault: () => void; onOpenEngines: () => void }) {
  const { providers, loading, error } = useProviders();
  const { secrets } = useVault();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-4" data-testid="providers-tab">
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 max-w-[700px] text-sm text-muted">
          API providers run through OpenCode. Keys stay in the Vault, and the hive&rsquo;s broker adds them, so OpenCode and the AI never see
          them. Local servers (Ollama, LM Studio) keep everything on this computer.
        </p>
        <Button className="ml-auto" onClick={() => setAdding((a) => !a)} type="button" variant="outline">
          <Plus aria-hidden="true" /> {adding ? 'Close the form' : 'Add a provider'}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted">
        The hive can only use these once OpenCode is installed and ready on the{' '}
        <Button className="h-auto min-h-0 p-0 text-xs" onClick={onOpenEngines} type="button" variant="link">
          Engines tab
        </Button>
        .
      </p>

      {error ? (
        <InlineAlert actions={[{ label: 'Try again', onClick: () => void refreshProviders(), primary: true }]} message={error} title="Couldn't load providers" tone="error" />
      ) : null}

      {adding ? <AddProviderForm onDone={() => setAdding(false)} onOpenVault={onOpenVault} secrets={secrets} taken={providers.map((p) => p.id)} /> : null}

      {loading && providers.length === 0 && !error ? (
        <div aria-busy="true" aria-label="Loading providers" className="grid gap-4 md:grid-cols-2" role="status">
          {[0, 1].map((i) => (
            <div className="h-48 rounded-2xl bg-surface-2 motion-safe:animate-pulse" key={i} />
          ))}
        </div>
      ) : providers.length ? (
        <ul aria-label="API providers" className="m-0 grid list-none gap-4 p-0 md:grid-cols-2" data-testid="provider-list">
          {providers.map((p) => (
            <li key={p.id}>
              <ProviderCard onOpenVault={onOpenVault} provider={p} secrets={secrets} />
            </li>
          ))}
        </ul>
      ) : !loading ? (
        <p className="m-0 text-sm text-muted" data-testid="providers-empty">
          No providers yet. Add one: a local server like Ollama is free and keeps everything on this PC.
        </p>
      ) : null}
    </div>
  );
}

function TierInputs({
  idPrefix,
  values,
  onChange,
  suggestions,
  disabled,
}: {
  idPrefix: string;
  values: Tiers;
  onChange: (next: Tiers) => void;
  suggestions: string[];
  disabled?: boolean;
}) {
  const listId = `${idPrefix}-models`;
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-sm text-muted">Models by tier</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {TIERS.map((t) => (
          <label className="flex flex-col gap-1 text-xs" key={t.key}>
            <span className="text-muted">{t.label}</span>
            <input
              aria-label={`${t.label} model`}
              autoComplete="off"
              className={`${inputCls} font-mono`}
              disabled={disabled}
              list={suggestions.length ? listId : undefined}
              maxLength={120}
              onChange={(e) => onChange({ ...values, [t.key]: e.target.value })}
              role="combobox"
              spellCheck={false}
              value={values[t.key]}
            />
          </label>
        ))}
      </div>
      {suggestions.length ? (
        <datalist id={listId}>
          {suggestions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ) : null}
    </fieldset>
  );
}

function ProviderCard({ provider: p, secrets, onOpenVault }: { provider: ProviderView; secrets: SecretMeta[]; onOpenVault: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  // The user's unsaved edits; null shows the stored tiers (which follow saves from anywhere).
  const [draft, setDraft] = useState<Tiers | null>(null);
  const tiers = draft ?? p.models;
  const headingId = `provider-${p.id}-name`;
  const preset = PROVIDER_PRESETS[p.preset];
  const showKey = needsKey(p.preset) || p.secretRef !== null;
  const dirty = draft !== null && TIERS.some((t) => draft[t.key] !== p.models[t.key]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> => {
    setBusy(true);
    setErr(null);
    const r = await providerAction(fn);
    setBusy(false);
    if (!r.ok) setErr(r.error);
    return r.ok;
  };

  const pickKey = (ref: string): void => void run(() => window.insectoids.providers.save({ ...toProvider(p), secretRef: ref || null }));
  const setEnabled = (on: boolean): void => void run(() => window.insectoids.providers.setEnabled(p.id, on));
  const saveTiers = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    const next = { ...toProvider(p), models: { strongest: tiers.strongest.trim(), standard: tiers.standard.trim(), light: tiers.light.trim() } };
    if (!ProviderSchema.safeParse(next).success) {
      setErr('Every tier needs a model name (up to 120 characters).');
      return;
    }
    if (await run(() => window.insectoids.providers.save(next))) setDraft(null);
  };

  const onTest = async (): Promise<void> => {
    setBusy(true);
    setTest(null);
    try {
      const r = await window.insectoids.providers.test(p.id);
      const found = r.ok ? ` Found ${r.models.length} ${r.models.length === 1 ? 'model' : 'models'}.` : '';
      setTest({ ok: r.ok, text: `${r.message}${found}${r.status !== null ? ` (HTTP ${r.status})` : ''}` });
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    setBusy(false);
    void refreshProviders();
  };

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-provider={p.id} data-testid={`provider-${p.id}`}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="m-0 font-display text-base font-semibold" id={headingId}>
          {p.label}
        </h3>
        <span className="text-xs text-muted">{preset.label}</span>
        {p.local ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-text" data-testid={`provider-${p.id}-local`}>
            <HardDrive aria-hidden="true" className="size-3" /> Local: nothing leaves this PC
          </span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1.5 text-sm" data-status={p.status} data-testid={`provider-${p.id}-status`}>
          <StatusDot status={STATUS_DOT[p.status]} />
          {STATUS_LABEL[p.status]}
        </span>
      </header>
      <p className="m-0 text-sm text-muted">{p.message}</p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted">Address</dt>
        <dd className="m-0 break-all font-mono">{p.baseUrl}</dd>
        <dt className="text-muted">Short name</dt>
        <dd className="m-0 font-mono">{p.id}</dd>
      </dl>

      {showKey ? (
        secrets.length ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Key</span>
            <select aria-label={`Key for ${p.label}`} className={selectCls} disabled={busy} onChange={(e) => pickKey(e.target.value)} value={p.secretRef ?? ''}>
              <option value="">No key</option>
              {secrets.map((k) => (
                <option key={k.ref} value={k.ref}>
                  {k.label}
                  {k.hint ? ` (${k.hint})` : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <Button className="self-start" onClick={onOpenVault} type="button" variant="link">
            Add a key first
          </Button>
        )
      ) : null}

      <form className="flex flex-col gap-2" onSubmit={(ev) => void saveTiers(ev)}>
        <TierInputs disabled={busy} idPrefix={`provider-${p.id}`} onChange={setDraft} suggestions={p.knownModels} values={tiers} />
        {dirty ? (
          <div className="flex gap-2">
            <Button disabled={busy} size="sm" type="submit">
              Save models
            </Button>
            <Button onClick={() => setDraft(null)} size="sm" type="button" variant="ghost">
              Undo changes
            </Button>
          </div>
        ) : null}
      </form>
      {p.knownModels.length ? (
        <p className="m-0 text-xs text-muted">Suggestions come from the last test ({p.knownModels.length} models). You can also type any model name.</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <span className="text-sm">Let the hive use it</span>
        <Switch checked={p.enabled} disabled={busy} label={`Let the hive use ${p.label}`} onChange={setEnabled} />
        <Button className="ml-auto" disabled={busy} onClick={() => void onTest()} type="button" variant="outline">
          <ListChecks aria-hidden="true" /> Test
        </Button>
      </div>

      {test ? (
        <InlineAlert message={test.text} onDismiss={() => setTest(null)} title={test.ok ? 'The provider answers' : 'Test failed'} tone={test.ok ? 'ok' : 'error'} />
      ) : null}
      {err ? <InlineAlert message={err} onDismiss={() => setErr(null)} title="That didn't work" tone="error" /> : null}

      <HoldButton
        aria-label={`Hold to remove ${p.label}`}
        className="self-start"
        completeLabel="Removed"
        holdingLabel="Keep holding"
        icon={Trash2}
        onHoldComplete={() => void run(() => window.insectoids.providers.remove(p.id))}
        resetAfter={1500}
        variant="danger"
      >
        Hold to remove
      </HoldButton>
    </article>
  );
}

function AddProviderForm({ secrets, taken, onDone, onOpenVault }: { secrets: SecretMeta[]; taken: string[]; onDone: () => void; onOpenVault: () => void }) {
  const [preset, setPreset] = useState<ProviderPreset>('openrouter');
  const [label, setLabel] = useState(PROVIDER_PRESETS.openrouter.label);
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS.openrouter.baseUrl);
  const [secretRef, setSecretRef] = useState('');
  const [tiers, setTiers] = useState<Tiers>({ strongest: '', standard: '', light: '' });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const effectiveId = idTouched ? id : slug(label);
  const info = PROVIDER_PRESETS[preset];

  const choose = (p: ProviderPreset): void => {
    setPreset(p);
    setLabel(PROVIDER_PRESETS[p].label);
    setBaseUrl(PROVIDER_PRESETS[p].baseUrl);
    setIdTouched(false);
    if (!PROVIDER_PRESETS[p].needsKey) setSecretRef('');
  };

  const onPresetKey = (ev: React.KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const next = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? i + 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? i - 1 : null;
    if (next === null) return;
    ev.preventDefault();
    const p = PRESET_ORDER[(next + PRESET_ORDER.length) % PRESET_ORDER.length]!;
    choose(p);
    document.getElementById(`provider-preset-${p}`)?.focus();
  };

  const onSubmit = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    // One model is enough to start: empty tiers take the strongest one, and can be tuned on the card later.
    const top = tiers.strongest.trim() || tiers.standard.trim() || tiers.light.trim();
    const candidate: Provider = {
      id: effectiveId,
      label: label.trim(),
      preset,
      baseUrl: baseUrl.trim(),
      secretRef: info.needsKey ? secretRef || null : null,
      models: { strongest: tiers.strongest.trim() || top, standard: tiers.standard.trim() || top, light: tiers.light.trim() || top },
      enabled: false,
    };
    const problems: string[] = [];
    const parsed = ProviderSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const field = String(i.path[0] ?? 'form');
        problems.push(
          field === 'id'
            ? 'Short name: lowercase letters, digits and dashes, starting with a letter (2–32).'
            : field === 'baseUrl'
              ? 'Address: a full web address.'
              : field === 'label'
                ? 'Give the provider a name.'
                : field === 'models'
                  ? 'Models: give at least one model name (the others can copy it).'
                  : `${field}: ${i.message}`,
        );
      }
    }
    const addr = addressProblem(candidate.baseUrl);
    if (addr) problems.push(addr);
    if (taken.includes(candidate.id)) problems.push(`Short name "${candidate.id}" is already used.`);
    if (problems.length) return setErrors([...new Set(problems)]);
    setErrors([]);
    setBusy(true);
    const r = await providerAction(() => window.insectoids.providers.save(candidate));
    setBusy(false);
    if (r.ok) onDone();
    else setErrors([r.error]);
  };

  return (
    <form
      aria-labelledby="provider-add-title"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
      data-testid="provider-add"
      onSubmit={(ev) => void onSubmit(ev)}
    >
      <h2 className="m-0 font-display text-base font-semibold" id="provider-add-title">
        Add a provider
      </h2>
      <div aria-label="Kind of provider" className="flex flex-wrap gap-2" role="radiogroup">
        {PRESET_ORDER.map((p, i) => (
          <button
            aria-checked={preset === p}
            className={cn(
              'inline-flex min-h-10 items-center rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-honey',
              preset === p ? 'border-honey text-honey-text' : 'border-line bg-ground text-text hover:bg-surface-2',
            )}
            id={`provider-preset-${p}`}
            key={p}
            onClick={() => choose(p)}
            onKeyDown={(ev) => onPresetKey(ev, i)}
            role="radio"
            tabIndex={preset === p ? 0 : -1}
            type="button"
          >
            {PROVIDER_PRESETS[p].label}
          </button>
        ))}
      </div>
      <p
        className={cn('m-0 text-sm', preset === 'freellmapi' ? 'rounded-[10px] border border-honey/50 bg-honey/10 px-3 py-2 text-text' : 'text-muted')}
        data-testid="provider-preset-note"
        role={preset === 'freellmapi' ? 'note' : undefined}
      >
        {info.note}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Name</span>
          <input className={inputCls} maxLength={80} onChange={(e) => setLabel(e.target.value)} value={label} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Short name (the hive uses this)</span>
          <input
            className={`${inputCls} font-mono`}
            maxLength={32}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value);
            }}
            value={effectiveId}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted">Address (OpenAI-compatible base URL)</span>
          <input className={`${inputCls} font-mono`} maxLength={300} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} value={baseUrl} />
        </label>
        {info.needsKey ? (
          secrets.length ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Key</span>
              <select aria-label="Key" className={selectCls} onChange={(e) => setSecretRef(e.target.value)} value={secretRef}>
                <option value="">Choose later</option>
                {secrets.map((k) => (
                  <option key={k.ref} value={k.ref}>
                    {k.label}
                    {k.hint ? ` (${k.hint})` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Button className="self-end" onClick={onOpenVault} type="button" variant="link">
              Add a key first
            </Button>
          )
        ) : null}
      </div>
      <TierInputs idPrefix="provider-add" onChange={setTiers} suggestions={[]} values={tiers} />
      <p className="m-0 text-xs text-muted">One model is enough to start: empty tiers use it too. Test the provider later to get suggestions.</p>
      {errors.length ? (
        <InlineAlert
          message={
            <ul className="m-0 list-disc pl-4">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          }
          onDismiss={() => setErrors([])}
          title="Check the form"
          tone="error"
        />
      ) : null}
      <div className="flex gap-2">
        <Button disabled={busy} type="submit">
          {busy ? 'Saving…' : 'Save provider'}
        </Button>
        <Button onClick={onDone} type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
}
