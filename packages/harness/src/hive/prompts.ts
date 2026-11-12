import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caste } from '@insectoids/shared';
import { MAX_CARDS_PER_WAVE, MAX_WAVES } from './protocol';

/** Skills each role carries by default in Phase 1 (Capabilities 03-D8: at most ~5 active). */
export const ROLE_SKILLS: Record<'queen' | 'inspector' | Caste, string[]> = {
  queen: ['writing-plans'],
  inspector: ['verification-before-completion'],
  coder: ['executing-a-task-card', 'coding-discipline'],
  tester: ['executing-a-task-card', 'test-driven-development'],
  reviewer: ['executing-a-task-card', 'code-review'],
  researcher: ['executing-a-task-card', 'deep-research'],
  documenter: ['executing-a-task-card', 'technical-writing'],
  designer: ['executing-a-task-card', 'web-design-guidelines'],
  analyst: ['executing-a-task-card'],
  writer: ['executing-a-task-card', 'writing-guidelines'],
};

const stripFrontmatter = (md: string): string => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

export class Library {
  constructor(private readonly dir: string) {}

  agent(name: string): string {
    return stripFrontmatter(readFileSync(join(this.dir, 'agents', name, 'AGENT.md'), 'utf8'));
  }

  skill(name: string): string {
    return stripFrontmatter(readFileSync(join(this.dir, 'skills', name, 'SKILL.md'), 'utf8'));
  }

  role(role: keyof typeof ROLE_SKILLS): string {
    const parts = [this.agent(role), ...ROLE_SKILLS[role].map((s) => `## Skill: ${s}\n\n${this.skill(s)}`)];
    return parts.join('\n\n---\n\n');
  }
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const HIVE_RULES = `## Hive rules for this run
- You are one agent in The Insectoids hive. You never talk to the user; only the Queen does.
- Work only inside the current folder (your card's workspace). Never push, publish, or install new dependencies yourself.
- Don't commit, merge or switch branches: leave your changes uncommitted. The hive commits them for you when you finish,
  with your name and the card on the commit.
- A safety guard checks every tool call. If it says something needs the user's approval, do not retry or work around it:
  stop and end with "STATUS: BLOCKED: <what you need and why>".
- Keep your messages compact: facts, file paths, commands and results.`;

/** Added to every brief when the run has live Brain access. */
export function brainRules(write: boolean): string {
  return [
    '## The Brain',
    '- The hive shares one Brain: the long-term memory for this project. Use the `brain` MCP tools (or the `brain` command in a shell if they are missing).',
    '- Search it before guessing at project conventions, earlier decisions or why something is the way it is.',
    write
      ? '- Record what the next agent should know: short, specific facts, proposed decisions and outcomes. Never secrets. Facts and decisions you write wait for the user to confirm them.'
      : '- Your Brain access is read-only in this run.',
  ].join('\n');
}

export interface PromptPair {
  /** Appended to the engine's own system prompt (via a file). */
  system: string;
  /** The task itself (sent on stdin). */
  task: string;
}

export function queenPrompt(lib: Library, o: { goal: string; bootCard: string; context: string; castes: readonly Caste[]; projectListing: string }): PromptPair {
  const system = [
    lib.role('queen'),
    HIVE_RULES.replace('You never talk to the user; only the Queen does.', 'You are the Queen. In this run you only plan; you do not edit files.'),
    `## Output contract
Reply with your plan as ONE fenced \`\`\`json block, exactly this shape:
{"summary": "<one paragraph>", "waves": [{"cards": [{"id": "C-01", "title": "...", "brief": "what to change and why, with file paths", "caste": "<one of: ${o.castes.join(', ')}>", "priority": "critical|high|normal|low", "acceptance": ["checkable criterion", "..."], "dependsOn": ["C-..."]}]}]}
Rules: at most ${MAX_WAVES} waves and ${MAX_CARDS_PER_WAVE} cards per wave; each card is sized for one insect in one session;
every card has checkable acceptance criteria; a card may depend only on cards in the same or an earlier wave;
tester cards depend on the coder cards they test. Use only the castes listed.`,
  ].join('\n\n');
  const task = [
    `# Goal\n${o.goal}`,
    o.bootCard && `# What the Brain knows\n${o.bootCard}`,
    o.context && `# Related records\n${o.context}`,
    o.projectListing && `# Project files (top level)\n${o.projectListing}`,
    'Plan this goal now. Read files if you need to; do not change anything.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, task };
}

export interface CardForPrompt {
  id: string;
  title: string;
  brief: string;
  acceptance: string[];
  attempts: number;
  lastFailure?: string;
}

export function insectPrompt(lib: Library, caste: Caste, card: CardForPrompt, bootCard: string): PromptPair {
  const system = [lib.role(caste), HIVE_RULES, 'End your final message with exactly one line: "STATUS: DONE", "STATUS: BLOCKED: <reason>" or "STATUS: NEEDS_CONTEXT: <question>".'].join('\n\n');
  const task = [
    `# Card ${card.id}: ${card.title}`,
    card.brief,
    `## Done means\n${card.acceptance.map((a) => `- ${a}`).join('\n')}`,
    card.attempts > 0 ? `## Previous attempt\nThis is attempt ${card.attempts + 1}. Last time: ${card.lastFailure ?? 'it did not pass review'}.` : '',
    bootCard ? `## What the Brain knows\n${bootCard}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { system, task };
}

export function inspectorPrompt(lib: Library, card: CardForPrompt, o: { result: string; changedFiles: string[] }): PromptPair {
  const system = [
    lib.role('inspector'),
    HIVE_RULES,
    'You are the Inspector. Verify; do not change files. Run the project\'s tests or checks if they exist.',
    'End your final message with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL: <what is missing>".',
  ].join('\n\n');
  const task = [
    `# Verify card ${card.id}: ${card.title}`,
    `## Done means\n${card.acceptance.map((a) => `- ${a}`).join('\n')}`,
    `## The insect reported\n${o.result || '(no report)'}`,
    `## Files changed\n${o.changedFiles.map((f) => `- ${f}`).join('\n') || '- (none)'}`,
    'Check every "done means" item with evidence. Then give your verdict.',
  ].join('\n\n');
  return { system, task };
}
