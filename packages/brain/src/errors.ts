/** A write contained something that looks like a secret (Memory 01-E6). */
export class SecretError extends Error {
  constructor(readonly kinds: string[]) {
    super(`Refused: looks like a secret (${kinds.join(', ')}). Secrets belong in the vault, never in the Brain.`);
    this.name = 'SecretError';
  }
}

/** An agent tried to set a trust level only the user may set (Memory 01-D3). */
export class TrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustError';
  }
}

/** An agent tried to change something the user confirmed; it must propose instead (Memory 01-D3). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
