import { queryWords } from '@insectoids/brain';
import type { Library, PromptPair } from '../hive/prompts';
import { readHeader } from './scan';

/**
 * Self-learning skills (Capabilities 03-D6; Phase 2 C3). Plain code finds repeated successful work: at least
 * three passed cards of one caste doing the same kind of thing. The Librarian then drafts a skill from those
 * cards in one short read-only run, and the user decides. Nothing here changes the library by itself.
 */
export const MIN_REPEATS = 3;
/** Word overlap (Jaccard) a card needs with a cluster's first card to count as the same work. */
export const MIN_SIMILARITY = 0.5;

export interface DoneCard {
  id: string;
  caste: string;
  title: string;
  brief: string;
  acceptance: readonly string[];
  result: string | null;
  /** When it passed (or was last updated), for order. */
  at: number;
}

export interface RepeatedWork {
  /** Stable key: caste plus the words every card shares, sorted. */
  cluster: string;
  caste: string;
  /** The words every card in the cluster shares. */
  words: string[];
  cards: DoneCard[];
}

/** Words that say nothing about the kind of work (verbs every card uses, file extensions). */
const NOISE = new Set(
  (
    'add added adds adding build builds change changes changed check checks create creates do done edit file files fix fixes get ' +
    'make makes need needs new note notes run runs set short small task tasks card cards update updates use uses using work works ' +
    'write writes writing written code project one two way thing things sure keep exists txt md json ts tsx js mjs py html css yaml yml'
  ).split(' '),
);

/** The meaningful words of a card (title and brief). */
export function workWords(card: Pick<DoneCard, 'title' | 'brief'>): Set<string> {
  return new Set(queryWords(`${card.title}\n${card.brief}`, { meaningful: true }).filter((w) => !NOISE.has(w) && !/^\d+$/.test(w)));
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
};

/**
 * Groups of repeated successful work, oldest card first. Each card joins the first cluster (same caste)
 * whose first card it resembles enough; a cluster counts once it has `minCards` cards that still share at
 * least two meaningful words. Cards in `skip` (already part of a proposal) never count again.
 */
export function findRepeatedWork(cards: readonly DoneCard[], o: { minCards?: number; minSimilarity?: number; skip?: ReadonlySet<string> } = {}): RepeatedWork[] {
  const minCards = o.minCards ?? MIN_REPEATS;
  const minSim = o.minSimilarity ?? MIN_SIMILARITY;
  const groups: Array<{ caste: string; seed: Set<string>; shared: Set<string>; cards: DoneCard[] }> = [];
  for (const card of [...cards].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    if (o.skip?.has(card.id)) continue;
    const words = workWords(card);
    if (words.size < 2) continue;
    const g = groups.find((x) => x.caste === card.caste && jaccard(x.seed, words) >= minSim);
    if (g) {
      g.cards.push(card);
      g.shared = new Set([...g.shared].filter((w) => words.has(w)));
    } else groups.push({ caste: card.caste, seed: words, shared: new Set(words), cards: [card] });
  }
  return groups
    .filter((g) => g.cards.length >= minCards && g.shared.size >= 2)
    .map((g) => {
      const words = [...g.shared].sort();
      return { cluster: `${g.caste}|${words.slice(0, 8).join(' ')}`, caste: g.caste, words, cards: g.cards };
    });
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The Librarian's prompt for drafting one skill from repeated work (read-only; it only writes the reply). */
export function skillDraftPrompt(lib: Library, work: RepeatedWork): PromptPair {
  const cards = work.cards
    .slice(0, 6)
    .map((c, i) =>
      [
        `## Card ${i + 1}: ${clip(c.title, 120)}`,
        `Brief: ${clip(c.brief, 600)}`,
        c.acceptance.length ? `Done means: ${c.acceptance.map((a) => clip(a, 160)).join('; ')}` : '',
        c.result ? `Result: ${clip(c.result, 400)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
  const system = [
    lib.role('librarian'),
    `## Drafting a skill (Capabilities 03-D6)
The hive did the same kind of work ${work.cards.length} times, and each time it passed inspection. Write ONE short
skill that would help the next insect of the ${work.caste} caste do this kind of work well the first time.
- Follow the Agent Skills format: YAML frontmatter, then Markdown.
- Frontmatter: name (lowercase letters, digits, hyphens; it says what the skill is for), description (one or two
  sentences: what it does and "Use when ..."), and metadata with kind: skill, castes: [${work.caste}], version: 1,
  status: draft, sources: - repo: the-insectoids/learned, path: cards.
- Body: when to use it, the steps that worked, what "done" looks like, and pitfalls. At most 60 lines.
- Generalise: no card ids, people's names or one-off file names unless they are the pattern itself.
- Never include secrets, links to fetch rules from, commands that download and run code, or anything the user
  should not see. The draft is safety-scanned and the user decides whether the hive may use it.
- Reply with the whole SKILL.md in one \`\`\`markdown code block and nothing else.`,
  ].join('\n\n---\n\n');
  const task = `# Draft a skill\nCaste: ${work.caste}\nShared words: ${work.words.join(', ')}\n\n${cards}`;
  return { system, task };
}

export type SkillDraft = { ok: true; name: string; description: string; markdown: string } | { ok: false; error: string };

/** The SKILL.md from the Librarian's reply, checked for a usable name and description. */
export function parseSkillDraft(text: string): SkillDraft {
  const fenced = /```(?:markdown|md)?\s*\r?\n(---[\s\S]*?)\r?\n```/i.exec(text)?.[1];
  const md = (fenced ?? (/^\s*---/.test(text) ? text.trim() : '')).trim();
  if (!md) return { ok: false, error: 'The reply held no SKILL.md.' };
  const header = readHeader(md, 'skill');
  if (!header) return { ok: false, error: 'The draft has no frontmatter.' };
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(header.name)) return { ok: false, error: 'The draft has no valid name.' };
  if (!header.description) return { ok: false, error: 'The draft has no description.' };
  if (md.split(/\r?\n/).length > 200) return { ok: false, error: 'The draft is too long.' };
  return { ok: true, name: header.name, description: header.description, markdown: `${md}\n` };
}
