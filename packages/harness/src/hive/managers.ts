import type { BoardCard, Brain, ForemanAction, ForemanWake, Incident } from '@insectoids/brain';
import { z } from 'zod';
import type { Library, PromptPair } from './prompts';

/**
 * The managers' brains (Hive 02-D8; Phase 2 C2). Each is one short, read-only LLM run over a compact,
 * code-built summary: the Foreman's decision on a stuck card, the Foreman's periodic review, and the
 * Scout's survey before the Queen plans. Their reflexes are plain code (the taskboard and the Watchdog).
 * Every report reaches the user only through the Queen's activity feed (02-D4).
 */

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The last fenced json block, or the outermost {...} in the text. */
function jsonIn(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidate = fences.length ? fences.at(-1)![1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

// ---- the Foreman's decision on a stuck card -------------------------------------------------------

export const WAKE_WORDS: Record<ForemanWake, string> = {
  'attempts-exhausted': 'it failed on every attempt it had',
  held: 'the Watchdog stopped its insect and is holding it',
  'lease-loop': 'its insects kept going silent until their lease ran out',
};

export interface ForemanSituation {
  wake: ForemanWake;
  card: BoardCard;
  /** Why earlier attempts ended (Inspector notes, give-up reasons), oldest first. */
  notes: string[];
  incidents: Incident[];
}

export function foremanSituation(brain: Brain, card: BoardCard, wake: ForemanWake): ForemanSituation {
  const notes = brain.taskboard
    .events(card.id)
    .filter((e) => e.note && e.note !== 'hold released')
    .map((e) => `${e.from} → ${e.to} by ${e.actor}: ${clip(oneLine(e.note!), 300)}`)
    .slice(-8);
  return { wake, card, notes, incidents: brain.incidents.list({ cardId: card.id, limit: 5 }) };
}

export function foremanDecisionPrompt(lib: Library, s: ForemanSituation): PromptPair {
  const system = [
    lib.role('foreman'),
    `## Output contract
Reply with ONE fenced \`\`\`json block:
{"action": "retry-with-note" | "stronger-model" | "to-queen", "reason": "<one or two sentences, with the evidence>", "note": "<for retry-with-note: what the next insect should do differently>"}
- retry-with-note: one more attempt, with your note added to the card's brief. Pick it when the failures show a clear, fixable cause.
- stronger-model: one more attempt on the strongest model. Pick it when the card is sound but the work was too hard for the model used.
- to-queen: stop here; the Queen re-plans with the user. Pick it when the card itself is the problem (too big, unclear, impossible, broken environment) or you are unsure.
This card gets at most one more try from you, ever. You change nothing yourself and you never talk to the user.`,
  ].join('\n\n');
  const c = s.card;
  const task = [
    `# Stuck card ${c.id}: ${c.title}`,
    `Why you were woken: ${WAKE_WORDS[s.wake]}.`,
    `Caste: ${c.caste} · priority: ${c.priority} · attempts used: ${c.attempts} of ${c.maxAttempts}${c.heldReason ? ` · held: ${c.heldReason}` : ''}`,
    `## Brief\n${clip(c.brief, 1500)}`,
    `## Done means\n${c.acceptance.map((a) => `- ${a}`).join('\n')}`,
    `## What happened\n${s.notes.length ? s.notes.map((n) => `- ${n}`).join('\n') : '- (no notes)'}`,
    `## Watchdog incidents\n${s.incidents.length ? s.incidents.map((i) => `- ${i.sensor} (${i.step}): ${clip(i.evidence, 200)}`).join('\n') : '- (none)'}`,
    'Decide now.',
  ].join('\n\n');
  return { system, task };
}

const ForemanReplySchema = z.object({
  action: z.enum(['retry-with-note', 'stronger-model', 'to-queen']),
  reason: z.string().trim().min(3).max(600),
  note: z.string().trim().max(800).optional(),
});

export interface ForemanChoice {
  action: ForemanAction;
  reason: string;
  note: string | null;
}

/** Read the Foreman's reply strictly. Anything malformed sends the card to the Queen (the safe choice). */
export function parseForemanReply(text: string): ForemanChoice {
  try {
    const parsed = ForemanReplySchema.safeParse(jsonIn(text));
    if (parsed.success) {
      const { action, reason, note } = parsed.data;
      // A retry with nothing to say differently is just the same retry: use the reason as the note.
      return { action, reason: oneLine(reason), note: action === 'retry-with-note' ? oneLine(note || reason) : null };
    }
  } catch {
    // fall through
  }
  return { action: 'to-queen', reason: "The Foreman's reply could not be read, so the card goes to the Queen.", note: null };
}

// ---- the Foreman's periodic review ----------------------------------------------------------------

export interface ReviewSummary {
  text: string;
  finished: number;
  incidents: number;
}

/** Board metrics and recent incidents since the last review, built by code for the Foreman to read. */
export function reviewSummary(brain: Brain, since: number | null): ReviewSummary {
  const from = since ?? 0;
  const cards = brain.taskboard.list();
  const byStatus = new Map<string, number>();
  for (const c of cards) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  const finished = cards.filter((c) => c.status === 'done' && c.updatedAt >= from);
  const retried = finished.filter((c) => c.attempts > 0);
  const failed = cards.filter((c) => c.status === 'failed' && c.updatedAt >= from);
  const incidents = brain.incidents.list({ since: from, limit: 200 });
  const bySensor = new Map<string, number>();
  for (const i of incidents) bySensor.set(i.sensor, (bySensor.get(i.sensor) ?? 0) + 1);
  const recurring = incidents.filter((i) => i.recurrence > 0);
  const decisions = brain.foreman.list(50).filter((d) => d.at >= from);
  const byCaste = new Map<string, { done: number; retried: number }>();
  for (const c of finished) {
    const e = byCaste.get(c.caste) ?? { done: 0, retried: 0 };
    e.done++;
    if (c.attempts > 0) e.retried++;
    byCaste.set(c.caste, e);
  }
  const text = [
    `Cards finished since the last review: ${finished.length} (${retried.length} needed a retry); failed for good: ${failed.length}.`,
    `Board now: ${[...byStatus].map(([s, n]) => `${s} ${n}`).join(', ') || 'empty'}.`,
    `By caste: ${[...byCaste].map(([c, e]) => `${c} ${e.done} done, ${e.retried} retried`).join('; ') || 'none'}.`,
    `Watchdog incidents: ${incidents.length}${bySensor.size ? ` (${[...bySensor].map(([s, n]) => `${s} ${n}`).join(', ')})` : ''}; recurring: ${recurring.length}.`,
    ...recurring.slice(0, 5).map((i) => `- recurring ${i.sensor}: ${clip(i.evidence, 160)} (seen ${i.recurrence + 1} times)`),
    `Foreman decisions: ${decisions.length}${decisions.length ? ` (${decisions.map((d) => d.action).join(', ')})` : ''}.`,
  ].join('\n');
  return { text, finished: finished.length, incidents: incidents.length };
}

export function foremanReviewPrompt(lib: Library, summary: ReviewSummary): PromptPair {
  const system = [
    lib.role('foreman'),
    `## Output contract
This is your periodic review. Reply with ONE fenced \`\`\`json block: {"report": "<at most 4 short sentences for the user, through the Queen>"}
Say what went well, what keeps going wrong (with numbers), and one concrete suggestion if there is one. If nothing needs changing, say so.
You change nothing yourself: no settings, no cards, no limits.`,
  ].join('\n\n');
  return { system, task: `# Board since the last review\n\n${summary.text}\n\nWrite the review now.` };
}

/** The review's report, always starting "Hive review:" (the user sees it in the Queen's feed). */
export function parseReviewReply(text: string, summary: ReviewSummary): string {
  let report = '';
  try {
    const r = (jsonIn(text) as { report?: unknown })?.report;
    if (typeof r === 'string') report = oneLine(r);
  } catch {
    report = '';
  }
  if (!report) report = `${summary.finished} card${summary.finished === 1 ? '' : 's'} finished, ${summary.incidents} incident${summary.incidents === 1 ? '' : 's'} since the last review.`;
  report = clip(report.replace(/^hive review:\s*/i, ''), 700);
  return `Hive review: ${report}`;
}

// ---- the Scout's survey ---------------------------------------------------------------------------

export function scoutPrompt(lib: Library, o: { goal: string; outline: string }): PromptPair {
  const system = [
    lib.role('scout'),
    `## This run
You survey the code for the Queen before she plans. You only read: no edits, no running code. Use the outline below
(from the hive's code map) first; open a file only to confirm something important. Reply with the compact survey from
your output format, at most 40 lines. Cite only lines you actually read. If nothing relevant exists, say so.`,
  ].join('\n\n');
  const task = [`# Goal\n${o.goal}`, `# Code map outline (symbols by file, most relevant first)\n${o.outline}`, 'Survey now.'].join('\n\n');
  return { system, task };
}

/** The survey as stored and passed to the Queen: trimmed, at most ~3,000 characters. */
export function surveyFrom(text: string): string | null {
  const t = text.replace(/```[a-z]*\n?|```/g, '').trim();
  return t.length >= 20 ? clip(t, 3_000) : null;
}
