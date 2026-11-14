import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { PRESETS, type Preset, PresetSchema } from '@insectoids/shared';

/**
 * `<userData>/app.json`: the app-level settings main owns (Onboarding 08). The Brain host keeps its own
 * `settings.json` for the project; the two never write the same file.
 */
export interface AppSettings {
  /** Absent = the default Brain folder (<userData>/brain). */
  brainDir?: string;
  preset: Preset;
  onboarding: { completedAt?: number };
  /** The sample goal on the practice project (Onboarding 08-D8; Phase 2 C5), once started. */
  sample?: { goalId: string; practicePath: string; startedAt: number };
  /** The project that was open before the sample switched to the practice project, so the user can go back. */
  previousProject?: string;
  /** Keep the computer awake while the hive works (05-D5; Phase 3 A2). Absent = off. */
  keepAwake?: boolean;
  /** Each webhook cadence's secret, as a Vault handle (cadence id -> ref; Cadence 05-D4; Phase 3 A4). Never the secret itself. */
  webhookSecrets?: Record<string, string>;
  /** The webhook listener's port on 127.0.0.1 (A4). Absent = DEFAULT_WEBHOOK_PORT. */
  webhookPort?: number;
}

/** Keeps every valid field and drops the rest, so one bad value never resets the whole file. */
export function parseAppSettings(raw: unknown): AppSettings {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const preset = PresetSchema.safeParse(o['preset']);
  const ob = typeof o['onboarding'] === 'object' && o['onboarding'] !== null ? (o['onboarding'] as Record<string, unknown>) : {};
  const completedAt = ob['completedAt'];
  const brainDir = o['brainDir'];
  const prev = o['previousProject'];
  const sample = parseSample(o['sample']);
  const webhookSecrets = parseWebhookSecrets(o['webhookSecrets']);
  return {
    ...(typeof brainDir === 'string' && brainDir.length > 0 ? { brainDir } : {}),
    preset: preset.success ? preset.data : 'balanced',
    onboarding: typeof completedAt === 'number' && Number.isFinite(completedAt) ? { completedAt } : {},
    ...(sample ? { sample } : {}),
    ...(typeof prev === 'string' && prev.length > 0 ? { previousProject: prev } : {}),
    ...(o['keepAwake'] === true ? { keepAwake: true } : {}),
    ...(webhookSecrets ? { webhookSecrets } : {}),
    ...(isPort(o['webhookPort']) ? { webhookPort: o['webhookPort'] } : {}),
  };
}

const WEBHOOK_ID = /^[A-Za-z0-9_-]{1,200}$/;
const VAULT_REF = /^sec_[a-z0-9]{8,40}$/;
const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65_535;

/** Keeps only well-formed cadence id -> Vault ref pairs; null when none are left. */
function parseWebhookSecrets(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [id, ref] of Object.entries(raw as Record<string, unknown>)) {
    if (WEBHOOK_ID.test(id) && typeof ref === 'string' && VAULT_REF.test(ref)) out[id] = ref;
  }
  return Object.keys(out).length ? out : null;
}

function parseSample(raw: unknown): AppSettings['sample'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const { goalId, practicePath, startedAt } = s;
  if (typeof goalId !== 'string' || !goalId || typeof practicePath !== 'string' || !practicePath) return null;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  return { goalId, practicePath, startedAt };
}

const DEFAULTS: AppSettings = { preset: 'balanced', onboarding: {} };

export class AppSettingsStore {
  readonly file: string;
  readonly defaultBrainDir: string;
  #value: AppSettings;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'app.json');
    this.defaultBrainDir = join(userDataDir, 'brain');
    this.#value = this.#read();
  }

  get value(): AppSettings {
    return structuredClone(this.#value);
  }

  get brainDir(): string {
    return this.#value.brainDir ?? this.defaultBrainDir;
  }

  get preset(): Preset {
    return this.#value.preset;
  }

  update(change: (s: AppSettings) => AppSettings): AppSettings {
    const next = parseAppSettings(change(this.value));
    this.#write(next);
    this.#value = next;
    return this.value;
  }

  /** Bad or missing JSON gives the defaults (the user can always rerun setup). */
  #read(): AppSettings {
    try {
      if (!existsSync(this.file)) return structuredClone(DEFAULTS);
      return parseAppSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  /** Atomic: write a temp file next to it, then rename over the old one. */
  #write(s: AppSettings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

/** The Hive limits for a preset (shared PRESETS table). */
export function limitsFor(preset: Preset): { insectCap: number; goalBudgetTokens: number; approveEveryPlan: boolean } {
  const p = PRESETS[preset];
  return { insectCap: p.insectCap, goalBudgetTokens: p.goalBudgetTokens, approveEveryPlan: p.approveEveryPlan };
}

/**
 * Can this folder hold the Brain? It must be an absolute path to a folder (created if missing) that
 * we can write to, proven by writing and removing a probe file. Returns an error in plain words, or null.
 */
export function checkBrainFolder(dir: string): string | null {
  if (!isAbsolute(dir)) return 'Choose a full folder path.';
  try {
    if (existsSync(dir) && !statSync(dir).isDirectory()) return `${dir} is a file, not a folder.`;
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.insectoids-write-test-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return `The Brain can't be saved in ${dir}${code ? ` (${code})` : ''}. Choose a folder you can write to.`;
  }
  const db = join(dir, 'brain.db');
  if (existsSync(db) && !statSync(db).isFile()) return `${db} exists but is not a Brain file.`;
  return null;
}
