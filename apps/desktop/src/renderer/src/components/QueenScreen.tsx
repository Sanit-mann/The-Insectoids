import { HexMark } from '@/components/HexMark';

/** Phase 0: the Queen's empty state. The composer is wired to the hive in Phase 1. */
export function QueenScreen() {
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-6 p-6">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <HexMark size={64} />
        <h2 className="m-0 font-display text-2xl font-semibold">Give the hive its first goal</h2>
        <p className="m-0 max-w-[520px] text-muted">
          Tell the Queen what you want done. She plans it in waves, insects do the work in safe copies of your files,
          and nothing reaches your project without your approval.
        </p>
      </div>
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3">
        <label htmlFor="queen-message" className="text-xs text-muted">
          Message the Queen
        </label>
        <textarea
          id="queen-message"
          rows={2}
          disabled
          placeholder="The hive comes alive in Phase 1"
          className="resize-none border-0 bg-transparent text-text outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-2.5">
          <span className="text-xs text-muted">Phase 0 · foundation</span>
          <button
            type="button"
            disabled
            className="ml-auto min-h-10 rounded-[10px] bg-honey px-3.5 font-semibold text-honey-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
