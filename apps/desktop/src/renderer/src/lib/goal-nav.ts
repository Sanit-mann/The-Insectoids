/**
 * Open a goal from any screen (Phase 3 A1: a cadence's run history links to the goal it started). Switches to
 * the Queen screen, where every goal is an <article data-goal-id>, then scrolls to it and moves focus there.
 */
export function openGoal(goalId: string): void {
  window.dispatchEvent(new CustomEvent('insectoids:navigate', { detail: 'queen' }));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let tries = 0;
  const find = (): void => {
    const el = document.querySelector<HTMLElement>(`[data-goal-id="${CSS.escape(goalId)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
      return;
    }
    if (++tries < 40) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
}
