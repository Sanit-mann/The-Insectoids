/**
 * Kanban board, adapted from Cult UI `kanban-board` (https://cult-ui.com, MIT).
 *
 * Kept from Cult UI: column header (status icon, title, animated count), cards that enter/leave and
 * move between columns with a shared-layout spring, reduced-motion support.
 * Changed for The Insectoids: read-only (only the hive moves cards, Hive 02-D10), so drag-and-drop is
 * gone; cards are buttons with roving focus (arrow keys move within and across columns, Enter opens);
 * colours come from our design tokens; card content is rendered by the caller.
 */
import { type ReactNode, type KeyboardEvent, useRef } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

export type ColumnTone = 'idle' | 'working' | 'blocked' | 'waiting' | 'done';

export interface KanbanColumn<T> {
  id: string;
  title: string;
  tone: ColumnTone;
  cards: T[];
}

export interface KanbanBoardProps<T> {
  columns: KanbanColumn<T>[];
  getId: (card: T) => string;
  /** Accessible name for a card button (e.g. its title and status). */
  getLabel: (card: T) => string;
  renderCard: (card: T, ctx: { selected: boolean; columnId: string }) => ReactNode;
  selectedId?: string | null;
  onOpen: (id: string) => void;
  /** Shown inside an empty column. */
  emptyText?: string;
  className?: string;
}

const springTransition = { type: 'spring' as const, stiffness: 500, damping: 30 };
const gentleSpring = { type: 'spring' as const, stiffness: 300, damping: 26 };

const cardVariants = {
  initial: { opacity: 0, y: 8, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -6, scale: 0.98 },
};

const TONE_STROKE: Record<ColumnTone, string> = {
  idle: 'var(--st-idle)',
  working: 'var(--st-working)',
  blocked: 'var(--st-blocked)',
  waiting: 'var(--st-waiting)',
  done: 'var(--st-done)',
};

function ColumnIcon({ tone }: { tone: ColumnTone }) {
  const common = { 'aria-hidden': true, fill: 'none', height: 13, width: 13, viewBox: '0 0 24 24', stroke: TONE_STROKE[tone], strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth: 2.2 };
  if (tone === 'working') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    );
  }
  if (tone === 'done') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  }
  if (tone === 'blocked') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12h8" />
      </svg>
    );
  }
  if (tone === 'waiting') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

export function KanbanBoard<T>({ columns, getId, getLabel, renderCard, selectedId, onOpen, emptyText = 'Nothing here', className }: KanbanBoardProps<T>) {
  const reduce = useReducedMotion();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const focusCard = (col: number, row: number): void => {
    const column = columns[col];
    const card = column?.cards[Math.max(0, Math.min(row, column.cards.length - 1))];
    if (card) refs.current.get(getId(card))?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, col: number, row: number): void => {
    const move: Record<string, () => void> = {
      ArrowDown: () => focusCard(col, row + 1),
      ArrowUp: () => focusCard(col, row - 1),
      ArrowRight: () => {
        for (let c = col + 1; c < columns.length; c++) if (columns[c]!.cards.length) return focusCard(c, row);
      },
      ArrowLeft: () => {
        for (let c = col - 1; c >= 0; c--) if (columns[c]!.cards.length) return focusCard(c, row);
      },
      Home: () => focusCard(col, 0),
      End: () => focusCard(col, Number.MAX_SAFE_INTEGER),
    };
    const fn = move[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  // Roving tabindex: one tab stop for the whole board (the selected card, else the first card).
  const first = columns.flatMap((c) => c.cards)[0];
  const tabStop = selectedId ?? (first ? getId(first) : null);

  return (
    <LayoutGroup>
      <div className={cn('grid min-w-0 grid-cols-[repeat(auto-fit,minmax(176px,1fr))] items-start gap-3 pb-2', className)}>
        {columns.map((column, ci) => (
          <section key={column.id} aria-label={`${column.title}, ${column.cards.length} card${column.cards.length === 1 ? '' : 's'}`} className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-line bg-surface/60 p-2.5">
            <div className="mb-2.5 flex items-center gap-[7px] px-1">
              <ColumnIcon tone={column.tone} />
              <span className="font-display text-[13px] font-semibold">{column.title}</span>
              <motion.span
                key={column.cards.length}
                initial={reduce ? false : { scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={springTransition}
                className="ml-auto text-xs font-semibold tabular-nums text-muted"
                aria-hidden="true"
              >
                {column.cards.length}
              </motion.span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              <AnimatePresence initial={false} mode="popLayout">
                {column.cards.map((card, ri) => {
                  const id = getId(card);
                  const selected = id === selectedId;
                  return (
                    <motion.li
                      key={id}
                      {...(reduce ? {} : { layout: true, layoutId: id })}
                      variants={cardVariants}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      transition={{ ...gentleSpring, layout: springTransition }}
                    >
                      <button
                        ref={(el) => {
                          if (el) refs.current.set(id, el);
                          else refs.current.delete(id);
                        }}
                        type="button"
                        tabIndex={id === tabStop ? 0 : -1}
                        aria-pressed={selected}
                        onClick={() => onOpen(id)}
                        onKeyDown={(e) => onKey(e, ci, ri)}
                        className={cn(
                          'flex w-full flex-col gap-1.5 rounded-[14px] border bg-surface px-3 py-2.5 text-left text-text transition-colors hover:border-[#4a4232]',
                          selected ? 'border-honey' : 'border-line',
                        )}
                      >
                        {/*
                          The name is the one-line summary; the card face is for the eye (an aria-label over visible
                          text it doesn't contain fails label-in-name, WCAG 2.5.3).
                        */}
                        <span className="sr-only">{getLabel(card)}</span>
                        <span aria-hidden="true" className="contents">
                          {renderCard(card, { selected, columnId: column.id })}
                        </span>
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
              {column.cards.length === 0 && <li className="px-1 py-3 text-xs text-muted">{emptyText}</li>}
            </ul>
          </section>
        ))}
      </div>
    </LayoutGroup>
  );
}
