/**
 * Guarded file and shell tools over MCP (stdio), started by an engine whose own pre-tool hooks can't
 * fail closed (Gemini CLI) for one insect run. The guard policy comes from INSECTOIDS_GUARD, exactly as
 * for the Claude Code hook. Bundled to dist/hive-tools-mcp.mjs. stdout carries the protocol, so
 * diagnostics go to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fsRealpath } from '@insectoids/reflexes';
import { createHiveToolsServer, policyFromEnv } from '../server';

const log = (msg: string): void => {
  process.stderr.write(`[insectoids-hive-tools] ${msg}\n`);
};

async function main(): Promise<void> {
  const result = policyFromEnv(process.env, fsRealpath);
  if (!result.policy) log(result.error);
  const server = createHiveToolsServer(result);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
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
