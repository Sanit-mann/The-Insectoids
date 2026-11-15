// A stand-in CLI for the generic command engine's tests: no AI calls, no tokens.
// It records what the hive gave it (args, cwd, prompt and how it came, MCP wiring, selected environment) to
// FAKE_COMMAND_REPORT and replies with JSON lines (or plain text). Like a well-behaved agent, it refuses to
// touch any file outside its working folder: a prompt line "WRITE <path>" writes "hi" there only if inside.
// Also answers `--version` and `auth status` for detection.
// FAKE_COMMAND_MODE: ok (default) | text | hang | auth | quota | fail | garbage
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = process.env.FAKE_COMMAND_MODE ?? 'ok';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === '--version') {
  process.stdout.write(`fake-command ${process.env.FAKE_COMMAND_VERSION ?? '1.4.2'}\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_COMMAND_SIGNED_IN === '0') {
    process.stderr.write('Not logged in. Run "fake-command login".\n');
    process.exit(1);
  }
  process.stdout.write('Logged in (fake account)\n');
  process.exit(0);
}

const main = (prompt, how) => {
  const mcpPath = flag('--mcp-config');
  if (process.env.FAKE_COMMAND_REPORT) {
    writeFileSync(
      process.env.FAKE_COMMAND_REPORT,
      JSON.stringify({
        args,
        cwd: process.cwd(),
        prompt,
        how,
        mcpPath: mcpPath ?? null,
        mcp: mcpPath && existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf8')) : null,
        env: {
          FAKE_COMMAND_MCP: process.env.FAKE_COMMAND_MCP ?? null,
          ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
          INSECTOIDS_GUARD: process.env.INSECTOIDS_GUARD ?? null,
          INSECTOIDS_BRAIN_TOKEN: process.env.INSECTOIDS_BRAIN_TOKEN ?? null,
          FAKE_SECRET: process.env.FAKE_SECRET ?? null,
        },
      }),
    );
  }
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'garbage') {
    process.stdout.write('not json\n{"type":\n');
    process.exit(1);
  }
  if (mode === 'auth') {
    process.stderr.write('Error: not signed in. Run "fake-command login".\n');
    process.exit(41);
  }
  if (mode === 'text') {
    process.stdout.write('Working on it.\nDone.\nSTATUS: DONE\n');
    process.exit(0);
  }
  out({ type: 'text', text: 'Working on it.' });
  for (const line of prompt.split(/\r?\n/)) {
    const m = /^WRITE (.+)$/.exec(line.trim());
    if (!m) continue;
    const target = resolve(process.cwd(), m[1]);
    const rel = relative(process.cwd(), target);
    out({ type: 'tool', id: `w-${m[1]}`, name: 'hive_write_file', input: { path: m[1] } });
    if (rel.startsWith('..') || isAbsolute(rel)) {
      out({ type: 'error', message: `Refused to write outside the workspace: ${m[1]}` });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'hi');
  }
  out({ type: 'usage', input: 3000, output: 500, cached: 1000, model: `${flag('--model') ?? 'fake-default'}-2026` });
  if (mode === 'quota') {
    out({ type: 'error', message: 'You have reached your usage limit. Try again in 2 hours.', code: 'quota' });
    out({ type: 'result', ok: false, error: 'usage limit', session: 's-1', turns: 1 });
    process.exit(1);
  }
  if (mode === 'fail') {
    out({ type: 'result', ok: false, error: 'The model gave up.', session: 's-1', turns: 1 });
    process.exit(0);
  }
  out({ type: 'text', text: 'Done.\nSTATUS: DONE' });
  // Like Copilot: token counts in a file at the end, when the hive asks for one.
  const usageFile = flag('--usage-file');
  if (usageFile) writeFileSync(usageFile, JSON.stringify({ tokens: { in: 700, out: 30 }, model: 'fake-from-file' }));
  out({ type: 'result', ok: true, session: 's-1', turns: 2, ...(process.env.FAKE_COMMAND_COST ? { cost: Number(process.env.FAKE_COMMAND_COST) } : {}) });
  process.exit(0);
};

const file = flag('--prompt-file');
const arg = flag('-p');
if (file) main(readFileSync(file, 'utf8'), 'file');
else if (arg !== undefined) main(arg, 'arg');
else if (args.includes('--prompt-last')) main(args.at(-1), 'positional');
else {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (stdin += d));
  process.stdin.on('end', () => main(stdin, 'stdin'));
}
