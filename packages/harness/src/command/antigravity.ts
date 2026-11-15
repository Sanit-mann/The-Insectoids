import type { CommandEvent, CommandPreset } from './preset';

/**
 * Google Antigravity CLI (`agy`, Gemini CLI's successor; Phase 4 B4): listed with its real install and
 * sign-in, never run. Checked from the docs only, on 2026-11-15, NOT run (no `agy` on this PC):
 * antigravity.google/docs/cli/reference.md, /docs/cli/headless.md, /docs/permissions.md, /docs/install.md,
 * /docs/sandbox.md (docs/research/engine-clis.md, section 9).
 *
 * Why it can't be guarded yet:
 * - Its tool rules (permissions.deny such as write_file(*) and command(*)) live only in the user's own
 *   ~/.gemini/antigravity-cli/settings.json, and its MCP servers only in the global mcp_config.json or the
 *   workspace's .agents/mcp_config.json. No flag or variable gives either for one run, so the hive would
 *   have to change the user's own files.
 * - Headless, a tool call it can't get approval for is "soft-denied": the run goes on and still exits 0, with
 *   a notice only on stderr.
 * It waits for container mode.
 *
 * The stream-json output is documented (events init, step_update, result with usage), so the parser below
 * follows the docs; it has never seen a real line. Unknown in the docs: a version flag and its output
 * (`--version` assumed), whether input_tokens include cache_read_tokens (taken as included, as in the Gemini
 * API), the exact form of `error`, model names per plan, telemetry beyond the account setting.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const AUTH = /authentication required|unauthenticated|unauthori[sz]ed|\b401\b|sign in|log ?in/i;
const QUOTA = /quota|rate.?limit|resource.?exhausted|\b429\b|too many requests|usage limit/i;

/** `error` is documented only as present on failures: a message string, or an object with type and message. */
const errorText = (e: unknown): string | undefined => str(e) ?? (str(obj(e)?.['message']) || str(obj(e)?.['type']));

/** One line of `agy -p ... --output-format stream-json`: {"event": name, <name>: {...}}. */
export function parseAntigravityLine(line: string): CommandEvent[] {
  let m: Json | null;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  if (!m) return [];
  switch (m['event']) {
    case 'step_update': {
      // Steps update while ACTIVE and once DONE: a tool step counts once, when it is done.
      const s = obj(m['step_update']);
      if (!s || s['step_type'] !== 'tool' || s['state'] !== 'DONE') return [];
      const info = obj(s['tool_info']);
      const name = str(s['tool_name']) ?? str(info?.['name']) ?? 'tool';
      const step = s['step_index'];
      return [{ kind: 'tool', name, ...(typeof step === 'number' ? { id: `step-${step}` } : {}), input: info?.['parameters'] }];
    }
    case 'result': {
      const r = obj(m['result']);
      if (!r) return [];
      const out: CommandEvent[] = [];
      const ok = r['status'] === 'SUCCESS';
      const text = str(r['response']);
      if (text) out.push({ kind: 'text', text });
      const u = obj(r['usage']);
      if (u) {
        const cached = num(u['cache_read_tokens']);
        // Thinking tokens are billed as output.
        out.push({ kind: 'usage', usage: { input: Math.max(0, num(u['input_tokens']) - cached), output: num(u['output_tokens']) + num(u['thinking_tokens']), cacheRead: cached, cacheWrite: 0 } });
      }
      const message = ok ? undefined : (errorText(r['error']) ?? `Antigravity stopped with status ${str(r['status']) ?? 'unknown'}.`);
      if (message) out.push({ kind: 'error', message, ...(AUTH.test(message) ? { auth: true } : {}), ...(QUOTA.test(message) ? { quota: true } : {}) });
      out.push({
        kind: 'final',
        ok,
        ...(text ? { text } : {}),
        ...(str(r['conversation_id']) ? { sessionId: str(r['conversation_id'])! } : {}),
        ...(typeof r['num_turns'] === 'number' ? { numTurns: r['num_turns'] } : {}),
        ...(message ? { errorMessage: message } : {}),
      });
      return out;
    }
    default:
      return [];
  }
}

export const ANTIGRAVITY_PRESET: CommandPreset = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  vendor: 'Google',
  executable: 'agy',
  // Not documented: `--version` is the usual convention; the current version isn't published.
  version: { args: ['--version'], pattern: /(\d+\.\d+\.\d+)/, minimum: '0.0.0' },
  install: { command: 'irm https://antigravity.google/cli/install.ps1 | iex', note: "Google's official installer (PowerShell; no licence stated, Google's terms apply). Needs a Google account (Free, Pro or Ultra plan) or a Gemini API key." },
  signIn: { command: 'agy', note: 'Its first start opens your browser to sign in with Google; headless runs need that sign-in first. The hive never sees your login.' },
  privacyNote: 'Antigravity sends your prompts and the code it reads to Google. Its telemetry choice is saved with your account (in its own /config).',
  prompt: { via: 'arg', flag: '-p' },
  headlessArgs: ['--output-format', 'stream-json', '--disable-slash-commands'],
  // Model slugs per plan aren't documented (`agy models` lists them): the account's default for every tier.
  model: null,
  effort: { flag: '--effort', values: { low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  output: { format: 'jsonl', parse: parseAntigravityLine },
  guard: null,
  unguardedWhy: 'Its tool rules and MCP servers can only be set in your own global settings files, not for one run, and a refused tool call still ends as a success.',
  forbiddenArgs: ['--dangerously-skip-permissions', '--mode', '--add-dir', '--remote-agent', '--remote-control', '--project', '--new-project'],
  reportsCost: false,
  subscription: true,
  authHint: /authentication required/i,
  tested: false,
};
