export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ClaudeEvent =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | {
      kind: 'result';
      isError: boolean;
      subtype: string;
      result: string;
      sessionId: string;
      numTurns: number;
      durationMs: number;
      costUsd: number;
      usage: Usage;
      /** Models that actually ran, from the CLI's own accounting (Connections 04, "truth about models"). */
      models: string[];
    };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => s(obj(p)['text'])).join('');
  return '';
}

/** One line of `--output-format stream-json`. Unknown or malformed lines yield no events. */
export function parseStreamLine(line: string): ClaudeEvent[] {
  let m: Json;
  try {
    m = obj(JSON.parse(line));
  } catch {
    return [];
  }
  const type = s(m['type']);
  if (type === 'system' && m['subtype'] === 'init') {
    return [{ kind: 'init', sessionId: s(m['session_id']), model: s(m['model']) }];
  }
  if (type === 'assistant') {
    const blocks = Array.isArray(obj(m['message'])['content']) ? (obj(m['message'])['content'] as unknown[]) : [];
    return blocks.flatMap((b): ClaudeEvent[] => {
      const blk = obj(b);
      if (blk['type'] === 'text') return [{ kind: 'text', text: s(blk['text']) }];
      if (blk['type'] === 'tool_use') return [{ kind: 'tool_use', id: s(blk['id']), name: s(blk['name']), input: blk['input'] }];
      return [];
    });
  }
  if (type === 'user') {
    const blocks = Array.isArray(obj(m['message'])['content']) ? (obj(m['message'])['content'] as unknown[]) : [];
    return blocks.flatMap((b): ClaudeEvent[] => {
      const blk = obj(b);
      if (blk['type'] !== 'tool_result') return [];
      return [{ kind: 'tool_result', toolUseId: s(blk['tool_use_id']), isError: blk['is_error'] === true, content: contentText(blk['content']) }];
    });
  }
  if (type === 'result') {
    const u = obj(m['usage']);
    return [
      {
        kind: 'result',
        isError: m['is_error'] === true,
        subtype: s(m['subtype']),
        result: s(m['result']),
        sessionId: s(m['session_id']),
        numTurns: num(m['num_turns']),
        durationMs: num(m['duration_ms']),
        costUsd: num(m['total_cost_usd']),
        usage: {
          input: num(u['input_tokens']),
          output: num(u['output_tokens']),
          cacheRead: num(u['cache_read_input_tokens']),
          cacheWrite: num(u['cache_creation_input_tokens']),
        },
        models: Object.keys(obj(m['modelUsage'])),
      },
    ];
  }
  return [];
}
