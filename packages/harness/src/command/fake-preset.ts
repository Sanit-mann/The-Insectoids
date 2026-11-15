import type { CommandEvent, CommandPreset } from './preset';

type Json = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Reads fake-command.mjs's JSON lines (tests only). */
export function parseFakeCommandLine(line: string): CommandEvent[] {
  let m: Json;
  try {
    m = JSON.parse(line) as Json;
  } catch {
    return [];
  }
  if (!m || typeof m !== 'object') return [];
  switch (m['type']) {
    case 'text':
      return [{ kind: 'text', text: str(m['text']) ?? '' }];
    case 'tool':
      return [{ kind: 'tool', name: str(m['name']) ?? 'tool', ...(str(m['id']) ? { id: str(m['id'])! } : {}), input: m['input'] }];
    case 'usage':
      return [{ kind: 'usage', usage: { input: num(m['input']), output: num(m['output']), cacheRead: num(m['cached']) }, ...(str(m['model']) ? { model: str(m['model'])! } : {}) }];
    case 'result':
      return [
        {
          kind: 'final',
          ok: m['ok'] === true,
          ...(str(m['session']) ? { sessionId: str(m['session'])! } : {}),
          numTurns: num(m['turns']),
          ...(typeof m['cost'] === 'number' ? { costUsd: m['cost'] } : {}),
          ...(str(m['error']) ? { errorMessage: str(m['error'])! } : {}),
        },
      ];
    case 'error':
      return [{ kind: 'error', message: str(m['message']) ?? 'error', ...(m['code'] === 'auth' ? { auth: true } : {}), ...(m['code'] === 'quota' ? { quota: true } : {}) }];
    default:
      return [];
  }
}

/** The test preset for fake-command.mjs: guarded (its tools off by flag, the hive's over an MCP config file). */
export function fakeCommandPreset(over: Partial<CommandPreset> = {}): CommandPreset {
  return {
    id: 'custom',
    name: 'Fake command',
    vendor: 'The Insectoids (tests)',
    executable: 'fake-command',
    version: { args: ['--version'], pattern: /fake-command (\d+\.\d+\.\d+)/, minimum: '1.2.0' },
    install: { command: 'npm install -g fake-command', note: 'Test only.' },
    signIn: { command: 'fake-command login', note: 'Its own login. The hive never sees it.' },
    privacyNote: null,
    prompt: { via: 'stdin' },
    headlessArgs: ['run', '--json'],
    model: { flag: '--model', tiers: { strongest: 'fake-large', standard: 'fake-medium', light: 'fake-small' } },
    effort: { flag: '--effort', values: { low: 'low', medium: 'medium', high: 'high' } },
    maxTurnsFlag: '--max-turns',
    output: { format: 'jsonl', parse: parseFakeCommandLine },
    signedInCheck: { args: ['auth', 'status'], signedIn: /^Logged in/m },
    guard: {
      disableBuiltinTools: ['--no-builtin-tools'],
      wireMcp: (servers, run) => ({
        args: ['--mcp-config', `${run.runDir}${run.platform === 'win32' ? '\\' : '/'}mcp.json`, '--only-mcp', Object.keys(servers).join(',')],
        env: { FAKE_COMMAND_MCP: '1' },
        files: [{ path: 'mcp.json', content: JSON.stringify({ servers }, null, 2) }],
      }),
    },
    forbiddenArgs: ['--yolo', '--allow-all-tools'],
    reportsCost: false,
    pricePerMTok: { input: 1, output: 4 },
    exitCodes: { 41: 'auth' },
    scrubEnv: ['FAKE_SECRET'],
    tested: true,
    ...over,
  };
}
