import type { Brain, BrainRecord, NewApproval } from '@insectoids/brain';
import { z } from 'zod';
import type { Library, PromptPair } from './prompts';

/**
 * The Librarian, the memory keeper (Hive 02, a manager built as "reflexes + brain", 02-D8; Phase 2 B3).
 *
 * - Reflexes (free, code only) live in the Brain and the host: lessons on failed work, decay, the
 *   duplicate audit and the health score.
 * - Its brain (an LLM run, spends tokens) reads a compact audit summary and proposes changes.
 *   It never changes a record itself: every proposal goes to the user's approval inbox, and only an
 *   approved proposal is applied, as the user.
 */

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const DAY = 86_400_000;

// ---- lessons (reflex) -----------------------------------------------------------------------------

/**
 * A lesson from a failed inspection (a retry or an escalation), in the register's "Don't … because …"
 * shape (01-E10), built from the card and the Inspector's reason: no LLM. The reason's first sentence
 * carries the "because". The text holds no attempt number, so the same failure again is the same lesson
 * (it folds in, and its "seen" count goes up) instead of a new one.
 */
export function lessonFrom(card: { title: string }, reason: string): { title: string; body: string } {
  const why = oneLine(reason).split(/(?<=[.!?])\s/)[0] ?? oneLine(reason);
  const title = `Don't hand in "${clip(oneLine(card.title), 60)}" as done because ${lowerFirst(clip(why.replace(/[.!?]$/, ''), 110))}`;
  const body = [`Card: ${oneLine(card.title)}`, `What the Inspector found: ${clip(oneLine(reason), 600)}`].join('\n');
  return { title, body };
}

// ---- audit summary (reflex) -----------------------------------------------------------------------

export interface AuditSummary {
  /** Near-duplicate pairs involving a record the user wrote or confirmed (only the user may merge them). */
  duplicates: Array<{ a: BrainRecord; b: BrainRecord }>;
  /** Confirmed facts nobody has used for 90+ days: still true? */
  staleFacts: BrainRecord[];
  /** Lessons agents wrote that the user hasn't confirmed yet. */
  lessons: BrainRecord[];
}

const MAX_ITEMS = 10;

/** What the Librarian's brain gets to read: a few items of each kind, never the whole Brain. */
export function auditSummary(brain: Brain, shelf: string, now: number): AuditSummary {
  const duplicates = brain
    .duplicatePairs(shelf)
    .filter((p) => p.userInvolved)
    .slice(0, MAX_ITEMS)
    .map(({ a, b }) => ({ a, b }));
  const staleFacts = brain
    .recent({ shelf, kinds: ['fact', 'decision'], limit: 500 })
    .map((h) => brain.get(h.id))
    .filter((r): r is BrainRecord => !!r && r.trust === 'confirmed' && (r.lastUsedAt ?? r.createdAt) < now - 90 * DAY)
    .slice(0, MAX_ITEMS);
  const lessons = brain
    .lessons(shelf, 50)
    .filter((l) => l.trust !== 'confirmed')
    .slice(0, MAX_ITEMS);
  return { duplicates, staleFacts, lessons };
}

export const summaryIsEmpty = (s: AuditSummary): boolean => !s.duplicates.length && !s.staleFacts.length && !s.lessons.length;

const line = (r: BrainRecord): string => `- ${r.id} [${r.kind}, ${r.trust}${r.owner === 'user' ? ', yours' : ''}] ${clip(oneLine(r.title), 100)}: ${clip(oneLine(r.body), 160)}`;

export function summaryText(s: AuditSummary): string {
  return [
    '## Near-duplicates (at least one is the user\'s; only the user may merge them)',
    s.duplicates.length ? s.duplicates.map((p, i) => `Pair ${i + 1}:\n${line(p.a)}\n${line(p.b)}`).join('\n') : '(none)',
    '',
    '## Confirmed facts and decisions not used for 90+ days (still true?)',
    s.staleFacts.length ? s.staleFacts.map(line).join('\n') : '(none)',
    '',
    '## Lessons waiting for the user (unconfirmed)',
    s.lessons.length ? s.lessons.map(line).join('\n') : '(none)',
  ].join('\n');
}

// ---- the review (brain) ---------------------------------------------------------------------------

export function librarianPrompt(lib: Library, summary: AuditSummary): PromptPair {
  const system = [
    lib.role('librarian'),
    `## Output contract
Reply with ONE fenced \`\`\`json block: {"proposals": [ ... ]}, at most ${MAX_ITEMS} proposals, each one of:
{"type": "merge", "keep": "<id>", "fold": "<id>", "reason": "<one sentence>"}      (both ids from the same near-duplicate pair)
{"type": "supersede", "old": "<id>", "new": "<id>", "reason": "<one sentence>"}   (both ids from the same pair; "new" replaces "old")
{"type": "confirm", "id": "<id>", "reason": "<one sentence>"}                      (an unconfirmed lesson worth keeping)
{"type": "archive", "id": "<id>", "reason": "<one sentence>"}                      (a stale fact or a lesson that no longer helps)
Use only ids listed in the summary. Propose nothing you are unsure about; an empty list is a fine answer.
You change nothing yourself: the user approves or denies each proposal.`,
  ].join('\n\n');
  const task = `# Brain audit\n\n${summaryText(summary)}\n\nReview it and reply with your proposals.`;
  return { system, task };
}

const Reason = z.string().trim().min(3).max(300);
const Id = z.string().min(1).max(100);
export const LibrarianProposalSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('merge'), keep: Id, fold: Id, reason: Reason }).strict(),
  z.object({ type: z.literal('supersede'), old: Id, new: Id, reason: Reason }).strict(),
  z.object({ type: z.literal('confirm'), id: Id, reason: Reason }).strict(),
  z.object({ type: z.literal('archive'), id: Id, reason: Reason }).strict(),
]);
export type LibrarianProposal = z.infer<typeof LibrarianProposalSchema>;

/**
 * Read the Librarian's reply strictly: every proposal must parse, use ids from this audit, and fit its
 * type (merge/supersede only within one listed pair; confirm only unconfirmed lessons; archive only stale
 * facts or lessons). Anything else is dropped and counted. At most 10 are kept.
 */
export function parseLibrarianReply(text: string, summary: AuditSummary): { proposals: LibrarianProposal[]; dropped: number; error: string | null } {
  let raw: unknown;
  try {
    const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
    const candidate = fences.length ? fences.at(-1)![1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    raw = JSON.parse(candidate);
  } catch {
    return { proposals: [], dropped: 0, error: 'The Librarian\'s reply was not valid JSON.' };
  }
  const list = (raw as { proposals?: unknown })?.proposals;
  if (!Array.isArray(list)) return { proposals: [], dropped: 0, error: 'The Librarian\'s reply had no "proposals" list.' };

  const pairOf = (x: string, y: string): boolean =>
    x !== y && summary.duplicates.some((p) => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x));
  const unconfirmedLesson = new Set(summary.lessons.map((l) => l.id));
  const archivable = new Set([...summary.staleFacts.map((f) => f.id), ...summary.lessons.map((l) => l.id)]);

  const proposals: LibrarianProposal[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of list) {
    const parsed = LibrarianProposalSchema.safeParse(item);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    const p = parsed.data;
    const ok =
      p.type === 'merge' ? pairOf(p.keep, p.fold)
      : p.type === 'supersede' ? pairOf(p.old, p.new)
      : p.type === 'confirm' ? unconfirmedLesson.has(p.id)
      : archivable.has(p.id);
    const key = JSON.stringify(p.type === 'merge' ? [p.type, [p.keep, p.fold].sort()] : p.type === 'supersede' ? [p.type, [p.old, p.new].sort()] : [p.type, p.id]);
    if (!ok || seen.has(key) || proposals.length >= MAX_ITEMS) {
      dropped++;
      continue;
    }
    seen.add(key);
    proposals.push(p);
  }
  return { proposals, dropped, error: null };
}

/** The approval the user sees for one proposal (only the Queen talks to the user; this goes to the inbox). */
export function approvalFor(p: LibrarianProposal, brain: Brain): NewApproval {
  const t = (id: string): string => `"${clip(brain.get(id)?.title ?? id, 70)}"`;
  const kindOf = (id: string): 'fact' | 'decision' => (brain.get(id)?.kind === 'decision' ? 'decision' : 'fact');
  const base = { from: 'Librarian', payload: { action: 'librarian', proposal: p } };
  switch (p.type) {
    case 'merge':
      return { ...base, kind: kindOf(p.keep), title: `Merge ${t(p.fold)} into ${t(p.keep)}`, whyItNeedsYou: `They say almost the same thing, and one of them is yours. ${p.reason}`, ifYouSayYes: `${t(p.fold)} is archived as "merged into" ${t(p.keep)}. Nothing is deleted; you can bring it back.` };
    case 'supersede':
      return { ...base, kind: kindOf(p.new), title: `Replace ${t(p.old)} with ${t(p.new)}`, whyItNeedsYou: `The newer note looks like it replaces the older one, which is yours to decide. ${p.reason}`, ifYouSayYes: `${t(p.old)} becomes history ("replaced by" ${t(p.new)}); search shows the newer one.` };
    case 'confirm':
      return { ...base, kind: 'fact', title: `Keep the lesson ${t(p.id)}`, whyItNeedsYou: `Agents learned it from failed work; only you can confirm it. ${p.reason}`, ifYouSayYes: 'It becomes a confirmed lesson that every agent sees first.' };
    case 'archive':
      return { ...base, kind: kindOf(p.id), title: `Archive ${t(p.id)}`, whyItNeedsYou: `It hasn't been used in a long time or no longer helps. ${p.reason}`, ifYouSayYes: 'It leaves search and stays readable as history. Nothing is deleted; you can bring it back.' };
  }
}

/** Apply a proposal the user approved, as the user. Throws when the records changed in the meantime. */
export function applyLibrarianProposal(brain: Brain, p: LibrarianProposal): void {
  const user = { type: 'user' as const };
  switch (p.type) {
    case 'merge':
      return brain.mergeRecords(p.keep, p.fold, user);
    case 'supersede':
      return brain.supersede(p.old, p.new, user);
    case 'confirm':
      brain.update(p.id, { trust: 'confirmed' }, user);
      return;
    case 'archive':
      return brain.archive(p.id, user, "archived on the Librarian's advice");
  }
}
