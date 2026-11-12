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
