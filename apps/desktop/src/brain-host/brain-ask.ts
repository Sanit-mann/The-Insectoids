/**
 * Ask the Brain (Memory 01; Phase 4 A1): the host side's plain code. Retrieval, the estimate shown before the first
 * question, and the record a saved answer becomes. The AI run itself is the Hive's (`askBrain`).
 */
import type { Brain } from '@insectoids/brain';
import type { AskSourceInput } from '@insectoids/harness';
import { BRAIN_ASK_MAX_SOURCES, type BrainAskEstimate, type BrainAskSource, RecordKindSchema, TrustSchema } from '@insectoids/shared';

export const NOTHING_MATCHES = "The Brain doesn't know: nothing in it matches that question.";
export const NOT_ANSWERED = "The records found don't answer it.";
/** A source's body handed to the run is cut here, so one huge record can't swamp the question. */
const BODY_MAX = 6_000;

type Embed = (text: string) => Promise<{ vector: Float32Array; model: string } | null>;

/**
 * Hybrid search (words + meaning when meaning search is on) over the project's shelf and Global, current records
 * only, at most BRAIN_ASK_MAX_SOURCES, numbered 1..n in rank order. Reading them counts as nothing (no `noteRead`).
 */
export async function findSources(brain: Brain, question: string, shelf: string, embed?: Embed): Promise<AskSourceInput[]> {
  const meaning = embed ? await embed(question).catch(() => null) : null;
  const hits = brain.search(question, { shelf, limit: BRAIN_ASK_MAX_SOURCES, ...(meaning ? { queryVector: meaning.vector, vectorModel: meaning.model } : {}) });
  const sources: AskSourceInput[] = [];
  for (const h of hits) {
    const r = brain.get(h.id);
    if (!r || r.archived || r.validTo !== null) continue;
    const body = r.body.length > BODY_MAX ? `${r.body.slice(0, BODY_MAX - 1)}…` : r.body;
    sources.push({ n: sources.length + 1, id: r.id, kind: r.kind, shelf: r.shelf, title: r.title, trust: r.trust, body, summary: r.summary });
  }
  return sources;
}

/** A source as the app shows it (no body). */
export const sourceView = (s: AskSourceInput): BrainAskSource => ({
  n: s.n,
  id: s.id,
  kind: RecordKindSchema.parse(s.kind),
  shelf: s.shelf,
  title: s.title,
  trust: TrustSchema.parse(s.trust),
});

/** The cited numbers that are really sources, once each, in number order. */
export function citedSources(sources: readonly AskSourceInput[], cited: readonly number[]): AskSourceInput[] {
  const wanted = new Set(cited);
  return sources.filter((s) => wanted.has(s.n)).sort((a, b) => a.n - b.n);
}

// ---- the estimate ------------------------------------------------------------------------------------

/** Without enough Librarian runs of its own, the hive says this. */
export const FALLBACK_TOKENS = { low: 3_000, high: 8_000 } as const;
/** Librarian runs needed before the hive trusts its own numbers. */
export const MIN_ASK_RUNS = 3;

export interface AskPastRun {
  role: string;
  engine: string;
  tokens: number;
  costUsd: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const roundTo = (n: number, step: number): number => Math.max(step, Math.round(n / step) * step);
const cents = (usd: number): number => Math.max(0.01, Math.round(usd * 100) / 100);
const num = (n: number): string => n.toLocaleString('en-US');

/**
 * The token range: half to one and a half times the median of past Librarian runs (the same engine's when it has
 * MIN_ASK_RUNS, else every engine's), rounded to hundreds; FALLBACK_TOKENS without enough runs.
 */
export function askTokenRange(runs: readonly AskPastRun[], engine: string | null): { low: number; high: number } {
  const lib = runs.filter((r) => r.role === 'librarian' && r.tokens > 0);
  const mine = lib.filter((r) => r.engine === engine);
  const use = mine.length >= MIN_ASK_RUNS ? mine : lib;
  if (use.length < MIN_ASK_RUNS) return { ...FALLBACK_TOKENS };
  const m = median(use.map((r) => r.tokens));
  const low = roundTo(m * 0.5, 100);
  return { low, high: Math.max(low + 100, roundTo(m * 1.5, 100)) };
}

export function askEstimate(i: {
  project: boolean;
  /**
   * The engine the Treasurer routes the Librarian's role to, or null when none can take it. `subscription` is
   * the engine's own capability (a plan engine: no per-token price, the run counts toward the plan's limits).
   */
  engine: { id: string; name: string; free: boolean; subscription: boolean } | null;
  /** Recent runs of every role (the routing history), for the token range and a per-token price. */
  runs: readonly AskPastRun[];
}): BrainAskEstimate {
  const e = i.engine;
  const { low, high } = askTokenRange(i.runs, e?.id ?? null);
  const base = { engine: e?.name ?? null, free: Boolean(e?.free), tokensLow: low, tokensHigh: high };
  if (!i.project && !e) return { ...base, canAsk: false, costUsdHigh: null, message: 'Open a project first.' };
  if (!e) return { ...base, canAsk: false, costUsdHigh: null, message: 'No AI engine is ready to answer. Set one up in Connections.' };
  const range = `${num(low)}–${num(high)} tokens per question on ${e.name}`;
  let costUsdHigh: number | null = null;
  let message: string;
  if (e.id === 'fake') message = `The scripted test engine answers on ${e.name}: it spends no tokens and costs nothing.`;
  else if (e.free) message = `Free: about ${range}, a model on this computer.`;
  else if (e.subscription) message = `About ${range} (your subscription).`;
  else {
    // An API provider bills per token: price it from this engine's own past runs when they reported a cost.
    const priced = i.runs.filter((r) => r.engine === e.id && r.costUsd > 0 && r.tokens > 0);
    const tokens = priced.reduce((s, r) => s + r.tokens, 0);
    const cost = priced.reduce((s, r) => s + r.costUsd, 0);
    if (tokens > 0 && cost > 0) {
      costUsdHigh = cents((high * cost) / tokens);
      message = `About ${range}, up to about $${costUsdHigh.toFixed(2)} (billed by your API provider).`;
    } else message = `About ${range} (billed by your API provider per token).`;
  }
  if (!i.project) return { ...base, canAsk: false, costUsdHigh, message: 'Open a project first.' };
  return { ...base, canAsk: true, costUsdHigh, message };
}

// ---- a saved answer --------------------------------------------------------------------------------------

/** The question on one line, cut to `max` characters. */
export function cutQuestion(question: string, max = 80): string {
  const one = question.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
}

/** The record a saved answer becomes: "Answer: <question>", the answer, then the cited titles. */
export function answerRecord(question: string, answer: string, citedTitles: readonly string[]): { title: string; body: string } {
  const sources = citedTitles.length ? `\n\nSources\n${citedTitles.map((t) => `- ${t}`).join('\n')}` : '';
  return { title: `Answer: ${cutQuestion(question)}`, body: `${answer.trim()}${sources}` };
}
