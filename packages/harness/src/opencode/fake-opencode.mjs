// A stand-in for `opencode run --format json` (OpenCode 2.2.1 shapes) in tests: no AI calls, no tokens.
// It checks the hive's safety rules itself and fails loudly (exit 3) if one is broken:
// - `run --standalone --format json --agent hive`, and never an auto-approve flag;
// - the config denies every tool first and only allows the hive's MCP tools;
// - the provider is the broker with the run's pass ({env:HIVE_RUN_PASS}), never a real key;
// - no ELECTRON_RUN_AS_NODE, no FAKE_REAL_KEY value anywhere in its environment;
// - OpenCode's folders and ProgramData point at the per-run folder.
// It records what it got to FAKE_OPENCODE_REPORT and answers by role: a plan for the Queen,
// a verdict for the Inspector, STATUS: DONE for insects.
// FAKE_OPENCODE_MODE: ok (default) | auth (401 error, exit 1) | hang | crash
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.FAKE_OPENCODE_MODE ?? 'ok';
const problems = [];
const need = (ok, what) => {
  if (!ok) problems.push(what);
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

need(args[0] === 'run', 'first argument is "run"');
need(args.includes('--standalone'), '--standalone');
need(flag('--format') === 'json', '--format json');
need(flag('--agent') === 'hive', '--agent hive');
for (const bad of ['--auto', '--yolo', '--dangerously-skip-permissions']) need(!args.includes(bad), `no ${bad}`);

let config = null;
try {
  config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '');
} catch {
  problems.push('OPENCODE_CONFIG_CONTENT is JSON');
}
const rules = config?.permissions ?? [];
need(rules[0]?.action === '*' && rules[0]?.effect === 'deny', 'permissions start with deny *');
need(rules.slice(1).every((r) => r.effect === 'allow' && /^(hive|brain|services)_\*$/.test(r.action)), 'only hive MCP tools allowed');
need(JSON.stringify(config?.agents?.hive?.permissions) === JSON.stringify(rules), 'the hive agent repeats the rules');
need(config?.plugins?.includes('-opencode.tool.*'), 'built-in tool plugins off');
const provider = config?.providers?.['hive-or'];
need(provider?.settings?.apiKey === '{env:HIVE_RUN_PASS}', 'provider key is the run pass placeholder');
need(/^http:\/\/127\.0\.0\.1:\d+\//.test(provider?.settings?.baseURL ?? ''), 'provider base URL is the local broker');
need(Boolean(process.env.HIVE_RUN_PASS), 'HIVE_RUN_PASS set');
need(!process.env.ELECTRON_RUN_AS_NODE, 'no ELECTRON_RUN_AS_NODE');
need(process.env.OPENCODE_DISABLE_PROJECT_CONFIG === '1', 'project config off');
need(process.env.OPENCODE_DB === ':memory:', 'no session database on disk');
const runDir = process.env.OPENCODE_CONFIG_DIR?.replace(/[\\/]opencode$/, '');
need(Boolean(runDir) && (process.env.ProgramData ?? '').startsWith(runDir), 'ProgramData points at the run folder');
const realKey = process.env.FAKE_REAL_KEY_CHECK;
if (realKey) need(!Object.values(process.env).some((v) => v?.includes(realKey)), 'no real key in the environment');
for (const [name, server] of Object.entries(config?.mcp?.servers ?? {})) {
  need(server.environment?.HIVE_RUN_PASS === '', `${name} server blanks the pass`);
  need(server.codemode === false, `${name} server without Code Mode`);
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_OPENCODE_REPORT) {
    writeFileSync(
      process.env.FAKE_OPENCODE_REPORT,
      JSON.stringify({ args, cwd: process.cwd(), prompt: stdin, config, problems, env: { PWD: process.env.PWD, ProgramData: process.env.ProgramData } }),
    );
  }
  const out = (o) => process.stdout.write(`${JSON.stringify({ timestamp: 1, sessionID: 'ses_1', ...o })}\n`);
  if (problems.length) {
    out({ type: 'error', error: { type: 'fake-check', message: `fake-opencode: broken rules: ${problems.join('; ')}` } });
    process.exit(3);
  }
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'crash') {
    process.stderr.write('panic: something broke\n');
    process.exit(2);
  }
  out({ type: 'step_start', part: { type: 'step-start' } });
  if (mode === 'auth') {
    out({ type: 'error', error: { type: 'api', message: 'Unauthorized: invalid API key', status: 401 } });
    process.exit(1);
  }
  out({ type: 'tool_use', part: { id: 't1', tool: 'hive_write_file', state: { status: 'completed', input: { path: 'hello.txt' }, output: 'Wrote hello.txt' } } });
  let reply = 'Done.\nSTATUS: DONE';
  if (/"waves"/.test(stdin) && /Output contract/i.test(stdin)) {
    reply = `\`\`\`json\n${JSON.stringify({
      headline: 'Say hello',
      summary: 'Say hello.',
      waves: [{ cards: [{ id: 'C-01', title: 'Write hello.txt', brief: 'Write hello.txt.', caste: 'coder', priority: 'normal', acceptance: ['hello.txt exists'], dependsOn: [] }] }],
    })}\n\`\`\``;
  } else if (/VERDICT: PASS/.test(stdin)) {
    reply = 'Checked.\nVERDICT: PASS';
  }
  out({ type: 'text', part: { type: 'text', text: reply } });
  out({ type: 'step_finish', part: { type: 'step-finish', cost: 0, tokens: { input: 1200, output: 300, reasoning: 20, cache: { read: 400, write: 0 } } } });
  process.exit(0);
});
