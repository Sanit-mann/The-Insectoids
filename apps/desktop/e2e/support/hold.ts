import type { ElementHandle, Locator, Page } from '@playwright/test';

/**
 * Press and hold a hold-to-confirm button (Kokonut UI `hold-button`) until it says it is done.
 *
 * A fixed wait is not enough: the button needs ~1.2 s of held time, and on a busy machine (several
 * Electron apps running tests in parallel) things can run late. So this holds until the button marks
 * itself `data-complete`, or leaves the page because its action removed it, up to `maxMs`.
 *
 * - The button is pinned to one element first: some buttons rename themselves while held ("Keep
 *   holding"), so a locator by name would stop matching halfway and let go too early.
 * - If the page shifts under the pointer, the button rightly cancels the hold (pointer left). Then
 *   this measures it again and presses again, like a person would.
 */
export async function holdUntilDone(page: Page, button: Locator, maxMs = 10_000): Promise<void> {
  await button.scrollIntoViewIfNeeded();
  const el = await button.elementHandle();
  if (!el) throw new Error('The hold button is not on the page.');
  const end = Date.now() + maxMs;
  try {
    for (;;) {
      await press(page, el);
      let idleSince: number | null = null;
      for (;;) {
        const state = await stateOf(el);
        if (state === 'done' || state === 'gone') return;
        if (Date.now() > end) throw new Error(`The hold button did not complete within ${maxMs} ms.`);
        if (state === 'idle') {
          idleSince ??= Date.now();
          // Not holding for a while after the press: the hold was cancelled. Press again.
          if (Date.now() - idleSince > 300) break;
        } else idleSince = null;
        await page.waitForTimeout(100);
      }
      await page.mouse.up();
    }
  } finally {
    await page.mouse.up();
    await page.mouse.move(0, 0);
    await el.dispose();
  }
}

async function press(page: Page, el: ElementHandle): Promise<void> {
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error('The hold button is not on screen.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

function stateOf(el: ElementHandle): Promise<'done' | 'gone' | 'holding' | 'idle'> {
  return el.evaluate((node) => {
    const n = node as unknown as { isConnected: boolean; hasAttribute: (a: string) => boolean };
    if (!n.isConnected) return 'gone';
    if (n.hasAttribute('data-complete')) return 'done';
    return n.hasAttribute('data-holding') ? 'holding' : 'idle';
  });
}
