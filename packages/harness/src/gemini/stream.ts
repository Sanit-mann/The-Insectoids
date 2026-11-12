import type { ClaudeEvent, Usage } from '../claude/stream';

/**
 * Gemini CLI `-o stream-json` (verified in the 0.68.0 bundle). One JSON object per line:
 *   init {session_id, model} · message {role, content, delta?} · tool_use {tool_name, tool_id, parameters}
 *   tool_result {tool_id, status, output?, error?} · error {severity, message} · result {status, error?, stats}
 * stats: {total_tokens, input_tokens, output_tokens, cached, input, duration_ms, tool_calls, models{}}.
 * Gemini reports no cost. Events are mapped into the hive's engine event model (the Claude-shaped one).
 */
export type GeminiLine =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'delta'; text: string }
  | { kind: 'event'; event: ClaudeEvent }
  | { kind: 'error'; severity: string; message: string }
  | { kind: 'result'; ok: boolean; errorType: string; errorMessage: string; usage: Usage; durationMs: number; toolCalls: number; models: string[] };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseGeminiLine(line: string): GeminiLine[] {
  let m: Json;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  switch (s(m['type'])) {
    case 'init':
      return [{ kind: 'init', sessionId: s(m['session_id']), model: s(m['model']) }];
    case 'message':
      // The user's own prompt is echoed back; only the model's text matters.
      return m['role'] === 'assistant' ? [{ kind: 'delta', text: s(m['content']) }] : [];
    case 'tool_use':
      return [{ kind: 'event', event: { kind: 'tool_use', id: s(m['tool_id']), name: s(m['tool_name']), input: m['parameters'] } }];
    case 'tool_result': {
      const isError = m['status'] === 'error';
      const content = isError ? s(obj(m['error'])['message']) || s(m['output']) : s(m['output']);
      return [{ kind: 'event', event: { kind: 'tool_result', toolUseId: s(m['tool_id']), isError, content } }];
    }
    case 'error':
      return [{ kind: 'error', severity: s(m['severity']) || 'error', message: s(m['message']) }];
    case 'result': {
      const st = obj(m['stats']);
      const err = obj(m['error']);
      const inputTokens = num(st['input_tokens']);
      const cached = num(st['cached']);
      // `input` is the uncached part of the prompt; older shapes only have input_tokens (incl. cached).
      const uncached = typeof st['input'] === 'number' ? num(st['input']) : Math.max(0, inputTokens - cached);
      return [
        {
          kind: 'result',
          ok: m['status'] === 'success',
          errorType: s(err['type']),
          errorMessage: s(err['message']),
          usage: { input: uncached, output: num(st['output_tokens']), cacheRead: cached, cacheWrite: 0 },
          durationMs: num(st['duration_ms']),
          toolCalls: num(st['tool_calls']),
          models: Object.keys(obj(st['models'])),
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Gemini reports tokens but no cost. The hive estimates it from list prices (USD per 1M tokens) so budgets
 * still work; the UI calls it "estimated". With a Google plan the real cost per run may be nothing, but the
 * estimate keeps engines comparable for the Treasurer.
 */
const PRICES: Array<{ match: RegExp; input: number; output: number; cached: number }> = [
  { match: /gemma/i, input: 0, output: 0, cached: 0 },
  { match: /flash-lite/i, input: 0.1, output: 0.4, cached: 0.025 },
  { match: /flash/i, input: 0.3, output: 2.5, cached: 0.075 },
  { match: /2\.5-pro/i, input: 1.25, output: 10, cached: 0.31 },
  { match: /pro/i, input: 2, output: 12, cached: 0.2 },
];
const FALLBACK = PRICES[2]!;

export function estimateGeminiCost(models: readonly string[], usage: Usage): number {
  // A run can touch helper models; price everything at the dearest one that ran (a safe upper estimate).
  const prices = models.length ? models.map((m) => PRICES.find((p) => p.match.test(m)) ?? FALLBACK) : [FALLBACK];
  const p = prices.reduce((a, b) => (b.output > a.output ? b : a));
  const usd = (usage.input * p.input + usage.output * p.output + usage.cacheRead * p.cached) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}
