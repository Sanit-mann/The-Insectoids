// A stand-in for the Claude Code CLI, used only in tests.
// It speaks the same headless protocol (-p, --output-format stream-json) and runs the
// PreToolUse hook from --settings exactly like Claude Code would, so the real guard is exercised.
//
// The prompt on stdin is a tiny script:
//   SAY <text>            reply with text
//   TOOL <Name> <json>    try a tool call (the hook decides)
//   HANG                  never finish
//   AUTHFAIL              behave like a signed-out CLI
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv.includes('--version')) {
  process.stdout.write('2.1.300 (Claude Code)\n');
  process.exit(0);
}

const model = flag('--model') ?? 'claude-sonnet-fake';
const effort = flag('--effort') ?? 'default';
const settings = JSON.parse(flag('--settings') ?? '{}');
const sessionId = '00000000-0000-4000-8000-000000000001';
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd(), tools: ['Bash', 'Read', 'Write'], effort });
  process.stdout.write('not json noise\n');
  const usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 };

  for (const line of input.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line === 'HANG') {
      setInterval(() => {}, 1000);
      return;
    }
    if (line === 'AUTHFAIL') {
      emit({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: sessionId, num_turns: 0, duration_ms: 5, total_cost_usd: 0, usage: {} });
      process.exit(1);
    }
    if (line.startsWith('SAY ')) {
      emit({ type: 'assistant', message: { model, content: [{ type: 'text', text: line.slice(4) }], usage } });
    }
    if (line.startsWith('TOOL ')) {
      const [, name, ...rest] = line.split(' ');
      const toolInput = JSON.parse(rest.join(' '));
      const id = `toolu_${Math.random().toString(36).slice(2)}`;
      emit({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id, name, input: toolInput }], usage } });
      let denied = false;
      let reason = '';
      for (const group of settings.hooks?.PreToolUse ?? []) {
        for (const h of group.hooks ?? []) {
          const r = spawnSync(h.command, h.args ?? [], {
            input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput, session_id: sessionId, cwd: process.cwd() }),
            encoding: 'utf8',
          });
          if (r.status === 2) {
            denied = true;
            reason = r.stderr;
          } else if (r.status === 0 && r.stdout.trim()) {
            const out = JSON.parse(r.stdout).hookSpecificOutput ?? {};
            if (out.permissionDecision === 'deny') {
              denied = true;
              reason = out.permissionDecisionReason;
            }
          } else if (h.onFailure === 'block') {
            denied = true;
            reason = 'hook failed';
          }
        }
      }
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: denied, content: denied ? reason : 'ok' }] } });
    }
  }
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Finished.',
    session_id: sessionId,
    num_turns: 2,
    duration_ms: 42,
    total_cost_usd: 0.0123,
    usage,
    modelUsage: { [model]: { inputTokens: 120, outputTokens: 30 } },
  });
});
