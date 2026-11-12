import { KeyRound, LockKeyhole, Trash2 } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { Button } from '@/components/ui/button';
import { refreshVault, useVault, vaultAction } from '@/lib/vault-store';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * Vault tab (Connections 04-D4; Phase 2 · A3; prototype Connections.dc.html).
 * The key input is uncontrolled: the value lives only in the DOM input until it is sent, and the input is
 * cleared right after, whether the save worked or not. It never enters React state, an error or a toast.
 * Remove uses Kokonut UI's hold-button (vendored); errors use Kokonut UI's inline-alert.
 */
export function VaultTab() {
  const { status, secrets, services, loading, error } = useVault();
  const keyInput = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const available = status?.available ?? false;
  const serviceName = (id: string): string => services.find((s) => s.id === id)?.label ?? id;

  const onAdd = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    setFormError(null);
    setSaved(null);
    const input = keyInput.current;
    const value = input?.value ?? '';
    // Clear the field at once: the key must not stay on screen or in the DOM.
    if (input) input.value = '';
    if (!label.trim()) return setFormError('Give the key a name, e.g. "GitHub token".');
    if (value.length < 8) return setFormError('That key looks too short. Paste the whole key.');
    setSaving(true);
    const r = await vaultAction(() => window.insectoids.vault.add({ label: label.trim(), value }));
    setSaving(false);
    if (r.ok) {
      setSaved(label.trim());
      setLabel('');
    } else {
      setFormError(r.error);
    }
  };

  const onRemove = async (ref: string): Promise<void> => {
    setRowErrors((e) => {
      const next = { ...e };
      delete next[ref];
      return next;
    });
    const r = await vaultAction(() => window.insectoids.vault.remove(ref));
    if (!r.ok) setRowErrors((e) => ({ ...e, [ref]: r.error }));
  };

  return (
    <div className="flex flex-col gap-4" data-testid="vault-tab">
      <p className="m-0 flex max-w-[720px] items-start gap-2 text-sm text-muted">
        <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-honey-text" />
        Keys are encrypted with your Windows login (or your computer&rsquo;s keychain) and never leave this computer. Agents never see a key:
        they reach services through the hive&rsquo;s local broker, with a pass that works only for their card.
      </p>

      {error ? (
        <InlineAlert actions={[{ label: 'Try again', onClick: () => void refreshVault(), primary: true }]} message={error} title="Couldn't open the Vault" tone="error" />
      ) : null}
      {status && !available ? (
        <InlineAlert message={status.message} title="Keys can't be saved on this computer" tone="error" />
      ) : null}

      <form
        aria-labelledby="vault-add-title"
        className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
        data-testid="vault-add"
        onSubmit={(ev) => void onAdd(ev)}
      >
        <h2 className="m-0 flex items-center gap-2 font-display text-base font-semibold" id="vault-add-title">
          <KeyRound aria-hidden="true" className="size-4 text-honey-text" /> Add a key
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Name</span>
            <input
              className="min-h-10 rounded-[10px] border border-line bg-ground px-3 text-text outline-none focus-visible:ring-2 focus-visible:ring-honey"
              disabled={!available || saving}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="GitHub token"
              value={label}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Key</span>
            <input
              autoComplete="off"
              className="min-h-10 rounded-[10px] border border-line bg-ground px-3 font-mono text-text outline-none focus-visible:ring-2 focus-visible:ring-honey"
              data-testid="vault-key-input"
              disabled={!available || saving}
              maxLength={8192}
              ref={keyInput}
              spellCheck={false}
              type="password"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 text-xs text-muted">The key is never shown again, here or anywhere else.</p>
          <Button className="ml-auto" disabled={!available || saving} type="submit">
            {saving ? 'Saving…' : 'Save key'}
          </Button>
        </div>
        {formError ? <InlineAlert message={formError} onDismiss={() => setFormError(null)} title="The key wasn't saved" tone="error" /> : null}
        {saved ? <InlineAlert message={`"${saved}" is in the Vault.`} onDismiss={() => setSaved(null)} title="Key saved" tone="ok" /> : null}
      </form>

      <section aria-labelledby="vault-list-title" className="flex flex-col gap-2">
        <h2 className="m-0 font-display text-base font-semibold" id="vault-list-title">
          Keys in the Vault
        </h2>
        {loading && !status ? (
          <div aria-busy="true" aria-label="Loading keys" className="h-20 rounded-2xl bg-surface-2 motion-safe:animate-pulse" role="status" />
        ) : secrets.length === 0 ? (
          <p className="m-0 text-sm text-muted">No keys yet. Add one above, then pick it for a service.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="vault-list">
            {secrets.map((s) => (
              <li className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3" data-secret={s.ref} key={s.ref}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="font-semibold">{s.label}</span>
                  <span className="font-mono text-xs text-muted" data-testid="secret-hint">
                    {s.hint ?? 'hidden'}
                  </span>
                  <span className="text-xs text-muted">Added {dateFmt.format(s.createdAt)}</span>
                  <span className="text-xs text-muted">
                    Used by: {s.usedBy.length ? s.usedBy.map(serviceName).join(', ') : 'nothing yet'}
                  </span>
                  <HoldButton
                    aria-label={`Hold to remove ${s.label}`}
                    className="ml-auto"
                    completeLabel="Removed"
                    holdingLabel="Keep holding"
                    icon={Trash2}
                    onHoldComplete={() => void onRemove(s.ref)}
                    resetAfter={1500}
                    variant="danger"
                  >
                    Hold to remove
                  </HoldButton>
                </div>
                {rowErrors[s.ref] ? (
                  <InlineAlert
                    message={rowErrors[s.ref]}
                    onDismiss={() =>
                      setRowErrors((e) => {
                        const next = { ...e };
                        delete next[s.ref];
                        return next;
                      })
                    }
                    title="Not removed"
                    tone="error"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
