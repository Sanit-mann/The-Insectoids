/**
 * Container mode (Phase 4 D1; Workspace & Safety 06-D4): a card's shell commands run inside a Docker or Podman
 * container instead of on the user's computer. It rides along in the guard policy (`HookPolicy.container`), so
 * every place that runs a card's commands sees it:
 * - the hive tools' `run_shell` runs each command as a throwaway container (see `containerRunArgs` in
 *   @insectoids/workspace) with only the card's worktree mounted at /work;
 * - the Claude Code hook blocks Claude's own Bash in container mode and points it at the hive's run_shell.
 *
 * Network inside a container is all or nothing (a container can't filter by site): castes with no network or
 * documentation-only network get none; castes with the open web get it (the user's decision, 2026-11-15).
 * Running a whole CLI inside a container is a later step.
 */
export type ContainerRuntimeKind = 'docker' | 'podman';
export type ContainerNetwork = 'none' | 'open';

export interface ContainerPolicy {
  runtime: ContainerRuntimeKind;
  /** The runtime program, resolved to a real executable (never started through a shell). */
  command: string;
  /** Leading arguments for that program (tests: the fake runtime is a script started by Node). */
  commandArgs?: string[];
  /** Image reference, pinned (tag and digest), e.g. node:22.23.3-bookworm-slim@sha256:…. */
  image: string;
  network: ContainerNetwork;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  /**
   * Unique per run: containers are named `<name>-<n>` and labelled `io.insectoids.run=<name>`, so a timeout
   * can kill one by name and the hive can remove anything a crash left behind by label.
   */
  name: string;
}

/** The caste's network rule inside a container: docs-only can't be enforced there, so it becomes none. */
export function containerNetworkFor(network: 'none' | 'docs' | 'web'): ContainerNetwork {
  return network === 'web' ? 'open' : 'none';
}

/** Where the worktree appears inside the container. */
export const CONTAINER_WORKDIR = '/work';
