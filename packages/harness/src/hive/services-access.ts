/**
 * Outside services for insects (Connections 04-D4, Phase 2 step A3).
 *
 * The secret broker lives in the app's main process with the Vault. For each run whose card names
 * integrations, the hive asks it for a capability token scoped to that card and only those integrations;
 * the engine hands the run a `services` MCP door (packages/services-mcp) holding the broker address and the
 * token in that server's own env (never the agent's or its shell's). The token is revoked when the run ends.
 *
 * Plain interfaces, so the harness doesn't depend on Electron: the app wires the real broker over the
 * host → main channel; tests use a stub or a real broker.
 */

/** Env the services door reads (packages/services-mcp). */
export const BROKER_ENV_URL = 'INSECTOIDS_BROKER_URL';
export const BROKER_ENV_TOKEN = 'INSECTOIDS_BROKER_TOKEN';

export interface ServiceSummary {
  id: string;
  description: string;
}

export interface ServiceGrant {
  cardId: string;
  runId?: string;
  agentId: string;
  integrations: string[];
  /** "Ask" rules the user approved for this card ("publish" lets write requests through). */
  approvedRules: string[];
}

export interface ServiceTicket {
  url: string;
  token: string;
  granted: string[];
  denied: Array<{ id: string; reason: string }>;
}

export interface ServiceAccess {
  /** Integrations switched on and usable now (for the Queen's prompt). */
  available(): Promise<ServiceSummary[]>;
  issue(g: ServiceGrant): Promise<ServiceTicket>;
  revoke(token: string): Promise<void>;
  /** How to start the services door. */
  door: { runtime: { command: string; args?: string[]; env?: Record<string, string> }; mcpScript: string };
}

/** What one engine run gets (only when its card names integrations that were granted). */
export interface RunServices {
  url: string;
  token: string;
  granted: string[];
  door: ServiceAccess['door'];
}

export function servicesEnv(s: RunServices): Record<string, string> {
  return { [BROKER_ENV_URL]: s.url, [BROKER_ENV_TOKEN]: s.token };
}

/** The `services` MCP server entry for a run (Claude's --mcp-config shape). */
export function servicesMcpServer(s: RunServices): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: s.door.runtime.command,
    args: [...(s.door.runtime.args ?? []), s.door.mcpScript],
    env: { ...s.door.runtime.env, ...servicesEnv(s) },
  };
}

/** A line for the insect's brief: what it may call, how, and what it can't. */
export function servicesBrief(granted: string[], denied: ServiceTicket['denied']): string {
  const lines = ['## Outside services'];
  if (granted.length) {
    lines.push(
      `You can use ${granted.map((g) => `"${g}"`).join(', ')} through the \`call_service\` tool (integration, method, path, query, body).`,
      'Reading is allowed. Anything that creates or changes something outside this computer (POST/PUT/PATCH/DELETE on most services) needs the user\'s approval: if a call says so, end with "STATUS: BLOCKED: <what you need>".',
      'You never see or need the keys; the hive adds them.',
    );
  }
  if (denied.length) lines.push(`Not available for this card: ${denied.map((d) => `"${d.id}" (${d.reason})`).join(', ')}. Work without it, or end with "STATUS: BLOCKED" if you can't.`);
  return lines.join('\n');
}
