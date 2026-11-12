import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * The services door (Connections 04-D4, Phase 2 A3): one MCP tool, `call_service`, that forwards to the
 * local secret broker with this run's capability token. The agent picks a service by id and gives a path;
 * the broker adds the key, keeps the path inside the service, and asks the user before anything that
 * changes something outside the computer. The token lives in this server's env only, never the agent's.
 */

export const SERVER_NAME = 'insectoids-services';
const SERVER_VERSION = '0.1.0';
/** What the agent sees of a body; the broker already caps at ~200 KB, this keeps a single answer small. */
const BODY_CHARS = 30_000;

export interface BrokerCall {
  integration: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: string;
}

export type BrokerAnswer =
  | { ok: true; status: number; headers: Record<string, string>; body: string; truncated: boolean }
  | { ok: false; status: number; error: string };

/** How the server reaches the broker (HTTP in real runs; a stub in tests). */
export type BrokerTransport = (call: BrokerCall) => Promise<BrokerAnswer>;

/** HTTP to the broker with the bearer token. Errors become answers, never thrown. */
export function httpTransport(url: string, token: string, fetchImpl: typeof fetch = fetch): BrokerTransport {
  return async (call) => {
    try {
      const res = await fetchImpl(`${url.replace(/\/+$/, '')}/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(call),
      });
      const parsed = (await res.json().catch(() => null)) as BrokerAnswer | null;
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
      return { ok: false, status: res.status, error: `The broker answered HTTP ${res.status}.` };
    } catch {
      return { ok: false, status: 0, error: "Can't reach the hive's service broker. Is the app running?" };
    }
  };
}

const input = {
  integration: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).describe('Service id from your brief, e.g. "github".'),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  path: z.string().min(1).max(2048).describe('Path under the service, starting with "/", e.g. "/repos/OWNER/REPO/issues". No full URLs, no query string here.'),
  query: z.record(z.string(), z.string()).optional().describe('Query parameters, e.g. {"state": "open"}.'),
  body: z.string().max(100_000).optional().describe('Request body (JSON text) for write methods.'),
};

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

export function format(a: BrokerAnswer): CallToolResult {
  if (!a.ok) return text(`Service call refused (${a.status}): ${a.error}`, true);
  const head = [`HTTP ${a.status}`, ...Object.entries(a.headers).map(([k, v]) => `${k}: ${v}`)].join('\n');
  let body = a.body;
  let cut = a.truncated;
  if (body.length > BODY_CHARS) {
    body = body.slice(0, BODY_CHARS);
    cut = true;
  }
  return text(`${head}\n\n${body}${cut ? '\n\n[Answer cut short: ask for less, e.g. per_page or a narrower path.]' : ''}`, a.status >= 400);
}

export function createServicesServer(transport: BrokerTransport | null, opts: { unavailableReason?: string } = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Outside services for this card, through the hive. Use call_service with a service id from your brief. Reading is allowed; creating or changing anything needs the user\'s approval (the call says so: then end with "STATUS: BLOCKED: …"). You never need or see keys.',
    },
  );
  server.registerTool(
    'call_service',
    {
      description:
        'Call an outside service your card may use (see your brief), e.g. GitHub or Brave Search. Give the service id, method, a path under the service, and optional query or body. Returns the HTTP status, a few headers and the body (capped).',
      inputSchema: input,
    },
    async (args) => {
      if (!transport) return text(`Outside services are not available in this run: ${opts.unavailableReason ?? 'no broker'}.`, true);
      return format(
        await transport({
          integration: args.integration,
          method: args.method,
          path: args.path,
          ...(args.query ? { query: args.query } : {}),
          ...(args.body !== undefined ? { body: args.body } : {}),
        }),
      );
    },
  );
  return server;
}
