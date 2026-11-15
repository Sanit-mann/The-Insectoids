import type { CardContainer, ContainerSettings, ContainerStatus } from '@insectoids/shared';

/**
 * Plain words for container mode (Phase 4 D2), shared by Settings, the Queen's goal view and the Taskboard so the
 * three places never describe the same choice differently.
 */

/** The three settings, in the order they're offered, each with the one line that says exactly what it does. */
export const CONTAINER_MODES: ReadonlyArray<{ mode: ContainerSettings['mode']; label: string; sentence: string }> = [
  {
    mode: 'off',
    label: 'Off',
    sentence: 'Commands run on this computer, guarded as usual. Only goals you mark "Run this goal\'s cards in containers" use one.',
  },
  {
    mode: 'auto',
    label: 'When needed',
    sentence:
      'Containers for cards the Queen marks as risky, cards the Watchdog moves after they got stuck, and goals you mark. Everything else runs on this computer.',
  },
  { mode: 'always', label: 'Every card', sentence: "Every card's commands run in a container." },
];

export const modeLabel = (mode: ContainerSettings['mode']): string => CONTAINER_MODES.find((m) => m.mode === mode)?.label ?? mode;

/**
 * Why containers can't be used right now, or null when Docker (or Podman) is running and the image is here. This is
 * about the runtime and image only, not the setting: a goal the user forces needs them even with the setting Off.
 */
export function notReadyWords(s: ContainerStatus): string | null {
  const name = s.runtime.kind === 'podman' ? 'Podman' : 'Docker';
  switch (s.runtime.state) {
    case 'checking':
      return "Docker isn't ready yet: the app is still looking for Docker or Podman.";
    case 'missing':
      return "Docker isn't ready yet: neither Docker nor Podman is on this computer.";
    case 'not-running':
      return `${name} isn't ready yet: it's installed but not running.`;
    case 'ready':
      if (s.pulling) return `${name} isn't ready yet: the image is still downloading.`;
      return s.imagePresent === true ? null : `${name} isn't ready yet: the container image isn't on this computer.`;
  }
}

/** The chip on a card: short words first (they carry the meaning; the icon only repeats them). */
export const CHIP_WORDS: Record<CardContainer['state'], string> = {
  container: 'In a container',
  waiting: 'Waiting for containers',
  suggested: 'Container suggested',
};

/** What each state means for the card, for the detail view (under the hive's own reason). */
export const STATE_MEANS: Record<CardContainer['state'], string> = {
  container: "Its commands run in a throwaway container that sees only this card's folder.",
  waiting: "It needs a container, but Docker or the image isn't ready, so it waits. It never runs on this computer instead.",
  suggested: 'Containers are off, so it runs on this computer, guarded as usual. Choose "When needed" in Settings → Containers to use one.',
};

/** Who asked for the container, for the detail view. */
export const SOURCE_WORDS: Record<CardContainer['source'], string> = {
  queen: 'The Queen marked it',
  watchdog: 'The Watchdog moved it',
  goal: 'You chose containers for this goal',
  always: 'The setting is "Every card"',
};

/** Opens Settings (the Containers section is there); App listens for this from any screen. */
export function openContainerSettings(): void {
  window.dispatchEvent(new CustomEvent('insectoids:navigate', { detail: 'settings' }));
}
