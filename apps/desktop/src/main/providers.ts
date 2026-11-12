import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROVIDER_PRESETS, type Provider, ProviderSchema, type ProviderView } from '@insectoids/shared';

/**
 * Model API providers (Connections 04-D3, Phase 2 step A4), metadata only: `<userData>/providers.json`.
 * Keys live in the Vault and are referenced by handle; engines reach a provider only through the broker's
 * `/llm/<id>/…` route with a per-run pass, so a provider key never enters an engine process.
 */

const MAX_KNOWN_MODELS = 500;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** https for remote providers; plain http only for servers on this computer (Ollama, LM Studio, a local FreeLLMAPI). */
export function checkProviderBase(url: string): { ok: true; local: boolean } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'That is not a valid address.' };
  }
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: 'The address may not contain a user name, query or fragment.' };
  const local = LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol === 'https:') return { ok: true, local };
  if (u.protocol === 'http:' && local) return { ok: true, local: true };
  return { ok: false, error: 'Use https, or http only for a server on this computer (127.0.0.1 or localhost).' };
}

interface TestRecord {
  ok: boolean;
  at: number;
  message: string;
  models: string[];
}

interface ProvidersFile {
  version: 1;
  providers: Provider[];
  tests: Record<string, TestRecord>;
}

export class ProvidersStore {
  readonly file: string;

  constructor(o: { dir: string }) {
    this.file = join(o.dir, 'providers.json');
  }

  all(): Provider[] {
    return this.#read().providers;
  }

  get(id: string): Provider | undefined {
    return this.all().find((p) => p.id === id);
  }

  /** Whether the provider needs a key: remote providers whose preset needs one, or any provider that names one. */
  needsKey(p: Provider): boolean {
    const base = checkProviderBase(p.baseUrl);
    return !(base.ok && base.local) && PROVIDER_PRESETS[p.preset].needsKey;
  }

  views(hasKey: (ref: string) => boolean): ProviderView[] {
    const tests = this.#read().tests;
    return this.all().map((p) => {
      const base = checkProviderBase(p.baseUrl);
      const local = base.ok && base.local;
      const test = tests[p.id];
      const keyMissing = (this.needsKey(p) && !p.secretRef) || (!!p.secretRef && !hasKey(p.secretRef));
      const note = p.preset === 'freellmapi' ? ` ${PROVIDER_PRESETS.freellmapi.note}` : '';
      let status: ProviderView['status'];
      let message: string;
      if (!base.ok) {
        status = 'error';
        message = base.error;
      } else if (keyMissing) {
        status = 'needs-key';
        message = p.secretRef ? 'Its key is missing from the Vault. Choose another key.' : 'Add a key in the Vault and choose it here.';
      } else if (!p.enabled) {
        status = 'off';
        message = 'Off. The hive never uses it until you switch it on.';
      } else if (test && !test.ok) {
        status = 'error';
        message = test.message;
      } else {
        status = 'ready';
        message = test?.ok ? test.message : local ? 'On. Runs on this computer; nothing leaves the PC.' : 'On. Insects can use it through the broker; they never see the key.';
      }
      return {
        ...p,
        status,
        message: `${message}${note}`,
        local,
        lastTestedAt: test?.at ?? null,
        knownModels: test?.models ?? [],
      };
    });
  }

  /** Usable for a run right now: null when fine, else the plain-words reason. */
  unusable(p: Provider, hasKey: (ref: string) => boolean): string | null {
    if (!p.enabled) return 'switched off';
    const base = checkProviderBase(p.baseUrl);
    if (!base.ok) return 'its address is not allowed';
    if (this.needsKey(p) && !p.secretRef) return 'no key chosen';
    if (p.secretRef && !hasKey(p.secretRef)) return 'its key is missing from the Vault';
    return null;
  }

  save(input: Provider): void {
    const p = ProviderSchema.parse(input);
    const base = checkProviderBase(p.baseUrl);
    if (!base.ok) throw new Error(base.error);
    const file = this.#read();
    const at = file.providers.findIndex((x) => x.id === p.id);
    if (at >= 0) {
      // A new address or key makes the last test meaningless.
      const old = file.providers[at]!;
      if (old.baseUrl !== p.baseUrl || old.secretRef !== p.secretRef) delete file.tests[p.id];
      file.providers[at] = p;
    } else {
      file.providers.push(p);
    }
    this.#write(file);
  }

  setEnabled(id: string, enabled: boolean): void {
    const file = this.#read();
    const p = file.providers.find((x) => x.id === id);
    if (!p) throw new Error(`No provider "${id}".`);
    p.enabled = enabled;
    this.#write(file);
  }

  remove(id: string): void {
    const file = this.#read();
    const next = file.providers.filter((p) => p.id !== id);
    if (next.length === file.providers.length) throw new Error(`No provider "${id}".`);
    delete file.tests[id];
    this.#write({ ...file, providers: next });
  }

  recordTest(id: string, ok: boolean, message: string, models: string[], at = Date.now()): void {
    const file = this.#read();
    const prev = file.tests[id];
    file.tests[id] = { ok, at, message, models: ok ? models.slice(0, MAX_KNOWN_MODELS) : (prev?.models ?? []) };
    this.#write(file);
  }

  /** Provider ids that use a Vault key. */
  usersOf(ref: string): string[] {
    return this.all().filter((p) => p.secretRef === ref).map((p) => p.id);
  }

  #read(): ProvidersFile {
    if (!existsSync(this.file)) return { version: 1, providers: [], tests: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ProvidersFile>;
      const providers = (Array.isArray(raw.providers) ? raw.providers : [])
        .map((p) => ProviderSchema.safeParse(p))
        .filter((r) => r.success)
        .map((r) => r.data);
      const tests = raw.tests && typeof raw.tests === 'object' ? raw.tests : {};
      return { version: 1, providers, tests };
    } catch {
      return { version: 1, providers: [], tests: {} };
    }
  }

  #write(file: ProvidersFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
