import type { ClaudeEvent, Usage } from '../claude/stream';

/**
 * `opencode run --format json` (2.2.1, cli/src/run/noninteractive.ts): one JSON object per line,
 * `{type, timestamp, sessionID, …}`, of type step_start, text, reasoning, tool_use, step_finish or error.
 */
export type OpenCodeLine =
  | { kind: 'session'; sessionId: string }
  | { kind: 'event'; event: ClaudeEvent }
  | { kind: 'step'; costUsd: number; usage: Usage }
  | { kind: 'error'; message: string; status: number | null; type: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function parseOpenCodeLine(line: string): OpenCodeLine[] {
  if (!line.startsWith('{')) return [];
  let m: Record<string, unknown>;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  const out: OpenCodeLine[] = [];
  const sessionId = str(m['sessionID']);
  const part = obj(m['part']);
  switch (m['type']) {
    case 'step_start':
      if (sessionId) out.push({ kind: 'session', sessionId });
      break;
    case 'text': {
      const text = str(part['text']);
      if (text.trim()) out.push({ kind: 'event', event: { kind: 'text', text } });
      break;
    }
    case 'tool_use': {
      const state = obj(part['state']);
      const id = str(part['id']) || str(part['partID']);
      const name = str(part['tool']);
      out.push({ kind: 'event', event: { kind: 'tool_use', id, name, input: state['input'] } });
      const failed = state['status'] === 'error';
      const content = failed ? str(state['error']) || 'The tool failed.' : str(state['output']);
      out.push({ kind: 'event', event: { kind: 'tool_result', toolUseId: id, isError: failed, content } });
      break;
    }
    case 'step_finish': {
      const tokens = obj(part['tokens']);
      const cache = obj(tokens['cache']);
      out.push({
        kind: 'step',
        costUsd: num(part['cost']),
        usage: {
          // Reasoning tokens are billed as output.
          input: num(tokens['input']),
          output: num(tokens['output']) + num(tokens['reasoning']),
          cacheRead: num(cache['read']),
          cacheWrite: num(cache['write']),
        },
      });
      break;
    }
    case 'error': {
      const e = obj(m['error']);
      const data = obj(e['data']);
      const status = num(e['status']) || num(data['statusCode']) || null;
      out.push({ kind: 'error', message: str(e['message']) || str(data['message']) || 'OpenCode reported an error.', status, type: str(e['type']) || str(e['name']) });
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * Upper-bound estimate (USD per 1M tokens) when neither OpenCode nor the broker gives a cost: local
 * providers cost nothing; remote ones are priced like a mid-range hosted model so budgets keep working.
 */
export function estimateOpenCodeCost(usage: Usage, local: boolean): number {
  if (local) return 0;
  const usd = (usage.input * 1 + usage.output * 4 + usage.cacheRead * 0.25) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
