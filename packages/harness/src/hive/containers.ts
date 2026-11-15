import { randomBytes } from 'node:crypto';
import { type ContainerPolicy, type ContainerRuntimeKind, containerNetworkFor } from '@insectoids/reflexes';
import type { HookPolicy } from '@insectoids/reflexes';
import type { CardContainer, ContainerSettings, GoalContainers } from '@insectoids/shared';

/**
 * Container mode in the hive (Phase 4 D1, D2; Workspace & Safety 06-D4). The app (the Brain host) knows the user's
 * setting and whether Docker or Podman and the image are ready; the hive asks it at the start of every card run
 * that may run commands (insects doing work, and the Inspector checking it) and turns the answer into the run's
 * `guard.container`. The Queen's planning and the other read-only roles never run commands, so they never ask.
 *
 * Who chooses (D2), per card run, highest first: the setting "always" (every card); the user forcing containers for
 * the goal (even with the setting off: their explicit choice); with the setting "auto", the Watchdog's move after the
 * card got stuck, then the Queen's mark in the plan. With the setting "off" a Queen mark is only shown as a suggestion.
 *
 * Whenever the answer is "a container" but containers aren't usable, the run is refused in plain words. It never
 * falls back to the computer, since a container was asked for.
 */

/** Docker or Podman and the image, as the app found them right now. */
export type ContainerRuntimeSetup =
  | {
      usable: true;
      runtime: ContainerRuntimeKind;
      command: string;
      commandArgs: string[];
      image: string;
      cpus: number;
      memoryMb: number;
      pidsLimit: number;
    }
  | { usable: false; reason: string };

/**
 * The user's setting and the runtime. `{ mode: 'off' }` alone means off with nothing known about the runtime (older
 * callers and tests): a goal the user forces into containers is then refused, never run on the computer.
 */
export type HiveContainerSetup = { mode: 'off' } | ({ mode: ContainerSettings['mode'] } & ContainerRuntimeSetup);

/** What one card run gets: no container, a container, or a refusal (its reason in plain words). */
export type ContainerChoice = { container: ContainerPolicy } | { refused: string } | null;

/**
 * Pause reasons that start with this are container mode's: the app resumes the hive by itself once containers
 * are ready again or no waiting card needs one any more (like the Treasurer's LIMIT_PAUSE).
 */
export const CONTAINER_PAUSE = 'Container mode:';

/** Why a run is refused when the app gave no runtime details at all. */
const NOT_SET_UP = 'Docker or Podman isn’t set up for this app yet. See the Containers settings.';

/** Can cards run in containers right now (runtime running, image here), whatever the setting? */
export function containersUsable(setup: HiveContainerSetup | undefined): boolean {
  return Boolean(setup && 'usable' in setup && setup.usable);
}

/** Why containers can't be used right now, in plain words (only meaningful when they aren't usable). */
export function containersProblem(setup: HiveContainerSetup | undefined): string {
  return setup && 'usable' in setup && !setup.usable ? setup.reason : NOT_SET_UP;
}

/**
 * A container name for one run: lowercase letters, digits and dashes only (what Docker and Podman accept and what
 * the runtime layer labels and kills by), unique per run even across restarts of the app: the agent, a counter,
 * and a random part.
 */
export function containerRunName(agentId: string, n: number): string {
  const who = agentId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '') || 'run';
  return `insectoids-${who}-${n}-${randomBytes(3).toString('hex')}`;
}

/**
 * The container decision for one run, from the app's setup and the run's network rule (its caste's). `wanted` says
 * whether this run should be in a container (the D2 rule, see `containerWant`); by default only the setting
 * "always" wants one (D1).
 */
export function chooseContainer(
  setup: HiveContainerSetup | undefined,
  network: HookPolicy['network'],
  name: string,
  wanted: boolean = setup?.mode === 'always',
): ContainerChoice {
  if (!setup || !wanted) return null;
  if (!('usable' in setup)) return { refused: NOT_SET_UP };
  if (!setup.usable) return { refused: setup.reason };
  return {
    container: {
      runtime: setup.runtime,
      command: setup.command,
      commandArgs: [...setup.commandArgs],
      image: setup.image,
      // Docs-only can't be filtered inside a container (it's all or nothing), so it becomes none (user decision).
      network: containerNetworkFor(network),
      cpus: setup.cpus,
      memoryMb: setup.memoryMb,
      pidsLimit: setup.pidsLimit,
      name,
    },
  };
}

/** What decides one card's container: the setting, the goal's choice, the Queen's mark and the Watchdog's move. */
export interface ContainerWantInput {
  mode: ContainerSettings['mode'];
  goal: GoalContainers;
  /** The Queen's reason in the plan ("it installs packages"), or null when she didn't mark the card. */
  queenMark: string | null;
  /** The Watchdog's move kept on the card (plain words), or null when it never moved it. */
  watchdogMove: string | null;
}

/** Who wants a container for the card, and whether its runs use one (false: only suggested, it runs on the computer). */
export interface ContainerWant {
  source: CardContainer['source'];
  wanted: boolean;
  reason: string;
}

const sentence = (s: string): string => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * The D2 rule for one card, highest first: always > goal > watchdog > queen. Null: nothing to say, its commands run
 * on the computer as before. The setting "off" never runs a card in a container because of the Queen or the
 * Watchdog; only the user's own choice for the goal does.
 */
export function containerWant(i: ContainerWantInput): ContainerWant | null {
  if (i.mode === 'always') return { source: 'always', wanted: true, reason: 'Container mode is set to every card.' };
  if (i.goal === 'always') return { source: 'goal', wanted: true, reason: 'You chose containers for every card of this goal.' };
  if (i.mode === 'auto' && i.watchdogMove) return { source: 'watchdog', wanted: true, reason: sentence(i.watchdogMove) };
  if (i.queenMark) {
    const mark = `The Queen marked it: ${sentence(i.queenMark)}`;
    return i.mode === 'auto'
      ? { source: 'queen', wanted: true, reason: mark }
      : { source: 'queen', wanted: false, reason: `${mark} Containers are off, so it runs on this computer, guarded as usual.` };
  }
  return null;
}

/** The card's container status in words (the Hive screen), from the rule and whether containers are usable now. */
export function cardContainerView(want: ContainerWant | null, setup: HiveContainerSetup | undefined): CardContainer | null {
  if (!want) return null;
  if (!want.wanted) return { source: want.source, state: 'suggested', reason: want.reason };
  if (containersUsable(setup)) return { source: want.source, state: 'container', reason: want.reason };
  return { source: want.source, state: 'waiting', reason: `${want.reason} It waits, never running on this computer instead: ${containersProblem(setup)}` };
}

/** The most a Queen's mark may say; longer reasons are clipped (it's a short status on the card). */
export const MAX_CONTAINER_MARK = 120;

/**
 * The Queen's container mark for a card, from the plan: a short plain-words reason, or null. Loose like `skills`: a
 * value that isn't usable text is dropped, never a reason to reject the plan.
 */
export function planContainerMark(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const one = raw.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length <= MAX_CONTAINER_MARK ? one : `${one.slice(0, MAX_CONTAINER_MARK - 1).trimEnd()}…`;
}
