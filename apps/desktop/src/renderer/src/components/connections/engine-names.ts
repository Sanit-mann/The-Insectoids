import type { EngineCard, EngineId, LaneStatus } from '@insectoids/shared';

/** Short display names, also used on hive lanes ("which engine ran this"). */
export const ENGINE_NAMES: Record<EngineId, string> = {
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex',
  opencode: 'OpenCode',
  copilot: 'Copilot',
  cursor: 'Cursor',
  qwen: 'Qwen Code',
  grok: 'Grok',
  kimi: 'Kimi',
  crush: 'Crush',
  pi: 'Pi',
  antigravity: 'Antigravity',
  custom: 'Custom command',
  fake: 'Test engine',
};

export const engineName = (id: EngineId | null | undefined): string | null => (id ? ENGINE_NAMES[id] : null);

/** Engine state → status dot colour (App 07 status tokens). Always shown with a text label. */
export const STATE_DOT: Record<EngineCard['state'], LaneStatus> = {
  ready: 'done',
  fake: 'done',
  checking: 'working',
  'signed-out': 'waiting',
  outdated: 'blocked',
  missing: 'idle',
  unsupported: 'idle',
};

export const STATE_LABEL: Record<EngineCard['state'], string> = {
  ready: 'Ready',
  fake: 'Ready (test engine)',
  checking: 'Checking…',
  'signed-out': 'Not signed in',
  outdated: 'Needs an update',
  missing: 'Not installed',
  unsupported: 'Not available yet',
};

/** How the command guard protects this engine's runs, in plain words. */
export const GUARD_TEXT: Record<NonNullable<EngineCard['guard']>, string> = {
  hook: 'The command guard checks every action before it runs, and blocks it if the check can’t run.',
  'policy-and-tools': 'Its own command and file tools are switched off; it works through the hive’s tools, which run the command guard first.',
  'read-only': 'Read-only work only: it can read and report, but never changes files.',
};

/** The engine the hive uses first: the first enabled, ready one in the user's order. */
export function defaultEngine(engines: readonly EngineCard[]): EngineCard | undefined {
  return engines.find((e) => e.enabled && (e.state === 'ready' || e.state === 'fake'));
}
