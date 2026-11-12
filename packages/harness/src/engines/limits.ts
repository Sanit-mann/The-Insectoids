/**
 * Vendor usage limits (Connections 04-D7; Phase 2 A5). The hive can't read a subscription's real quota, so it
 * believes the engine when a run says a limit was hit, and stays off that engine until the reset time the
 * message gives (or an hour, if it gives none).
 */
export interface UsageLimit {
  limited: boolean;
  /** When the vendor says it frees up (epoch ms); null when the message gives no time. */
  resetAt: number | null;
}

const NOT_LIMITED: UsageLimit = { limited: false, resetAt: null };

/** Messages engines and providers use when a subscription or rate limit stops a run. */
const LIMIT_TEXT =
  /(usage limit|rate[ -]?limit|limit (?:has been )?reached|reached (?:your|the) (?:usage |rate |daily |weekly )?limit|hit your (?:usage )?limit|quota (?:exceeded|exhausted)|exceeded (?:your|the) (?:current )?quota|resource[_ ]exhausted|too many requests|(?:status|http|error|code)\W{0,3}429\b)/i;

/** Default wait when the message names no reset time. */
export const DEFAULT_LIMIT_WAIT_MS = 60 * 60_000;

/** Reads a reset time from a limit message, relative to `now`. Null when there is none. */
export function parseResetTime(text: string, now: number): number | null {
  // Claude Code's classic form: "Claude AI usage limit reached|1767225600" (epoch seconds).
  const pipe = /\|(\d{10})(?!\d)/.exec(text);
  if (pipe) return Number(pipe[1]) * 1000;
  // Explicit epoch fields in JSON errors: "resetsAt": 1767225600 / "reset_at": 1767225600000.
  const field = /"?(?:resets?_?at|reset_time|resetAt|resetsAt)"?\s*[:=]\s*"?(\d{10,13})/i.exec(text);
  if (field) {
    const n = Number(field[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  // ISO timestamps after "reset"/"until"/"after".
  const iso = /(?:reset|until|after|at)[^0-9]{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]!);
    if (Number.isFinite(t)) return t;
  }
  // "retry after 120 seconds", "try again in 15 minutes", "in 2 hours", "Retry-After: 30".
  const rel = /(?:retry[- ]after|try again in|resets? in|in)\s*:?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit.startsWith('h') ? 3600_000 : unit.startsWith('m') ? 60_000 : 1000;
    return now + Math.round(n * ms);
  }
  const retryAfter = /retry-after\s*:\s*(\d+)/i.exec(text);
  if (retryAfter) return now + Number(retryAfter[1]) * 1000;
  // "resets 3pm", "resets at 3:30 PM", "resets 15:00": the next such local time.
  const clock = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (clock) {
    let h = Number(clock[1]);
    const m = clock[2] ? Number(clock[2]) : 0;
    const ap = clock[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && m <= 59) {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      let t = d.getTime();
      if (t <= now) t += 24 * 3600_000;
      return t;
    }
  }
  return null;
}

/** Does a failed run's text say a usage or rate limit stopped it? */
export function detectUsageLimit(text: string, now: number): UsageLimit {
  if (!text || !LIMIT_TEXT.test(text)) return NOT_LIMITED;
  return { limited: true, resetAt: parseResetTime(text, now) };
}

/** "3:00 PM" style local time for messages. */
export function formatClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
