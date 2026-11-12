import { existsSync } from 'node:fs';
import { type ClaudeInstall, checkClaudeAuth, detectClaude } from '../claude/detect';
import { type GeminiAuth, type GeminiInstall, checkGeminiAuth, detectGemini, hasMachinePolicies, machinePolicyDir } from '../gemini/detect';
import { GeminiEngine } from '../gemini/engine';
import type { runGemini } from '../gemini/run';
import { ClaudeEngine, type Engine } from '../hive/engine';
import type { EngineAdapter, EngineDetection } from './registry';

const EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export interface ClaudeAdapterOptions {
  /** How to start the bundled guard hook (on Windows: the hook launcher). */
  hook: { command: string; args: string[] };
  /** Where per-run system prompts and MCP configs are written (outside every workspace). */
  promptDir: string;
  env?: Record<string, string>;
  /** Tests: replace detection and the sign-in check. */
  detect?: () => Promise<ClaudeInstall>;
  auth?: (command: string) => Promise<{ loggedIn: boolean }>;
  platform?: NodeJS.Platform;
}

/** Claude Code (Anthropic): the guard runs as a pre-tool hook that fails closed. */
export function claudeAdapter(o: ClaudeAdapterOptions): EngineAdapter {
  const win = (o.platform ?? process.platform) === 'win32';
  let command: string | null = null;
  let engine: { command: string; engine: Engine } | null = null;
  return {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    capabilities: { guard: 'hook', mcp: true, effort: EFFORTS, reportsCost: true },
    models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' },
    availableIn: null,
    install: {
      command: win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
      note: `Anthropic's official installer${win ? ' (run it in PowerShell)' : ''}. The hive never runs it without you.`,
    },
    signIn: { command: 'claude auth login', note: 'Opens your browser to sign in to your Claude account. The hive never sees your login.' },
    privacyNote: null,
    async detect(): Promise<EngineDetection> {
      const install = await (o.detect ?? (() => detectClaude()))();
      if (install.status === 'missing') {
        return { state: 'missing', version: null, message: 'Claude Code is not installed. Install it from claude.com/claude-code; the hive checks again every minute.' };
      }
      if (install.status === 'unsupported') return { state: 'missing', version: null, message: install.reason };
      if (install.status === 'outdated') {
        return { state: 'outdated', version: install.version, message: `Claude Code ${install.version} is older than ${install.minimum}. Run "claude update" in a terminal.` };
      }
      const auth = await (o.auth ?? ((c: string) => checkClaudeAuth(c)))(install.command);
      if (!auth.loggedIn) {
        return { state: 'signed-out', version: install.version, message: 'Claude Code is signed out. Run "claude auth login" in a terminal; the hive checks again every minute.' };
      }
      command = install.command;
      return { state: 'ready', version: install.version, message: `Claude Code ${install.version} is ready.` };
    },
    create(): Engine {
      if (!command) throw new Error('Claude Code is not ready.');
      // One engine per install: it numbers its prompt files, so runs never overwrite each other's.
      if (engine?.command !== command) {
        engine = { command, engine: new ClaudeEngine({ claude: command, hook: o.hook, promptDir: o.promptDir, ...(o.env ? { env: o.env } : {}) }) };
      }
      return engine.engine;
    },
  };
}

export interface GeminiAdapterOptions {
  /** The hive tools MCP bundle (guarded shell and file tools). Missing → Gemini gets read-only work only. */
  hiveTools: string | null;
  /** Where per-run settings and policies are written (outside every workspace). */
  runBase: string;
  /** Tests: replace detection, the sign-in check, the machine-policy check and the runner. */
  detect?: () => Promise<GeminiInstall>;
  auth?: () => GeminiAuth;
  machinePolicies?: () => boolean;
  run?: typeof runGemini;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
}

/**
 * Gemini CLI (Google). Its pre-tool hooks fail open, so the guard doesn't rely on them: every built-in tool
 * is denied by a per-run admin policy and changes go through the hive's guarded MCP tools.
 */
/** Shown when Gemini CLI is signed in with a personal Google account, which Google no longer serves. */
export const PERSONAL_LOGIN_ENDED =
  'Google stopped serving Gemini CLI for personal Google sign-ins (Google AI Pro, Ultra and free use) on June 18, 2026; its replacement for those plans is Antigravity CLI. Gemini CLI still works with a paid Gemini API key.';

export function geminiAdapter(o: GeminiAdapterOptions): EngineAdapter {
  const exists = o.exists ?? existsSync;
  const hasTools = (): boolean => Boolean(o.hiveTools && exists(o.hiveTools));
  let install: Extract<GeminiInstall, { status: 'installed' }> | null = null;
  let engine: { key: string; engine: Engine } | null = null;
  return {
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    get capabilities() {
      return { guard: hasTools() ? ('policy-and-tools' as const) : ('read-only' as const), mcp: true, effort: EFFORTS, reportsCost: false };
    },
    models: { strongest: 'pro', standard: 'flash', light: 'flash-lite' },
    availableIn: null,
    install: { command: 'npm install -g @google/gemini-cli', note: "Google's official package. Needs Node.js 20 or newer. The hive never runs it without you." },
    signIn: {
      command: 'gemini',
      note: 'Needs a paid Gemini API key (or a work account with Gemini Code Assist). "Login with Google" no longer works for personal Google AI Pro/Ultra plans. The hive never sees your login.',
    },
    privacyNote: 'Gemini CLI keeps its own chat logs in your user folder (~/.gemini/tmp). The hive turns its usage statistics off and never lets it spend AI credits.',
    async detect(): Promise<EngineDetection> {
      install = null;
      const found = await (o.detect ?? (() => detectGemini()))();
      if (found.status === 'missing') {
        return { state: 'missing', version: null, message: 'Gemini CLI is not installed. Install it with npm; the hive checks again every minute.' };
      }
      if (found.status === 'outdated') {
        return { state: 'outdated', version: found.version, message: `Gemini CLI ${found.version} is older than ${found.minimum}. Update it with npm.` };
      }
      if (found.status === 'no-node') return { state: 'missing', version: found.version, message: found.reason };
      if ((o.machinePolicies ?? (() => hasMachinePolicies(o.platform)))()) {
        return {
          state: 'missing',
          version: found.version,
          message: `This computer has its own Gemini CLI admin policies (${machinePolicyDir(o.platform)}). They would replace the hive's safety policy, so the hive won't run Gemini here.`,
        };
      }
      const auth = (o.auth ?? (() => checkGeminiAuth()))();
      if (!auth.signedIn) {
        return { state: 'signed-out', version: found.version, message: 'Gemini CLI is not signed in. Run "gemini" in a terminal and choose "Login with Google"; the hive checks again every minute.' };
      }
      // Google stopped serving Gemini CLI for personal Google sign-ins (Google AI Pro/Ultra and free use) on
      // 2026-06-18: the server refuses them ("IneligibleTierError"), so this sign-in can't run hive work.
      if (auth.method === 'oauth-personal') {
        return { state: 'signed-out', version: found.version, message: PERSONAL_LOGIN_ENDED };
      }
      install = found;
      const how = '';
      return {
        state: 'ready',
        version: found.version,
        message: hasTools()
          ? `Gemini CLI ${found.version} is ready${how}.`
          : `Gemini CLI ${found.version} is ready${how}, for read-only work only: the hive tools aren't built (run "pnpm build:doors").`,
      };
    },
    create(): Engine {
      if (!install) throw new Error('Gemini CLI is not ready.');
      const tools = hasTools() ? o.hiveTools : null;
      const key = `${install.node}|${install.script}|${tools ?? ''}`;
      if (engine?.key !== key) {
        engine = {
          key,
          engine: new GeminiEngine({ node: install.node, script: install.script, hiveTools: tools, runBase: o.runBase, ...(o.run ? { run: o.run } : {}) }),
        };
      }
      return engine.engine;
    },
  };
}

/** A scripted engine (e2e tests and token-free demos). Always ready; guarded by the same hook rules in spirit. */
export function fakeAdapter(engine: Engine, o: { name?: string; message?: string } = {}): EngineAdapter {
  const name = o.name ?? 'Demo engine';
  return {
    id: 'fake',
    name,
    vendor: 'The Insectoids',
    capabilities: { guard: 'hook', mcp: false, effort: EFFORTS, reportsCost: true },
    // Claude Code's tier names, so scripted runs look like the real thing in lanes and tests.
    models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' },
    availableIn: null,
    install: null,
    signIn: null,
    privacyNote: null,
    detect: async () => ({ state: 'fake', version: null, message: o.message ?? 'Scripted demo: no AI calls and no tokens are used.' }),
    create: () => engine,
  };
}

/** Engines the hive knows about but can't run yet in this build (shown on the Connections screen). */
export function plannedAdapters(): EngineAdapter[] {
  return [
    {
      id: 'codex',
      name: 'Codex CLI',
      vendor: 'OpenAI',
      capabilities: { guard: null, mcp: true, effort: EFFORTS, reportsCost: false },
      models: null,
      availableIn: 'a later Phase 2 step (needs a ChatGPT plan to test with)',
      install: { command: 'npm install -g @openai/codex', note: "OpenAI's official package." },
      signIn: { command: 'codex login', note: 'Sign in with your ChatGPT account. The hive never sees your login.' },
      privacyNote: null,
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      vendor: 'SST (open source)',
      capabilities: { guard: null, mcp: true, effort: null, reportsCost: false },
      models: null,
      availableIn: 'Phase 2 · step A4',
      install: { command: 'npm install -g opencode-ai', note: 'The doorway for OpenRouter, FreeLLMAPI and local models (Ollama, LM Studio).' },
      signIn: { command: 'opencode auth login', note: 'Choose a provider and add its key in OpenCode itself; local models need none.' },
      privacyNote: null,
    },
  ];
}
