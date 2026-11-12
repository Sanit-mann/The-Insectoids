import type { ScreenId } from '@/screens';

/** Event the app shell listens for to switch screens (e.g. "Open Approvals" from Changes). */
export const NAVIGATE_EVENT = 'insectoids:navigate';

export function openScreen(id: ScreenId): void {
  window.dispatchEvent(new CustomEvent<ScreenId>(NAVIGATE_EVENT, { detail: id }));
}
