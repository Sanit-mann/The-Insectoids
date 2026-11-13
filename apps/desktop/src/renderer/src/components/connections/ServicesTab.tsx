import { type Integration, type IntegrationView, IntegrationSchema, type SecretMeta } from '@insectoids/shared';
import { PlugZap, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { HoldButton } from '@/components/kokonutui/hold-button';
import { InlineAlert } from '@/components/kokonutui/inline-alert';
import { StatusDot } from '@/components/StatusDot';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { refreshVault, useVault, vaultAction } from '@/lib/vault-store';
import { Switch } from './Switch';

const STATUS_DOT = { ready: 'done', 'needs-key': 'waiting', off: 'idle', error: 'blocked' } as const;
const STATUS_LABEL: Record<IntegrationView['status'], string> = { ready: 'Ready', 'needs-key': 'Needs a key', off: 'Off', error: 'Problem' };
const AUTH_LABEL: Record<Integration['authType'], string> = { none: 'No key', bearer: 'Bearer token', header: 'Key in a header', basic: 'Email and API token' };

/** Ready-made forms for the Add-a-service form (C4, 04-D5). Jira's address is per site, so it is a template, not a built-in. */
type TemplateId = 'rest' | 'jira';
const JIRA_SITE_PLACEHOLDER = 'https://<your-site>.atlassian.net';
const TEMPLATES: Record<TemplateId, { label: string; hint: string }> = {
  rest: { label: 'Any REST service', hint: 'Any web service with a REST API.' },
  jira: {
    label: 'Jira',
    hint: 'Jira Cloud: read issues and projects. Put your site in the address, and save the key in the Vault as email:token (your Atlassian email, a colon, then an API token).',
  },
};
/** Jira's search endpoints take POST but only read. */
const JIRA_READ_POSTS = ['/rest/api/3/search', '/rest/api/3/search/jql'];

const toIntegration = (s: IntegrationView): Integration => ({
  id: s.id,
  label: s.label,
  kind: s.kind,
  baseUrl: s.baseUrl,
  authType: s.authType,
  authHeader: s.authHeader,
  secretRef: s.secretRef,
  enabled: s.enabled,
  readMethods: s.readMethods,
  readPosts: s.readPosts,
  extraHeaders: s.extraHeaders,
  description: s.description,
});

/** What the hive may do without asking, in words (reads pass through the broker; changes wait for the user). */
function readsLine(s: Pick<Integration, 'kind' | 'readMethods' | 'readPosts'>): string {
  const parts = [s.readMethods.filter((m) => m !== 'POST').join(' and ') + ' requests'];
  if (s.readMethods.includes('POST')) parts.push('any POST');
  if (s.kind === 'linear') parts.push('GraphQL queries (not mutations)');
  return parts.join(', ');
}

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);

const selectCls =
  'min-h-10 rounded-[10px] border border-line bg-ground px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-honey disabled:opacity-50';
const inputCls = 'min-h-10 rounded-[10px] border border-line bg-ground px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-honey';

/**
 * Services tab (Connections 04-D4, D5 and draft item 7: keyed services are off until the user consents;
 * Phase 2 · A3). Agents reach a service only through the local broker and never see its key.
 * Uses the vendored shadcn button, Kokonut UI hold-button and inline-alert, and our accessible Switch.
 */
export function ServicesTab({ onOpenVault }: { onOpenVault: () => void }) {
  const { services, secrets, loading, error } = useVault();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-4" data-testid="services-tab">
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 max-w-[680px] text-sm text-muted">
          Outside services the hive may use. Insects reach them only through the hive&rsquo;s local broker, with a pass for their own card,
          and never see a key. Reading is allowed; anything that changes something outside this computer waits for your OK.
        </p>
        <Button className="ml-auto" onClick={() => setAdding((a) => !a)} type="button" variant="outline">
          <Plus aria-hidden="true" /> {adding ? 'Close the form' : 'Add a service'}
        </Button>
      </div>

      {error ? (
        <InlineAlert actions={[{ label: 'Try again', onClick: () => void refreshVault(), primary: true }]} message={error} title="Couldn't load services" tone="error" />
      ) : null}

      {adding ? <AddServiceForm onDone={() => setAdding(false)} onOpenVault={onOpenVault} secrets={secrets} taken={services.map((s) => s.id)} /> : null}

      {loading && services.length === 0 ? (
        <div aria-busy="true" aria-label="Loading services" className="grid gap-4 md:grid-cols-2" role="status">
          {[0, 1].map((i) => (
            <div className="h-48 rounded-2xl bg-surface-2 motion-safe:animate-pulse" key={i} />
          ))}
        </div>
      ) : (
        <ul aria-label="Services" className="m-0 grid list-none gap-4 p-0 md:grid-cols-2" data-testid="service-list">
          {services.map((s) => (
            <li key={s.id}>
              <ServiceCard onOpenVault={onOpenVault} secrets={secrets} service={s} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ServiceCard({ service: s, secrets, onOpenVault }: { service: IntegrationView; secrets: SecretMeta[]; onOpenVault: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const headingId = `service-${s.id}-name`;
  const needsKey = s.authType !== 'none';

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true);
    setErr(null);
    const r = await vaultAction(fn);
    setBusy(false);
    if (!r.ok) setErr(r.error);
  };

  const pickKey = (ref: string): void => void run(() => window.insectoids.vault.saveService({ ...toIntegration(s), secretRef: ref || null }));
  const setEnabled = (on: boolean): void => void run(() => window.insectoids.vault.setServiceEnabled(s.id, on));

  const onTest = async (): Promise<void> => {
    setBusy(true);
    setTest(null);
    try {
      const r = await window.insectoids.vault.testService(s.id);
      setTest({ ok: r.ok, text: r.status !== null ? `${r.message} (HTTP ${r.status})` : r.message });
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
    setBusy(false);
    void refreshVault();
  };

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" data-service={s.id} data-testid={`service-${s.id}`}>
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="m-0 font-display text-base font-semibold" id={headingId}>
          {s.label}
        </h3>
        <span className="text-xs text-muted">{s.builtIn ? 'Built in' : 'Yours'}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-sm" data-status={s.status} data-testid={`service-${s.id}-status`}>
          <StatusDot status={STATUS_DOT[s.status]} />
          {STATUS_LABEL[s.status]}
        </span>
      </header>
      <p className="m-0 text-sm text-muted">{s.message}</p>
      <p className="m-0 text-sm">{s.description}</p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted">Address</dt>
        <dd className="m-0 break-all font-mono">{s.baseUrl}</dd>
        <dt className="text-muted">Sign-in</dt>
        <dd className="m-0">
          {AUTH_LABEL[s.authType]}
          {s.authType === 'header' && s.authHeader ? <span className="font-mono"> ({s.authHeader})</span> : null}
        </dd>
        <dt className="text-muted">Reads freely</dt>
        <dd className="m-0" data-testid={`service-${s.id}-reads`}>
          {readsLine(s)}
          {s.readPosts.length ? (
            <>
              {', and POST to '}
              {s.readPosts.map((r, i) => (
                <span key={r}>
                  {i ? ', ' : ''}
                  <code className="font-mono text-xs">{r}</code>
                </span>
              ))}
            </>
          ) : null}
        </dd>
        <dt className="text-muted">Changes</dt>
        <dd className="m-0">Anything that changes something on {s.label} waits for your OK.</dd>
      </dl>
      {s.authType === 'basic' ? (
        <p className="m-0 text-xs text-muted">Save its key in the Vault as email:token (your account email, a colon, then the API token).</p>
      ) : null}

      {needsKey ? (
        secrets.length ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Key</span>
            <select
              aria-label={`Key for ${s.label}`}
              className={selectCls}
              disabled={busy}
              onChange={(e) => pickKey(e.target.value)}
              value={s.secretRef ?? ''}
            >
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

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <span className="text-sm">Let insects use it</span>
        <Switch checked={s.enabled} disabled={busy} label={`Let insects use ${s.label}`} onChange={setEnabled} />
        <Button className="ml-auto" disabled={busy} onClick={() => void onTest()} type="button" variant="outline">
          <PlugZap aria-hidden="true" /> Test connection
        </Button>
      </div>
      <p className="m-0 text-xs text-muted">Insects can use this service through the broker; they never see the key.</p>

      {test ? (
        <InlineAlert message={test.text} onDismiss={() => setTest(null)} title={test.ok ? 'Connection works' : 'Connection failed'} tone={test.ok ? 'ok' : 'error'} />
      ) : null}
      {err ? <InlineAlert message={err} onDismiss={() => setErr(null)} title="That didn't work" tone="error" /> : null}

      {!s.builtIn ? (
        <HoldButton
          aria-label={`Hold to remove ${s.label}`}
          className="self-start"
          completeLabel="Removed"
          holdingLabel="Keep holding"
          icon={Trash2}
          onHoldComplete={() => void run(() => window.insectoids.vault.removeService(s.id))}
          resetAfter={1500}
          variant="danger"
        >
          Hold to remove
        </HoldButton>
      ) : null}
    </article>
  );
}

function AddServiceForm({ secrets, taken, onDone, onOpenVault }: { secrets: SecretMeta[]; taken: string[]; onDone: () => void; onOpenVault: () => void }) {
  const [template, setTemplate] = useState<TemplateId>('rest');
  const [label, setLabel] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [baseUrl, setBaseUrl] = useState('https://');
  const [authType, setAuthType] = useState<Integration['authType']>('bearer');
  const [authHeader, setAuthHeader] = useState('');
  const [secretRef, setSecretRef] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const effectiveId = idTouched ? id : slug(label);
  const readPosts = template === 'jira' ? JIRA_READ_POSTS : [];

  const chooseTemplate = (t: TemplateId): void => {
    setTemplate(t);
    if (t === 'jira') {
      setLabel('Jira');
      setIdTouched(false);
      setBaseUrl(JIRA_SITE_PLACEHOLDER);
      setAuthType('basic');
    } else {
      setLabel('');
      setIdTouched(false);
      setBaseUrl('https://');
      setAuthType('bearer');
    }
  };

  const onTemplateKey = (ev: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const ids = Object.keys(TEMPLATES) as TemplateId[];
    const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const next = ids[(i + step + ids.length) % ids.length]!;
    chooseTemplate(next);
    document.getElementById(`service-template-${next}`)?.focus();
  };

  const onSubmit = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    const candidate: Integration = {
      id: effectiveId,
      label: label.trim(),
      kind: template === 'jira' ? 'jira' : 'rest',
      baseUrl: baseUrl.trim(),
      authType,
      authHeader: authType === 'header' ? authHeader.trim() : null,
      secretRef: authType === 'none' ? null : secretRef || null,
      enabled: false,
      readMethods: ['GET', 'HEAD'],
      readPosts,
      extraHeaders: {},
      description:
        template === 'jira' ? 'Read Jira issues and projects. Creating or changing anything in Jira needs your approval.' : `Your service at ${baseUrl.trim()}.`,
    };
    const problems: string[] = [];
    if (candidate.baseUrl.includes('<your-site>')) problems.push('Address: put your Jira site name in place of <your-site>.');
    const parsed = IntegrationSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const field = String(i.path[0] ?? 'form');
        problems.push(
          field === 'id'
            ? 'Short name: lowercase letters, digits and dashes, starting with a letter (2–32).'
            : field === 'baseUrl'
              ? 'Address: a full web address.'
              : field === 'label'
                ? 'Give the service a name.'
                : field === 'authHeader'
                  ? 'Header name: letters, digits and dashes only.'
                  : `${field}: ${i.message}`,
        );
      }
    }
    if (!candidate.baseUrl.startsWith('https://')) problems.push('Address: only https addresses are allowed.');
    if (taken.includes(candidate.id)) problems.push(`Short name "${candidate.id}" is already used.`);
    if (authType === 'header' && !authHeader.trim()) problems.push('Header name is needed for "Key in a header".');
    if (problems.length) return setErrors([...new Set(problems)]);
    setErrors([]);
    setBusy(true);
    const r = await vaultAction(() => window.insectoids.vault.saveService(candidate));
    setBusy(false);
    if (r.ok) onDone();
    else setErrors([r.error]);
  };

  return (
    <form
      aria-labelledby="service-add-title"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4"
      data-testid="service-add"
      onSubmit={(ev) => void onSubmit(ev)}
    >
      <h2 className="m-0 font-display text-base font-semibold" id="service-add-title">
        Add a service
      </h2>
      <div aria-label="Kind of service" className="flex flex-wrap gap-2" role="radiogroup">
        {(Object.keys(TEMPLATES) as TemplateId[]).map((t, i) => (
          <button
            aria-checked={template === t}
            className={cn(
              'inline-flex min-h-10 items-center rounded-full border px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-honey',
              template === t ? 'border-honey text-honey-text' : 'border-line bg-ground text-text hover:bg-surface-2',
            )}
            data-testid={`service-template-${t}`}
            id={`service-template-${t}`}
            key={t}
            onClick={() => chooseTemplate(t)}
            onKeyDown={(ev) => onTemplateKey(ev, i)}
            role="radio"
            tabIndex={template === t ? 0 : -1}
            type="button"
          >
            {TEMPLATES[t].label}
          </button>
        ))}
      </div>
      <p className="m-0 text-xs text-muted" data-testid="service-template-hint">
        {TEMPLATES[template].hint} It starts switched off; insects can only read until you approve more.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Name</span>
          <input className={inputCls} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Linear" value={label} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Short name (agents use this)</span>
          <input
            className={`${inputCls} font-mono`}
            maxLength={32}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value);
            }}
            placeholder="linear"
            value={effectiveId}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          <span className="text-muted">Address (https)</span>
          <input className={`${inputCls} font-mono`} maxLength={300} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" value={baseUrl} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Sign-in</span>
          <select className={selectCls} onChange={(e) => setAuthType(e.target.value as Integration['authType'])} value={authType}>
            <option value="none">No key</option>
            <option value="bearer">Bearer token</option>
            <option value="header">Key in a header</option>
            <option value="basic">Email and API token</option>
          </select>
        </label>
        {authType === 'basic' ? (
          <p className="m-0 self-end text-xs text-muted md:col-span-1" data-testid="service-basic-hint">
            Save the key in the Vault as <span className="font-mono">email:token</span>.
          </p>
        ) : null}
        {authType === 'header' ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Header name</span>
            <input className={`${inputCls} font-mono`} maxLength={64} onChange={(e) => setAuthHeader(e.target.value)} placeholder="X-Api-Key" value={authHeader} />
          </label>
        ) : null}
        {authType !== 'none' ? (
          secrets.length ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Key</span>
              <select className={selectCls} onChange={(e) => setSecretRef(e.target.value)} value={secretRef}>
                <option value="">Choose later</option>
                {secrets.map((k) => (
                  <option key={k.ref} value={k.ref}>
                    {k.label}
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
      {readPosts.length ? (
        <p className="m-0 text-xs text-muted" data-testid="service-read-posts">
          These POST paths only read, so they don&rsquo;t need your OK:{' '}
          {readPosts.map((r, i) => (
            <span key={r}>
              {i ? ', ' : ''}
              <code className="font-mono">{r}</code>
            </span>
          ))}
          .
        </p>
      ) : null}
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
          {busy ? 'Saving…' : 'Save service'}
        </Button>
        <Button onClick={onDone} type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
}
