import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeEvent } from '../claude/stream';
import { type EngineRequest, FakeEngine, type FakeReply } from './engine';

/**
 * The scripted demo engine (INSECTOIDS_ENGINE=fake): a full goal with no AI calls and no tokens.
 * End-to-end tests and demos rely on exactly this script:
 * - The Queen plans "Say hello" in 2 waves (so the plan needs approval, Hive 02-D11):
 *   wave 1: C-01 "Write hello.txt" (coder), C-02 "Check hello.txt" (tester, depends on C-01);
 *   wave 2: C-03 "Write README note" (coder).
 * - Each insect writes `<card id>.txt` (C-01.txt, C-02.txt, C-03.txt) in its worktree and ends with STATUS: DONE.
 * - The Inspector always passes (with `inspectorFailsFirst`, it fails C-01's first attempt once: a lesson, B3).
 * - The Librarian's review proposes confirming the first lesson its summary lists as waiting, if any.
 * After the last wave the merge into main waits for approval.
 */
export const DEMO_PLAN = {
  summary: 'Say hello',
  waves: [
    {
      cards: [
        { id: 'C-01', title: 'Write hello.txt', brief: 'Create hello.txt with a friendly greeting.', caste: 'coder', priority: 'normal', acceptance: ['hello.txt exists and greets the reader'], dependsOn: [] },
        { id: 'C-02', title: 'Check hello.txt', brief: 'Check that hello.txt greets the reader.', caste: 'tester', priority: 'normal', acceptance: ['The greeting is checked'], dependsOn: ['C-01'] },
      ],
    },
    {
      cards: [{ id: 'C-03', title: 'Write README note', brief: 'Add a short note about hello.txt.', caste: 'coder', priority: 'low', acceptance: ['The note exists'], dependsOn: [] }],
    },
  ],
} as const;

export interface DemoTiming {
  queenMs: number;
  insectMs: number;
  inspectorMs: number;
  /** e2e (B3): the Inspector fails C-01's first attempt once, so the hive retries it and learns a lesson. */
  inspectorFailsFirst?: boolean;
}

const cardOf = (req: EngineRequest): string => /# (?:Verify card|Card) (C-\d+)/.exec(req.task)?.[1] ?? 'C-00';

/** The demo Librarian: proposes confirming the first lesson its summary lists as waiting; nothing else. */
function demoLibrarianReply(task: string): string {
  const waiting = task.split('## Lessons waiting for the user')[1] ?? '';
  const id = /^- (\S+) \[lesson/m.exec(waiting)?.[1];
  const proposals = id ? [{ type: 'confirm', id, reason: 'It explains a real failure and still applies.' }] : [];
  return `I read the audit.\n\`\`\`json\n${JSON.stringify({ proposals })}\n\`\`\``;
}

export function demoEngine(timing: Partial<DemoTiming> = {}): FakeEngine {
  const t: DemoTiming = { queenMs: 400, insectMs: 600, inspectorMs: 300, ...timing };
  let failedOnce = false;
  return new FakeEngine((req): FakeReply => {
    const init: ClaudeEvent = { kind: 'init', sessionId: `demo-${req.agentId}`, model: req.route.model };
    if (req.role === 'queen') {
      return {
        delayMs: t.queenMs,
        tokens: 4_000,
        costUsd: 0.01,
        events: [init, { kind: 'text', text: 'Reading the goal and the project files.' }, { kind: 'text', text: 'Plan: 2 waves, 3 cards.' }],
        text: `Here is the plan.\n\`\`\`json\n${JSON.stringify(DEMO_PLAN)}\n\`\`\``,
      };
    }
    if (req.role === 'librarian') {
      return { delayMs: t.inspectorMs, tokens: 1_200, events: [init, { kind: 'text', text: 'Reading the Brain audit.' }], text: demoLibrarianReply(req.task) };
    }
    const id = cardOf(req);
    if (req.role === 'inspector' && t.inspectorFailsFirst && id === 'C-01' && !failedOnce) {
      failedOnce = true;
      return {
        delayMs: t.inspectorMs,
        tokens: 1_500,
        events: [init, { kind: 'text', text: `Checking ${id} against its "done means".` }],
        text: `${id} is not done yet.\nVERDICT: FAIL: hello.txt has no greeting. It only holds a placeholder.`,
      };
    }
    if (req.role === 'inspector') {
      return {
        delayMs: t.inspectorMs,
        tokens: 1_500,
        events: [init, { kind: 'text', text: `Checking ${id} against its "done means".` }],
        text: `${id} meets every criterion.\nVERDICT: PASS`,
      };
    }
    const file = `${id}.txt`;
    return {
      delayMs: t.insectMs,
      tokens: 2_500,
      costUsd: 0.004,
      effects: (cwd) => writeFileSync(join(cwd, file), `Hello from ${req.agentId} (${id}).\n`),
      events: [
        init,
        { kind: 'text', text: `Working on ${id}.` },
        { kind: 'tool_use', id: `t-${id}`, name: 'Write', input: { file_path: file } },
        { kind: 'tool_result', toolUseId: `t-${id}`, isError: false, content: `Wrote ${file}` },
        { kind: 'text', text: 'Done.' },
      ],
      text: `Wrote ${file}.\nSTATUS: DONE`,
    };
  });
}
