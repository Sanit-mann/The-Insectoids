/**
 * The services door over stdio (Connections 04-D4). Started by the AI tool for one insect run; finds the
 * secret broker through INSECTOIDS_BROKER_URL / INSECTOIDS_BROKER_TOKEN in this server's own env.
 * Bundled to dist/services-mcp.mjs. stdout carries the protocol, so diagnostics go to stderr only.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServicesServer, httpTransport } from '../server';

const log = (msg: string): void => {
  process.stderr.write(`[insectoids-services-mcp] ${msg}\n`);
};

async function main(): Promise<void> {
  const url = process.env['INSECTOIDS_BROKER_URL'];
  const token = process.env['INSECTOIDS_BROKER_TOKEN'];
  // Only a loopback broker: this door never sends the token anywhere else.
  const loopback = !!url && /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(url);
  const reason = !url || !token ? 'the run has no service token' : !loopback ? 'the broker address is not local' : undefined;
  if (reason) log(`services unavailable: ${reason}`);
  const server = createServicesServer(reason ? null : httpTransport(url!, token!), reason ? { unavailableReason: reason } : {});
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
