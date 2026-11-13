import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BrainClient, BrainServiceError } from '@insectoids/brain-service/client';
import { type ErrorCode, type Identity, type Method, Params, type ParamsOf, type Results, formatCodeLookup } from '@insectoids/brain-service/protocol';
import type { BrainRecord } from '@insectoids/brain';

export const SERVER_NAME = 'insectoids-brain';
export const SERVER_VERSION = '0.1.0';

/**
 * How the MCP server reaches the Brain. Either a live client (optionally able to reconnect after
 * the service restarts) or "unavailable" with the reason, so tools fail clearly instead of hanging.
 */
export interface BrainAccess {
  /** Null when the Brain could not be reached at start. */
  readonly identity: Identity | null;
  call<M extends Method>(method: M, params: ParamsOf<M>): Promise<Results[M]>;
  close(): void;
}

/** A live client. After the connection drops, the next call reconnects once via `reconnect`. */
export function clientAccess(client: BrainClient, reconnect?: () => Promise<BrainClient>): BrainAccess {
  let current: BrainClient | null = client;
  return {
    identity: client.identity,
    async call(method, params) {
      if (!current) {
        if (!reconnect) throw new BrainServiceError('disconnected', 'The Brain connection was lost.');
        current = await reconnect();
      }
      try {
        return await current.call(method, params);
      } catch (err) {
        // Don't retry here: a write may already have landed. The next call reconnects.
        if (err instanceof BrainServiceError && err.code === 'disconnected') current = null;
        throw err;
      }
    },
    close: () => current?.close(),
  };
}

/** The Brain could not be reached: every tool explains why. */
export function unavailableAccess(error: BrainServiceError): BrainAccess {
  return {
    identity: null,
    call: () => Promise.reject(error),
    close: () => {},
  };
}

const HINTS: Record<ErrorCode, string> = {
  forbidden: "Your Brain access doesn't allow this (read-only, or another project's shelf). Don't retry; work within your project.",
  secret: 'Never store secrets in the Brain. Remove the value and say where it lives (e.g. the vault) instead.',
  trust: 'Only the user can confirm facts and decisions. Write it without trust "confirmed"; it will wait for the user.',
  conflict: 'The user confirmed this record (or it is archived). Do not edit it; write a new proposed decision explaining the change.',
  not_found: 'No record you can see has that id. Search first to find the right one.',
  disconnected: 'The Brain service is not reachable right now. Retry once; if it still fails, continue without the Brain and mention it in your report.',
  unauthorized: "This insect's Brain access is missing or revoked. Continue without the Brain and mention it in your report.",
  bad_request: "Check the arguments against the tool's input schema.",
  internal: 'Unexpected Brain error. Continue and mention it in your report.',
};

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });

function errorResult(err: unknown): CallToolResult {
  const e = err instanceof BrainServiceError ? err : new BrainServiceError('internal', err instanceof Error ? err.message : String(err));
  return { isError: true, content: [{ type: 'text', text: `Brain error (${e.code}): ${e.message}\nHint: ${HINTS[e.code]}` }] };
}

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function formatRecord(r: BrainRecord): string {
  const meta = [`shelf ${r.shelf}`, `trust ${r.trust}`, `v${r.version}`, `owner ${r.owner}`, `updated ${when(r.updatedAt)}`];
  if (r.archived) meta.push(`ARCHIVED${r.archivedReason ? ` (${r.archivedReason})` : ''}`);
  if (r.validTo !== null) meta.push(`SUPERSEDED${r.supersededBy ? ` by ${r.supersededBy}` : ''} at ${when(r.validTo)}`);
  if (r.source) meta.push(`source ${r.source}`);
  const head = [`[${r.kind}] ${r.title} (${r.id})`, meta.join(' · ')];
  if (r.summary) head.push(`Summary: ${r.summary}`);
  return `${head.join('\n')}\n\n${r.body}`;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

function instructions(identity: Identity | null, unavailableReason?: string): string {
  if (unavailableReason) {
    return `The Insectoids Brain (shared hive memory) is unavailable: ${unavailableReason} Continue without it and mention this in your report.`;
  }
  const canWrite = identity?.type === 'user' || (identity?.type === 'agent' && identity.write);
  const lines = [
    "The Insectoids Brain: this project's shared hive memory (decisions, facts, tasks, outcomes).",
    'Start with brain_boot_card. Prefer brain_read for answers packed within a token budget; use brain_get only for a record you need in full.',
    'Look code up with brain_code before reading whole files: where a symbol is, a file outline, who calls it.',
  ];
  if (canWrite) {
    lines.push(
      'Search before writing so you do not duplicate. Write only durable things: decisions, facts, outcomes, short updates.',
      'Facts and decisions you write wait for the user to confirm; you cannot change what the user confirmed. Never store secrets.',
    );
  } else {
    lines.push('Your Brain access is read-only.');
  }
  return lines.join('\n');
}

export interface BrainMcpOptions {
  /** Shown in the server instructions when the Brain could not be reached. */
  unavailableReason?: string;
}

/**
 * MCP server exposing the Brain as tools. Input schemas come from the service protocol, so the
 * service re-validates exactly what the model was shown. Agents never see a `shelf` argument (their
 * token binds it), and read-only agents never see write tools (fewer tokens, no dead ends).
 */
export function createBrainMcpServer(source: BrainClient | BrainAccess, opts: BrainMcpOptions = {}): McpServer {
  const access: BrainAccess = source instanceof BrainClient ? clientAccess(source) : source;
  const { identity } = access;
  const isUser = identity?.type === 'user';
  // When the Brain is unreachable the identity is unknown: list every tool so any call explains why.
  const canWrite = identity === null || isUser || (identity.type === 'agent' && identity.write);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(identity, opts.unavailableReason) },
  );

  const run = async <M extends Method>(method: M, params: unknown, format: (r: Results[M]) => string | Promise<string>) => {
    try {
      return text(await format(await access.call(method, params as ParamsOf<M>)));
    } catch (err) {
      return errorResult(err);
    }
  };

  // Shapes: agents (and the unavailable mode) never get a shelf argument.
  const search = isUser ? Params.search.shape : Params.search.omit({ shelf: true }).shape;
  const read = isUser ? Params.read.shape : Params.read.omit({ shelf: true }).shape;
  const boot = isUser ? Params.bootCard.shape : Params.bootCard.omit({ shelf: true }).shape;
  const write = isUser ? Params.write.shape : Params.write.omit({ shelf: true }).shape;
  const codeShape = isUser ? Params.code.shape : Params.code.omit({ shelf: true }).shape;

  server.registerTool(
    'brain_boot_card',
    {
      description: "Call this first. A short card (~300 tokens) of the project's confirmed decisions, facts and recent outcomes.",
      inputSchema: boot,
      annotations: READ_ONLY,
    },
    (args) => run('bootCard', args, (r) => r.text || 'The Brain has nothing on this shelf yet.'),
  );

  server.registerTool(
    'brain_read',
    {
      description:
        'Answer a question from the Brain within a token budget (default ~800): best matches as one-line summaries with ids. Use this before brain_search or brain_get.',
      inputSchema: read,
      annotations: READ_ONLY,
    },
    (args) =>
      run('read', args, (r) =>
        !r.text ? 'No matches.' : r.truncated ? `${r.text}\n(More matches beyond the budget: narrow the query or raise tokenBudget.)` : r.text,
      ),
  );

  server.registerTool(
    'brain_code',
    {
      description:
        'Look code up in the project code map before reading whole files. mode "symbol" (default): where a function, class, method or type is defined (exact, then prefix, then contains). "file": a file outline and its imports (full path or its ending). "callers" / "callees": who calls a symbol, what it calls. One line per hit: path:line kind name — signature, then its doc.',
      inputSchema: codeShape,
      annotations: READ_ONLY,
    },
    (args) => run('code', args, (r) => formatCodeLookup(r, (args as { mode?: 'symbol' | 'file' | 'callers' | 'callees' }).mode)),
  );

  server.registerTool(
    'brain_search',
    {
      description:
        'Search the Brain by words (and meaning, when it is on). Returns ids and titles, one per line; open one with brain_get. Current records only; set includeHistory to also see superseded and archived ones (marked).',
      inputSchema: search,
      annotations: READ_ONLY,
    },
    (args) =>
      run('search', args, (hits) =>
        hits.length
          ? hits
              .map((h) => `[${h.kind}] ${h.title} (${h.id})${h.status !== 'current' ? ` [${h.status.toUpperCase()}]` : ''}${h.summary ? ` - ${h.summary}` : ''}`)
              .join('\n')
          : 'No matches.',
      ),
  );

  server.registerTool(
    'brain_get',
    {
      description: 'Open one Brain record in full (body, trust, version, owner). Use only when the summary is not enough.',
      inputSchema: Params.get.shape,
      annotations: READ_ONLY,
    },
    (args) => run('get', args, (r) => (r ? formatRecord(r) : `No record ${args.id} that you can see. Search first.`)),
  );

  server.registerTool(
    'brain_history',
    {
      description: "A record's versions (who changed it and when). Nothing in the Brain is ever deleted.",
      inputSchema: Params.history.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      run('history', args, (vs) =>
        vs.map((v) => `v${v.version} ${v.change} by ${v.changedBy} at ${when(v.changedAt)} [${v.trust}]: ${v.title}`).join('\n'),
      ),
  );

  server.registerTool(
    'brain_links',
    {
      description: 'Records linked to this one (e.g. blocks, supersedes, see), with direction.',
      inputSchema: Params.links.shape,
      annotations: READ_ONLY,
    },
    (args) =>
      run('links', args, async (links) => {
        if (!links.length) return 'No links.';
        const lines = await Promise.all(
          links.map(async (l) => {
            const other = await access.call('get', { id: l.id }).catch(() => null);
            const arrow = l.direction === 'out' ? `-${l.rel}->` : `<-${l.rel}-`;
            return `${arrow} ${other ? `[${other.kind}] ${other.title} ` : ''}(${l.id})`;
          }),
        );
        return lines.join('\n');
      }),
  );

  if (!canWrite) return server;

  server.registerTool(
    'brain_write',
    {
      description:
        'Save something durable: a decision, fact, outcome, task or short update. Search first; duplicates and near-duplicates are folded into what is already there. To replace an outdated record, pass supersedes with its id (the old one stays as history). Facts start unconfirmed and decisions proposed until the user confirms. Never include secrets.',
      inputSchema: write,
      annotations: WRITES,
    },
    (args) =>
      run('write', args, async (r) => {
        if (!r.created) return r.note ?? `Already in the Brain as ${r.id} (exact duplicate; nothing new saved).`;
        const rec = await access.call('get', { id: r.id }).catch(() => null);
        return `Saved as ${r.id}${rec ? ` (trust: ${rec.trust})` : ''}.${r.note ? ` ${r.note}` : ''}`;
      }),
  );

  server.registerTool(
    'brain_update',
    {
      description:
        'Change a record you or another insect wrote; it becomes a new version and history is kept. You cannot change what the user confirmed: write a new proposed decision instead.',
      inputSchema: Params.update.shape,
      annotations: WRITES,
    },
    (args) => run('update', args, (r) => `Updated ${args.id} to version ${r.version}.`),
  );

  server.registerTool(
    'brain_archive',
    {
      description: 'Retire an outdated record. It leaves search but keeps its history (nothing is deleted).',
      inputSchema: Params.archive.shape,
      annotations: WRITES,
    },
    (args) => run('archive', args, () => `Archived ${args.id}. It no longer shows in search; its history is kept.`),
  );

  server.registerTool(
    'brain_link',
    {
      description: 'Link two records with a short lowercase relation, e.g. blocks, supersedes, implements, see.',
      inputSchema: Params.link.shape,
      annotations: WRITES,
    },
    (args) => run('link', args, () => `Linked ${args.from} -${args.rel}-> ${args.to}.`),
  );

  return server;
}
