import { SECRET_REMOVED } from '@insectoids/shared';

/**
 * Secrets guard (Memory 01-E6): API keys, tokens, passwords and private keys never enter the Brain.
 * Returns the kinds found, never the values, so the refusal itself can't leak them.
 */
const PATTERNS: ReadonlyArray<readonly [kind: string, re: RegExp]> = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
  ['password-assignment', /\b[A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_TOKEN)[A-Za-z_]*\s*[:=]\s*['"]?[^\s'"]{6,}/i],
];

export function detectSecrets(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
}

/**
 * Redaction order: the assignment pattern first, so "API_KEY=sk-ant-…" goes as a whole instead of leaving
 * "API_KEY=" in front of the placeholder (which would itself look like an assignment).
 */
const REDACT: ReadonlyArray<readonly [kind: string, re: RegExp]> = [
  ...PATTERNS.filter(([kind]) => kind === 'password-assignment'),
  ...PATTERNS.filter(([kind]) => kind !== 'password-assignment'),
].map(([kind, re]) => [kind, new RegExp(re.source, `${re.flags}g`)] as const);

/** While redacting, a match becomes this one private-use character, which no pattern can take as part of a value. */
const HOLE = '\ue000';
/** "PASSWORD = <hole>": an assignment whose value was removed; the name goes too. */
const ASSIGNED_HOLE = /\b[A-Za-z_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_TOKEN)[A-Za-z_]*\s*[:=]\s*['"]?\ue000/gi;

/** Replaces every match of the secret patterns with SECRET_REMOVED; returns the kinds found (never the values). */
export function redactSecrets(text: string): { text: string; kinds: string[] } {
  const kinds = new Set<string>();
  let out = text.replaceAll(HOLE, '');
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const [kind, re] of REDACT) {
      out = out.replace(re, () => {
        changed = true;
        kinds.add(kind);
        return HOLE;
      });
    }
    out = out.replace(ASSIGNED_HOLE, HOLE);
    if (!changed) break;
  }
  return { text: out.replaceAll(HOLE, SECRET_REMOVED), kinds: [...kinds] };
}
