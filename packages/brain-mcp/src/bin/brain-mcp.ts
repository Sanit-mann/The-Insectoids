/**
 * MCP door into the Brain over stdio (01-D5). Started by the AI tool (e.g. Claude Code via
 * --mcp-config) for one insect; finds the Brain service through INSECTOIDS_BRAIN_ENDPOINT/TOKEN.
 * Bundled to dist/brain-mcp.mjs. stdout carries the protocol, so diagnostics go to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrainClient, BrainServiceError } from '@insectoids/brain-service/client';
import { type BrainAccess, clientAccess, createBrainMcpServer, unavailableAccess } from '../server';

const log = (msg: string): void => {
  process.stderr.write(`[insectoids-brain-mcp] ${msg}\n`);
};

async function main(): Promise<void> {
  let access: BrainAccess;
  let unavailableReason: string | undefined;
  try {
    const client = await BrainClient.fromEnv();
    access = clientAccess(client, () => BrainClient.fromEnv());
  } catch (err) {
    const e = err instanceof BrainServiceError ? err : new BrainServiceError('internal', String(err));
    unavailableReason = e.message;
    log(`Brain unavailable (${e.code}): ${e.message}`);
    // Still serve: every tool returns this error instead of the AI tool waiting on a dead server.
    access = unavailableAccess(e);
  }

  const server = createBrainMcpServer(access, unavailableReason ? { unavailableReason } : {});
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    access.close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
