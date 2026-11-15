import { randomBytes } from 'node:crypto';
import { type ContainerPolicy, type ContainerRuntimeKind, containerNetworkFor } from '@insectoids/reflexes';
import type { HookPolicy } from '@insectoids/reflexes';

/**
 * Container mode in the hive (Phase 4 D1; Workspace & Safety 06-D4). The app (the Brain host) knows the user's
 * setting and whether Docker or Podman and the image are ready; the hive asks it at the start of every card run
 * that may run commands (insects doing work, and the Inspector checking it) and turns the answer into the run's
 * `guard.container`. The Queen's planning and the other read-only roles never run commands, so they never ask.
 *
 * Off: commands run on the computer, guarded as before. On but not usable: the run is refused in plain words. It
 * never falls back to the computer, since the user asked for commands to stay off it.
 */
export type HiveContainerSetup =
  | { mode: 'off' }
  | {
      mode: 'always';
      usable: true;
      runtime: ContainerRuntimeKind;
      command: string;
      commandArgs: string[];
      image: string;
      cpus: number;
      memoryMb: number;
      pidsLimit: number;
    }
  | { mode: 'always'; usable: false; reason: string };

/** What one card run gets: no container, a container, or a refusal (its reason in plain words). */
export type ContainerChoice = { container: ContainerPolicy } | { refused: string } | null;

/**
 * Pause reasons that start with this are container mode's: the app resumes the hive by itself once containers
 * are ready again or the user switches container mode off (like the Treasurer's LIMIT_PAUSE).
 */
export const CONTAINER_PAUSE = 'Container mode:';

/**
 * A container name for one run: lowercase letters, digits and dashes only (what Docker and Podman accept and what
 * the runtime layer labels and kills by), unique per run even across restarts of the app: the agent, a counter,
 * and a random part.
 */
export function containerRunName(agentId: string, n: number): string {
  const who = agentId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '') || 'run';
  return `insectoids-${who}-${n}-${randomBytes(3).toString('hex')}`;
}

/** The container decision for one run, from the app's setup and the run's network rule (its caste's). */
export function chooseContainer(setup: HiveContainerSetup | undefined, network: HookPolicy['network'], name: string): ContainerChoice {
  if (!setup || setup.mode === 'off') return null;
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
