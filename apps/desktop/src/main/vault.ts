import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SecretMeta, VaultStatus } from '@insectoids/shared';

/**
 * The Vault (Connections 04-D4, Phase 2 step A3), in the main process only.
 *
 * - Every key is encrypted by the OS (Electron safeStorage: Windows DPAPI, macOS Keychain, Linux secret
 *   service) and stored as ciphertext in `<userData>/vault.json`.
 * - **Fail closed:** without OS encryption nothing is saved; there is no plain-text fallback.
 * - A key never leaves this module except through `reveal()`, which only the broker calls, at the moment
 *   it injects the key into an outgoing request. No method logs, returns or throws a key.
 */

/** The parts of Electron's safeStorage the Vault uses (injectable for tests). */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

interface Entry {
  ref: string;
  label: string;
  hint: string | null;
  createdAt: number;
  /** base64 of the OS-encrypted bytes. */
  ciphertext: string;
}

interface VaultFile {
  version: 1;
  entries: Entry[];
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

const REF = /^sec_[a-z0-9]{8,40}$/;
const newRef = (): string => `sec_${randomBytes(12).toString('hex')}`;
/** Last 4 characters, only when the key is long enough that 4 characters give nothing useful away. */
const hintFor = (value: string): string | null => (value.length >= 12 ? `…${value.slice(-4)}` : null);

export class Vault {
  readonly file: string;
  readonly #crypto: SecretCrypto;
  readonly #now: () => number;

  constructor(o: { dir: string; crypto: SecretCrypto; now?: () => number }) {
    this.file = join(o.dir, 'vault.json');
    this.#crypto = o.crypto;
    this.#now = o.now ?? Date.now;
  }

  status(): VaultStatus {
    let available: boolean;
    try {
      available = this.#crypto.isEncryptionAvailable();
    } catch {
      available = false;
    }
    return available
      ? { available: true, message: 'Keys are encrypted with your operating system and stay on this computer.' }
      : {
          available: false,
          message:
            "This computer can't encrypt keys for the app (no OS key store is available), so the Vault saves nothing. The hive never stores a key in plain text.",
        };
  }

  /** Metadata only; `usedBy` is filled in by the caller from the integrations registry. */
  list(): Array<Omit<SecretMeta, 'usedBy'>> {
    return this.#read().entries.map(({ ref, label, hint, createdAt }) => ({ ref, label, hint, createdAt }));
  }

  has(ref: string): boolean {
    return this.#read().entries.some((e) => e.ref === ref);
  }

  /** Encrypts and stores a key; returns its handle. Refuses (fail closed) without OS encryption. */
  add(label: string, value: string): string {
    if (!this.status().available) throw new VaultError(this.status().message);
    let cipher: Buffer;
    try {
      cipher = this.#crypto.encryptString(value);
    } catch {
      // Never include the value or the crypto error text (it could echo input) in the message.
      throw new VaultError("The operating system couldn't encrypt the key, so it wasn't saved.");
    }
    const ref = newRef();
    const file = this.#read();
    file.entries.push({ ref, label, hint: hintFor(value), createdAt: this.#now(), ciphertext: cipher.toString('base64') });
    this.#write(file);
    return ref;
  }

  remove(ref: string): void {
    if (!REF.test(ref)) throw new VaultError('Unknown key.');
    const file = this.#read();
    const next = file.entries.filter((e) => e.ref !== ref);
    if (next.length === file.entries.length) throw new VaultError('Unknown key.');
    this.#write({ ...file, entries: next });
  }

  /**
   * The key itself, for the broker only, at the moment it injects it into an outgoing request.
   * Returns null when the key is missing or can't be decrypted (fail closed).
   */
  reveal(ref: string): string | null {
    const entry = this.#read().entries.find((e) => e.ref === ref);
    if (!entry || !this.status().available) return null;
    try {
      return this.#crypto.decryptString(Buffer.from(entry.ciphertext, 'base64'));
    } catch {
      return null;
    }
  }

  #read(): VaultFile {
    if (!existsSync(this.file)) return { version: 1, entries: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<VaultFile>;
      const entries = Array.isArray(raw.entries)
        ? raw.entries.filter(
            (e): e is Entry =>
              !!e && typeof e === 'object' && REF.test(String((e as Entry).ref)) && typeof (e as Entry).label === 'string' && typeof (e as Entry).ciphertext === 'string',
          )
        : [];
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  /** Atomic: a temp file next to it, then rename over the old one. */
  #write(file: VaultFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
