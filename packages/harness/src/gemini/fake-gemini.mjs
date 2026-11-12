// A stand-in for Gemini CLI's headless mode in tests: no AI calls, no quota.
// It records what the hive gave it (args, run settings, admin policy, environment, prompt) to
// FAKE_GEMINI_REPORT and replies with recorded `-o stream-json` lines (Gemini CLI 0.68.0 shapes).
// FAKE_GEMINI_MODE: ok (default) | turns (exit 53) | auth (exit 41) | hang (never ends) | garbage
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = process.env.FAKE_GEMINI_MODE ?? 'ok';
const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
const policyPath = flag('--admin-policy');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_GEMINI_REPORT) {
    writeFileSync(
      process.env.FAKE_GEMINI_REPORT,
      JSON.stringify({
        args,
        cwd: process.cwd(),
        prompt: stdin,
        settings: settingsPath && existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null,
        policy: policyPath && existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : null,
        env: {
          ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
          INSECTOIDS_GUARD: process.env.INSECTOIDS_GUARD ?? null,
          INSECTOIDS_BRAIN_TOKEN: process.env.INSECTOIDS_BRAIN_TOKEN ?? null,
          GEMINI_CLI_NO_RELAUNCH: process.env.GEMINI_CLI_NO_RELAUNCH ?? null,
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath ?? null,
        },
      }),
    );
  }
  const out = (o) => process.stdout.write(`${JSON.stringify({ timestamp: '2026-11-12T00:00:00.000Z', ...o })}\n`);
  if (mode === 'hang') return setInterval(() => {}, 1000);
  if (mode === 'garbage') {
    process.stdout.write('not json\n');
    process.exit(1);
  }
  if (mode === 'auth') {
    process.stderr.write('Error: Please run "gemini" and Login with Google first.\n');
    process.exit(41);
  }
  const model = flag('-m') ?? 'auto';
  out({ type: 'init', session_id: 'sess-1', model: model === 'flash-lite' ? 'gemini-3.1-flash-lite' : model });
  out({ type: 'message', role: 'user', content: stdin });
  out({ type: 'message', role: 'assistant', content: 'Working ', delta: true });
  out({ type: 'message', role: 'assistant', content: 'on it.', delta: true });
  out({ type: 'tool_use', tool_name: 'mcp_hive_write_file', tool_id: 't1', parameters: { path: 'hello.txt', content: 'hi' } });
  out({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'Wrote hello.txt' });
  out({ type: 'tool_use', tool_name: 'write_file', tool_id: 't2', parameters: { file_path: 'x.txt' } });
  out({ type: 'tool_result', tool_id: 't2', status: 'error', error: { type: 'policy', message: 'Denied by policy.' } });
  if (mode === 'turns') {
    out({ type: 'result', status: 'error', error: { type: 'FatalTurnLimitedError', message: 'Reached max session turns.' }, stats: { total_tokens: 10, input_tokens: 8, output_tokens: 2, cached: 0, input: 8, duration_ms: 5, tool_calls: 2, models: {} } });
    process.exit(53);
  }
  out({ type: 'message', role: 'assistant', content: 'Done.\nSTATUS: DONE', delta: true });
  out({
    type: 'result',
    status: 'success',
    stats: {
      total_tokens: 3500,
      input_tokens: 3000,
      output_tokens: 500,
      cached: 1000,
      input: 2000,
      duration_ms: 1234,
      tool_calls: 2,
      models: { 'gemini-3.1-flash-lite': { total_tokens: 3500, input_tokens: 3000, output_tokens: 500, cached: 1000, input: 2000 } },
    },
  });
  process.exit(0);
});
