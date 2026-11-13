/**
 * Wire protocol between the Brain service (the single writer, 01-D14) and its doors (01-D5).
 *
 * Transport: newline-delimited JSON over a local socket (a named pipe on Windows, a Unix socket
 * in a private folder elsewhere). The first frame must be `hello` with a token; the service binds
 * the connection to that token's identity. Identity is never taken from the request itself, so an
 * insect cannot act as the user: the user's (master) token stays in the app, insects get agent tokens
 * scoped to one agent, one project shelf and read or read-write.
 */
import { z } from 'zod';
import { RecordKindSchema, TrustSchema } from '@insectoids/shared';
import type { BrainRecord, CodeLookup, LinkView, RecordVersion, SearchHit } from '@insectoids/brain';

export const PROTOCOL_VERSION = 1;
/** Largest frame either side accepts (bytes, one JSON line). */
export const MAX_FRAME_BYTES = 1_000_000;
/** A connection must say hello within this time. */
export const HELLO_TIMEOUT_MS = 5_000;

/** Environment variables a door reads to find the service (set by the app for each insect). */
export const BRAIN_ENV = {
  endpoint: 'INSECTOIDS_BRAIN_ENDPOINT',
  token: 'INSECTOIDS_BRAIN_TOKEN',
} as const;

export type Identity =
  | { type: 'user' }
  | { type: 'agent'; id: string; shelf: string; write: boolean };

// ---- frames ------------------------------------------------------------------------------------

export const HelloFrame = z.object({ type: z.literal('hello'), v: z.number().int(), token: z.string().min(1).max(200) });
export const CallFrame = z.object({
  type: z.literal('call'),
  id: z.number().int().nonnegative(),
  method: z.string().max(64),
  params: z.unknown().optional(),
});

export type ServerFrame =
  | { type: 'welcome'; v: number; identity: Identity }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number | null; error: WireError };

export type ErrorCode =
  | 'unauthorized' // bad or revoked token, or no hello
  | 'forbidden' // the identity may not do this (read-only token, other shelf, user-only method)
  | 'bad_request' // params failed validation, unknown method, malformed frame
  | 'not_found'
  | 'secret' // Memory 01-E6: looks like a secret
  | 'trust' // Memory 01-D3: only the user may confirm
  | 'conflict' // confirmed by the user, or archived
  | 'disconnected' // client side: the service went away
  | 'internal';

export interface WireError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// ---- methods -----------------------------------------------------------------------------------

const Id = z.string().min(1).max(100);
const Shelf = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'shelf: lowercase letters, digits, . _ - (max 64)');
const Text = (max: number) => z.string().min(1).max(max);

/** Parameter schemas. Doors reuse these (the MCP door builds its tool inputs from them). */
export const Params = {
  ping: z.object({}).strict(),
  search: z
    .object({
      query: Text(500),
      kinds: z.array(RecordKindSchema).max(7).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      /** User only; agents are always held to their own shelf (plus global). */
      shelf: Shelf.optional(),
      /** Also superseded and archived records, each marked with its status (B2). */
      includeHistory: z.boolean().optional(),
    })
    .strict(),
  read: z
    .object({
      query: Text(500),
      kinds: z.array(RecordKindSchema).max(7).optional(),
      tokenBudget: z.number().int().min(100).max(4000).optional(),
      shelf: Shelf.optional(),
    })
    .strict(),
  /**
   * The code map (Phase 2 B4): symbols by name, a file's outline, callers or callees. Read-only. Agents see
   * their project's map only; the user names the shelf.
   */
  code: z
    .object({
      query: Text(200),
      mode: z.enum(['symbol', 'file', 'callers', 'callees']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      shelf: Shelf.optional(),
    })
    .strict(),
  get: z.object({ id: Id }).strict(),
  history: z.object({ id: Id }).strict(),
  links: z.object({ id: Id }).strict(),
  bootCard: z.object({ shelf: Shelf.optional() }).strict(),
  write: z
    .object({
      kind: RecordKindSchema,
      title: Text(200),
      body: Text(20_000),
      summary: Text(500).optional(),
      source: Text(500).optional(),
      confidence: z.number().min(0).max(1).optional(),
      trust: TrustSchema.optional(),
      shelf: Shelf.optional(),
      /**
       * Replace an older record on the same shelf (time-aware facts, B2): it stays as history. If the user
       * confirmed it, this record is saved as a proposal instead and the user decides.
       */
      supersedes: Id.optional(),
    })
    .strict(),
  update: z
    .object({
      id: Id,
      title: Text(200).optional(),
      body: Text(20_000).optional(),
      summary: Text(500).optional(),
      trust: TrustSchema.optional(),
    })
    .strict(),
  archive: z.object({ id: Id }).strict(),
  link: z.object({ from: Id, to: Id, rel: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, 'rel: lowercase word, max 40') }).strict(),
  /** Bring an archived (e.g. faded) record back as a new version. The user only (B2). */
  unarchive: z.object({ id: Id }).strict(),
  'admin.issueToken': z
    .object({
      agentId: Text(100),
      shelf: Shelf,
      write: z.boolean(),
      /** Ties this token's reads to one card attempt, so a pass credits what helped (B2). */
      readKey: Text(200).optional(),
    })
    .strict(),
  'admin.revokeToken': z.object({ token: Text(200) }).strict(),
} as const;

export type Method = keyof typeof Params;
export type ParamsOf<M extends Method> = z.input<(typeof Params)[M]>;

export interface Results {
  ping: { v: number; identity: Identity };
  search: SearchHit[];
  read: { text: string; ids: string[]; truncated: boolean };
  code: CodeLookup;
  get: BrainRecord | null;
  history: RecordVersion[];
  links: LinkView[];
  bootCard: { text: string };
  /** merged: folded into a near-duplicate; note: plain words for the agent ("already known as …"). */
  write: { id: string; created: boolean; merged?: boolean; note?: string };
  update: { version: number };
  archive: { ok: true };
  link: { ok: true };
  unarchive: { ok: true };
  'admin.issueToken': { token: string };
  'admin.revokeToken': { ok: true };
}

/** Methods that change the Brain (refused for read-only agent tokens). */
export const WRITE_METHODS: ReadonlySet<Method> = new Set(['write', 'update', 'archive', 'link', 'unarchive']);
/** Methods only the user's token may call. */
export const USER_METHODS: ReadonlySet<Method> = new Set(['admin.issueToken', 'admin.revokeToken', 'unarchive']);

export const isMethod = (m: string): m is Method => Object.hasOwn(Params, m);

/**
 * Code map lookups as compact lines for agents and the CLI (B4): `path:line kind name — signature`, the
 * doc's first sentence indented below, then imports (file mode) and a note when the list was cut.
 */
export function formatCodeLookup(r: Results['code'], mode: 'symbol' | 'file' | 'callers' | 'callees' = 'symbol'): string {
  const lines = [r.message];
  for (const h of r.hits) {
    const name = h.parent && mode !== 'file' ? `${h.parent}.${h.name}` : h.name;
    const indent = mode === 'file' && h.parent ? '  ' : '';
    lines.push(`${indent}${h.path}:${h.line} ${h.kind} ${name} — ${h.signature}`);
    if (h.doc) lines.push(`${indent}    ${h.doc}`);
  }
  if (r.imports.length) lines.push(`imports: ${r.imports.join(', ')}`);
  if (r.truncated) lines.push('(more matches: narrow the query)');
  return lines.join('\n');
}
