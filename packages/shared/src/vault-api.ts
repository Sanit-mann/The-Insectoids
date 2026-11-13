import { z } from 'zod';

/**
 * Vault and outside services (Connections 04-D4, D5; Phase 2 step A3).
 *
 * - The Vault lives in the main process: keys are encrypted with the OS (Electron safeStorage: Windows DPAPI,
 *   macOS Keychain, Linux secret service) and **fail closed** (no OS encryption, no saving).
 * - A key goes from the UI to the Vault once, when the user adds it, and **never comes back**: not to the UI,
 *   logs, errors, the Brain, or any agent. Everything else only sees a `secretRef` handle.
 * - Insects reach keyed services only through the local **secret broker**, with a capability token scoped to
 *   one card and only the integrations that card needs, which expires when the card's run ends.
 */
export const VAULT_IPC = {
  vaultStatus: 'vault:status',
  vaultList: 'vault:list',
  vaultAdd: 'vault:add',
  vaultRemove: 'vault:remove',
  servicesList: 'services:list',
  servicesSave: 'services:save',
  servicesSetEnabled: 'services:set-enabled',
  servicesRemove: 'services:remove',
  /** Makes one harmless read request through the broker (e.g. GitHub GET /user) and reports the result. */
  servicesTest: 'services:test',
} as const;

const Ref = z.string().regex(/^sec_[a-z0-9]{8,40}$/);
const Label = z.string().trim().min(1).max(80);

export const VaultStatusSchema = z.object({
  /** false: the OS can't encrypt here, so nothing can be saved (fail closed). */
  available: z.boolean(),
  message: z.string(),
});
export type VaultStatus = z.infer<typeof VaultStatusSchema>;

/** What the UI may know about a stored key: never the key itself. */
export const SecretMetaSchema = z.object({
  ref: Ref,
  label: Label,
  /** Last 4 characters only, to tell keys apart (e.g. "…a1b2"); null if the key is shorter than 12. */
  hint: z.string().nullable(),
  createdAt: z.number(),
  /** Integration ids that use this key. */
  usedBy: z.array(z.string()),
});
export type SecretMeta = z.infer<typeof SecretMetaSchema>;

export const VaultAddSchema = z.object({
  label: Label,
  /** The key itself. Crosses IPC once, into the main process; never stored in plain text. */
  value: z.string().min(8).max(8192),
});
export type VaultAdd = z.infer<typeof VaultAddSchema>;

/** C4 adds the Phase 2 services (04-D5): Notion, Linear, Slack built in; Jira as a template (its address is per site). */
export const IntegrationKindSchema = z.enum(['github', 'brave-search', 'notion', 'linear', 'slack', 'jira', 'rest']);
export type IntegrationKind = z.infer<typeof IntegrationKindSchema>;

/** basic = HTTP Basic with a vault secret written as "email:token" (Jira Cloud API tokens). */
export const AuthTypeSchema = z.enum(['none', 'bearer', 'header', 'basic']);

/** An outside service the hive may use (metadata only). */
export const IntegrationSchema = z.object({
  /** Short id agents use to pick the service, e.g. "github". */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  label: Label,
  kind: IntegrationKindSchema,
  /** https only. The broker never leaves this base (no other hosts, no `..`). */
  baseUrl: z.string().url().max(300),
  authType: AuthTypeSchema,
  /** Header name for authType "header" (e.g. X-Subscription-Token). */
  authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable(),
  secretRef: Ref.nullable(),
  /** Consent gate (04 draft 7): keyed services are off until the user switches them on. */
  enabled: z.boolean(),
  /**
   * Methods that only read pass straight through; methods that change something outside the computer
   * (POST/PUT/PATCH/DELETE) need the user's approval for that card ("publish", 02-D7).
   */
  readMethods: z.array(z.enum(['GET', 'HEAD', 'POST'])),
  /**
   * POST paths that only read (e.g. Notion "/search", "/databases/<id>/query"), as path patterns where "*"
   * matches one path segment. Other POSTs need approval unless POST is in readMethods. For GraphQL services
   * (Linear) the broker also treats a POST whose body is a query (not a mutation) as a read.
   */
  readPosts: z.array(z.string().max(200)).max(20).default([]),
  /** Fixed extra headers the service needs (e.g. Notion-Version). Never secrets. */
  extraHeaders: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(200)).default({}),
  /** One line for the Services tab: what the hive can do with it. */
  description: z.string().max(300),
});
export type Integration = z.infer<typeof IntegrationSchema>;
/** What callers send (readPosts and extraHeaders may be left out; they default to none). */
export type IntegrationInput = z.input<typeof IntegrationSchema>;

export const IntegrationViewSchema = IntegrationSchema.extend({
  status: z.enum(['ready', 'needs-key', 'off', 'error']),
  /** Plain words, including what to do next. */
  message: z.string(),
  lastTestedAt: z.number().nullable(),
  /** Ready-made template (GitHub, Brave Search) vs. one the user added. */
  builtIn: z.boolean(),
});
export type IntegrationView = z.infer<typeof IntegrationViewSchema>;

export const ServiceTestResultSchema = z.object({
  ok: z.boolean(),
  /** HTTP status from the service, if it answered. */
  status: z.number().nullable(),
  message: z.string(),
});
export type ServiceTestResult = z.infer<typeof ServiceTestResultSchema>;

export const VaultResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type VaultResult = z.infer<typeof VaultResultSchema>;

/** The Vault and Services part of `window.insectoids`. */
export interface VaultApi {
  status(): Promise<VaultStatus>;
  list(): Promise<SecretMeta[]>;
  add(input: VaultAdd): Promise<VaultResult & { ref?: string }>;
  /** Refused while an enabled integration still uses the key. */
  remove(ref: string): Promise<VaultResult>;
  services(): Promise<IntegrationView[]>;
  /** Adds or updates an integration (built-in ones: only label, secretRef and enabled can change). */
  saveService(i: IntegrationInput): Promise<VaultResult>;
  setServiceEnabled(id: string, enabled: boolean): Promise<VaultResult>;
  /** Built-in templates can't be removed, only switched off. */
  removeService(id: string): Promise<VaultResult>;
  testService(id: string): Promise<ServiceTestResult>;
}
