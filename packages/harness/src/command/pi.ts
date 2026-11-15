import type { CommandEvent, CommandPreset } from './preset';

/**
 * Pi, the coding agent from earendil-works/pi (formerly badlogic/pi-mono) (Phase 4 B4): listed with its
 * real install, never run. Written from Pi's docs on 2026-11-15 (packages/coding-agent/docs: cli, mcp,
 * json, message-types, configuration, environment-variables; docs for npm 1.5.2, install pinned to 1.4.0 by the 14-day rule) and docs/research/engine-clis.md
 * §8. NOT run.
 *
 * Why it can't be guarded here:
 * - Its own tools can be switched off for one run by flags (`--tools` allowlist, `--no-tools`,
 *   `--no-extensions`), but Pi has no permission system at all, and the hive's MCP servers can't be given
 *   to one run: MCP servers come only from mcp.json in its agent folder or a trusted project's .pi/mcp.json
 *   (no flag or variable names another file).
 * - Giving one run its own agent folder (PI_CODING_AGENT_DIR) would also move auth.json, where Pi keeps
 *   its API keys and OAuth sign-ins, and the hive never copies or handles credentials.
 * A read-only run without the hive tools (`--tools read,grep,find,ls --no-extensions --no-mcp`) would be
 * possible by flags alone, but without the Brain or the hive tools. It waits for container mode.
 *
 * `--mode json` events are documented, so the parser below is ready for when it can run.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const AUTH = /\b401\b|unauthori[sz]ed|no api key|api key (?:is )?(?:missing|invalid)|not (?:logged|signed) in|\/login\b/i;
const QUOTA = /\b429\b|rate.?limit|quota|too many requests|usage limit/i;

const failure = (message: string): CommandEvent => ({ kind: 'error', message, ...(AUTH.test(message) ? { auth: true } : {}), ...(QUOTA.test(message) ? { quota: true } : {}) });

/**
 * One line of `pi --mode json`. The assistant's `message_end` is the final word on each message (its text,
 * model, usage and stop reason); the last one decides the outcome, unless the run was aborted.
 */
export function parsePiLine(line: string): CommandEvent[] {
  let m: Json | null;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  if (!m) return [];
  switch (m['type']) {
    case 'message_end': {
      const msg = obj(m['message']);
      if (msg?.['role'] !== 'assistant') return [];
      const out: CommandEvent[] = [];
      const content = Array.isArray(msg['content']) ? msg['content'] : [];
      const text = content
        .map((b) => obj(b))
        .filter((b): b is Json => b?.['type'] === 'text' && typeof b['text'] === 'string')
        .map((b) => b['text'] as string)
        .join('');
      if (text) out.push({ kind: 'text', text });
      const u = obj(msg['usage']);
      const model = str(msg['model']);
      if (u || model) {
        const cost = num(obj(u?.['cost'])?.['total']);
        out.push({
          kind: 'usage',
          usage: { input: num(u?.['input']), output: num(u?.['output']), cacheRead: num(u?.['cacheRead']), cacheWrite: num(u?.['cacheWrite']) },
          ...(model ? { model } : {}),
          ...(cost > 0 ? { costUsd: cost } : {}),
        });
      }
      const stop = str(msg['stopReason']);
      if (stop === 'error' || stop === 'aborted') {
        const message = str(msg['errorMessage']) ?? (stop === 'aborted' ? 'Pi stopped the run.' : 'Pi reported an error.');
        out.push(failure(message), { kind: 'final', ok: false, errorMessage: message, ...(model ? { model } : {}) });
      } else {
        out.push({ kind: 'final', ok: true, ...(text ? { text } : {}), ...(model ? { model } : {}) });
      }
      return out;
    }
    case 'tool_execution_start':
      return [{ kind: 'tool', name: str(m['toolName']) ?? 'tool', ...(str(m['toolCallId']) ? { id: str(m['toolCallId'])! } : {}), input: m['args'] }];
    case 'auto_retry_end':
      return m['success'] === false ? [failure(str(m['finalError']) ?? 'Pi gave up after retrying.')] : [];
    case 'agent_settled':
      return m['aborted'] === true ? [{ kind: 'final', ok: false, errorMessage: 'Pi stopped the run.' }] : [];
    default:
      return [];
  }
}

export const PI_PRESET: CommandPreset = {
  id: 'pi',
  name: 'Pi',
  vendor: 'Earendil (pi)',
  executable: 'pi',
  version: { args: ['--version'], pattern: /(\d+\.\d+\.\d+)/, minimum: '1.4.0' },
  install: {
    command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0',
    note: 'The official package (MIT). Needs Node.js 22.19 or newer and a sign-in or API key for one of its model providers.',
  },
  signIn: { command: 'pi', note: 'Start Pi in a terminal and type /login to choose a provider. The hive never sees your login.' },
  privacyNote: 'Pi sends your prompts and the code it reads to the model provider you choose.',
  // Piped stdin is only documented as added to a prompt; the prompt itself is the last argument.
  prompt: { via: 'arg', flag: null },
  headlessArgs: ['--mode', 'json', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve'],
  model: null,
  effort: { flag: '--thinking', values: { low: 'low', medium: 'medium', high: 'high' } },
  output: { format: 'jsonl', parse: parsePiLine },
  guard: null,
  unguardedWhy:
    'It has no permission system, and the hive’s tools can’t be loaded for one run without giving it its own agent folder, which would also move its sign-in (auth.json), which the hive never copies.',
  forbiddenArgs: [
    '--approve', '-a', '--extension', '-e', '--api-key', '--skill', '--prompt-template', '--continue', '-c', '--resume', '-r',
    '--session', '--fork',
  ],
  // Its usage carries a cost, but the docs don't say in which unit.
  reportsCost: false,
  // Pi itself has no plan; it runs on whichever provider (API key or provider sign-in) the user chose.
  subscription: false,
  authHint: AUTH,
  scrubEnv: ['PI_SELF_UPDATE_COMMAND'],
  tested: false,
};
