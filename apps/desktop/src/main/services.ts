import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Integration, IntegrationSchema, type IntegrationView } from '@insectoids/shared';

/**
 * Outside services the hive may use (Connections 04-D5), metadata only: `<userData>/services.json`.
 * Keys live in the Vault and are referenced by handle. Everything is off until the user switches it on
 * (consent tier "secret", 04 draft 7).
 */

export const BUILT_IN: readonly Integration[] = [
  {
    id: 'github',
    label: 'GitHub',
    kind: 'github',
    baseUrl: 'https://api.github.com',
    authType: 'bearer',
    authHeader: null,
    secretRef: null,
    enabled: false,
    readMethods: ['GET', 'HEAD'],
    description: 'Read repositories, issues and pull requests. Creating or changing anything on GitHub needs your approval.',
  },
  {
    id: 'brave-search',
    label: 'Brave Search',
    kind: 'brave-search',
    baseUrl: 'https://api.search.brave.com/res/v1',
    authType: 'header',
    authHeader: 'X-Subscription-Token',
    secretRef: null,
    enabled: false,
    readMethods: ['GET'],
    description: 'Search the web with the Brave Search API.',
  },
];

const BUILT_IN_IDS = new Set(BUILT_IN.map((b) => b.id));

/** The harmless read `testService` makes for each kind (it goes through the broker like any call). */
export function testRequest(i: Integration): { method: 'GET'; path: string; query?: Record<string, string> } {
  if (i.kind === 'github') return { method: 'GET', path: '/user' };
  if (i.kind === 'brave-search') return { method: 'GET', path: '/web/search', query: { q: 'test', count: '1' } };
  return { method: 'GET', path: '/' };
}

interface ServicesFile {
  version: 1;
  /** User-added integrations, plus the user's changes to built-in ones (label, key, on/off). */
  integrations: Integration[];
  /** Last test result per integration (not part of the shared schema). */
  tests: Record<string, { ok: boolean; at: number; message: string }>;
}

export interface UrlRules {
  /** Tests only: allow http://127.0.0.1 / localhost base URLs (a fake upstream). */
  allowLoopbackHttp?: boolean;
  /** Tests only: point a built-in integration at another base URL. */
  baseOverrides?: Record<string, string>;
}

export function isAllowedBase(url: string, rules: UrlRules = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.protocol === 'https:') return true;
  return !!rules.allowLoopbackHttp && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}

export class ServicesStore {
  readonly file: string;
  readonly #rules: UrlRules;

  constructor(o: { dir: string; rules?: UrlRules }) {
    this.file = join(o.dir, 'services.json');
    this.#rules = o.rules ?? {};
  }

  get rules(): UrlRules {
    return this.#rules;
  }

  /** Built-ins (with the user's saved changes) first, then the user's own. */
  all(): Integration[] {
    const saved = this.#read().integrations;
    const byId = new Map(saved.map((i) => [i.id, i]));
    const builtIns = BUILT_IN.map((b) => {
      const s = byId.get(b.id);
      const merged: Integration = s ? { ...b, label: s.label, secretRef: s.secretRef, enabled: s.enabled } : { ...b };
      const override = this.#rules.baseOverrides?.[b.id];
      return override ? { ...merged, baseUrl: override } : merged;
    });
    return [...builtIns, ...saved.filter((i) => !BUILT_IN_IDS.has(i.id))];
  }

  get(id: string): Integration | undefined {
    return this.all().find((i) => i.id === id);
  }

  views(hasKey: (ref: string) => boolean): IntegrationView[] {
    const tests = this.#read().tests;
    return this.all().map((i) => {
      const test = tests[i.id];
      const builtIn = BUILT_IN_IDS.has(i.id);
      const needsKey = i.authType !== 'none' && !(i.secretRef && hasKey(i.secretRef));
      let status: IntegrationView['status'];
      let message: string;
      if (needsKey) {
        status = 'needs-key';
        message = `Add a key in the Vault and choose it here.${i.enabled ? '' : ' Then switch it on.'}`;
      } else if (!i.enabled) {
        status = 'off';
        message = 'Off. The hive never uses it until you switch it on.';
      } else if (test && !test.ok) {
        status = 'error';
        message = test.message;
      } else {
        status = 'ready';
        message = test?.ok ? test.message : 'On. Insects can use it when their card needs it.';
      }
      return { ...i, status, message, lastTestedAt: test?.at ?? null, builtIn };
    });
  }

  /** Adds or updates one. Built-ins: only label, key and on/off can change. */
  save(input: Integration): void {
    const i = IntegrationSchema.parse(input);
    const file = this.#read();
    if (BUILT_IN_IDS.has(i.id)) {
      const base = BUILT_IN.find((b) => b.id === i.id)!;
      this.#upsert(file, { ...base, label: i.label, secretRef: i.secretRef, enabled: i.enabled });
    } else {
      if (i.kind !== 'rest') throw new Error('Only "rest" services can be added; GitHub and Brave Search are built in.');
      if (!isAllowedBase(i.baseUrl, this.#rules)) throw new Error('The base address must be https, with no user name, query or fragment.');
      if (i.authType === 'header' && !i.authHeader) throw new Error('Name the header that carries the key.');
      this.#upsert(file, i);
    }
    this.#write(file);
  }

  setEnabled(id: string, enabled: boolean): void {
    const current = this.get(id);
    if (!current) throw new Error(`No service "${id}".`);
    const file = this.#read();
    // Built-ins keep only label, key and on/off from the saved copy (all() re-applies the template).
    this.#upsert(file, { ...current, enabled });
    this.#write(file);
  }

  remove(id: string): void {
    if (BUILT_IN_IDS.has(id)) throw new Error('Built-in services can only be switched off, not removed.');
    const file = this.#read();
    const next = file.integrations.filter((i) => i.id !== id);
    if (next.length === file.integrations.length) throw new Error(`No service "${id}".`);
    delete file.tests[id];
    this.#write({ ...file, integrations: next });
  }

  recordTest(id: string, ok: boolean, message: string, at = Date.now()): void {
    const file = this.#read();
    file.tests[id] = { ok, at, message };
    this.#write(file);
  }

  /** Enabled integrations that use a key (to refuse removing a key still in use). */
  usersOf(ref: string): string[] {
    return this.all().filter((i) => i.secretRef === ref).map((i) => i.id);
  }

  #upsert(file: ServicesFile, i: Integration): void {
    const at = file.integrations.findIndex((x) => x.id === i.id);
    if (at >= 0) file.integrations[at] = i;
    else file.integrations.push(i);
  }

  #read(): ServicesFile {
    if (!existsSync(this.file)) return { version: 1, integrations: [], tests: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ServicesFile>;
      const integrations = (Array.isArray(raw.integrations) ? raw.integrations : [])
        .map((i) => IntegrationSchema.safeParse(i))
        .filter((r) => r.success)
        .map((r) => r.data);
      const tests = raw.tests && typeof raw.tests === 'object' ? raw.tests : {};
      return { version: 1, integrations, tests };
    } catch {
      return { version: 1, integrations: [], tests: {} };
    }
  }

  #write(file: ServicesFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
