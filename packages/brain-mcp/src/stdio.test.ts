import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type Brain, openBrain } from '@insectoids/brain';
import { BRAIN_ENV, type BrainService, startBrainService } from '@insectoids/brain-service';
import { rolldown } from 'rolldown';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
let tmp: string;
let bundlePath: string;
let brain: Brain;
let service: BrainService;
const clients: Client[] = [];

// The same single-file bundle the app ships (pnpm --filter @insectoids/brain-mcp build).
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'insectoids-brain-mcp-'));
  bundlePath = join(tmp, 'brain-mcp.mjs');
  const bundle = await rolldown({ input: here('./bin/brain-mcp.ts'), platform: 'node' });
  await bundle.write({ file: bundlePath, format: 'esm' });
  await bundle.close();
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
  brain = openBrain(':memory:');
  service = await startBrainService({ brain });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await service.close();
  brain.close();
});

/** Start the bundled MCP server the way Claude Code does: a child process speaking MCP on stdio. */
async function spawnDoor(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundlePath], env, stderr: 'pipe' });
  const client = new Client({ name: 'claude-code-stand-in', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const textOf = (r: unknown): string => (r as CallToolResult).content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('the bundled MCP door over stdio', () => {
  it('an insect reads and writes the Brain through MCP', async () => {
    const token = service.issueAgentToken({ agentId: 'Ant-12', shelf: 'site', write: true });
    const mcp = await spawnDoor({ [BRAIN_ENV.endpoint]: service.endpoint, [BRAIN_ENV.token]: token });

    expect(mcp.getServerVersion()?.name).toBe('insectoids-brain');
    expect((await mcp.listTools()).tools).toHaveLength(10);

    const saved = textOf(await mcp.callTool({ name: 'brain_write', arguments: { kind: 'outcome', title: 'Hero shipped', body: 'Hero section built and tested.' } }));
    const id = /Saved as ([\w-]+)/.exec(saved)?.[1];
    expect(id).toBeTruthy();
    // Written by the insect, through the one writer, as the insect.
    expect(brain.get(id!)).toMatchObject({ shelf: 'site', owner: 'Ant-12', kind: 'outcome' });

    brain.write({ kind: 'decision', shelf: 'site', title: 'Mobile first', body: 'Design for phones first.' }, { type: 'user' });
    expect(textOf(await mcp.callTool({ name: 'brain_read', arguments: { query: 'mobile phones' } }))).toContain('Mobile first');
    expect(textOf(await mcp.callTool({ name: 'brain_boot_card', arguments: {} }))).toContain('Hero shipped');
  });

  it('a read-only insect gets only read tools', async () => {
    const token = service.issueAgentToken({ agentId: 'Inspector-1', shelf: 'site', write: false });
    const mcp = await spawnDoor({ [BRAIN_ENV.endpoint]: service.endpoint, [BRAIN_ENV.token]: token });
    expect((await mcp.listTools()).tools.map((t) => t.name)).not.toContain('brain_write');
  });

  it('without the Brain environment it still answers, with a clear error instead of hanging', async () => {
    const mcp = await spawnDoor({});
    expect(mcp.getInstructions()).toMatch(/unavailable/);
    const r = (await mcp.callTool({ name: 'brain_search', arguments: { query: 'x' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Brain error \(unauthorized\)[\s\S]*INSECTOIDS_BRAIN_ENDPOINT/);
  });

  it('with a revoked or wrong token it reports unauthorized', async () => {
    const mcp = await spawnDoor({ [BRAIN_ENV.endpoint]: service.endpoint, [BRAIN_ENV.token]: 'not-a-token' });
    const r = (await mcp.callTool({ name: 'brain_read', arguments: { query: 'x' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Brain error \(unauthorized\)/);
  });

  it('exits cleanly when its stdin closes (the AI tool went away)', async () => {
    const child = spawn(process.execPath, [bundlePath], {
      env: { ...process.env, [BRAIN_ENV.endpoint]: service.endpoint, [BRAIN_ENV.token]: service.issueAgentToken({ agentId: 'A', shelf: 'site', write: false }) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', resolve);
      setTimeout(() => child.stdin.end(), 300);
      setTimeout(() => {
        child.kill();
        resolve(-1);
      }, 8000);
    });
    expect(code).toBe(0);
  });
});
