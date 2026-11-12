import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeEngine, type EngineRequest, FakeEngine } from './engine';
import { Hive } from './hive';
import { Library, queenPrompt } from './prompts';
import { parsePlan } from './protocol';
import { BROKER_ENV_TOKEN, BROKER_ENV_URL, type ServiceAccess, type ServiceGrant, servicesBrief, servicesMcpServer } from './services-access';

const library = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const door = { runtime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, mcpScript: '/doors/services-mcp.mjs' };
const json = (o: unknown) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe('plan cards name their integrations; the Queen sees only switched-on ones', () => {
  it('parses integrations (default none) and lists available services in the Queen\'s brief', () => {
    const r = parsePlan(json({ summary: 's', waves: [{ cards: [{ title: 'a', brief: 'b', caste: 'coder', acceptance: ['x'], integrations: ['github'] }, { title: 'c', brief: 'd', caste: 'coder', acceptance: ['y'] }] }] }), { castes: ['coder'] });
    expect(r.ok && r.plan.waves[0]!.cards.map((c) => c.integrations)).toEqual([['github'], []]);
    const p = queenPrompt(library, { goal: 'g', bootCard: '', context: '', castes: ['coder'], projectListing: '', services: [{ id: 'github', description: 'Read repos.' }] });
    expect(p.system).toContain('- github: Read repos.');
    expect(p.system).toMatch(/only the ones it really needs/);
    expect(queenPrompt(library, { goal: 'g', bootCard: '', context: '', castes: ['coder'], projectListing: '' }).system).toMatch(/None are switched on/);
  });

  it('the services door gets the broker env in its own server entry only', () => {
    const s = { url: 'http://127.0.0.1:5', token: 't', granted: ['github'], door };
    expect(servicesMcpServer(s)).toEqual({ command: process.execPath, args: ['/doors/services-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1', [BROKER_ENV_URL]: 'http://127.0.0.1:5', [BROKER_ENV_TOKEN]: 't' } });
    expect(servicesBrief(['github'], [{ id: 'brave-search', reason: 'switched off' }])).toMatch(/call_service[\s\S]*Not available for this card: "brave-search" \(switched off\)/);
  });
});

describe('ClaudeEngine: the services door joins the MCP config, never Claude\'s environment', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'insectoids-svcrun-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('passes a config with the services server and keeps the token out of the CLI env', async () => {
    const probe = join(tmp, 'probe.mjs');
    writeFileSync(probe, `
      import { readFileSync } from 'node:fs';
      const a = process.argv.slice(2);
      const cfg = a[a.indexOf('--mcp-config') + 1];
      process.stdin.resume();
      process.stdin.on('end', () => {
        const report = { cfgPath: cfg, mcp: JSON.parse(readFileSync(cfg, 'utf8')), envToken: process.env.${BROKER_ENV_TOKEN} ?? null };
        const o = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
        o({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report), session_id: 's', num_turns: 1, duration_ms: 1, total_cost_usd: 0, usage: {} });
      });`);
    const engine = new ClaudeEngine({ claude: process.execPath, claudeArgs: [probe], hook: { command: process.execPath, args: [] }, promptDir: join(tmp, 'prompts') });
    const services = { url: 'http://127.0.0.1:9', token: 'svc-token', granted: ['github'], door };
    const r = await engine.run({
      role: 'coder', agentId: 'Ant-01', cwd: tmp, system: 'sys', task: 'go',
      route: { model: 'sonnet', effort: 'low', maxTurns: 2, maxBudgetUsd: 1, timeoutMs: 20_000 } as EngineRequest['route'],
      guard: { workspace: tmp, home: tmp, noGo: [], network: 'none' },
      services,
    }).done;
    const report = JSON.parse(r.text) as { cfgPath: string; mcp: { mcpServers: Record<string, unknown> }; envToken: string | null };
    expect(report.mcp.mcpServers).toEqual({ services: servicesMcpServer(services) });
    expect(report.envToken).toBeNull();
    expect(existsSync(report.cfgPath)).toBe(false);
  });
});

describe('the hive asks the broker for a token per run, only for cards with integrations', () => {
  let root: string;
  let repo: string;
  let brain: Brain;
  let ws: Workspace;
  const grants: ServiceGrant[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'insectoids-hivesvc-'));
    repo = join(root, 'project');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'user@example.com');
    writeFileSync(join(repo, 'README.md'), '# Site\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    brain = openBrain(':memory:');
    ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'worktrees') });
    grants.length = 0;
    revoked.length = 0;
  });

  afterEach(async () => {
    await ws.dispose();
    brain.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const access = (): ServiceAccess => ({
    available: async () => [{ id: 'github', description: 'Read repos.' }],
    issue: async (g) => {
      grants.push(g);
      return { url: 'http://127.0.0.1:1', token: `tok-${grants.length}`, granted: g.integrations.filter((i) => i === 'github'), denied: g.integrations.filter((i) => i !== 'github').map((id) => ({ id, reason: 'switched off' })) };
    },
    revoke: async (t) => {
      revoked.push(t);
    },
    door,
  });

  it('a card with integrations gets a token and the door; its token is revoked; other runs get nothing', async () => {
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') {
        return {
          text: json({
            summary: 's',
            waves: [{ cards: [
              { id: 'C-01', title: 'Read issues', brief: 'List open issues', caste: 'coder', acceptance: ['listed'], integrations: ['github', 'brave-search'] },
              { id: 'C-02', title: 'Write docs', brief: 'Docs', caste: 'coder', acceptance: ['written'] },
            ] }],
          }),
        };
      }
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `${req.title?.replace(/\W/g, '')}.txt`), 'x') };
    });
    const hive = new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 2, castes: ['coder'], leaseMs: 60_000,
      services: access(),
    });
    await hive.submitGoal('Summarise the open issues and write docs');
    await hive.runUntilIdle();

    const calls = engine.calls;
    expect(calls.find((c) => c.role === 'queen')!.system).toContain('- github: Read repos.');
    // Only the card that named integrations asked for a token, for exactly those.
    expect(grants).toEqual([expect.objectContaining({ cardId: expect.stringMatching(/\.C-01$/), integrations: ['github', 'brave-search'], approvedRules: [] })]);
    expect(revoked).toEqual(['tok-1']);
    const withServices = calls.filter((c) => c.services);
    expect(withServices.map((c) => c.title)).toEqual(['Read issues']);
    expect(withServices[0]!.services).toEqual({ url: 'http://127.0.0.1:1', token: 'tok-1', granted: ['github'], door });
    expect(withServices[0]!.system).toMatch(/call_service[\s\S]*"brave-search" \(switched off\)/);
    // The Queen, the Inspector and the other card never get services.
    expect(calls.filter((c) => c.role !== 'coder' || c.title !== 'Read issues').every((c) => !c.services)).toBe(true);
  });
});
