import { parseArgs } from 'node:util';
import { RecordKindSchema } from '@insectoids/shared';
import { BrainServiceError } from '@insectoids/brain-service/client';
import type { ErrorCode, Identity, Method, ParamsOf, Results } from '@insectoids/brain-service/protocol';

/** What the CLI needs from a Brain connection (BrainClient fits). */
export interface CliClient {
  readonly identity: Identity;
  call<M extends Method>(method: M, params: ParamsOf<M>): Promise<Results[M]>;
  close(): void;
}

export interface CliIO {
  /** Opens the connection; only called once a command is known to be valid. */
  connect(): Promise<CliClient>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** All of stdin, for `--body -`. */
  readStdin(): Promise<string>;
  /** True when stdin is a terminal (nothing piped): `--body -` then refuses instead of hanging. */
  stdinIsTTY?: boolean;
}

export const EXIT = { ok: 0, service: 1, usage: 2 } as const;

const KINDS = RecordKindSchema.options;

export const HELP = `brain: the hive's shared memory (The Insectoids). Read before you work; record what others need.

Usage: brain <command> [args] [--json]
  whoami                         who this token is (agent, shelf, read/write)
  boot                           short briefing for your project: decisions, facts, recent outcomes
  search <query> [--kind k]... [--limit n] [--history]   matching records (--history: also superseded/archived)
  read <query> [--kind k]... [--budget n]      best matches packed into ~n tokens (default 800)
  get <id> | history <id> | links <id>
  write --kind k --title t --body <text|-> [--summary s] [--source s] [--supersedes id]
  update <id> [--title t] [--body <text|->] [--summary s]
  archive <id>                   hide from search; nothing is ever deleted
  link <from> <to> --rel r       e.g. --rel blocks, depends-on, see
Kinds: ${KINDS.join(', ')}.
--body - reads the text from stdin (use it for long or quoted text). A body starting with "-": --body=-text.
--supersedes id replaces an outdated record of yours; the old one stays as history. Near-duplicates are
folded into what is already there ("already known as …").
--json prints machine-readable output.

Rules: facts and decisions you write start unconfirmed/proposed until the user confirms them.
You cannot change what the user confirmed: write a new proposal instead. Never store secrets
(keys, passwords, tokens); they are refused. You only see your project's shelf and the global one.
Exit codes: 0 ok, 1 Brain refused or unreachable, 2 usage error.`;

const USAGE = 'Run `brain help` for usage.';

const HINTS: Record<ErrorCode, string> = {
  unauthorized: 'This run has no valid Brain token (INSECTOIDS_BRAIN_TOKEN); it may have ended or been revoked.',
  forbidden: 'Your token does not allow this (read-only, or another project\'s shelf).',
  bad_request: USAGE,
  not_found: 'Check the id (find ids with `brain search`).',
  secret: 'Secrets never go in the Brain; leave them out or describe them without the value.',
  trust: 'Only the user confirms facts and decisions; leave trust unset to propose.',
  conflict: 'The user confirmed this (or it is archived): write a new proposal instead of editing it.',
  disconnected: 'Is The Insectoids app running? It sets INSECTOIDS_BRAIN_ENDPOINT for each insect.',
  internal: 'Unexpected Brain error; mention it in your report.',
};

type OptName = 'kind' | 'limit' | 'budget' | 'title' | 'body' | 'summary' | 'source' | 'rel' | 'json' | 'help' | 'history' | 'supersedes';
const OPTIONS = {
  kind: { type: 'string', multiple: true },
  limit: { type: 'string' },
  budget: { type: 'string' },
  title: { type: 'string' },
  body: { type: 'string' },
  summary: { type: 'string' },
  source: { type: 'string' },
  rel: { type: 'string' },
  history: { type: 'boolean' },
  supersedes: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Per command: [min positionals, max positionals (Infinity = joined query), allowed options]. */
const COMMANDS: Record<string, [number, number, OptName[]]> = {
  whoami: [0, 0, []],
  boot: [0, 0, []],
  search: [1, Infinity, ['kind', 'limit', 'history']],
  read: [1, Infinity, ['kind', 'budget']],
  get: [1, 1, []],
  history: [1, 1, []],
  links: [1, 1, []],
  write: [0, 0, ['kind', 'title', 'body', 'summary', 'source', 'supersedes']],
  update: [1, 1, ['title', 'body', 'summary']],
  archive: [1, 1, []],
  link: [2, 2, ['rel']],
  help: [0, 1, []],
};

class UsageError extends Error {}

const date = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

function intOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} needs a whole number.`);
  return Number(v);
}

function kindsOpt(v: string[] | undefined): Array<(typeof KINDS)[number]> | undefined {
  if (!v) return undefined;
  for (const k of v) if (!(KINDS as readonly string[]).includes(k)) throw new UsageError(`Unknown kind "${k}". Kinds: ${KINDS.join(', ')}.`);
  return v as Array<(typeof KINDS)[number]>;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const out = (s: string): void => io.stdout(s.endsWith('\n') ? s : `${s}\n`);

  let parsed: { values: Partial<Record<OptName, string | string[] | boolean>>; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    io.stderr(`brain: ${(err as Error).message.split('\n')[0]}\n${USAGE}\n`);
    return EXIT.usage;
  }
  const { values: v, positionals } = parsed;
  const [cmd = 'help', ...pos] = positionals;
  if (v.help || cmd === 'help') {
    out(HELP);
    return EXIT.ok;
  }

  const spec = COMMANDS[cmd];
  let body: string | undefined;
  try {
    if (!spec) throw new UsageError(`Unknown command "${cmd}".`);
    const [min, max, allowed] = spec;
    if (pos.length < min) throw new UsageError(`"${cmd}" needs ${min === 1 ? 'an argument' : `${min} arguments`}.`);
    if (pos.length > max) throw new UsageError(`"${cmd}" takes ${max === 0 ? 'no arguments' : `${max} argument(s)`}; quote text with spaces.`);
    for (const k of Object.keys(v) as OptName[]) {
      if (k !== 'json' && !allowed.includes(k)) throw new UsageError(`--${k} does not apply to "${cmd}".`);
    }
    if (cmd === 'write') {
      if (!v.kind || !v.title || v.body === undefined) throw new UsageError('write needs --kind, --title and --body.');
      if ((v.kind as string[]).length > 1) throw new UsageError('write takes one --kind.');
    }
    if (cmd === 'link' && !v.rel) throw new UsageError('link needs --rel.');
    if (cmd === 'update' && v.title === undefined && v.body === undefined && v.summary === undefined) {
      throw new UsageError('update needs at least one of --title, --body, --summary.');
    }
    kindsOpt(v.kind as string[] | undefined);
    intOpt(v.limit as string | undefined, 'limit');
    intOpt(v.budget as string | undefined, 'budget');
    body = v.body as string | undefined;
    if (body === '-') {
      if (io.stdinIsTTY) throw new UsageError('--body - reads stdin, but nothing is piped in.');
      body = (await io.readStdin()).replace(/\r?\n$/, '');
      if (!body.trim()) throw new UsageError('--body - got empty stdin.');
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr(`brain: ${err.message}\n${USAGE}\n`);
    return EXIT.usage;
  }

  const json = v.json === true;
  const str = (k: OptName): string | undefined => v[k] as string | undefined;
  let client: CliClient | undefined;
  try {
    client = await io.connect();
    const c = client;
    const emit = (result: unknown, text: () => string): void => out(json ? JSON.stringify(result) : text());
    switch (cmd) {
      case 'whoami': {
        const who = c.identity;
        emit(who, () => (who.type === 'user' ? 'user (the app)' : `agent ${who.id} · shelf ${who.shelf} · ${who.write ? 'read-write' : 'read-only'}`));
        break;
      }
      case 'boot': {
        const r = await c.call('bootCard', {});
        emit(r, () => r.text || 'Nothing recorded for this project yet.');
        break;
      }
      case 'search': {
        const kinds = kindsOpt(v.kind as string[] | undefined);
        const limit = intOpt(str('limit'), 'limit');
        const hits = await c.call('search', {
          query: pos.join(' '),
          ...(kinds ? { kinds } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(v.history ? { includeHistory: true } : {}),
        });
        emit(hits, () =>
          hits.length
            ? hits
                .map((h) => {
                  const mark = h.status !== 'current' ? ` [${h.status.toUpperCase()}]` : '';
                  return `${h.id} [${h.kind}] ${oneLine(h.title, 80)}${mark}${h.summary ? ` — ${oneLine(h.summary, 100)}` : ''}`;
                })
                .join('\n')
            : 'No matches.',
        );
        break;
      }
      case 'read': {
        const kinds = kindsOpt(v.kind as string[] | undefined);
        const tokenBudget = intOpt(str('budget'), 'budget');
        const r = await c.call('read', { query: pos.join(' '), ...(kinds ? { kinds } : {}), ...(tokenBudget !== undefined ? { tokenBudget } : {}) });
        emit(r, () => (r.text ? `${r.text}${r.truncated ? '\n(more matches: narrow the query or raise --budget)' : ''}` : 'No matches.'));
        break;
      }
      case 'get': {
        const rec = await c.call('get', { id: pos[0]! });
        if (!rec) throw new BrainServiceError('not_found', `No Brain record ${pos[0]}`);
        emit(rec, () =>
          [
            `${rec.id} [${rec.kind}] ${rec.title}`,
            `shelf ${rec.shelf} · ${rec.trust} · v${rec.version} · by ${rec.owner} · ${date(rec.updatedAt)}` +
              (rec.archived ? ` · ARCHIVED${rec.archivedReason ? ` (${rec.archivedReason})` : ''}` : '') +
              (rec.validTo !== null ? ` · SUPERSEDED${rec.supersededBy ? ` by ${rec.supersededBy}` : ''}` : ''),
            ...(rec.summary ? [`summary: ${rec.summary}`] : []),
            ...(rec.source ? [`source: ${rec.source}`] : []),
            '',
            rec.body,
          ].join('\n'),
        );
        break;
      }
      case 'history': {
        const h = await c.call('history', { id: pos[0]! });
        emit(h, () => h.map((x) => `v${x.version} ${x.change} ${date(x.changedAt)} by ${x.changedBy} [${x.trust}] ${oneLine(x.title, 80)}`).join('\n') || 'No history.');
        break;
      }
      case 'links': {
        const l = await c.call('links', { id: pos[0]! });
        emit(l, () => l.map((x) => (x.direction === 'out' ? `-> ${x.rel} ${x.id}` : `<- ${x.rel} ${x.id}`)).join('\n') || 'No links.');
        break;
      }
      case 'write': {
        const r = await c.call('write', {
          kind: (v.kind as string[])[0] as (typeof KINDS)[number],
          title: str('title')!,
          body: body!,
          ...(str('summary') !== undefined ? { summary: str('summary')! } : {}),
          ...(str('source') !== undefined ? { source: str('source')! } : {}),
          ...(str('supersedes') !== undefined ? { supersedes: str('supersedes')! } : {}),
        });
        emit(r, () => (r.created ? `created ${r.id}${r.note ? `\n${r.note}` : ''}` : (r.note ?? `exists ${r.id} (identical record already stored)`)));
        break;
      }
      case 'update': {
        const r = await c.call('update', {
          id: pos[0]!,
          ...(str('title') !== undefined ? { title: str('title')! } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(str('summary') !== undefined ? { summary: str('summary')! } : {}),
        });
        emit(r, () => `updated ${pos[0]} -> v${r.version}`);
        break;
      }
      case 'archive': {
        const r = await c.call('archive', { id: pos[0]! });
        emit(r, () => `archived ${pos[0]}`);
        break;
      }
      case 'link': {
        const r = await c.call('link', { from: pos[0]!, to: pos[1]!, rel: str('rel')! });
        emit(r, () => `linked ${pos[0]} -${str('rel')}-> ${pos[1]}`);
        break;
      }
    }
    return EXIT.ok;
  } catch (err) {
    const e = err instanceof BrainServiceError ? err : new BrainServiceError('internal', err instanceof Error ? err.message : String(err));
    if (json) io.stderr(`${JSON.stringify({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } })}\n`);
    else io.stderr(`brain: ${e.code}: ${e.message}\nhint: ${HINTS[e.code]}\n`);
    return EXIT.service;
  } finally {
    client?.close();
  }
}
