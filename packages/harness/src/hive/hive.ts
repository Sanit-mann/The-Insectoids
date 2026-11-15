import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CadenceAutonomy, Caste } from '@insectoids/shared';
import { type ApprovalItem, type BoardCard, type Brain, type Goal, cardReadKey } from '@insectoids/brain';
import type { Workspace } from '@insectoids/workspace';
import type { ClaudeEvent } from '../claude/stream';
import { type BrainAccess, type BrainTicket, brainWriteAccess } from './brain-access';
import { type ServiceAccess, type ServiceTicket, servicesBrief } from './services-access';
import type { Engine, EngineRequest, EngineResult } from './engine';
import { CASTE_NETWORK, MAX_FOUND_SKILLS, chooseSkills, firstSentence } from './catalog';
import { type Library, ROLE_SKILLS, brainRules, estimateTokens, inspectorPrompt, insectPrompt, queenPrompt } from './prompts';
import { type Plan, parsePlan, parseStatus, parseVerdict } from './protocol';
import type { EngineId } from '@insectoids/shared';
import { detectUsageLimit } from '../engines/limits';
import { ASK_ROUTE, type AskSourceInput, askPrompt, parseAskReply } from './ask';
import { type AuditSummary, type LibrarianProposal, LibrarianProposalSchema, applyLibrarianProposal, lessonFrom, librarianPrompt, parseLibrarianReply } from './librarian';
import { type ModelTiers, type Route, type RouteInput, type Tier, TIERS, budgetState, isInsectRole, routeCard, runTokens } from './router';
import type { ForemanWake, Incident } from '@insectoids/brain';
import { type RunWatch, type Trip, Watchdog, type WatchdogThresholds } from './watchdog';
import { type RepeatedWork, type SkillDraft, parseSkillDraft, skillDraftPrompt } from '../library/proposals';
import {
  type ForemanChoice,
  foremanDecisionPrompt,
  foremanReviewPrompt,
  foremanSituation,
  parseForemanReply,
  parseReviewReply,
  reviewSummary,
  scoutPrompt,
  surveyFrom,
} from './managers';

export interface HiveOptions {
  brain: Brain;
  workspace: Workspace;
  engine: Engine;
  library: Library;
  /** The user's project (read by the Queen; changed only by approved merges). */
  repoDir: string;
  /** Hive-private folder for the Queen's scratch space. */
  dataDir: string;
  shelf: string;
  home: string;
  models: ModelTiers;
  /**
   * Picks the engine, model and effort for a run (e.g. an EngineRegistry across several engines).
   * Default: `routeCard` on `models`, all on Claude Code.
   */
  route?: (input: RouteInput) => Route;
  /** Most insects working at once (Hive 02-D7, set by the user). */
  insectCap: number;
  /** Castes this hive has (Phase 1: coder, tester). */
  castes: Caste[];
  noGo?: string[];
  linkDependencies?: string[];
  leaseMs?: number;
  defaultBudgetTokens?: number;
  /**
   * Every plan waits for the user's approval, not only big ones (Onboarding 08-D7 "Careful" preset).
   * Default false: only plans with more than one wave wait (Hive 02-D11).
   */
  approveEveryPlan?: boolean;
  /**
   * Gives each run a Brain token and the doors (MCP + `brain` command). Without it agents get the
   * boot card in their brief but no live Brain tools.
   */
  brainAccess?: BrainAccess;
  /**
   * Outside services through the secret broker (Connections 04-D4). A card that names integrations gets a
   * token for only those (and only ones switched on) for each run; it's revoked when the run ends.
   */
  services?: ServiceAccess;
  /**
   * The Treasurer's limits (Connections 04-D7, Phase 2 A5): told when an engine's vendor limit stops a run,
   * asked whether any engine can still take a role, and how many insects may work right now.
   */
  limits?: HiveLimits;
  /** Clock for run outcomes (tests). Default Date.now. */
  now?: () => number;
  onEvent?: (e: HiveEvent) => void;
  /**
   * Meaning search (Phase 2 B1): the query's vector from the Brain host's embedder, or null when it is off.
   * The Queen's related-records lookup then finds notes by meaning, not just matching words.
   */
  embedQuery?: (text: string) => Promise<{ vector: Float32Array; model: string } | null>;
  /**
   * The Watchdog's reflexes (Phase 2 C2): thresholds to override (tests use short stall windows), or false
   * to switch it off. Default on with WATCHDOG_DEFAULTS.
   */
  watchdog?: Partial<WatchdogThresholds> | false;
  /**
   * The Foreman's brain (C2): one short LLM decision when a card is stuck (out of attempts, held by the
   * Watchdog, or its lease keeps running out). Default on. Off = Phase 1 behaviour: the goal is stuck at once.
   */
  foremanBrain?: boolean;
  /**
   * The Scout (C2): before the Queen plans a goal of at least 6 words, one read-only survey from a code-map
   * outline. `enabled` is the user's setting; `outline` returns null when the code map isn't ready.
   */
  scout?: { enabled(): boolean; outline(goal: string): string | null };
}

export interface HiveLimits {
  /** An engine's vendor said a usage or rate limit stopped a run. */
  hit(engine: EngineId, resetAt: number | null, detail: string): void;
  /** Can any engine take this role right now? */
  canRoute(role: RouteInput['role']): boolean;
  /** Most insects allowed right now (lower when engines are near their caps); null = the user's cap. */
  cap?(): number | null;
}

/** Pause reasons that start with this are the Treasurer's: the app resumes the hive when an engine frees up. */
export const LIMIT_PAUSE = 'Usage limit:';

export interface HiveEvent {
  type:
    | 'goal-planned'
    | 'goal-started'
    | 'goal-stuck'
    | 'goal-done'
    | 'approval-needed'
    | 'wave-posted'
    | 'card-started'
    | 'card-submitted'
    | 'card-blocked'
    | 'card-verified'
    | 'card-rejected'
    | 'engine'
    | 'budget'
    | 'paused'
    | 'librarian'
    | 'resumed'
    | 'run-started'
    | 'run-ended'
    | 'goal-cancelled'
    | 'card-undone'
    | 'goal-undone'
    | 'merge-undone'
    | 'merge-redone'
    // C2: the managers' brain side. Their reports reach the user through the Queen's feed (02-D4).
    | 'watchdog'
    | 'card-held'
    | 'foreman'
    | 'scout'
    // Phase 3 A3: a goal first reached the Treasurer's warn level (75% of its token budget). Once per goal per run of the app.
    | 'budget-warning';
  goalId?: string;
  cardId?: string;
  agentId?: string;
  message: string;
  /** Set on 'watchdog': the incident as stored. */
  incident?: Incident;
  engineEvent?: ClaudeEvent;
  /** Set on run-started, engine and run-ended: which run (one agent session) this is about. */
  run?: RunInfo;
}

/** One agent run, for the Hive monitor's lanes. */
export interface RunInfo {
  runId: string;
  role: EngineRequest['role'];
  title: string;
  /** Which engine runs it. */
  engine: string;
  /** Planned by the router; the engine's init event reports what actually ran. */
  model: string;
  effort: string;
  /** Why the Treasurer chose this engine, model and effort. */
  reason?: string;
  /** run-ended only. */
  ok?: boolean;
  error?: string;
  tokens?: number;
  costUsd?: number;
}

/** What Hive.askBrain returns (Phase 4 A1). `unknown`: the run said UNKNOWN or cited no source it was given. */
export type AskBrainResult =
  | { ok: true; answer: string; cited: number[]; tokens: number; costUsd: number; costEstimated: boolean; engine: string; model: string | null }
  | { ok: false; unknown: boolean; error: string | null; tokens: number; costUsd: number };

/** Where a goal stands on the user's branch (Workspace 06-D3, D6). */
export type MergeState = 'not-merged' | 'awaiting-approval' | 'merged' | 'undone';

interface Job {
  kind: 'insect' | 'inspector' | 'librarian' | 'foreman' | 'scout';
  cardId: string;
  done: Promise<void>;
  stop(): void;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const local = (cardId: string): string => cardId.slice(cardId.indexOf('.') + 1);
const wsId = (card: BoardCard): string => `${local(card.id)}.a${card.attempts}`;

/**
 * The hive runtime (Hive 02): the Queen plans, the Foreman dispatches, insects work in their own worktrees,
 * the Inspector verifies, and the Treasurer and Watchdog reflexes keep it within budget and limits.
 * tick() is one deterministic Foreman pass; the app calls it on a timer.
 */
export class Hive {
  readonly #o: HiveOptions;
  readonly #jobs = new Map<string, Job>();
  #ants = 0;
  #runs = 0;
  #asks = 0;
  readonly #deciding = new Set<string>();
  /** Goals already warned at 75% of their budget (A3: once per goal). */
  readonly #budgetWarned = new Set<string>();
  #paused = false;
  /** "Ask" rules the user approved, per card (Hive 02-D7). */
  readonly #approved = new Map<string, string[]>();
  /** Last failure note per card, for the next attempt's brief. */
  readonly #lastFailure = new Map<string, string>();
  /** The Watchdog (C2), or null when switched off. */
  readonly #watchdog: Watchdog | null;
  /** Runs under watch, by run id: the stall timer checks them. */
  readonly #watches = new Map<string, { watch: RunWatch; stop: () => void }>();
  #stallTimer: ReturnType<typeof setInterval> | null = null;
  /** A breaker step the Watchdog took on an agent's current run; the run's owner acts on it when the run ends. */
  readonly #breakers = new Map<string, Trip>();
  /** Why a held card waits for the Foreman (default: the Watchdog held it). */
  readonly #holdWake = new Map<string, ForemanWake>();

  constructor(o: HiveOptions) {
    this.#o = { leaseMs: 20 * 60_000, defaultBudgetTokens: 2_000_000, ...o };
    this.#watchdog = o.watchdog === false ? null : new Watchdog(o.watchdog ?? {}, () => this.#now());
  }

  #route(input: RouteInput): Route {
    return this.#o.route ? this.#o.route(input) : routeCard(input, this.#o.models);
  }

  /**
   * Why the hive pauses when a run's engine is signed out. It names the engine the run was routed to, since
   * with several engines "Claude Code is signed out" would send the user to the wrong login.
   */
  #signedOutReason(route: Route | undefined): string {
    const name = (route && this.#o.engine.name?.(route.engine)) || 'The AI engine';
    return `${name} is signed out. Sign in, then resume the hive.`;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Limits from the user's safety preset (Onboarding 08-D7). Applies to the next dispatch and the next goal. */
  configure(limits: { insectCap?: number; defaultBudgetTokens?: number; approveEveryPlan?: boolean }): void {
    if (limits.insectCap !== undefined) {
      if (!Number.isInteger(limits.insectCap) || limits.insectCap < 1) throw new Error('insectCap must be a whole number of at least 1.');
      this.#o.insectCap = limits.insectCap;
    }
    if (limits.defaultBudgetTokens !== undefined) this.#o.defaultBudgetTokens = limits.defaultBudgetTokens;
    if (limits.approveEveryPlan !== undefined) this.#o.approveEveryPlan = limits.approveEveryPlan;
  }

  get runningJobs(): number {
    return this.#jobs.size;
  }

  /** The user gives the Queen a goal. She plans it; a big plan waits for approval (Hive 02-D11). */
  async submitGoal(
    text: string,
    opts: {
      title?: string;
      budgetTokens?: number;
      /** The cadence this run comes from (Phase 3 A1): recorded on the goal and named in the plan approval. */
      cadenceId?: string;
      cadenceName?: string;
      /**
       * How much a cadence run may do without the user (05-D6): 'ask' = every plan waits; 'small-plans' = the
       * normal rule; 'run' = the plan starts on its own. The Careful preset (approveEveryPlan) still wins.
       */
      autonomy?: CadenceAutonomy;
    } = {},
  ): Promise<Goal> {
    const { brain } = this.#o;
    const goal = brain.goals.create({
      title: opts.title ?? clip(text.split('\n')[0]!, 60),
      text,
      shelf: this.#o.shelf,
      budgetTokens: opts.budgetTokens ?? this.#o.defaultBudgetTokens!,
      ...(opts.cadenceId ? { cadenceId: opts.cadenceId } : {}),
    });
    brain.write({ kind: 'task', shelf: this.#o.shelf, title: `Goal: ${goal.title}`, body: text, source: goal.id }, { type: 'user' });

    const plan = await this.#plan(goal);
    if (!plan) {
      brain.goals.setStatus(goal.id, 'stuck');
      this.#emit({ type: 'goal-stuck', goalId: goal.id, message: 'The Queen could not produce a valid plan.' });
      return brain.goals.get(goal.id)!;
    }
    brain.goals.setPlan(goal.id, plan);
    this.#emit({ type: 'goal-planned', goalId: goal.id, message: `${plan.waves.length} wave(s), ${plan.waves.flatMap((w) => w.cards).length} card(s): ${plan.headline}` });

    const big = plan.waves.length > 1;
    const autonomy = opts.autonomy ?? 'small-plans';
    // The stricter rule wins: the user's Careful preset, the cadence's own level, then the big-plan rule.
    const why = this.#o.approveEveryPlan
      ? 'Your safety preset (Careful) asks you to approve every plan.'
      : autonomy === 'ask'
        ? `This run of the cadence "${opts.cadenceName ?? 'unnamed'}" is set to ask before every plan.`
        : autonomy === 'small-plans' && big
          ? opts.cadenceId
            ? `This run of the cadence "${opts.cadenceName ?? 'unnamed'}" planned more than one wave, so it counts as big (Hive D11).`
            : 'The plan has more than one wave, so it counts as big (Hive D11).'
          : null;
    if (why) {
      brain.goals.setStatus(goal.id, 'awaiting_approval');
      this.#ask({
        goalId: goal.id,
        kind: 'plan',
        title: `Approve the plan for "${goal.title}"`,
        from: 'Queen',
        whyItNeedsYou: why,
        ifYouSayYes: 'Wave 1 is posted to the taskboard and insects start working in separate copies of your project.',
        payload: { action: 'start-goal', goalId: goal.id },
      });
    } else {
      await this.#startGoal(goal.id);
    }
    return brain.goals.get(goal.id)!;
  }

  /** The user approves an item in the inbox; the hive acts on it. */
  async approve(approvalId: string): Promise<void> {
    await this.#decide(approvalId, true);
  }

  async deny(approvalId: string): Promise<void> {
    await this.#decide(approvalId, false);
  }

  /**
   * Acts first, then records the decision: if the action fails (e.g. a merge meets uncommitted work in
   * the project), the item stays waiting and the error goes back to the user instead of a false "approved".
   */
  async #decide(approvalId: string, yes: boolean): Promise<void> {
    const { approvals } = this.#o.brain;
    const a = approvals.get(approvalId);
    if (!a) throw new Error(`No approval ${approvalId}`);
    if (a.status !== 'waiting') throw new Error('This was already decided.');
    if (this.#deciding.has(approvalId)) throw new Error('Already working on this decision.');
    this.#deciding.add(approvalId);
    try {
      await this.#act(a, yes);
      approvals.decide(approvalId, yes ? 'approved' : 'denied', { type: 'user' });
    } finally {
      this.#deciding.delete(approvalId);
    }
  }

  /**
   * The Librarian's review (B3): one read-only LLM run over a compact audit summary. It returns validated
   * proposals; it changes nothing. Its cost is recorded like any run (no goal: it belongs to the Brain).
   */
  async librarianReview(summary: AuditSummary): Promise<{ ok: boolean; proposals: LibrarianProposal[]; dropped: number; error: string | null }> {
    const scratch = join(this.#o.dataDir, 'librarian');
    mkdirSync(scratch, { recursive: true });
    const prompt = librarianPrompt(this.#o.library, summary);
    let stopRun: (() => void) | undefined;
    const agentId = 'Librarian';
    const done = (async () => {
      return this.#runWith(null, undefined, {
        role: 'librarian',
        agentId,
        title: 'Brain review',
        cwd: scratch,
        system: prompt.system,
        task: prompt.task,
        route: this.#route({ role: 'librarian', priority: 'normal', attempts: 0 }),
        guard: { workspace: scratch, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
      }, (stop) => (stopRun = stop));
    })().finally(() => this.#jobs.delete(agentId));
    this.#jobs.set(agentId, { kind: 'librarian', cardId: '', done: done.then(() => undefined, () => undefined), stop: () => stopRun?.() });
    const result = await done;
    if (!result.ok) return { ok: false, proposals: [], dropped: 0, error: `The review run failed (${result.error ?? 'error'}).` };
    const parsed = parseLibrarianReply(result.text, summary);
    return { ok: parsed.error === null, ...parsed };
  }

  /**
   * The Librarian drafts a skill from repeated successful work (03-D6, C3): one short read-only run that only
   * writes its reply. The draft is checked here for a name and a description; the caller scans it and asks
   * the user. Its cost is recorded like any run (no goal: it belongs to the library).
   */
  async draftSkill(work: RepeatedWork): Promise<SkillDraft> {
    const scratch = join(this.#o.dataDir, 'librarian');
    mkdirSync(scratch, { recursive: true });
    const prompt = skillDraftPrompt(this.#o.library, work);
    let stopRun: (() => void) | undefined;
    const jobKey = 'Librarian:skill-draft';
    const done = (async () => {
      return this.#runWith(null, undefined, {
        role: 'librarian',
        agentId: 'Librarian',
        title: `Draft a skill: ${work.words.slice(0, 4).join(' ')}`,
        cwd: scratch,
        system: prompt.system,
        task: prompt.task,
        // 'normal': the Librarian's standard tier. 'low' is its light tier, kept for Ask the Brain (ASK_ROUTE).
        route: this.#route({ role: 'librarian', priority: 'normal', attempts: 0 }),
        guard: { workspace: scratch, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
      }, (stop) => (stopRun = stop));
    })().finally(() => this.#jobs.delete(jobKey));
    this.#jobs.set(jobKey, { kind: 'librarian', cardId: '', done: done.then(() => undefined, () => undefined), stop: () => stopRun?.() });
    const result = await done;
    if (!result.ok) return { ok: false, error: `The drafting run failed (${result.error ?? 'error'}).` };
    return parseSkillDraft(result.text);
  }

  /**
   * Ask the Brain (Phase 4 A1): one short read-only Librarian run that sees only the numbered sources and
   * must cite them. It has no Brain door, no network and a scratch folder of its own; its cost is recorded
   * like any run (no goal). Routed with ASK_ROUTE: a free local model when one is ready (see ask.ts).
   * Never throws: a failed run is `error`, a reply that is UNKNOWN or cites nothing valid is `unknown`.
   */
  async askBrain(question: string, sources: readonly AskSourceInput[]): Promise<AskBrainResult> {
    if (!sources.length) return { ok: false, unknown: true, error: null, tokens: 0, costUsd: 0 };
    const scratch = join(this.#o.dataDir, 'ask');
    mkdirSync(scratch, { recursive: true });
    const prompt = askPrompt(question, sources);
    const route = this.#route({ ...ASK_ROUTE });
    let stopRun: (() => void) | undefined;
    // Each question is its own job, so two asks at once don't overwrite each other's entry.
    const jobKey = `Librarian:ask#${++this.#asks}`;
    const done = this.#runWith(null, undefined, {
      role: 'librarian',
      agentId: 'Librarian',
      title: 'Ask the Brain',
      cwd: scratch,
      system: prompt.system,
      task: prompt.task,
      route,
      guard: { workspace: scratch, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
    }, (stop) => (stopRun = stop)).finally(() => this.#jobs.delete(jobKey));
    this.#jobs.set(jobKey, { kind: 'librarian', cardId: '', done: done.then(() => undefined, () => undefined), stop: () => stopRun?.() });
    let result: EngineResult;
    try {
      result = await done;
    } catch (err) {
      return { ok: false, unknown: false, error: `The run crashed (${err instanceof Error ? err.message : String(err)}).`, tokens: 0, costUsd: 0 };
    }
    const tokens = runTokens(result.usage);
    if (!result.ok) return { ok: false, unknown: false, error: `The run failed (${result.error ?? 'error'}).`, tokens, costUsd: result.costUsd };
    const parsed = parseAskReply(result.text, sources.length);
    if (!parsed) return { ok: false, unknown: true, error: null, tokens, costUsd: result.costUsd };
    return {
      ok: true,
      ...parsed,
      tokens,
      costUsd: result.costUsd,
      costEstimated: result.costEstimated ?? false,
      engine: route.engine,
      model: result.model ?? (route.model || null),
    };
  }

  /** A lesson from a failed inspection, retried or escalated (01-E10, B3): free, no LLM. Never blocks the hive. */
  #learn(shelf: string, card: BoardCard, reason: string): void {
    try {
      const lesson = lessonFrom({ title: card.title }, reason);
      this.#o.brain.learn({ shelf, ...lesson, source: card.id }, { type: 'agent', id: 'Librarian' });
    } catch {
      // A reason that trips the secrets guard (or anything else) just doesn't become a lesson.
    }
  }

  /** Watchdog breaker: stop every agent now and pause dispatching. */
  pause(reason: string): void {
    this.#paused = true;
    for (const job of this.#jobs.values()) job.stop();
    this.#emit({ type: 'paused', message: reason });
  }

  resume(): void {
    this.#paused = false;
    this.#emit({ type: 'resumed', message: 'Hive resumed.' });
  }

  /**
   * Stop every running agent and wait until each has finished its bookkeeping (spend, outcomes, commits,
   * worktree cleanup). Call before the Brain or the workspace closes: work that outlives them would write
   * to a closed database or a removed folder.
   */
  async settle(reason = 'Stopping.'): Promise<void> {
    this.pause(reason);
    while (this.#jobs.size > 0) await Promise.allSettled([...this.#jobs.values()].map((j) => j.done));
  }

  /** The user stops a goal: its agents stop, its open approvals are closed, nothing is merged. */
  async cancelGoal(goalId: string): Promise<void> {
    const { brain } = this.#o;
    const goal = brain.goals.get(goalId);
    if (!goal) throw new Error(`No goal ${goalId}`);
    if (goal.status === 'done' || goal.status === 'cancelled') return;
    const jobs = [...this.#jobs.values()].filter((j) => j.cardId.startsWith(`${goalId}.`));
    for (const j of jobs) j.stop();
    await Promise.allSettled(jobs.map((j) => j.done));
    for (const a of brain.approvals.list({ status: 'waiting', goalId })) brain.approvals.decide(a.id, 'denied', { type: 'user' });
    brain.goals.setStatus(goalId, 'cancelled');
    this.#emit({ type: 'goal-cancelled', goalId, message: 'Goal cancelled.' });
  }

  /** Revert one verified card on the goal's hive branch; history is kept (Workspace 06-D6). */
  async undoCard(cardId: string): Promise<void> {
    const { brain, workspace } = this.#o;
    const card = brain.taskboard.get(cardId);
    if (!card) throw new Error(`No card ${cardId}`);
    if (card.status !== 'done') throw new Error(`Only verified cards can be undone; ${local(cardId)} is ${card.status}.`);
    if (this.mergeState(card.goalId) === 'merged') throw new Error('This goal is already in your main branch. Undo the merge first.');
    await workspace.undoCard(card.goalId, wsId(card));
    brain.write({ kind: 'outcome', shelf: this.#o.shelf, title: `Undid ${local(cardId)}: ${card.title}`, body: 'Reverted on the hive branch by the user.', source: cardId }, { type: 'user' });
    this.#emit({ type: 'card-undone', goalId: card.goalId, cardId, message: card.title });
  }

  /** Reset the goal's hive branch to its checkpoint (the old tip is archived, never deleted). */
  async undoGoal(goalId: string): Promise<void> {
    const { brain, workspace } = this.#o;
    const goal = brain.goals.get(goalId);
    if (!goal) throw new Error(`No goal ${goalId}`);
    if (this.mergeState(goalId) === 'merged') throw new Error('This goal is already in your main branch. Undo the merge first.');
    if (!['done', 'cancelled', 'stuck'].includes(goal.status)) await this.cancelGoal(goalId);
    await workspace.undoGoal(goalId);
    brain.write({ kind: 'outcome', shelf: this.#o.shelf, title: `Undid goal: ${goal.title}`, body: `The hive branch was reset to its checkpoint.`, source: goalId }, { type: 'user' });
    this.#emit({ type: 'goal-undone', goalId, message: goal.title });
  }

  /** Ask the user to take a merged goal back out of main (destructive, so hold-to-approve in the UI). */
  requestUndoMerge(goalId: string): void {
    this.#requestMergeFlip(goalId, 'undo-merge');
  }

  /** Ask the user to put an undone goal back into main. */
  requestRedoMerge(goalId: string): void {
    this.#requestMergeFlip(goalId, 'redo-merge');
  }

  /**
   * Where the goal stands on the user's branch, from its merge approvals (newest decision wins;
   * denied ones change nothing).
   */
  mergeState(goalId: string): MergeState {
    const merges = this.#o.brain.approvals
      .list({ goalId })
      .filter((a) => a.kind === 'merge')
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    if (merges.some((a) => a.status === 'waiting')) return 'awaiting-approval';
    for (const a of merges) {
      if (a.status !== 'approved') continue;
      const action = (a.payload as { action?: string } | null)?.action;
      if (action === 'undo-merge') return 'undone';
      if (action === 'merge-goal' || action === 'redo-merge') return 'merged';
    }
    return 'not-merged';
  }

  #requestMergeFlip(goalId: string, action: 'undo-merge' | 'redo-merge'): void {
    const goal = this.#o.brain.goals.get(goalId);
    if (!goal) throw new Error(`No goal ${goalId}`);
    const state = this.mergeState(goalId);
    const need = action === 'undo-merge' ? 'merged' : 'undone';
    if (state !== need) {
      throw new Error(action === 'undo-merge' ? `"${goal.title}" is not in your main branch (${state}).` : `"${goal.title}" has no undone merge to redo (${state}).`);
    }
    const undo = action === 'undo-merge';
    this.#ask({
      goalId,
      kind: 'merge',
      title: undo ? `Undo "${goal.title}" in your main branch` : `Put "${goal.title}" back into your main branch`,
      from: 'You',
      whyItNeedsYou: 'Your main branch changes only with your approval (Workspace D3).',
      ifYouSayYes: undo
        ? 'A new commit on main reverses this goal. Nothing is deleted; you can put it back later.'
        : 'A new commit on main re-applies this goal exactly as it was merged.',
      destructive: undo,
      payload: { action, goalId },
    });
  }

  /** One Foreman pass. */
  async tick(): Promise<void> {
    const { brain } = this.#o;
    for (const id of brain.taskboard.sweepExpiredLeases()) this.#leaseLoop(id);
    for (const goal of brain.goals.list('running')) {
      if (this.#paused) break;
      this.#inspectReviews(goal);
      this.#foremanPass(goal);
      this.#dispatch(goal);
      await this.#advance(goal);
    }
  }

  // ---- the Foreman's brain (Hive 02-D8; Phase 2 C2) -------------------------------------------------

  /** A card whose lease ran out twice is probably the problem itself: hold it for the Foreman. */
  #leaseLoop(id: string): void {
    if (this.#o.foremanBrain === false) return;
    try {
      const board = this.#o.brain.taskboard;
      const card = board.get(id);
      if (!card || card.status !== 'open' || card.heldReason || board.leaseExpiries(id) < 2) return;
      board.hold(id, 'Foreman', 'Its insects went silent until the lease ran out, twice.');
      this.#holdWake.set(id, 'lease-loop');
      this.#emit({ type: 'card-held', goalId: card.goalId, cardId: id, message: `"${card.title}" is held: its insects went silent twice. The Foreman decides what happens next.` });
    } catch {
      // Bookkeeping must never stop the hive.
    }
  }

  /** The Foreman's latest decision on a failed card, if it is final (to the Queen, made after the card failed). */
  #finalDecision(card: BoardCard): { reason: string } | null {
    if (this.#o.foremanBrain === false) return { reason: 'A card failed after all its attempts.' };
    const last = this.#o.brain.foreman.forCard(card.id).at(-1);
    return last && last.action === 'to-queen' && last.at >= card.updatedAt ? last : null;
  }

  /** Wake the Foreman for each stuck card of the goal that it hasn't decided on yet. */
  #foremanPass(goal: Goal): void {
    if (this.#o.foremanBrain === false) return;
    for (const card of this.#o.brain.taskboard.list({ goalId: goal.id })) {
      const held = card.status === 'open' && card.heldReason !== null;
      const failed = card.status === 'failed' && !this.#finalDecision(card);
      if (!held && !failed) continue;
      if (this.#jobs.has(`Foreman:${card.id}`)) continue;
      this.#startForeman(goal, card, held ? (this.#holdWake.get(card.id) ?? 'held') : 'attempts-exhausted');
    }
  }

  #startForeman(goal: Goal, card: BoardCard, wake: ForemanWake): void {
    const key = `Foreman:${card.id}`;
    let stopRun: (() => void) | undefined;
    const done = (async () => {
      let choice: ForemanChoice;
      if (card.foremanRetries >= 1) {
        // Never retry the same way again (foreman AGENT.md): one more try per card, then the Queen.
        choice = { action: 'to-queen', reason: 'The Foreman already gave this card one more try, and it is stuck again.', note: null };
      } else {
        const scratch = join(this.#o.dataDir, 'foreman');
        mkdirSync(scratch, { recursive: true });
        const prompt = foremanDecisionPrompt(this.#o.library, foremanSituation(this.#o.brain, card, wake));
        const result = await this.#runWith(goal.id, card.id, {
          role: 'foreman',
          agentId: 'Foreman',
          title: `Decide: ${card.title}`,
          cwd: scratch,
          system: prompt.system,
          task: prompt.task,
          route: this.#route({ role: 'foreman', priority: card.priority, attempts: 0 }),
          guard: { workspace: scratch, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
        }, (stop) => (stopRun = stop));
        // Paused or cancelled meanwhile: decide on a later pass.
        if (!result.ok && (result.error === 'stopped' || result.error === 'quota' || result.error === 'auth')) return;
        choice = result.ok ? parseForemanReply(result.text) : { action: 'to-queen', reason: `The Foreman's run failed (${result.error ?? 'error'}), so the card goes to the Queen.`, note: null };
      }
      this.#applyForeman(goal, card.id, wake, choice);
    })().finally(() => this.#jobs.delete(key));
    this.#jobs.set(key, { kind: 'foreman', cardId: card.id, done: done.then(() => undefined, () => undefined), stop: () => stopRun?.() });
  }

  #applyForeman(goal: Goal, cardId: string, wake: ForemanWake, choice: ForemanChoice): void {
    const { brain } = this.#o;
    const board = brain.taskboard;
    const card = board.get(cardId);
    if (!card) return;
    const stuck = card.status === 'failed' || (card.status === 'open' && card.heldReason !== null);
    if (!stuck) return;
    let action = choice.action;
    try {
      if (action !== 'to-queen') {
        board.foremanRetry(cardId, 'Foreman', { note: choice.note, tier: action === 'stronger-model' ? 'strongest' : null });
      } else if (card.status === 'open') {
        board.escalate(cardId, 'Foreman', `Foreman: ${choice.reason}`);
      }
    } catch {
      action = 'to-queen';
      if (board.get(cardId)?.status === 'open') board.escalate(cardId, 'Foreman', `Foreman: ${choice.reason}`);
    }
    this.#holdWake.delete(cardId);
    brain.foreman.record({ goalId: goal.id, cardId, cardTitle: card.title, wake, action, reason: choice.reason });
    const what =
      action === 'retry-with-note'
        ? `gave "${card.title}" one more try with a note`
        : action === 'stronger-model'
          ? `gave "${card.title}" one more try on the strongest model`
          : `sent "${card.title}" back to the Queen`;
    this.#emit({ type: 'foreman', goalId: goal.id, cardId, agentId: 'Foreman', message: `The Foreman ${what}: ${choice.reason}` });
  }

  /**
   * The Foreman's periodic review (C2): one short read-only run over board metrics and recent Watchdog
   * incidents (built by code). It changes nothing; the caller stores the report and tells the user via the Queen.
   */
  async review(since: number | null): Promise<{ ok: boolean; summary: string | null; error: string | null }> {
    const key = 'Foreman:review';
    if (this.#jobs.has(key)) return { ok: false, summary: null, error: 'A review is already running.' };
    const scratch = join(this.#o.dataDir, 'foreman');
    mkdirSync(scratch, { recursive: true });
    const summary = reviewSummary(this.#o.brain, since);
    const prompt = foremanReviewPrompt(this.#o.library, summary);
    let stopRun: (() => void) | undefined;
    const done = this.#runWith(null, undefined, {
      role: 'foreman',
      agentId: 'Foreman',
      title: 'Hive review',
      cwd: scratch,
      system: prompt.system,
      task: prompt.task,
      route: this.#route({ role: 'foreman', priority: 'normal', attempts: 0 }),
      guard: { workspace: scratch, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
    }, (stop) => (stopRun = stop)).finally(() => this.#jobs.delete(key));
    this.#jobs.set(key, { kind: 'foreman', cardId: '', done: done.then(() => undefined, () => undefined), stop: () => stopRun?.() });
    const result = await done;
    if (!result.ok) return { ok: false, summary: null, error: `The review run failed (${result.error ?? 'error'}).` };
    return { ok: true, summary: parseReviewReply(result.text, summary), error: null };
  }

  // ---- the Scout (Hive 02 Managers; Phase 2 C2) ---------------------------------------------------

  /**
   * Before the Queen plans: one read-only survey from a code-map outline, when the user has the Scout on,
   * the goal has at least 6 words and the code map is ready. Saved to the Brain as an unconfirmed update.
   * Any failure just means the Queen plans without it.
   */
  async #scout(goal: Goal): Promise<string | null> {
    const s = this.#o.scout;
    if (!s || !s.enabled() || goal.text.trim().split(/\s+/).length < 6) return null;
    let outline: string | null;
    try {
      outline = s.outline(goal.text);
    } catch {
      outline = null;
    }
    if (!outline) return null;
    const key = `Scout:${goal.id}`;
    const scratch = join(this.#o.dataDir, 'goals', goal.id, 'scout');
    mkdirSync(scratch, { recursive: true });
    const prompt = scoutPrompt(this.#o.library, { goal: goal.text, outline });
    let stopRun: (() => void) | undefined;
    const done = this.#runWith(goal.id, undefined, {
      role: 'scout',
      agentId: 'Scout',
      title: `Survey: ${goal.title}`,
      cwd: this.#o.repoDir,
      system: prompt.system,
      task: prompt.task,
      route: this.#route({ role: 'scout', priority: 'normal', attempts: 0 }),
      guard: { workspace: scratch, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
    }, (stop) => (stopRun = stop)).finally(() => this.#jobs.delete(key));
    this.#jobs.set(key, { kind: 'scout', cardId: `${goal.id}.scout`, done: done.then(() => undefined, () => undefined), stop: () => stopRun?.() });
    let survey: string | null;
    try {
      const result = await done;
      survey = result.ok ? surveyFrom(result.text) : null;
    } catch {
      survey = null;
    }
    if (!survey) {
      this.#emit({ type: 'scout', goalId: goal.id, agentId: 'Scout', message: 'The Scout could not survey the code; the Queen plans without it.' });
      return null;
    }
    try {
      this.#o.brain.write({ kind: 'update', shelf: goal.shelf, title: `Scout survey: ${goal.title}`, body: survey, source: goal.id, trust: 'unconfirmed' }, { type: 'agent', id: 'Scout' });
    } catch {
      // A survey that trips the secrets guard is still given to the Queen, just not stored.
    }
    this.#emit({ type: 'scout', goalId: goal.id, agentId: 'Scout', message: `The Scout surveyed the code for "${goal.title}".` });
    return survey;
  }

  /** Run Foreman passes until nothing is running and nothing changes (tests, demos). */
  async runUntilIdle(maxTicks = 500): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      await this.tick();
      if (this.#jobs.size === 0) {
        await this.tick();
        if (this.#jobs.size === 0) return;
      }
      await Promise.race([...this.#jobs.values()].map((j) => j.done));
    }
    throw new Error('The hive did not settle.');
  }

  async #plan(goal: Goal): Promise<Plan | null> {
    const { brain, library, castes } = this.#o;
    const scratch = join(this.#o.dataDir, 'goals', goal.id, 'queen');
    mkdirSync(scratch, { recursive: true });
    const services = await this.#o.services?.available().catch(() => []) ?? [];
    const meaning = await this.#o.embedQuery?.(goal.text).catch(() => null);
    const survey = await this.#scout(goal);
    const base = queenPrompt(library, {
      ...(survey ? { survey } : {}),
      services,
      goal: goal.text,
      bootCard: brain.bootCard(goal.shelf),
      context: brain.read(goal.text, { shelf: goal.shelf, tokenBudget: 800, ...(meaning ? { queryVector: meaning.vector, vectorModel: meaning.model } : {}) }).text,
      castes,
      projectListing: this.#listing(),
      skills: this.#skillsForGoal(goal.text),
    });
    let task = base.task;
    let limitRetries = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.#runEngine(goal.id, undefined, {
        role: 'queen',
        agentId: 'Queen',
        title: `Plan: ${goal.title}`,
        cwd: this.#o.repoDir,
        system: base.system,
        task,
        route: this.#route({ role: 'queen', priority: 'normal', attempts: 0 }),
        guard: { workspace: scratch, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
      });
      if (!result.ok) {
        // A vendor limit: plan on another engine if one can take it (doesn't count as a planning attempt).
        if (result.error === 'quota' && limitRetries++ < 3 && (this.#o.limits?.canRoute('queen') ?? false)) {
          attempt--;
          continue;
        }
        if (result.error === 'quota') this.#afterLimit('queen');
        return null;
      }
      const parsed = parsePlan(result.text, { castes, skillAllowed: (n) => this.#canCarry(n) });
      if (parsed.ok) return parsed.plan;
      task = `${base.task}\n\nYour previous plan was not valid: ${parsed.error}\nReply again with only the corrected JSON plan.`;
    }
    return null;
  }

  // ---- library skills (Capabilities 03-D8; Phase 2 C1) --------------------------------------------

  /** A skill an insect may carry: switchable in the catalog (never dormant) and on disk. */
  #canCarry(name: string): boolean {
    try {
      return this.#o.brain.library.isActivatable(name) && this.#o.library.hasSkill(name);
    } catch {
      return false;
    }
  }

  /** Up to 12 switchable skills that fit the goal, for the Queen's plan ("Find"). */
  #skillsForGoal(text: string): Array<{ name: string; description: string }> {
    try {
      return this.#o.brain.library
        .activatable(text, { limit: 12, minTerms: 1 })
        .filter((s) => this.#o.library.hasSkill(s.name))
        .map((s) => ({ name: s.name, description: clip(firstSentence(s.description), 200) }));
    } catch {
      return [];
    }
  }

  /** The Queen's skill picks for a card, from the stored plan (cards themselves don't keep them). */
  #cardSkillPicks(goalId: string, cardId: string): string[] {
    const plan = this.#o.brain.goals.get(goalId)?.plan as Plan | null | undefined;
    const card = plan?.waves.flatMap((w) => w.cards).find((c) => `${goalId}.${c.id}` === cardId);
    return card?.skills ?? [];
  }

  /**
   * The skills one insect carries on this card attempt ("Activate", at most 5): its caste's defaults, the
   * Queen's picks, then the best matches for the card's own text. A resumed or re-routed run of the same
   * attempt keeps the same set. Bookkeeping trouble never stops the card: it falls back to the defaults.
   */
  #skillsForCard(card: BoardCard): string[] {
    const { brain, library } = this.#o;
    const defaults = ROLE_SKILLS[card.caste];
    try {
      const already = brain.library.activated(card.id, card.attempts).filter((n) => library.hasSkill(n));
      if (already.length) return already;
      const picked = this.#cardSkillPicks(card.goalId, card.id).filter((n) => this.#canCarry(n));
      const found = brain.library
        .activatable(`${card.title}\n${card.brief}`, { caste: card.caste, limit: MAX_FOUND_SKILLS, exclude: [...defaults, ...picked] })
        .map((s) => s.name)
        .filter((n) => library.hasSkill(n));
      const chosen = chooseSkills({ defaults, picked, found });
      brain.library.activate(card.id, card.attempts, chosen.map((name) => ({ name, tokens: estimateTokens(library.skill(name)) })));
      return chosen;
    } catch {
      return [...defaults];
    }
  }

  /** How the attempt ended, for the skills it carried ("Deactivate": they left with the insect). */
  #settleSkills(card: BoardCard, outcome: 'passed' | 'failed'): void {
    try {
      this.#o.brain.library.settle(card.id, card.attempts, outcome);
    } catch {
      // Bookkeeping must never stop the hive.
    }
  }

  async #startGoal(goalId: string): Promise<void> {
    const { brain, workspace } = this.#o;
    brain.goals.setStatus(goalId, 'running');
    await workspace.startGoal(goalId);
    this.#emit({ type: 'goal-started', goalId, message: 'Goal started.' });
    this.#postWave(goalId, 1);
  }

  #postWave(goalId: string, wave: number): void {
    const { brain } = this.#o;
    const plan = brain.goals.get(goalId)!.plan as Plan;
    for (const c of plan.waves[wave - 1]!.cards) {
      brain.taskboard.post({
        id: `${goalId}.${c.id}`,
        goalId,
        wave,
        title: c.title,
        brief: c.brief,
        caste: c.caste,
        priority: c.priority,
        acceptance: c.acceptance,
        dependsOn: c.dependsOn.map((d) => `${goalId}.${d}`),
      });
    }
    brain.goals.setWave(goalId, wave);
    this.#emit({ type: 'wave-posted', goalId, message: `Wave ${wave} posted.` });
  }

  /** The Treasurer's 75% warning (02-D9, Cadence A3), once per goal: one plain line, and a hive event cadences can wait for. */
  #maybeWarnBudget(goalId: string): void {
    if (this.#budgetWarned.has(goalId)) return;
    const g = this.#o.brain.goals.get(goalId);
    if (!g || budgetState(g.spentTokens, g.budgetTokens) === 'ok') return;
    this.#budgetWarned.add(goalId);
    this.#emit({
      type: 'budget-warning',
      goalId,
      message: `"${g.title}" has used ${g.spentTokens.toLocaleString('en-US')} of its ${g.budgetTokens?.toLocaleString('en-US')} token budget (75% or more).`,
    });
  }

  #dispatch(goal: Goal): void {
    const { brain } = this.#o;
    const state = budgetState(goal.spentTokens, goal.budgetTokens);
    if (state === 'stop') {
      if (!brain.approvals.list({ status: 'waiting', goalId: goal.id }).some((a) => (a.payload as { action?: string })?.action === 'raise-budget')) {
        this.#ask({
          goalId: goal.id,
          kind: 'risky_action',
          title: `"${goal.title}" reached its token budget`,
          from: 'Treasurer',
          whyItNeedsYou: `It has used ${goal.spentTokens.toLocaleString()} of ${goal.budgetTokens?.toLocaleString()} tokens. New cards are on hold.`,
          ifYouSayYes: 'The budget grows by 50% and the hive continues.',
          payload: { action: 'raise-budget', goalId: goal.id },
        });
        this.#emit({ type: 'budget', goalId: goal.id, message: 'Budget reached; new cards on hold.' });
      }
      return;
    }
    const insects = () => [...this.#jobs.values()].filter((j) => j.kind === 'insect').length;
    const cap = Math.min(this.#o.insectCap, this.#o.limits?.cap?.() ?? Number.POSITIVE_INFINITY);
    let progress = true;
    while (progress && insects() < cap) {
      progress = false;
      for (const caste of this.#o.castes) {
        if (insects() >= cap) break;
        // A caste no engine can take right now (all at their limits) waits on the board.
        if (this.#o.limits && !this.#o.limits.canRoute(caste)) continue;
        const agentId = `Ant-${String(++this.#ants).padStart(2, '0')}`;
        const card = brain.taskboard.claimNext({ agentId, caste, leaseMs: this.#o.leaseMs!, goalId: goal.id });
        if (!card) {
          this.#ants--;
          continue;
        }
        progress = true;
        this.#startInsect(goal, card, agentId);
      }
    }
  }

  #startInsect(goal: Goal, card: BoardCard, agentId: string, resumeNote?: string): void {
    let stopRun: (() => void) | undefined;
    const done = (async () => {
      const { brain, workspace } = this.#o;
      const id = wsId(card);
      let cardPath: string;
      if (resumeNote) {
        cardPath = workspace.cardPath(goal.id, id);
      } else {
        // A run stopped by a vendor limit leaves this attempt's worktree in place (no attempt was used up):
        // the next engine picks the card up in the same folder.
        const kept = workspace.cardPath(goal.id, id);
        cardPath = existsSync(kept) ? kept : (await workspace.createCard(goal.id, id, { linkDependencies: this.#o.linkDependencies ?? [] })).path;
        brain.taskboard.start(card.id, agentId);
      }
      this.#emit({ type: 'card-started', goalId: goal.id, cardId: card.id, agentId, message: card.title });

      const beat = setInterval(() => brain.taskboard.heartbeat(card.id, agentId, this.#o.leaseMs!), Math.max(1_000, this.#o.leaseMs! / 3));
      // The Foreman's one more try (C2) comes with its note for this insect.
      const foremanNote = card.foremanNote ? `## The Foreman's note\n${card.foremanNote}` : '';
      const brief = [card.brief, foremanNote, resumeNote ?? ''].filter(Boolean).join('\n\n');
      const prompt = insectPrompt(this.#o.library, card.caste, {
        id: local(card.id),
        title: card.title,
        brief,
        acceptance: card.acceptance,
        attempts: card.attempts,
        ...(this.#lastFailure.has(card.id) ? { lastFailure: this.#lastFailure.get(card.id)! } : {}),
      }, brain.bootCard(goal.shelf), this.#skillsForCard(card));
      const asks: string[] = [];
      let result: EngineResult;
      let route: Route | undefined;
      try {
        result = await this.#runEngine(goal.id, card.id, {
          role: card.caste,
          agentId,
          title: card.title,
          cwd: cardPath,
          system: prompt.system,
          task: prompt.task,
          route: (route = this.#route({
            role: card.caste,
            priority: card.priority,
            attempts: card.attempts,
            ...(card.foremanTier && (TIERS as readonly string[]).includes(card.foremanTier) ? { minTier: card.foremanTier as Tier } : {}),
          })),
          guard: {
            workspace: cardPath,
            home: this.#o.home,
            linkedPaths: (this.#o.linkDependencies ?? []).map((n) => join(cardPath, n)),
            noGo: this.#o.noGo ?? [],
            network: CASTE_NETWORK[card.caste],
            approvedRules: this.#approved.get(card.id) ?? [],
          },
          onEvent: (e) => {
            if (e.kind === 'tool_result' && e.isError) {
              const m = /Needs the user's approval \[([a-z-]+)\]/.exec(e.content);
              if (m) asks.push(m[1]!);
            }
          },
        }, (stop) => (stopRun = stop));
      } finally {
        clearInterval(beat);
      }

      // The Watchdog stopped this run (C2): the attempt is used, and on "pause the card" the card is held
      // until the Foreman decides. A hard stop (stop-agent) just sends the card back with the incident note.
      const breaker = this.#breakers.get(agentId);
      this.#breakers.delete(agentId);
      if (breaker) {
        this.#lastFailure.set(card.id, `The Watchdog stopped the last run: ${breaker.evidence}`);
        this.#settleSkills(card, 'failed');
        const after = brain.taskboard.giveUp(card.id, agentId, `Watchdog: ${breaker.evidence}`);
        // Hold it before anything awaits: the next Foreman pass must not hand the card to a new insect first.
        if (breaker.step === 'pause-card' && after.status === 'open') this.#holdCard(card, breaker.evidence);
        await workspace.removeCard(goal.id, id);
        return;
      }

      if (!result.ok && result.error === 'crash' && this.#watchdog) {
        // First crash: one fresh insect restarts the card (the usual retry). Second crash on the card: a hard
        // stop, and the card is held for the Foreman.
        const before = this.#o.brain.incidents.list({ cardId: card.id, limit: 50 }).filter((i) => i.sensor === 'crash').length;
        const again = before > 0;
        const trip: Trip = {
          sensor: 'crash',
          step: again ? 'stop-agent' : 'warn',
          evidence: again ? 'The insect crashed again on this card.' : 'The insect crashed; a fresh insect restarts the card.',
          signature: `crash|${card.caste}|`,
        };
        const run = { runId: `${agentId}:crash`, agentId, role: card.caste, goalId: goal.id, cardId: card.id };
        this.#incident(run, trip);
        if (again) {
          this.#lastFailure.set(card.id, `${result.error}: ${clip(result.text || result.stderrTail, 300)}`);
          this.#settleSkills(card, 'failed');
          const after = brain.taskboard.giveUp(card.id, agentId, 'Watchdog: crashed again');
          if (after.status === 'open') this.#holdCard(card, trip.evidence);
          this.#serious();
          await workspace.removeCard(goal.id, id);
          return;
        }
      }

      if (!result.ok) {
        if (result.error === 'auth') {
          brain.taskboard.block(card.id, agentId, 'The AI engine is signed out.');
          this.pause(this.#signedOutReason(route));
          return;
        }
        if (result.error === 'quota') {
          // The vendor stopped it before real work: back on the board without using an attempt. The Foreman
          // gives it to another engine, or the hive rests until one frees up.
          brain.taskboard.release(card.id, agentId, `${route?.engine ?? 'The engine'} hit its usage limit`);
          this.#afterLimit(card.caste);
          return;
        }
        this.#lastFailure.set(card.id, `${result.error}: ${clip(result.text || result.stderrTail, 300)}`);
        this.#settleSkills(card, 'failed');
        brain.taskboard.giveUp(card.id, agentId, result.error ?? 'error');
        await workspace.removeCard(goal.id, id);
        return;
      }

      const status = parseStatus(result.text);
      if (status.status !== 'done') {
        brain.taskboard.block(card.id, agentId, status.detail);
        this.#ask({
          goalId: goal.id,
          kind: 'risky_action',
          title: status.detail || `${local(card.id)} needs you`,
          from: `${card.caste[0]!.toUpperCase()}${card.caste.slice(1)} · ${agentId}`,
          whyItNeedsYou: asks.length ? `The guard requires your approval for: ${[...new Set(asks)].join(', ')}.` : 'The insect needs a decision or information only you have.',
          ifYouSayYes: asks.length ? 'The insect continues, allowed to do exactly that kind of action on this card.' : 'The insect continues.',
          payload: { action: 'resume-card', cardId: card.id, agentId, rules: [...new Set(asks)], detail: status.detail },
        });
        this.#emit({ type: 'card-blocked', goalId: goal.id, cardId: card.id, agentId, message: status.detail });
        return;
      }

      await workspace.commitCard(goal.id, id, { message: card.title, insect: agentId });
      brain.taskboard.submit(card.id, agentId, clip(result.text, 2_000));
      this.#emit({ type: 'card-submitted', goalId: goal.id, cardId: card.id, agentId, message: card.title });
    })().finally(() => this.#jobs.delete(agentId));
    this.#jobs.set(agentId, { kind: 'insect', cardId: card.id, done, stop: () => stopRun?.() });
  }

  #inspectReviews(goal: Goal): void {
    const inspecting = new Set([...this.#jobs.values()].filter((j) => j.kind === 'inspector').map((j) => j.cardId));
    for (const card of this.#o.brain.taskboard.list({ goalId: goal.id, status: 'review' })) {
      if (inspecting.has(card.id)) continue;
      this.#startInspector(goal, card);
    }
  }

  #startInspector(goal: Goal, card: BoardCard): void {
    const agentId = `Inspector:${card.id}`;
    let stopRun: (() => void) | undefined;
    const done = (async () => {
      const { brain, workspace } = this.#o;
      const id = wsId(card);
      const cardPath = workspace.cardPath(goal.id, id);
      const diff = await workspace.diffCard(goal.id, id);
      const prompt = inspectorPrompt(this.#o.library, { id: local(card.id), title: card.title, brief: card.brief, acceptance: card.acceptance, attempts: card.attempts }, {
        result: card.result ?? '',
        changedFiles: diff.files.map((f) => `${f.path} (${f.status})`),
      });
      // Kept so a signed-out pause can name the engine this check ran on.
      const route = this.#route({ role: 'inspector', priority: card.priority, attempts: 0 });
      const result = await this.#runEngine(goal.id, card.id, {
        role: 'inspector',
        agentId: 'Inspector',
        title: `Verify: ${card.title}`,
        cwd: cardPath,
        system: prompt.system,
        task: prompt.task,
        route,
        guard: { workspace: cardPath, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
      }, (stop) => (stopRun = stop));

      if (!result.ok && result.error === 'auth') {
        this.pause(this.#signedOutReason(route));
        return;
      }
      if (!result.ok && result.error === 'quota') {
        // The card stays in review; the next Foreman pass inspects it on another engine (or after the rest).
        this.#afterLimit('inspector');
        return;
      }
      const verdict = result.ok ? parseVerdict(result.text) : { verdict: 'fail' as const, note: `Inspector run failed (${result.error}).` };
      if (verdict.verdict === 'pass') {
        const merge = await workspace.mergeCard(goal.id, id, card.title);
        if (merge.ok) {
          brain.outcomes.settle(card.id, card.attempts, 'pass');
          this.#settleSkills(card, 'passed');
          // What this attempt's insects read from the Brain helped work that passed (B2 ranking).
          brain.creditHelped(cardReadKey(card.id, card.attempts));
          brain.taskboard.review(card.id, { verdict: 'pass', by: 'Inspector' });
          brain.write({ kind: 'outcome', shelf: goal.shelf, title: `${local(card.id)} verified: ${card.title}`, body: `Passed on attempt ${card.attempts + 1}. ${clip(card.result ?? '', 300)}`, source: card.id }, { type: 'agent', id: 'Inspector' });
          await workspace.removeCard(goal.id, id);
          this.#emit({ type: 'card-verified', goalId: goal.id, cardId: card.id, message: card.title });
          return;
        }
        verdict.verdict = 'fail';
        verdict.note = `Verified, but it conflicts with earlier merged work in: ${merge.conflicts.join(', ')}. Redo it on top of the latest hive branch.`;
      }
      this.#lastFailure.set(card.id, verdict.note);
      brain.outcomes.settle(card.id, card.attempts, 'fail');
      this.#settleSkills(card, 'failed');
      const after = brain.taskboard.review(card.id, { verdict: 'fail', by: 'Inspector', note: verdict.note });
      this.#learn(goal.shelf, card, verdict.note);
      await workspace.removeCard(goal.id, id);
      this.#emit({ type: 'card-rejected', goalId: goal.id, cardId: card.id, message: verdict.note });
      if (after.status === 'failed') {
        brain.write({ kind: 'outcome', shelf: goal.shelf, title: `${local(card.id)} failed after ${after.attempts} attempts: ${card.title}`, body: verdict.note, source: card.id }, { type: 'agent', id: 'Inspector' });
      }
    })().finally(() => this.#jobs.delete(agentId));
    this.#jobs.set(agentId, { kind: 'inspector', cardId: card.id, done, stop: () => stopRun?.() });
  }

  async #advance(goal: Goal): Promise<void> {
    const { brain } = this.#o;
    const cards = brain.taskboard.list({ goalId: goal.id });
    const failed = cards.filter((c) => c.status === 'failed');
    if (failed.length) {
      // The Foreman decides first (C2); the goal is stuck only once it sent every failed card to the Queen.
      const finals = failed.map((c) => this.#finalDecision(c));
      if (finals.some((f) => !f)) return;
      brain.goals.setStatus(goal.id, 'stuck');
      const message =
        this.#o.foremanBrain === false
          ? 'A card failed after all its attempts; the Queen needs to re-plan with you.'
          : `Foreman: ${finals[0]!.reason} The Queen needs to re-plan with you.`;
      this.#emit({ type: 'goal-stuck', goalId: goal.id, message });
      return;
    }
    const wave = cards.filter((c) => c.wave === goal.currentWave);
    if (!wave.length || wave.some((c) => c.status !== 'done')) return;
    const plan = goal.plan as Plan;
    if (goal.currentWave < plan.waves.length) {
      this.#postWave(goal.id, goal.currentWave + 1);
      return;
    }
    if (!brain.approvals.list({ goalId: goal.id }).some((a) => a.kind === 'merge')) {
      this.#ask({
        goalId: goal.id,
        kind: 'merge',
        title: `Merge "${goal.title}" into your main branch`,
        from: 'Inspector',
        whyItNeedsYou: 'Your main branch changes only with your approval, once per goal (Workspace D3).',
        ifYouSayYes: `All ${cards.length} verified card(s) are merged into main. You can undo it for 30 days.`,
        payload: { action: 'merge-goal', goalId: goal.id },
      });
    }
  }

  async #act(a: ApprovalItem, yes: boolean): Promise<void> {
    const { brain, workspace } = this.#o;
    const p = a.payload as { action: string; goalId?: string; cardId?: string; agentId?: string; rules?: string[]; detail?: string };
    if (p.action === 'start-goal' && p.goalId) {
      if (yes) await this.#startGoal(p.goalId);
      else brain.goals.setStatus(p.goalId, 'cancelled');
    } else if (p.action === 'merge-goal' && p.goalId) {
      if (yes) await workspace.mergeIntoMain(p.goalId, { approvedBy: 'user' });
      brain.goals.setStatus(p.goalId, 'done');
      brain.write({ kind: 'outcome', shelf: this.#o.shelf, title: `Goal ${yes ? 'merged' : 'finished without merging'}: ${brain.goals.get(p.goalId)!.title}`, body: yes ? 'Merged into main.' : `Left on branch hive/${p.goalId}.` }, { type: 'user' });
      this.#emit({ type: 'goal-done', goalId: p.goalId, message: yes ? 'Merged into main.' : 'Finished; not merged.' });
    } else if ((p.action === 'undo-merge' || p.action === 'redo-merge') && p.goalId) {
      if (!yes) return;
      const goal = brain.goals.get(p.goalId)!;
      if (p.action === 'undo-merge') await workspace.undoMainMerge(p.goalId, { approvedBy: 'user' });
      else await workspace.redoMainMerge(p.goalId, { approvedBy: 'user' });
      const undo = p.action === 'undo-merge';
      brain.write({ kind: 'outcome', shelf: this.#o.shelf, title: `${undo ? 'Undid' : 'Re-applied'} goal in main: ${goal.title}`, body: undo ? 'Reverted on main by a new commit.' : 'Re-applied on main by a new commit.', source: p.goalId }, { type: 'user' });
      this.#emit({ type: undo ? 'merge-undone' : 'merge-redone', goalId: p.goalId, message: goal.title });
    } else if (p.action === 'raise-budget' && p.goalId) {
      if (yes) {
        const g = brain.goals.get(p.goalId)!;
        brain.goals.setBudget(p.goalId, Math.ceil((g.budgetTokens ?? g.spentTokens) * 1.5));
      }
    } else if (p.action === 'librarian') {
      // A Librarian proposal (B3): applied only when the user says yes, and then as the user.
      const proposal = (a.payload as { proposal?: unknown }).proposal;
      const parsed = LibrarianProposalSchema.safeParse(proposal);
      if (yes && parsed.success) {
        applyLibrarianProposal(brain, parsed.data);
        this.#emit({ type: 'librarian', message: `Done: ${a.title}.` });
      }
    } else if (p.action === 'resume-card' && p.cardId && p.agentId) {
      const card = brain.taskboard.get(p.cardId)!;
      const goal = brain.goals.get(card.goalId)!;
      if (yes && p.rules?.length) this.#approved.set(card.id, [...(this.#approved.get(card.id) ?? []), ...p.rules]);
      brain.taskboard.unblock(card.id, p.agentId, this.#o.leaseMs!);
      const note = yes
        ? `The user approved: ${p.detail ?? p.rules?.join(', ')}. You may now do exactly that and continue.`
        : `The user said no to: ${p.detail ?? p.rules?.join(', ')}. Find another way, or finish without it.`;
      this.#startInsect(goal, brain.taskboard.get(card.id)!, p.agentId, note);
    }
  }

  /** The card's integrations from its plan (cards themselves don't store them; the plan does). */
  #cardIntegrations(goalId: string, cardId: string): string[] {
    const plan = this.#o.brain.goals.get(goalId)?.plan as Plan | null | undefined;
    const card = plan?.waves.flatMap((w) => w.cards).find((c) => `${goalId}.${c.id}` === cardId);
    return card?.integrations ?? [];
  }

  async #runEngine(goalId: string, cardId: string | undefined, req: EngineRequest, onStop?: (stop: () => void) => void): Promise<EngineResult> {
    // Outside services: only insects working a card that names integrations; never the Queen or Inspector.
    const services = this.#o.services;
    const wanted = services && cardId && goalId && isInsectRole(req.role) ? this.#cardIntegrations(goalId, cardId) : [];
    if (!services || !cardId || !wanted.length) return this.#runWithBrain(goalId, cardId, req, onStop);
    let ticket: ServiceTicket;
    try {
      ticket = await services.issue({ cardId, agentId: req.agentId, integrations: wanted, approvedRules: this.#approved.get(cardId) ?? [] });
    } catch (err) {
      // No broker: the card runs without services and is told so.
      const reason = err instanceof Error ? err.message : String(err);
      return this.#runWithBrain(goalId, cardId, { ...req, system: `${req.system}

${servicesBrief([], wanted.map((id) => ({ id, reason })))}` }, onStop);
    }
    try {
      const brief = servicesBrief(ticket.granted, ticket.denied);
      return await this.#runWithBrain(goalId, cardId, {
        ...req,
        system: `${req.system}

${brief}`,
        ...(ticket.granted.length ? { services: { url: ticket.url, token: ticket.token, granted: ticket.granted, door: services.door } } : {}),
      }, onStop);
    } finally {
      await services.revoke(ticket.token).catch(() => {});
    }
  }

  async #runWithBrain(goalId: string, cardId: string | undefined, req: EngineRequest, onStop?: (stop: () => void) => void): Promise<EngineResult> {
    const access = this.#o.brainAccess;
    if (!access) return this.#runWith(goalId, cardId, req, onStop);
    // One token per run, scoped to this agent and the goal's shelf; it dies with the run, whatever happens.
    const write = brainWriteAccess(req.role);
    const shelf = this.#o.brain.goals.get(goalId)?.shelf ?? this.#o.shelf;
    // Insects' reads are tied to their card attempt, so a pass can credit what helped (B2).
    const card = cardId && isInsectRole(req.role) ? this.#o.brain.taskboard.get(cardId) : undefined;
    const readKey = card ? cardReadKey(card.id, card.attempts) : undefined;
    const ticket: BrainTicket = await access.grant({ agentId: req.agentId, shelf, write, ...(readKey ? { readKey } : {}) });
    try {
      return await this.#runWith(goalId, cardId, {
        ...req,
        system: `${req.system}\n\n${brainRules(write)}`,
        brain: { endpoint: access.endpoint, token: ticket.token, write, doors: access.doors },
      }, onStop);
    } finally {
      await ticket.revoke();
    }
  }

  async #runWith(goalId: string | null, cardId: string | undefined, req: EngineRequest, onStop?: (stop: () => void) => void): Promise<EngineResult> {
    const info: RunInfo = {
      runId: `${req.agentId}#${++this.#runs}`,
      role: req.role,
      title: req.title ?? req.agentId,
      engine: req.route.engine,
      model: req.route.model,
      effort: req.route.effort,
      ...(req.route.reason ? { reason: req.route.reason } : {}),
    };
    const ids = { ...(goalId ? { goalId } : {}), ...(cardId ? { cardId } : {}), agentId: req.agentId };
    this.#emit({ type: 'run-started', ...ids, message: info.title, run: info });
    // The Watchdog watches the Queen and every insect (C2). The other runs are short, read-only and capped.
    const watched = { runId: info.runId, agentId: req.agentId, role: req.role, goalId, cardId: cardId ?? null };
    const watch = this.#watchdog && (req.role === 'queen' || isInsectRole(req.role)) ? this.#watchdog.watch(watched) : null;
    let stopNow: (() => void) | null = null;
    let result: EngineResult;
    try {
      const run = this.#o.engine.run({
        ...req,
        onEvent: (e) => {
          req.onEvent?.(e);
          this.#emit({ type: 'engine', ...ids, message: e.kind, engineEvent: e, run: info });
          const trip = watch?.event(e);
          if (watch && trip) this.#onTrip(watch, trip, () => stopNow?.());
        },
      });
      stopNow = run.stop;
      onStop?.(run.stop);
      if (watch) this.#watch(info.runId, watch, run.stop);
      result = this.#classifyLimit(await run.done);
    } catch (err) {
      this.#emit({ type: 'run-ended', ...ids, message: 'crash', run: { ...info, ok: false, error: 'crash' } });
      throw err;
    } finally {
      this.#unwatch(info.runId);
    }
    const tokens = runTokens(result.usage);
    if (watch && !watch.stopped && cardId && goalId) {
      const trip = this.#watchdog!.overspend(watched, tokens, this.#cardShare(goalId, cardId));
      if (trip) {
        this.#incident(watched, trip);
        if (trip.step === 'stop-agent') {
          this.#breakers.set(req.agentId, trip);
          this.#serious();
        }
      }
    }
    if (goalId) {
      this.#o.brain.goals.addSpend(goalId, tokens, result.costUsd);
      this.#maybeWarnBudget(goalId);
    }
    this.#recordOutcome(info.runId, goalId, cardId, req, result);
    if (result.error === 'quota') {
      const until = result.resetAt ?? null;
      this.#o.limits?.hit(req.route.engine, until, clip(result.text || result.stderrTail, 300));
    }
    this.#emit({
      type: 'run-ended',
      ...ids,
      message: result.ok ? 'ok' : (result.error ?? 'error'),
      run: { ...info, ...(result.model ? { model: result.model } : {}), ok: result.ok, ...(result.error ? { error: result.error } : {}), tokens, costUsd: result.costUsd },
    });
    return result;
  }

  // ---- the Watchdog (Hive 02-D9 P3, D12; Phase 2 C2) -------------------------------------------------

  #watch(runId: string, watch: RunWatch, stop: () => void): void {
    this.#watches.set(runId, { watch, stop });
    if (this.#stallTimer || !this.#watchdog) return;
    const every = Math.min(5_000, Math.max(50, Math.floor(this.#watchdog.t.stallMs / 4)));
    this.#stallTimer = setInterval(() => {
      for (const { watch: w, stop: s } of [...this.#watches.values()]) {
        const trip = w.idle();
        if (trip) this.#onTrip(w, trip, s);
      }
    }, every);
    this.#stallTimer.unref?.();
  }

  #unwatch(runId: string): void {
    this.#watches.delete(runId);
    if (this.#watches.size === 0 && this.#stallTimer) {
      clearInterval(this.#stallTimer);
      this.#stallTimer = null;
    }
  }

  /** A sensor tripped on a running agent: record it, then take the breaker step. */
  #onTrip(watch: RunWatch, trip: Trip, stop: () => void): void {
    this.#incident(watch.run, trip);
    if (trip.step === 'warn') return;
    watch.markStopped();
    if (trip.step === 'pause-hive') {
      // The Queen herself looped or stalled (02-D12): pause the hive and alert the user in the Hive monitor.
      stop();
      this.pause(`Watchdog: the Queen ${trip.sensor === 'stall' ? 'stalled' : 'kept repeating herself'} (${trip.evidence}) The hive is paused; resume it when you're ready.`);
      return;
    }
    this.#breakers.set(watch.run.agentId, trip);
    stop();
    this.#serious();
  }

  /** Store an incident and tell the Queen's feed. Bookkeeping trouble never stops the hive. */
  #incident(run: { runId: string; agentId: string; goalId: string | null; cardId: string | null }, trip: Trip): void {
    let incident: Incident | undefined;
    try {
      incident = this.#o.brain.incidents.record({
        sensor: trip.sensor,
        step: trip.step,
        agentId: run.agentId,
        runId: run.runId,
        goalId: run.goalId,
        cardId: run.cardId,
        evidence: trip.evidence,
        signature: trip.signature,
      });
    } catch {
      incident = undefined;
    }
    const verb = { warn: 'warned', 'pause-card': 'stopped and held the card of', 'stop-agent': 'stopped', 'pause-hive': 'paused the hive because of' }[trip.step];
    this.#emit({
      type: 'watchdog',
      ...(run.goalId ? { goalId: run.goalId } : {}),
      ...(run.cardId ? { cardId: run.cardId } : {}),
      agentId: run.agentId,
      message: `The Watchdog ${verb} ${run.agentId}: ${trip.evidence}`,
      ...(incident ? { incident } : {}),
    });
  }

  /** A serious trip (pause-card or worse); several within the window pause the whole hive. */
  #serious(): void {
    if (!this.#watchdog?.serious()) return;
    const t = this.#watchdog.t;
    const trip: Trip = {
      sensor: 'hive',
      step: 'pause-hive',
      evidence: `${t.hiveTrips} agents were stopped within ${Math.round(t.hiveWindowMs / 60_000)} minutes; something shared may be broken (the engine, the network or the project).`,
      signature: 'hive||',
    };
    this.#incident({ runId: 'hive', agentId: 'Watchdog', goalId: null, cardId: null }, trip);
    this.pause(`Watchdog: ${trip.evidence} The hive is paused; resume it when you're ready.`);
  }

  /** The Watchdog holds the card (breaker step "pause the card"); the Foreman wakes on the next pass. */
  #holdCard(card: BoardCard, evidence: string): void {
    try {
      this.#o.brain.taskboard.hold(card.id, 'Watchdog', clip(evidence, 200));
      this.#holdWake.set(card.id, 'held');
      this.#emit({ type: 'card-held', goalId: card.goalId, cardId: card.id, message: `"${card.title}" is held: ${clip(evidence, 200)} The Foreman decides what happens next.` });
    } catch {
      // A card that moved on meanwhile isn't held.
    }
  }

  /** The card's per-attempt share of its goal's budget (null when the goal has no budget or plan). */
  #cardShare(goalId: string, cardId: string): number | null {
    const goal = this.#o.brain.goals.get(goalId);
    const plan = goal?.plan as Plan | null | undefined;
    const cards = plan?.waves.flatMap((w) => w.cards).length ?? 0;
    const card = this.#o.brain.taskboard.get(cardId);
    if (!goal?.budgetTokens || !cards || !card) return null;
    return goal.budgetTokens / (cards * Math.max(1, card.maxAttempts));
  }

  /** A failed run whose text says a usage or rate limit stopped it becomes a `quota` result (Phase 2 A5). */
  #classifyLimit(result: EngineResult): EngineResult {
    if (result.ok || result.error === 'stopped' || result.error === 'timeout' || result.error === 'quota') return result;
    const limit = detectUsageLimit(`${result.text}
${result.stderrTail}`, this.#now());
    return limit.limited ? { ...result, error: 'quota', resetAt: limit.resetAt } : result;
  }

  /** One row per run in the Treasurer's memory. Finished insect runs wait for the Inspector (`pending`). */
  #recordOutcome(runId: string, goalId: string | null, cardId: string | undefined, req: EngineRequest, result: EngineResult): void {
    const card = cardId ? this.#o.brain.taskboard.get(cardId) : undefined;
    const insect = isInsectRole(req.role);
    const outcome = !result.ok
      ? result.error === 'auth' ? 'auth' : result.error === 'stopped' ? 'stopped' : result.error === 'quota' ? 'limit' : 'error'
      : insect ? 'pending' : 'pass';
    try {
      this.#o.brain.outcomes.record({
        runId: `${goalId ?? req.role}:${runId}`,
        goalId,
        cardId: cardId ?? null,
        role: req.role,
        priority: card?.priority ?? 'normal',
        engine: req.route.engine,
        tier: req.route.tier ?? 'standard',
        model: result.model ?? req.route.model,
        effort: req.route.effort,
        attempt: card?.attempts ?? 0,
        result: outcome,
        tokensIn: result.usage.input,
        tokensOut: result.usage.output,
        tokensCache: result.usage.cacheWrite,
        costUsd: result.costUsd,
        costEstimated: result.costEstimated ?? false,
        durationMs: result.durationMs,
        at: this.#now(),
        reason: req.route.reason ?? null,
      });
    } catch {
      // Bookkeeping must never stop the hive.
    }
  }

  /** After a vendor limit: rest the hive with a clear line if no engine can take this role any more. */
  #afterLimit(role: RouteInput['role']): void {
    if (this.#o.limits?.canRoute(role) ?? true) return;
    this.pause(`${LIMIT_PAUSE} every AI engine that can do this work is at its usage limit. The hive rests and carries on by itself when one frees up.`);
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #ask(a: Parameters<Brain['approvals']['create']>[0]): void {
    const item = this.#o.brain.approvals.create(a);
    this.#emit({ type: 'approval-needed', ...(a.goalId ? { goalId: a.goalId } : {}), message: item.title });
  }

  #listing(): string {
    try {
      return readdirSync(this.#o.repoDir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, 60)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n');
    } catch {
      return '';
    }
  }

  #emit(e: HiveEvent): void {
    this.#o.onEvent?.(e);
  }
}
