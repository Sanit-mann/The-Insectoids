import { z } from 'zod';

/**
 * Webhooks (Cadence 05-D2, D4; Phase 3 A4): the local listener's HTTP contract, the call main hands the Brain
 * host, and the renderer's IPC for a webhook's URL and secret.
 *
 * Where things live:
 * - **main** runs the listener (node:http on 127.0.0.1 only) and owns each webhook's secret in the Vault. It checks
 *   the secret, size and rate, then hands a `WebhookCall` to the Brain host. The secret never leaves main except
 *   onto the user's clipboard when they press "Copy secret".
 * - **the Brain host** (CadenceKeeper) applies the cadence's trust mode: logs every call in the run history, saves
 *   notes, asks in Approvals, or starts the run.
 *
 * HTTP contract (POST only, body ≤ 64 KB, any content type; JSON or text):
 * - `POST /hooks/<cadenceId>`       asks the hive to run the cadence, with the body attached as details;
 * - `POST /hooks/<cadenceId>/note`  only tells the hive something: the body becomes a note in the Brain.
 * The call must carry the webhook's secret, one of:
 * - `X-Insectoids-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>` (preferred);
 * - `X-Hub-Signature-256: sha256=<same>` (what GitHub sends);
 * - `Authorization: Bearer <secret>` (for simple senders that can't sign).
 * Replies are JSON `{ ok, message }` with the status below; `message` is plain words, never the secret.
 */

export const WEBHOOK_HOST = '127.0.0.1';
/** Default port; app.json `webhookPort` changes it, and e2e sets INSECTOIDS_WEBHOOK_PORT=0 for a free one. */
export const DEFAULT_WEBHOOK_PORT = 47821;
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** Calls per webhook per minute; more are refused (429). A refusal is logged at most once a minute per webhook. */
export const WEBHOOK_MAX_CALLS_PER_MINUTE = 30;
/** How much of the body is kept (in the log, the approval, the note and the run's goal). */
export const WEBHOOK_MESSAGE_MAX_CHARS = 4_000;
export const WEBHOOK_SIGNATURE_HEADER = 'x-insectoids-signature';
export const WEBHOOK_GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
/** Secrets look like `whsec_` + 43 base64url characters (32 random bytes). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

export const WebhookCallKindSchema = z.enum(['run', 'note']);
export type WebhookCallKind = z.infer<typeof WebhookCallKindSchema>;

/** main -> Brain host (host method `webhookCall`), after main checked the secret, size and rate. */
export const WebhookCallSchema = z.object({
  cadenceId: z.string().min(1).max(200),
  kind: WebhookCallKindSchema,
  /** False when main turned it away; the host only logs it (as `refused`, at most once a minute per webhook). */
  accepted: z.boolean(),
  /** Why main turned it away, in plain words ("The signature doesn't match this webhook's secret."), else null. */
  refusal: z.string().max(300).nullable(),
  /** The body as text (JSON re-printed compactly when it parses), cut to WEBHOOK_MESSAGE_MAX_CHARS. Empty when refused. */
  message: z.string().max(WEBHOOK_MESSAGE_MAX_CHARS + 50),
});
export type WebhookCall = z.infer<typeof WebhookCallSchema>;

/**
 * Brain host -> main: what to answer the caller. Statuses: 200 done (note saved / run started), 202 accepted and
 * waiting (Approvals, or the hive is paused / the last run is still going), 401 refused (secret), 404 no such
 * webhook, 409 it can't run now (switched off, or its project isn't the open one), 413 too big, 429 too many calls.
 */
export const WebhookReplySchema = z.object({
  status: z.number().int().min(200).max(599),
  ok: z.boolean(),
  message: z.string(),
});
export type WebhookReply = z.infer<typeof WebhookReplySchema>;

/** What the Cadence screen shows for one webhook cadence (renderer -> main). */
export const WebhookInfoSchema = z.object({
  cadenceId: z.string(),
  /** POST here to ask the hive to run it. */
  runUrl: z.string(),
  /** POST here to only send a note. */
  noteUrl: z.string(),
  /** Whether the listener is answering right now. */
  listening: z.boolean(),
  /** In words: "Listening on this computer only (127.0.0.1:47821)." or why not ("Port 47821 is used by another app."). */
  status: z.string(),
  /** Whether this webhook has a secret in the Vault yet ("Copy secret" makes one). */
  hasSecret: z.boolean(),
  /** "…a1b2" when the secret is long enough to show its last 4 characters. */
  secretHint: z.string().nullable(),
  /** False when the OS key store is missing: no secret can be kept, so the webhook refuses every call. */
  vaultAvailable: z.boolean(),
});
export type WebhookInfo = z.infer<typeof WebhookInfoSchema>;

export const WebhookSecretResultSchema = z.discriminatedUnion('ok', [
  /** The secret is on the clipboard (never in this reply). */
  z.object({ ok: z.literal(true), info: WebhookInfoSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type WebhookSecretResult = z.infer<typeof WebhookSecretResultSchema>;

export const WEBHOOK_IPC = {
  info: 'webhook:info',
  /** Copies the webhook's secret to the clipboard, making one first if it has none. */
  copySecret: 'webhook:copy-secret',
  /** Replaces the secret (the old one stops working at once) and copies the new one. */
  newSecret: 'webhook:new-secret',
} as const;

/** `window.insectoids.webhooks`. Every call takes the cadence id. */
export interface WebhookApi {
  info(cadenceId: string): Promise<WebhookInfo>;
  copySecret(cadenceId: string): Promise<WebhookSecretResult>;
  newSecret(cadenceId: string): Promise<WebhookSecretResult>;
}
