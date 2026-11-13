/**
 * Open a task card on the Taskboard, or a record in the Brain, from any screen (C2: the Watchdog panel,
 * the Foreman's decisions, the last review). Same pattern as library-nav: switch screens, and leave the
 * target here until the screen mounts and picks it up (or handles the event if it is already showing).
 */
const CARD_EVENT = 'insectoids:card-open';
const RECORD_EVENT = 'insectoids:brain-record-open';

export interface CardTarget {
  goalId: string | null;
  cardId: string;
}

let pendingCard: CardTarget | null = null;
let pendingRecord: string | null = null;

const navigate = (screen: string): void => {
  window.dispatchEvent(new CustomEvent('insectoids:navigate', { detail: screen }));
};

export function openCard(target: CardTarget): void {
  pendingCard = target;
  navigate('taskboard');
  window.dispatchEvent(new CustomEvent(CARD_EVENT, { detail: target }));
}

export const peekPendingCard = (): CardTarget | null => pendingCard;
export function clearPendingCard(): void {
  pendingCard = null;
}

export function onCardOpen(fn: (t: CardTarget) => void): () => void {
  const listener = (e: Event) => {
    const t = (e as CustomEvent<unknown>).detail as CardTarget | undefined;
    if (t && typeof t.cardId === 'string') {
      pendingCard = null;
      fn(t);
    }
  };
  window.addEventListener(CARD_EVENT, listener);
  return () => window.removeEventListener(CARD_EVENT, listener);
}

export function openBrainRecord(id: string): void {
  pendingRecord = id;
  navigate('brain');
  window.dispatchEvent(new CustomEvent(RECORD_EVENT, { detail: id }));
}

export const peekPendingRecord = (): string | null => pendingRecord;
export function clearPendingRecord(): void {
  pendingRecord = null;
}

export function onBrainRecordOpen(fn: (id: string) => void): () => void {
  const listener = (e: Event) => {
    const id = (e as CustomEvent<unknown>).detail;
    if (typeof id === 'string') {
      pendingRecord = null;
      fn(id);
    }
  };
  window.addEventListener(RECORD_EVENT, listener);
  return () => window.removeEventListener(RECORD_EVENT, listener);
}
