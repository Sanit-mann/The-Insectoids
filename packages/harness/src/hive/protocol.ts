import { type Caste, CasteSchema, PrioritySchema } from '@insectoids/shared';
import { z } from 'zod';
import { planContainerMark } from './containers';

/** Most cards a single wave may hold, so every wave stays small enough to review. */
export const MAX_CARDS_PER_WAVE = 6;
export const MAX_WAVES = 6;
/** The most library skills the Queen may add to one card (Capabilities 03-D8). */
export const MAX_PLAN_SKILLS = 3;

const PlanCardSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/).optional(),
  title: z.string().min(1).max(120),
  brief: z.string().min(1),
  caste: CasteSchema,
  priority: PrioritySchema.default('normal'),
  acceptance: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).default([]),
  /** Outside services this card needs (ids from the enabled list the Queen was given); none by default. */
  integrations: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/)).max(5).default([]),
  /**
   * Library skills the Queen adds to this card (03-D8). Loose on purpose: names the hive can't switch on are
   * dropped by parsePlan, never a reason to reject the plan.
   */
  skills: z.array(z.unknown()).default([]),
  /**
   * The Queen marks a risky card for a container (Phase 4 D2): a short reason in plain words ("it installs
   * packages"). Absent = no mark. Loose like skills: a value that isn't usable text is dropped by parsePlan.
   */
  container: z.unknown().optional(),
});

const PlanSchema = z.object({
  /** One short line for the plan card; older plans may lack it (derived from the summary). */
  headline: z.string().trim().min(1).max(140).optional(),
  summary: z.string().min(1),
  waves: z.array(z.object({ cards: z.array(PlanCardSchema).min(1).max(MAX_CARDS_PER_WAVE) })).min(1).max(MAX_WAVES),
});

export type PlanCard = Omit<z.infer<typeof PlanCardSchema>, 'skills' | 'container'> & { id: string; skills?: string[]; container?: string };
export interface Plan {
  headline: string;
  summary: string;
  waves: Array<{ cards: PlanCard[] }>;
}

/** First sentence of a summary, clipped: the fallback headline for plans written without one. */
export function headlineFrom(summary: string): string {
  const first = summary.trim().split(/(?<=[.!?])\s/)[0] ?? summary;
  return first.length <= 100 ? first : `${first.slice(0, 99).trimEnd()}…`;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidate = fences.length ? fences.at(-1)![1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

/** The Queen's skill picks for a card: known, switchable names only, deduplicated, at most MAX_PLAN_SKILLS. */
function planSkills(raw: readonly unknown[], allowed: ((name: string) => boolean) | undefined): string[] {
  if (!allowed) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || out.includes(v) || !allowed(v)) continue;
    out.push(v);
    if (out.length >= MAX_PLAN_SKILLS) break;
  }
  return out;
}

/** Read and check the Queen's plan (Hive 02-D5, D10): valid castes, "done means", real dependencies, no cycles. */
export function parsePlan(text: string, opts: { castes: readonly Caste[]; skillAllowed?: (name: string) => boolean }): PlanResult {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, error: 'No JSON plan found in the reply.' };
  }
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `The plan is not in the required shape: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }

  let n = 0;
  const waves = parsed.data.waves.map((w) => ({
    cards: w.cards.map(({ container, ...c }) => {
      const mark = planContainerMark(container);
      return { ...c, id: c.id ?? `C-${String(++n).padStart(2, '0')}`, skills: planSkills(c.skills, opts.skillAllowed), ...(mark ? { container: mark } : {}) };
    }),
  }));
  const ids = new Set<string>();
  const waveOf = new Map<string, number>();
  for (const [wi, w] of waves.entries()) {
    for (const c of w.cards) {
      if (ids.has(c.id)) return { ok: false, error: `Card id ${c.id} is used twice.` };
      if (!opts.castes.includes(c.caste)) return { ok: false, error: `Card ${c.id} needs the ${c.caste} caste, which this hive does not have yet.` };
      ids.add(c.id);
      waveOf.set(c.id, wi);
    }
  }
  for (const [wi, w] of waves.entries()) {
    for (const c of w.cards) {
      for (const d of c.dependsOn) {
        if (!waveOf.has(d)) return { ok: false, error: `Card ${c.id} depends on ${d}, which is not in the plan.` };
        if (d === c.id) return { ok: false, error: `Card ${c.id} depends on itself.` };
        if (waveOf.get(d)! > wi) return { ok: false, error: `Card ${c.id} depends on ${d}, which comes in a later wave.` };
      }
    }
  }
  const deps = new Map(waves.flatMap((w) => w.cards.map((c) => [c.id, c.dependsOn] as const)));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'visiting') return true;
    state.set(id, 'visiting');
    const cyclic = (deps.get(id) ?? []).some(visit);
    state.set(id, 'done');
    return cyclic;
  };
  if ([...deps.keys()].some(visit)) return { ok: false, error: 'The plan has a dependency cycle.' };

  return { ok: true, plan: { headline: parsed.data.headline ?? headlineFrom(parsed.data.summary), summary: parsed.data.summary, waves } };
}

export type InsectStatus = { status: 'done' | 'blocked' | 'needs_context'; detail: string };

/** The insect's last STATUS line (executing-a-task-card skill). No line means it considers the card done. */
export function parseStatus(text: string): InsectStatus {
  const all = [...text.matchAll(/^\s*STATUS:\s*(DONE|BLOCKED|NEEDS_CONTEXT)\b[\s:–-]*(.*)$/gim)];
  const last = all.at(-1);
  if (!last) return { status: 'done', detail: '' };
  return { status: last[1]!.toLowerCase() as InsectStatus['status'], detail: last[2]!.trim() };
}

export type Verdict = { verdict: 'pass' | 'fail'; note: string };

/** The Inspector's last VERDICT line. No verdict counts as a fail: done means verified. */
export function parseVerdict(text: string): Verdict {
  const last = [...text.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\b[\s:–-]*(.*)$/gim)].at(-1);
  if (!last) return { verdict: 'fail', note: 'The Inspector gave no verdict.' };
  return { verdict: last[1]!.toLowerCase() as Verdict['verdict'], note: last[2]!.trim() };
}
