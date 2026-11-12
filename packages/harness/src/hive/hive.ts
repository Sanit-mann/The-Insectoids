import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Caste } from '@insectoids/shared';
import type { ApprovalItem, BoardCard, Brain, Goal } from '@insectoids/brain';
import type { Workspace } from '@insectoids/workspace';
import type { ClaudeEvent } from '../claude/stream';
import { type BrainAccess, type BrainTicket, brainWriteAccess } from './brain-access';
import type { Engine, EngineRequest, EngineResult } from './engine';
import { type Library, brainRules, inspectorPrompt, insectPrompt, queenPrompt } from './prompts';
import { type Plan, parsePlan, parseStatus, parseVerdict } from './protocol';
import { type ModelTiers, type Route, type RouteInput, budgetState, routeCard, runTokens } from './router';

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
  onEvent?: (e: HiveEvent) => void;
}

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
    | 'resumed'
    | 'run-started'
    | 'run-ended'
    | 'goal-cancelled'
    | 'card-undone'
    | 'goal-undone'
    | 'merge-undone'
    | 'merge-redone';
  goalId?: string;
  cardId?: string;
  agentId?: string;
  message: string;
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
  /** run-ended only. */
  ok?: boolean;
  error?: string;
  tokens?: number;
  costUsd?: number;
}

/** Where a goal stands on the user's branch (Workspace 06-D3, D6). */
export type MergeState = 'not-merged' | 'awaiting-approval' | 'merged' | 'undone';

interface Job {
  kind: 'insect' | 'inspector';
  cardId: string;
  done: Promise<void>;
  stop(): void;
}

const NETWORK: Record<Caste, 'none' | 'docs' | 'web'> = {
  coder: 'docs', tester: 'docs', reviewer: 'docs', documenter: 'docs', designer: 'docs',
  researcher: 'web', analyst: 'web', writer: 'web',
};
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
  readonly #deciding = new Set<string>();
  #paused = false;
  /** "Ask" rules the user approved, per card (Hive 02-D7). */
  readonly #approved = new Map<string, string[]>();
  /** Last failure note per card, for the next attempt's brief. */
  readonly #lastFailure = new Map<string, string>();

  constructor(o: HiveOptions) {
    this.#o = { leaseMs: 20 * 60_000, defaultBudgetTokens: 2_000_000, ...o };
  }

  #route(input: RouteInput): Route {
    return this.#o.route ? this.#o.route(input) : routeCard(input, this.#o.models);
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
  async submitGoal(text: string, opts: { title?: string; budgetTokens?: number } = {}): Promise<Goal> {
    const { brain } = this.#o;
    const goal = brain.goals.create({ title: opts.title ?? clip(text.split('\n')[0]!, 60), text, shelf: this.#o.shelf, budgetTokens: opts.budgetTokens ?? this.#o.defaultBudgetTokens! });
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
    if (big || this.#o.approveEveryPlan) {
      brain.goals.setStatus(goal.id, 'awaiting_approval');
      this.#ask({
        goalId: goal.id,
        kind: 'plan',
        title: `Approve the plan for "${goal.title}"`,
        from: 'Queen',
        whyItNeedsYou: big
          ? 'The plan has more than one wave, so it counts as big (Hive D11).'
          : 'Your safety preset (Careful) asks you to approve every plan.',
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
    brain.taskboard.sweepExpiredLeases();
    for (const goal of brain.goals.list('running')) {
      if (this.#paused) break;
      this.#inspectReviews(goal);
      this.#dispatch(goal);
      await this.#advance(goal);
    }
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
    const base = queenPrompt(library, {
      goal: goal.text,
      bootCard: brain.bootCard(goal.shelf),
      context: brain.read(goal.text, { shelf: goal.shelf, tokenBudget: 800 }).text,
      castes,
      projectListing: this.#listing(),
    });
    let task = base.task;
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
      if (!result.ok) return null;
      const parsed = parsePlan(result.text, { castes });
      if (parsed.ok) return parsed.plan;
      task = `${base.task}\n\nYour previous plan was not valid: ${parsed.error}\nReply again with only the corrected JSON plan.`;
    }
    return null;
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
    let progress = true;
    while (progress && insects() < this.#o.insectCap) {
      progress = false;
      for (const caste of this.#o.castes) {
        if (insects() >= this.#o.insectCap) break;
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
        cardPath = (await workspace.createCard(goal.id, id, { linkDependencies: this.#o.linkDependencies ?? [] })).path;
        brain.taskboard.start(card.id, agentId);
      }
      this.#emit({ type: 'card-started', goalId: goal.id, cardId: card.id, agentId, message: card.title });

      const beat = setInterval(() => brain.taskboard.heartbeat(card.id, agentId, this.#o.leaseMs!), Math.max(1_000, this.#o.leaseMs! / 3));
      const prompt = insectPrompt(this.#o.library, card.caste, {
        id: local(card.id),
        title: card.title,
        brief: resumeNote ? `${card.brief}\n\n${resumeNote}` : card.brief,
        acceptance: card.acceptance,
        attempts: card.attempts,
        ...(this.#lastFailure.has(card.id) ? { lastFailure: this.#lastFailure.get(card.id)! } : {}),
      }, brain.bootCard(goal.shelf));
      const asks: string[] = [];
      let result: EngineResult;
      try {
        result = await this.#runEngine(goal.id, card.id, {
          role: card.caste,
          agentId,
          title: card.title,
          cwd: cardPath,
          system: prompt.system,
          task: prompt.task,
          route: this.#route({ role: card.caste, priority: card.priority, attempts: card.attempts }),
          guard: {
            workspace: cardPath,
            home: this.#o.home,
            linkedPaths: (this.#o.linkDependencies ?? []).map((n) => join(cardPath, n)),
            noGo: this.#o.noGo ?? [],
            network: NETWORK[card.caste],
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

      if (!result.ok) {
        if (result.error === 'auth') {
          brain.taskboard.block(card.id, agentId, 'The AI engine is signed out.');
          this.pause('Claude Code is signed out. Sign in, then resume the hive.');
          return;
        }
        this.#lastFailure.set(card.id, `${result.error}: ${clip(result.text || result.stderrTail, 300)}`);
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
      const result = await this.#runEngine(goal.id, card.id, {
        role: 'inspector',
        agentId: 'Inspector',
        title: `Verify: ${card.title}`,
        cwd: cardPath,
        system: prompt.system,
        task: prompt.task,
        route: this.#route({ role: 'inspector', priority: card.priority, attempts: 0 }),
        guard: { workspace: cardPath, home: this.#o.home, noGo: this.#o.noGo ?? [], network: 'none' },
      }, (stop) => (stopRun = stop));

      if (!result.ok && result.error === 'auth') {
        this.pause('Claude Code is signed out. Sign in, then resume the hive.');
        return;
      }
      const verdict = result.ok ? parseVerdict(result.text) : { verdict: 'fail' as const, note: `Inspector run failed (${result.error}).` };
      if (verdict.verdict === 'pass') {
        const merge = await workspace.mergeCard(goal.id, id, card.title);
        if (merge.ok) {
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
      const after = brain.taskboard.review(card.id, { verdict: 'fail', by: 'Inspector', note: verdict.note });
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
    if (cards.some((c) => c.status === 'failed')) {
      brain.goals.setStatus(goal.id, 'stuck');
      this.#emit({ type: 'goal-stuck', goalId: goal.id, message: 'A card failed after all its attempts; the Queen needs to re-plan with you.' });
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

  async #runEngine(goalId: string, cardId: string | undefined, req: EngineRequest, onStop?: (stop: () => void) => void): Promise<EngineResult> {
    const access = this.#o.brainAccess;
    if (!access) return this.#runWith(goalId, cardId, req, onStop);
    // One token per run, scoped to this agent and the goal's shelf; it dies with the run, whatever happens.
    const write = brainWriteAccess(req.role);
    const shelf = this.#o.brain.goals.get(goalId)?.shelf ?? this.#o.shelf;
    const ticket: BrainTicket = await access.grant({ agentId: req.agentId, shelf, write });
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

  async #runWith(goalId: string, cardId: string | undefined, req: EngineRequest, onStop?: (stop: () => void) => void): Promise<EngineResult> {
    const info: RunInfo = {
      runId: `${req.agentId}#${++this.#runs}`,
      role: req.role,
      title: req.title ?? req.agentId,
      engine: req.route.engine,
      model: req.route.model,
      effort: req.route.effort,
    };
    const ids = { goalId, ...(cardId ? { cardId } : {}), agentId: req.agentId };
    this.#emit({ type: 'run-started', ...ids, message: info.title, run: info });
    let result: EngineResult;
    try {
      const run = this.#o.engine.run({
        ...req,
        onEvent: (e) => {
          req.onEvent?.(e);
          this.#emit({ type: 'engine', ...ids, message: e.kind, engineEvent: e, run: info });
        },
      });
      onStop?.(run.stop);
      result = await run.done;
    } catch (err) {
      this.#emit({ type: 'run-ended', ...ids, message: 'crash', run: { ...info, ok: false, error: 'crash' } });
      throw err;
    }
    const tokens = runTokens(result.usage);
    this.#o.brain.goals.addSpend(goalId, tokens, result.costUsd);
    this.#emit({
      type: 'run-ended',
      ...ids,
      message: result.ok ? 'ok' : (result.error ?? 'error'),
      run: { ...info, ...(result.model ? { model: result.model } : {}), ok: result.ok, ...(result.error ? { error: result.error } : {}), tokens, costUsd: result.costUsd },
    });
    return result;
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
