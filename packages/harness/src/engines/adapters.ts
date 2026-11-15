import { existsSync } from 'node:fs';
import { type ClaudeInstall, checkClaudeAuth, detectClaude } from '../claude/detect';
import { type GeminiAuth, type GeminiInstall, checkGeminiAuth, detectGemini, hasMachinePolicies, machinePolicyDir } from '../gemini/detect';
import { GeminiEngine } from '../gemini/engine';
import type { runGemini } from '../gemini/run';
import { ClaudeEngine, type Engine, type HiveToolsDoor } from '../hive/engine';
import { type OpenCodeInstall, blockingSystemConfig, detectOpenCode } from '../opencode/detect';
import { type LlmAccess, OpenCodeEngine, type ReadyProvider } from '../opencode/engine';
import type { runOpenCode } from '../opencode/run';
import type { EngineAdapter, EngineDetection } from './registry';

const EFFORTS = ['low', 'medium', 'high', 'max'] as const;

export interface ClaudeAdapterOptions {
  /** How to start the bundled guard hook (on Windows: the hook launcher). */
  hook: { command: string; args: string[] };
  /** Where per-run system prompts and MCP configs are written (outside every workspace). */
  promptDir: string;
  env?: Record<string, string>;
  /** The hive tools, for runs in container mode (Phase 4 D1): Claude's own Bash is blocked there. */
  hiveTools?: HiveToolsDoor | null;
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
    // Runs on the user's Claude plan: no per-run charge, it counts toward the plan's limits.
    capabilities: { guard: 'hook', mcp: true, effort: EFFORTS, reportsCost: true, subscription: true },
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
        engine = {
          command,
          engine: new ClaudeEngine({ claude: command, hook: o.hook, promptDir: o.promptDir, ...(o.env ? { env: o.env } : {}), ...(o.hiveTools ? { hiveTools: o.hiveTools } : {}) }),
        };
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
      // Counted as a subscription (as before): estimates say "your subscription", not a per-token price.
      return { guard: hasTools() ? ('policy-and-tools' as const) : ('read-only' as const), mcp: true, effort: EFFORTS, reportsCost: false, subscription: true };
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
      // Runs on the user's ChatGPT plan once supported.
      capabilities: { guard: null, mcp: true, effort: EFFORTS, reportsCost: false, subscription: true },
      models: null,
      availableIn: 'a later Phase 2 step (needs a ChatGPT plan to test with)',
      install: { command: 'npm install -g @openai/codex', note: "OpenAI's official package." },
      signIn: { command: 'codex login', note: 'Sign in with your ChatGPT account. The hive never sees your login.' },
      privacyNote: null,
    },
  ];
}

export interface OpenCodeAdapterOptions {
  /** The hive tools MCP bundle; null or missing file = read-only work only. */
  hiveTools: string | null;
  /** Runtime for the hive's MCP servers in OpenCode runs (its env reaches only those servers). */
  runtime: { command: string; args?: string[]; env?: Record<string, string> };
  runBase: string;
  /** Enabled providers that passed their test, in the user's order (from main). */
  providers: () => Promise<ReadyProvider[]>;
  llm: LlmAccess;
  /** Tests: replace detection, the system-config check and the run. */
  detect?: () => Promise<OpenCodeInstall>;
  systemConfig?: () => string | null;
  run?: typeof runOpenCode;
}

/**
 * OpenCode 2.x: the doorway for API providers (OpenRouter, FreeLLMAPI, Ollama, LM Studio). Its built-in
 * tools are switched off by config and its file and shell work goes through the hive tools (guarded), and
 * the provider's key stays in the Vault: OpenCode talks to the local broker with a per-run pass.
 */
export function opencodeAdapter(o: OpenCodeAdapterOptions): EngineAdapter {
  const hasTools = (): boolean => Boolean(o.hiveTools && existsSync(o.hiveTools));
  let install: Extract<OpenCodeInstall, { status: 'installed' }> | null = null;
  let current: ReadyProvider | null = null;
  let engine: { key: string; engine: Engine } | null = null;
  return {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'Anomaly (open source, MIT)',
    get capabilities() {
      return {
        guard: hasTools() ? ('policy-and-tools' as const) : ('read-only' as const),
        mcp: true,
        effort: null,
        reportsCost: true,
        // A provider on this computer (Ollama, LM Studio, a local FreeLLMAPI) costs nothing per run.
        ...(install && current?.local ? { free: true } : {}),
      };
    },
    // The run's provider decides the models; until one is ready the tiers are placeholders.
    get models() {
      return current?.models ?? { strongest: 'provider-strongest', standard: 'provider-standard', light: 'provider-light' };
    },
    availableIn: null,
    install: {
      command: 'npm install -g @opencode/cli@2.2.6',
      note: 'The official package (about 260 MB; its install step copies the program file using PowerShell). Needs Node.js. The hive never runs it without you.',
    },
    signIn: {
      command: 'Connections → API providers',
      note: 'OpenCode needs no sign-in of its own here: add an API provider (OpenRouter, FreeLLMAPI, Ollama or LM Studio) on the API providers tab. Keys stay in the Vault.',
    },
    privacyNote:
      'Local providers (Ollama, LM Studio, a local FreeLLMAPI) keep everything on this computer. Remote providers see your prompts and the code the insects read.',
    async detect(): Promise<EngineDetection> {
      install = null;
      const found = await (o.detect ?? (() => detectOpenCode()))();
      if (found.status === 'missing') return { state: 'missing', version: null, message: 'OpenCode is not installed. Install it with npm; the hive checks again every minute.' };
      if (found.status === 'outdated') {
        return { state: 'outdated', version: found.version, message: `OpenCode ${found.version} is older than ${found.minimum}. Update it with npm.` };
      }
      const blocking = (o.systemConfig ?? (() => blockingSystemConfig()))();
      if (blocking) {
        return {
          state: 'missing',
          version: found.version,
          message: `This computer has a machine-wide OpenCode config (${blocking}). It would override the hive's safety settings, so the hive won't run OpenCode here.`,
        };
      }
      const providers = await o.providers().catch(() => [] as ReadyProvider[]);
      current = providers[0] ?? null;
      if (!current) {
        return { state: 'signed-out', version: found.version, message: 'Add an API provider on the API providers tab, switch it on and test it; then OpenCode is ready.' };
      }
      install = found;
      const where = current.local ? ' (runs on this computer)' : '';
      return {
        state: 'ready',
        version: found.version,
        message: hasTools()
          ? `OpenCode ${found.version} is ready with ${current.label}${where}.`
          : `OpenCode ${found.version} is ready with ${current.label}${where}, for read-only work only: the hive tools aren't built (run "pnpm build:doors").`,
      };
    },
    create(): Engine {
      if (!install) throw new Error('OpenCode is not ready.');
      const tools = hasTools() ? o.hiveTools : null;
      const key = `${install.command}|${(install.args ?? []).join(' ')}|${tools ?? ''}`;
      if (engine?.key !== key) {
        engine = {
          key,
          engine: new OpenCodeEngine({
            command: install.command,
            ...(install.args ? { commandArgs: install.args } : {}),
            hiveTools: tools,
            runtime: o.runtime,
            provider: () => current,
            llm: o.llm,
            runBase: o.runBase,
            ...(o.run ? { run: o.run } : {}),
          }),
        };
      }
      return engine.engine;
    },
  };
}
