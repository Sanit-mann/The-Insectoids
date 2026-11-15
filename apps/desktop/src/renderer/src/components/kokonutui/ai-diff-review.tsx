/**
 * Adapted from Kokonut UI "AI Diff Review" (https://kokonutui.com, MIT, @kokonutui, v1.1.0).
 * Kept: the file rows, five-block change bar, numbered hunk lines and the measured-height collapse.
 * Changed for The Insectoids: read-only (the hive already committed the card; Undo lives next to it),
 * real git statuses (added / modified / deleted / renamed), old and new line numbers, +/− signs and a
 * text label so changes are never colour-only, our design tokens, and no demo data.
 */
import { ChevronRight } from 'lucide-react';
import { MotionConfig, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { type DiffFile, type DiffHunk, type DiffLine, countLines } from '@/components/changes/parse-diff';
import { cn } from '@/lib/utils';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ReviewFile {
  path: string;
  status: FileStatus;
  /** Parsed hunks for this file; absent when the patch did not include it (e.g. cut off). */
  diff?: DiffFile | undefined;
}

interface AIDiffReviewProps {
  files: ReviewFile[];
  /** The patch was cut off for size. */
  truncated?: boolean;
  className?: string;
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const HEIGHT_SPRING = { type: 'spring', duration: 0.32, bounce: 0 } as const;

const STATUS_LABEL: Record<FileStatus, string> = { added: 'new', modified: 'changed', deleted: 'deleted', renamed: 'renamed' };
const STATUS_STYLE: Record<FileStatus, string> = {
  added: 'border-st-done/40 text-st-done',
  modified: 'border-st-waiting/40 text-st-waiting',
  deleted: 'border-st-blocked/40 text-st-blocked',
  renamed: 'border-st-paused/40 text-st-paused',
};

/** GitHub-style five-block bar: how much of the change adds vs. removes. */
function ChangeBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const green = total === 0 ? 0 : Math.round((added / total) * 5);
  return (
    <span aria-hidden="true" className="hidden gap-px sm:flex">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn('size-1.5 rounded-[1px]', total === 0 ? 'bg-line' : i < green ? 'bg-st-done' : 'bg-st-blocked')} />
      ))}
    </span>
  );
}

const LINE_STYLE: Record<DiffLine['type'], string> = {
  add: 'bg-st-done/10 text-text',
  remove: 'bg-st-blocked/10 text-text',
  context: 'text-muted',
  note: 'text-muted italic',
};
const LINE_SIGN: Record<DiffLine['type'], string> = { add: '+', remove: '−', context: ' ', note: ' ' };

function Hunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="py-1">
      <div className="px-3 py-0.5 font-mono text-[11px] text-muted">{hunk.header}</div>
      {hunk.lines.map((line, i) => (
        <div key={i} className={cn('flex font-mono text-xs leading-5', LINE_STYLE[line.type])} data-line={line.type}>
          <span className="w-10 shrink-0 select-none pr-1 text-right text-muted/70 tabular-nums">{line.old ?? ''}</span>
          <span className="w-10 shrink-0 select-none pr-2 text-right text-muted/70 tabular-nums">{line.new ?? ''}</span>
          <span
            className={cn('w-4 shrink-0 select-none text-center font-semibold', line.type === 'add' && 'text-st-done', line.type === 'remove' && 'text-st-blocked')}
            aria-label={line.type === 'add' ? 'added' : line.type === 'remove' ? 'removed' : undefined}
          >
            {LINE_SIGN[line.type]}
          </span>
          <span className="whitespace-pre pr-3">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/** Animates to the measured height of its content; content stays mounted while closed. */
function Collapse({ open, id, reduce, children }: { open: boolean; id: string; reduce: boolean; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      animate={{ height: open ? height : 0, opacity: open ? 1 : 0 }}
      className="overflow-hidden"
      id={id}
      inert={!open}
      initial={false}
      transition={reduce ? { duration: 0 } : { height: HEIGHT_SPRING, opacity: { duration: 0.18, ease: EASE_OUT } }}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}

function FileRow({ file, open, onToggle }: { file: ReviewFile; open: boolean; onToggle: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const diffId = useId();
  const { added, removed } = file.diff ? countLines(file.diff) : { added: 0, removed: 0 };
  const slash = file.path.lastIndexOf('/');
  const dir = file.path.slice(0, slash + 1);
  const name = file.path.slice(slash + 1);
  const hasBody = Boolean(file.diff && (file.diff.hunks.length > 0 || file.diff.binary));

  return (
    <li className="border-t border-line first:border-t-0" data-testid="diff-file" data-path={file.path}>
      <button
        type="button"
        aria-controls={diffId}
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-surface-2"
      >
        <ChevronRight aria-hidden="true" className={cn('size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
          <span className="text-muted">{dir}</span>
          <span className={cn('text-text', file.status === 'deleted' && 'line-through')}>{name}</span>
        </span>
        <span className={cn('shrink-0 rounded border px-1.5 text-[11px] leading-5', STATUS_STYLE[file.status])}>{STATUS_LABEL[file.status]}</span>
        <span className="font-mono text-[11px] tabular-nums">
          <span className="text-st-done">+{added}</span> <span className="text-st-blocked">−{removed}</span>
        </span>
        <ChangeBar added={added} removed={removed} />
      </button>
      <Collapse id={diffId} open={open} reduce={reduce}>
        <div className="px-2 pb-2">
          <div aria-label="Line changes" className="overflow-x-auto rounded-lg border border-line bg-ground" role="region" tabIndex={0}>
            {!hasBody && <p className="m-0 px-3 py-2 text-xs text-muted">No line changes to show for this file.</p>}
            {file.diff?.binary && <p className="m-0 px-3 py-2 text-xs text-muted">Binary file: contents not shown.</p>}
            {file.diff?.hunks.map((h, i) => <Hunk hunk={h} key={i} />)}
          </div>
        </div>
      </Collapse>
    </li>
  );
}

export default function AIDiffReview({ files, truncated = false, className }: AIDiffReviewProps) {
  // The first file opens by default, so one click on a card shows code right away.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const isOpen = (path: string, index: number): boolean => opened[path] ?? index === 0;
  const totals = files.reduce(
    (sum, f) => {
      const c = f.diff ? countLines(f.diff) : { added: 0, removed: 0 };
      return { added: sum.added + c.added, removed: sum.removed + c.removed };
    },
    { added: 0, removed: 0 },
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn('w-full rounded-2xl border border-line bg-surface p-1.5', className)}>
        <div className="flex h-9 items-center gap-2 px-2.5">
          <span className="text-sm font-medium">
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </span>
          <span className="font-mono text-[11px] tabular-nums">
            <span className="text-st-done">+{totals.added}</span> <span className="text-st-blocked">−{totals.removed}</span>
          </span>
        </div>
        <ul className="m-0 list-none p-0">
          {files.map((f, i) => (
            <FileRow key={f.path} file={f} open={isOpen(f.path, i)} onToggle={() => setOpened((o) => ({ ...o, [f.path]: !isOpen(f.path, i) }))} />
          ))}
        </ul>
        {truncated && (
          <p className="m-0 px-2.5 py-2 text-xs text-st-blocked" role="note">
            This diff was cut off because it is very large. Only the first part is shown.
          </p>
        )}
      </div>
    </MotionConfig>
  );
}
