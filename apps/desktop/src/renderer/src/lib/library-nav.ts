/**
 * Open one library item from anywhere (a card's skill chip, a caste's default skill): switch to the
 * Library screen and show that item. The name waits here until the Library screen picks it up.
 */
const EVENT = 'insectoids:library-open';
let pending: string | null = null;

export function openLibraryItem(name: string): void {
  pending = name;
  window.dispatchEvent(new CustomEvent('insectoids:navigate', { detail: 'library' }));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: name }));
}

/** The item someone asked to open before the Library screen mounted (pure, so StrictMode's double render is safe). */
export function peekPendingLibraryItem(): string | null {
  return pending;
}

/** Called once the Library screen has shown the pending item. */
export function clearPendingLibraryItem(): void {
  pending = null;
}

/** Calls `fn` when an item is opened while the Library screen is already showing. */
export function onLibraryOpen(fn: (name: string) => void): () => void {
  const listener = (e: Event) => {
    const name = (e as CustomEvent<unknown>).detail;
    if (typeof name === 'string') {
      pending = null;
      fn(name);
    }
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
