import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caste } from '@insectoids/shared';
import { MAX_CARDS_PER_WAVE, MAX_PLAN_SKILLS, MAX_WAVES } from './protocol';

/** Skills each role carries by default in Phase 1 (Capabilities 03-D8: at most ~5 active). */
export const ROLE_SKILLS: Record<'queen' | 'inspector' | 'librarian' | 'scout' | 'foreman' | Caste, string[]> = {
  queen: ['writing-plans'],
  inspector: ['verification-before-completion'],
  librarian: ['compact-output'],
  // C2: the managers' brains. Lean on purpose: they read a compact summary, not the whole project.
  scout: ['compact-output'],
  foreman: ['compact-output'],
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

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;

export class Library {
  /**
   * `dir` is the shipped library; `userDir` (C3) the user's own library in the app's data folder, holding
   * learned and imported skills. Whether a skill may be switched on is the Brain catalog's status (a draft or
   * retired one never is); this class only reads the files.
   */
  constructor(
    private readonly dir: string,
    private readonly userDir?: string,
  ) {}

  agent(name: string): string {
    return stripFrontmatter(readFileSync(join(this.dir, 'agents', name, 'AGENT.md'), 'utf8'));
  }

  skill(name: string): string {
    const path = this.#skillPath(name);
    if (!path) throw new Error(`No skill called ${name}.`);
    return stripFrontmatter(readFileSync(path, 'utf8'));
  }

  /** Whether a skill is on disk (only those can be switched on for an insect). */
  hasSkill(name: string): boolean {
    return this.#skillPath(name) !== null;
  }

  /** The shipped skill first, then a learned one, then an imported one. */
  #skillPath(name: string): string | null {
    if (!SKILL_NAME.test(name)) return null;
    const candidates = [join(this.dir, 'skills', name, 'SKILL.md')];
    if (this.userDir) candidates.push(join(this.userDir, 'learned', 'skills', name, 'SKILL.md'), join(this.userDir, 'imported', 'skills', name, 'SKILL.md'));
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /**
   * The role's agent text plus the skills it carries for this run. Default: the role's default skills
   * (ROLE_SKILLS). Insects get the skills chosen for their card (Capabilities 03-D8), defaults first.
   */
  role(role: keyof typeof ROLE_SKILLS, skills: readonly string[] = ROLE_SKILLS[role]): string {
    const parts = [this.agent(role), ...skills.map((s) => `## Skill: ${s}\n\n${this.skill(s)}`)];
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
    '- Look code up with `brain_code` before reading whole files (shell: `brain code <name> [--file|--callers|--callees]`): where a symbol is defined, a file outline, who calls what.',
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

/** The outside services the Queen may hand to cards (only ones the user switched on). */
function servicesSection(services: ReadonlyArray<{ id: string; description: string }>): string {
  if (!services.length) return '## Outside services\nNone are switched on, so every card\'s "integrations" stays [].';
  return [
    '## Outside services',
    'These are switched on. A card may list in "integrations" only the ones it really needs (least privilege); most cards need none:',
    ...services.map((s) => `- ${s.id}: ${s.description}`),
  ].join('\n');
}

/**
 * Library skills that fit the goal (Capabilities 03-D8). Each insect already carries its caste's defaults;
 * the Queen may add a few more to a card, and the hive finds more from the card's own text.
 */
function skillsSection(skills: ReadonlyArray<{ name: string; description: string }>): string {
  if (!skills.length) return '## Library skills\nEach insect carries its caste\'s default skills. Leave every card\'s "skills" as [].';
  return [
    '## Library skills',
    `Each insect already carries its caste's default skills. A card may name up to ${MAX_PLAN_SKILLS} more in "skills", only from this list and only when the card clearly needs one (most cards need none):`,
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}

export function queenPrompt(
  lib: Library,
  o: {
    goal: string;
    bootCard: string;
    context: string;
    castes: readonly Caste[];
    projectListing: string;
    services?: ReadonlyArray<{ id: string; description: string }>;
    /** Library skills that fit this goal (03-D8 "Find"); a card may name a few in "skills". */
    skills?: ReadonlyArray<{ name: string; description: string }>;
    /** The Scout's survey of the code for this goal (Phase 2 C2), when it ran. */
    survey?: string;
  },
): PromptPair {
  const system = [
    lib.role('queen'),
    HIVE_RULES.replace('You never talk to the user; only the Queen does.', 'You are the Queen. In this run you only plan; you do not edit files.'),
    `## Output contract
Reply with your plan as ONE fenced \`\`\`json block, exactly this shape:
{"headline": "<one short line, at most 100 characters>", "summary": "<at most 3 sentences>", "waves": [{"cards": [{"id": "C-01", "title": "...", "brief": "what to change and why, with file paths", "caste": "<one of: ${o.castes.join(', ')}>", "priority": "critical|high|normal|low", "acceptance": ["checkable criterion", "..."], "dependsOn": ["C-..."], "integrations": [], "skills": []}]}]}
Rules: at most ${MAX_WAVES} waves and ${MAX_CARDS_PER_WAVE} cards per wave; each card is sized for one insect in one session;
every card has checkable acceptance criteria; a card may depend only on cards in the same or an earlier wave;
tester cards depend on the coder cards they test. Use only the castes listed.
Priority: use "normal" by default. Use "high" only when other work waits on the card or it is risky, "critical" only for
an urgent fix, "low" for nice-to-haves. Priority decides how much model effort a card gets, so over-using "high" wastes tokens.
Don't say whether the plan needs the user's approval; the hive decides that from its own rules.`,
    servicesSection(o.services ?? []),
    skillsSection(o.skills ?? []),
  ].join('\n\n');
  const task = [
    `# Goal\n${o.goal}`,
    o.bootCard && `# What the Brain knows\n${o.bootCard}`,
    o.context && `# Related records\n${o.context}`,
    o.survey && `# The Scout's survey (facts from the code map; unconfirmed)\n${o.survey}`,
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

/**
 * An insect's prompt. `skills` are the library skills switched on for this card (03-D8, defaults first);
 * without them it carries its caste's defaults. Nothing carries over to the next card (03-D7).
 */
export function insectPrompt(lib: Library, caste: Caste, card: CardForPrompt, bootCard: string, skills?: readonly string[]): PromptPair {
  const system = [lib.role(caste, skills ?? ROLE_SKILLS[caste]), HIVE_RULES, 'End your final message with exactly one line: "STATUS: DONE", "STATUS: BLOCKED: <reason>" or "STATUS: NEEDS_CONTEXT: <question>".'].join('\n\n');
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
