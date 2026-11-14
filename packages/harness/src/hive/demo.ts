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

/**
 * A goal that mentions "welcome docs" (e.g. "Write the welcome docs") gets a one-wave plan across three castes
 * (Phase 2 C1, 03-D3): C-01 coder, C-02 tester and C-03 documenter (both depend on C-01). One wave, so it
 * starts without plan approval (unless every plan waits); the Queen adds a library skill to two cards.
 */
export const DEMO_TEAM_GOAL = /welcome docs/i;
export const DEMO_TEAM_PLAN = {
  headline: 'Write the welcome docs with three castes',
  summary: 'A coder writes welcome.txt, a tester checks it, and a documenter documents it.',
  waves: [
    {
      cards: [
        { id: 'C-01', title: 'Write welcome.txt', brief: 'Create welcome.txt with a short welcome.', caste: 'coder', priority: 'normal', acceptance: ['welcome.txt exists'], dependsOn: [], skills: ['surgical-patch'] },
        { id: 'C-02', title: 'Check welcome.txt', brief: 'Check that welcome.txt welcomes the reader.', caste: 'tester', priority: 'normal', acceptance: ['The welcome is checked'], dependsOn: ['C-01'] },
        { id: 'C-03', title: 'Document welcome.txt', brief: 'Add a short note to the docs about welcome.txt.', caste: 'documenter', priority: 'low', acceptance: ['The note exists'], dependsOn: ['C-01'], skills: ['writing-guidelines'] },
      ],
    },
  ],
} as const;

/**
 * Phase 2 C2, the managers' brain side (one coder card each, one wave, so no plan approval):
 * - "Loop on purpose": the first attempt repeats one tool call, so the Watchdog warns and then holds the card;
 *   the Foreman gives it one more try with a note; the second attempt passes.
 * - "Fail on purpose": the Inspector fails every attempt; the Foreman sends the card to the Queen (goal stuck).
 * - A goal of 6+ words with the Scout on and the code map ready gets a Scout survey before the Queen plans.
 * - The Foreman's periodic review reports the numbers it was given.
 */
export const DEMO_LOOP_GOAL = /loop on purpose/i;
export const DEMO_FAIL_GOAL = /fail on purpose/i;
const oneCardPlan = (title: string, headline: string) => ({
  headline,
  summary: headline,
  waves: [{ cards: [{ id: 'C-01', title, brief: `Create C-01.txt. (${headline})`, caste: 'coder', priority: 'normal', acceptance: ['C-01.txt exists'], dependsOn: [] }] }],
});
export const DEMO_LOOP_PLAN = oneCardPlan('Loop on purpose', 'A card whose first insect loops, to show the Watchdog and the Foreman');
/** Phase 2 C5: onboarding's sample goal on the practice project (08-D8) plans one small card, no approval needed. */
export const DEMO_SAMPLE_GOAL = /farewell function/i;
export const DEMO_SAMPLE_PLAN = oneCardPlan('Add a farewell function', 'One small card on the practice project');
export const DEMO_FAIL_PLAN = oneCardPlan('Fail on purpose', 'A card the Inspector never passes, to show the Foreman sending it to the Queen');

/**
 * Phase 2 C3, self-learning skills (03-D6): a goal that mentions "greeting pages" (e.g. "Add three greeting
 * pages") gets one wave of three similar coder cards. Once all three pass, the hive sees repeated work and the
 * Librarian drafts the skill below; it waits as a draft in the Library with an approval.
 */
export const DEMO_SKILL_GOAL = /greeting pages/i;
const greetingCard = (id: string, who: string) => ({
  id,
  title: `Add a greeting page for ${who}`,
  brief: `Create greeting-${who.toLowerCase()}.txt: a friendly greeting page for ${who}.`,
  caste: 'coder',
  priority: 'normal',
  acceptance: [`greeting-${who.toLowerCase()}.txt greets ${who}`],
  dependsOn: [],
});
export const DEMO_SKILL_PLAN = {
  headline: 'Add three greeting pages',
  summary: 'Three coders each write one friendly greeting page.',
  waves: [{ cards: [greetingCard('C-01', 'Ada'), greetingCard('C-02', 'Grace'), greetingCard('C-03', 'Linus')] }],
};
export const DEMO_LEARNED_SKILL = `---
name: greeting-pages
description: Write a short, friendly greeting page for one person. Use when a card asks for a greeting page or a welcome note for someone.
metadata:
  kind: skill
  castes: [coder]
  version: 1
  status: draft
  sources:
    - repo: the-insectoids/learned
      path: cards
---

# Greeting pages

## When to use

A card asks for a greeting page (or a welcome note) for one named person.

## Steps

1. Name the file after the person, in lowercase: greeting-<name>.txt.
2. Greet them by name in the first line, in a friendly tone.
3. Keep it to two or three short lines; no links.

## Done means

The file exists, greets the person by name, and nothing else changed.
`;

const fenced = (intro: string, value: unknown): string => `${intro}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** The demo Foreman: sends "Fail on purpose" to the Queen; gives anything else one more try with a note. */
function demoForemanReply(task: string): string {
  if (task.startsWith('# Board since the last review')) {
    const finished = /Cards finished since the last review: (\d+)/.exec(task)?.[1] ?? '0';
    const incidents = /Watchdog incidents: (\d+)/.exec(task)?.[1] ?? '0';
    const report = `${finished} card${finished === '1' ? '' : 's'} finished, ${incidents} incident${incidents === '1' ? '' : 's'} since the last review. Nothing needs changing.`;
    return fenced('Reviewed the board.', { report });
  }
  const decision = /# Stuck card \S+: Fail on purpose/.test(task)
    ? { action: 'to-queen', reason: 'The Inspector rejected it on every attempt for the same reason; the card needs re-planning.' }
    : { action: 'retry-with-note', reason: 'The insect repeated one command instead of reading its error.', note: 'Run the command once, read the output, then write C-01.txt.' };
  return fenced('Decided.', decision);
}

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
    const goal = /^# Goal\r?\n(.*)$/m.exec(req.task)?.[1] ?? '';
    if (req.role === 'queen' && (DEMO_LOOP_GOAL.test(goal) || DEMO_FAIL_GOAL.test(goal) || DEMO_SAMPLE_GOAL.test(goal))) {
      const plan = DEMO_LOOP_GOAL.test(goal) ? DEMO_LOOP_PLAN : DEMO_FAIL_GOAL.test(goal) ? DEMO_FAIL_PLAN : DEMO_SAMPLE_PLAN;
      return { delayMs: t.queenMs, tokens: 3_000, costUsd: 0.01, events: [init, { kind: 'text', text: 'Plan: 1 wave, 1 card.' }], text: fenced('Here is the plan.', plan) };
    }
    if (req.role === 'scout') {
      return {
        delayMs: t.inspectorMs,
        tokens: 1_200,
        events: [init, { kind: 'text', text: 'Reading the code map outline.' }],
        text: 'area: the project root  question: where the greeting belongs\nkey files: see the outline (high)\nrisks: none found\ngaps: no source files were opened',
      };
    }
    if (req.role === 'foreman') {
      return { delayMs: t.inspectorMs, tokens: 900, events: [init, { kind: 'text', text: 'Reading the stuck card.' }], text: demoForemanReply(req.task) };
    }
    if (req.role === 'queen' && DEMO_SKILL_GOAL.test(goal)) {
      return { delayMs: t.queenMs, tokens: 3_000, costUsd: 0.01, events: [init, { kind: 'text', text: 'Plan: 1 wave, 3 cards.' }], text: fenced('Here is the plan.', DEMO_SKILL_PLAN) };
    }
    if (req.role === 'librarian' && req.task.startsWith('# Draft a skill')) {
      return { delayMs: t.inspectorMs, tokens: 1_400, events: [init, { kind: 'text', text: 'Reading the repeated cards.' }], text: `Here is the draft.\n\`\`\`markdown\n${DEMO_LEARNED_SKILL}\`\`\`` };
    }
    if (req.role === 'queen' && DEMO_TEAM_GOAL.test(goal)) {
      return {
        delayMs: t.queenMs,
        tokens: 4_000,
        costUsd: 0.01,
        events: [init, { kind: 'text', text: 'Reading the goal and the project files.' }, { kind: 'text', text: 'Plan: 1 wave, 3 cards, 3 castes.' }],
        text: `Here is the plan.\n\`\`\`json\n${JSON.stringify(DEMO_TEAM_PLAN)}\n\`\`\``,
      };
    }
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
    if (req.role === 'inspector' && /^# Verify card \S+: Fail on purpose/m.test(req.task)) {
      return {
        delayMs: t.inspectorMs,
        tokens: 1_500,
        events: [init, { kind: 'text', text: `Checking ${id} against its "done means".` }],
        text: `${id} is not done.\nVERDICT: FAIL: C-01.txt only holds a placeholder, not the work the card asks for.`,
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
    if (/^# Card \S+: Loop on purpose/m.test(req.task) && !/This is attempt \d+/.test(req.task)) {
      // The first attempt keeps running the same command: the Watchdog warns at 5 and holds the card at 10.
      const call = (n: number): ClaudeEvent => ({ kind: 'tool_use', id: `loop-${n}`, name: 'Bash', input: { command: 'npm test' } });
      return {
        delayMs: 50,
        eventGapMs: 40,
        tokens: 2_500,
        events: [init, { kind: 'text', text: 'Running the tests.' }, ...Array.from({ length: 14 }, (_, n) => call(n))],
        text: 'Still running the tests.\nSTATUS: DONE',
      };
    }
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
