import { type Brain, openBrain } from '@insectoids/brain';
import { BrainClient, type BrainService, startBrainService } from '@insectoids/brain-service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliIO, EXIT, runCli } from './cli';

let brain: Brain;
let service: BrainService;
let agentToken: string;
const user = { type: 'user' } as const;

beforeEach(async () => {
  let n = 0;
  brain = openBrain(':memory:', { newId: () => `r${++n}` });
  service = await startBrainService({ brain });
  agentToken = service.issueAgentToken({ agentId: 'Ant-07', shelf: 'site', write: true });
});

afterEach(async () => {
  await service.close();
  brain.close();
});

interface RunOpts {
  token?: string;
  endpoint?: string;
  stdin?: string;
  tty?: boolean;
}

async function run(argv: string[], o: RunOpts = {}): Promise<{ code: number; out: string; err: string; connected: boolean }> {
  let out = '';
  let err = '';
  let connected = false;
  const io: CliIO = {
    connect: () => {
      connected = true;
      return BrainClient.connect({ endpoint: o.endpoint ?? service.endpoint, token: o.token ?? agentToken, timeoutMs: 2000 });
    },
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    readStdin: () => Promise.resolve(o.stdin ?? ''),
    stdinIsTTY: o.tty ?? false,
  };
  const code = await runCli(argv, io);
  return { code, out, err, connected };
}

describe('help and usage errors (exit 2, never touch the Brain)', () => {
  it('prints help for no args, help and --help, including the trust rules', async () => {
    for (const argv of [[], ['help'], ['--help'], ['search', '-h']]) {
      const r = await run(argv);
      expect(r.code).toBe(EXIT.ok);
      expect(r.out).toContain('Usage: brain <command>');
      expect(r.out).toMatch(/unconfirmed\/proposed/);
      expect(r.out).toMatch(/Never store secrets/);
      expect(r.connected).toBe(false);
    }
  });

  it.each([
    [['fly'], /Unknown command "fly"/],
    [['search', '--wat'], /Unknown option/],
    [['search'], /needs an argument/],
    [['get', 'a', 'b'], /takes 1 argument/],
    [['whoami', 'x'], /takes no arguments/],
    [['get', 'r1', '--limit', '3'], /--limit does not apply to "get"/],
    [['search', 'x', '--kind', 'poem'], /Unknown kind "poem"/],
    [['search', 'x', '--limit', 'ten'], /--limit needs a whole number/],
    [['write', '--kind', 'fact', '--title', 'T'], /write needs --kind, --title and --body/],
    [['write', '--kind', 'fact', '--kind', 'task', '--title', 'T', '--body', 'b'], /one --kind/],
    [['link', 'a', 'b'], /link needs --rel/],
    [['update', 'r1'], /at least one of/],
  ])('%j', async (argv, msg) => {
    const r = await run(argv);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(msg);
    expect(r.err).toContain('brain help');
    expect(r.connected).toBe(false);
  });

  it('--body - refuses a terminal and empty stdin instead of hanging or writing nothing', async () => {
    const args = ['write', '--kind', 'fact', '--title', 'T', '--body', '-'];
    expect((await run(args, { tty: true })).err).toMatch(/nothing is piped/);
    expect((await run(args, { stdin: '\n' })).code).toBe(EXIT.usage);
  });
});

describe('commands', () => {
  it('whoami', async () => {
    expect((await run(['whoami'])).out).toBe('agent Ant-07 · shelf site · read-write\n');
    expect(JSON.parse((await run(['whoami', '--json'])).out)).toEqual({ type: 'agent', id: 'Ant-07', shelf: 'site', write: true });
    expect((await run(['whoami'], { token: service.masterToken })).out).toBe('user (the app)\n');
  });

  it('write, then the same write again, with the body from stdin', async () => {
    const w = await run(['write', '--kind', 'fact', '--title', 'Brand font', '--body', '-', '--summary', 'Satoshi everywhere', '--source', 'brand.pdf'], {
      stdin: 'Satoshi, 400 and 700.\n',
    });
    expect(w).toMatchObject({ code: 0, out: 'created r1\n' });
    expect(brain.get('r1')).toMatchObject({ body: 'Satoshi, 400 and 700.', owner: 'Ant-07', trust: 'unconfirmed', source: 'brand.pdf' });
    const again = await run(['write', '--kind', 'fact', '--title', 'Brand font', '--body', 'Satoshi, 400 and 700.']);
    expect(again.out).toBe('exists r1 (identical record already stored)\n');
    expect(JSON.parse((await run(['write', '--kind', 'task', '--title', 'Hero', '--body', 'Build it', '--json'])).out)).toEqual({ id: 'r2', created: true });
  });

  it('get, search, read, history, links, link, update, archive, boot', async () => {
    brain.write({ kind: 'decision', shelf: 'site', title: 'Use Tailwind', body: 'Tailwind 4 for all styling.', summary: 'Tailwind 4 only' }, user);
    brain.write({ kind: 'task', shelf: 'site', title: 'Hero section', body: 'Build the hero with Tailwind.' }, user);

    const get = await run(['get', 'r1']);
    expect(get.out).toMatch(/^r1 \[decision\] Use Tailwind\nshelf site · confirmed · v1 · by user · \d{4}-\d\d-\d\d \d\d:\d\d\nsummary: Tailwind 4 only\n\nTailwind 4 for all styling.\n$/);
    expect(JSON.parse((await run(['get', 'r1', '--json'])).out)).toMatchObject({ id: 'r1', kind: 'decision' });

    expect((await run(['search', 'tailwind'])).out.trim().split('\n')).toHaveLength(2);
    expect((await run(['search', 'tailwind', '--kind', 'task'])).out).toBe('r2 [task] Hero section\n');
    expect((await run(['search', 'tailwind', '--limit', '1'])).out.trim().split('\n')).toHaveLength(1);
    expect((await run(['search', 'hero', 'section'])).out).toContain('r2'); // unquoted words join into one query
    expect((await run(['search', 'nothing-here'])).out).toBe('No matches.\n');

    const read = await run(['read', 'tailwind', '--budget', '100']);
    expect(read.out).toContain('[decision] Use Tailwind: Tailwind 4 only (r1)');

    expect((await run(['link', 'r2', 'r1', '--rel', 'depends-on'])).out).toBe('linked r2 -depends-on-> r1\n');
    expect((await run(['links', 'r2'])).out).toBe('-> depends-on r1\n');
    expect((await run(['links', 'r1'])).out).toBe('<- depends-on r2\n');

    expect((await run(['update', 'r2', '--body', '-'], { stdin: 'Build the hero; mobile first.' })).out).toBe('updated r2 -> v2\n');
    const hist = (await run(['history', 'r2'])).out.trim().split('\n');
    expect(hist).toHaveLength(2);
    expect(hist[1]).toMatch(/^v2 update .* by Ant-07 \[confirmed\] Hero section$/);

    expect((await run(['archive', 'r2'])).out).toBe('archived r2\n');
    expect((await run(['get', 'r2'])).out).toContain('ARCHIVED');

    expect((await run(['boot'])).out).toContain('Use Tailwind');
  });

  it('a long body passes through stdin untouched (quotes, newlines, shell characters)', async () => {
    const body = `Line 1 with "quotes" & 'apostrophes' | pipes > redirects $HOME %PATH% ^caret !bang\nLine 2\n${'x'.repeat(5000)}`;
    await run(['write', '--kind', 'update', '--title', 'Long note', '--body', '-'], { stdin: `${body}\n` });
    expect(brain.get('r1')?.body).toBe(body);
  });
});

describe('Brain refusals and failures (exit 1 with a hint)', () => {
  it('secret, trust, conflict, forbidden, not found', async () => {
    const secret = await run(['write', '--kind', 'fact', '--title', 'key', '--body', 'AKIAABCDEFGHIJKLMNOP']);
    expect(secret.code).toBe(EXIT.service);
    expect(secret.err).toMatch(/^brain: secret: .*\nhint: Secrets never go in the Brain/);
    expect(brain.search('key')).toHaveLength(0);

    brain.write({ kind: 'decision', shelf: 'site', title: 'Keep the brand', body: 'No rebrand.' }, user);
    const conflict = await run(['update', 'r1', '--body', 'Rebrand.']);
    expect(conflict.err).toMatch(/^brain: conflict: .*\nhint: The user confirmed this/);

    const ro = service.issueAgentToken({ agentId: 'Ant-08', shelf: 'site', write: false });
    expect((await run(['write', '--kind', 'fact', '--title', 'a', '--body', 'b'], { token: ro })).err).toMatch(/^brain: forbidden: This token is read-only/);

    const missing = await run(['get', 'nope']);
    expect(missing).toMatchObject({ code: EXIT.service });
    expect(missing.err).toMatch(/^brain: not_found: No Brain record nope\nhint: Check the id/);
  });

  it('bad token and missing service', async () => {
    expect((await run(['whoami'], { token: 'stale' })).err).toMatch(/^brain: unauthorized: /);
    const endpoint = service.endpoint;
    await service.close();
    const down = await run(['boot'], { endpoint });
    expect(down.code).toBe(EXIT.service);
    expect(down.err).toMatch(/^brain: disconnected: .*\nhint: Is The Insectoids app running\?/);
    service = await startBrainService({ brain }); // for afterEach
  });

  it('--json errors are machine-readable on stderr', async () => {
    const r = await run(['get', 'nope', '--json']);
    expect(r.out).toBe('');
    expect(JSON.parse(r.err)).toEqual({ error: { code: 'not_found', message: 'No Brain record nope' } });
  });
});

describe('B2: --supersedes and --history', () => {
  it('supersedes a record, hides the old one, and shows it with --history', async () => {
    const first = await run(['write', '--kind', 'fact', '--title', 'Hosting', '--body', 'The site is on Netlify.']);
    expect(first.out).toBe('created r1\n');
    const second = await run(['write', '--kind', 'fact', '--title', 'Hosting', '--body', 'The site moved to Vercel.', '--supersedes', 'r1']);
    expect(second.out).toMatch(/^created r2/);
    expect((await run(['search', 'hosting'])).out).not.toContain('r1 ');
    expect((await run(['search', 'hosting', '--history'])).out).toContain('r1 [fact] Hosting [SUPERSEDED]');
    expect((await run(['get', 'r1'])).out).toContain('SUPERSEDED by r2');
  });

  it('a near-duplicate says it is already known', async () => {
    await run(['write', '--kind', 'update', '--title', 'Checkout', '--body', 'The checkout page uses Stripe Elements for card entry.']);
    const dup = await run(['write', '--kind', 'update', '--title', 'Checkout', '--body', 'the checkout page uses stripe elements, for card entry']);
    expect(dup.code).toBe(0);
    expect(dup.out).toMatch(/^Already known as "Checkout" \(r1\)/);
  });
});

describe('code (B4)', () => {
  beforeEach(() => {
    brain.code.putFile('site', {
      path: 'src/util.ts',
      language: 'typescript',
      contentHash: 'h1',
      size: 10,
      imports: ['./a.js'],
      symbols: [
        { name: 'slugify', qualified: 'slugify', kind: 'function', line: 3, endLine: 5, signature: 'export function slugify(text: string): string {', doc: 'Turns text into a slug.', parent: null },
        { name: 'helper', qualified: 'helper', kind: 'function', line: 7, endLine: 9, signature: 'function helper() {', doc: null, parent: null },
      ],
      edges: [{ from: 'slugify', callee: 'helper', toPath: null, line: 4 }],
    });
  });

  it('finds symbols, outlines files, lists callers and callees', async () => {
    expect((await run(['code', 'slug'])).out).toBe(
      '1 symbol(s) match "slug".\nsrc/util.ts:3 function slugify — export function slugify(text: string): string {\n    Turns text into a slug.\n',
    );
    expect((await run(['code', 'util.ts', '--file'])).out).toContain('imports: ./a.js');
    expect((await run(['code', 'helper', '--callers'])).out).toContain('src/util.ts:3 function slugify');
    expect((await run(['code', 'slugify', '--callees'])).out).toContain('src/util.ts:7 function helper');
    const json = JSON.parse((await run(['code', 'helper', '--json'])).out) as { hits: Array<{ name: string }> };
    expect(json.hits.map((h) => h.name)).toEqual(['helper']);
  });

  it('refuses two modes at once', async () => {
    const r = await run(['code', 'x', '--file', '--callers']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/one of --file, --callers, --callees/);
  });
});
