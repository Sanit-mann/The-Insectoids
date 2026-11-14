import type { ModelTiers } from '../hive/router';

/**
 * Per-run OpenCode 2.x configuration (checked against the v2.2.1 and v2.2.5 source and real 2.2.6 runs).
 *
 * Safety comes from three layers that don't depend on OpenCode's plugin hooks:
 * 1. Every built-in tool is removed: a permission rule list that denies everything, then allows only the
 *    hive's MCP tools (`hive_*`, `brain_*`, `services_*`). OpenCode drops a tool from the catalog when the
 *    last matching rule is "deny"; the same rules are repeated inside the hive's own agent.
 * 2. The built-in tool plugins aren't even loaded (`-opencode.tool.*`, web search, auto-detected local
 *    providers), and policies deny every provider, MCP server and skill except ours.
 * 3. File and shell work goes through the hive tools MCP server, which runs the command guard before
 *    every action and refuses on any error.
 *
 * The config text is substituted by OpenCode ({env:NAME} and {file:path}). So no prompt or other outside
 * text ever goes in here (a goal containing {file:~/.ssh/id_rsa} would otherwise be read into the run),
 * and every value is checked for those tokens. The prompt itself goes on stdin.
 */

/** The provider id inside OpenCode for this run's model provider (always the broker, never the real one). */
export const RUN_PROVIDER = 'hive-or';
/** Environment variable holding the run's broker pass (OpenCode reads it via {env:…} as the "API key"). */
export const PASS_ENV = 'HIVE_RUN_PASS';
/** The hive's own agent in OpenCode. */
export const HIVE_AGENT = 'hive';
/** MCP servers a run may load. */
export const HIVE_MCP = ['hive', 'brain', 'services'] as const;
export type HiveMcpName = (typeof HIVE_MCP)[number];

/** Flags that would auto-approve tools; the hive never passes them. */
export const FORBIDDEN_FLAGS = ['--auto', '--yolo', '--dangerously-skip-permissions'] as const;

export interface OpenCodeMcpServer {
  /** Executable followed by its arguments. */
  command: string[];
  environment: Record<string, string>;
  cwd?: string;
}

export interface OpenCodeConfigInput {
  /** The broker's LLM route for this run's provider (its OpenAI-compatible base URL). */
  baseUrl: string;
  /** Upstream model ids by tier; the run's models are keyed by tier name. */
  tiers: ModelTiers;
  mcpServers: Partial<Record<HiveMcpName, OpenCodeMcpServer>>;
  /** No hive tools: only the Brain and services, no file or shell access at all. */
  readOnly: boolean;
  /** The route's turn limit (OpenCode agent `steps`). */
  maxSteps?: number;
}

type Rule = { action: string; resource: string; effect: 'allow' | 'deny' };

const deny = (action: string): Rule => ({ action, resource: '*', effect: 'deny' });
const allow = (action: string): Rule => ({ action, resource: '*', effect: 'allow' });

/** Deny everything, then allow only the hive's MCP tools (last matching rule wins in OpenCode). */
export function hivePermissions(servers: readonly string[]): Rule[] {
  return [deny('*'), ...servers.map((s) => allow(`${s}_*`))];
}

const TIER_KEYS = ['strongest', 'standard', 'light'] as const;

/** The OpenCode model key for an upstream model id (models are keyed by tier, since ids can contain "/"). */
export function modelKeyFor(tiers: ModelTiers, model: string): (typeof TIER_KEYS)[number] {
  return TIER_KEYS.find((k) => tiers[k] === model) ?? 'standard';
}

/** True when a value would be rewritten by OpenCode's {env:…} / {file:…} substitution. */
export function substitutes(value: string): boolean {
  return /\{(env|file):/i.test(value);
}

export function buildOpenCodeConfig(o: OpenCodeConfigInput): Record<string, unknown> {
  const servers = HIVE_MCP.filter((n) => o.mcpServers[n] && !(o.readOnly && n === 'hive'));
  const rules = hivePermissions(servers);
  const mcp: Record<string, unknown> = {};
  for (const name of servers) {
    const s = o.mcpServers[name]!;
    mcp[name] = {
      type: 'local',
      command: s.command,
      environment: s.environment,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      // Tools listed directly (Code Mode would wrap them in its own execute tool).
      codemode: false,
      timeout: { startup: 30_000, catalog: 30_000, execution: 10 * 60_000 },
    };
  }
  const models: Record<string, unknown> = {};
  for (const key of TIER_KEYS) {
    models[key] = {
      modelID: o.tiers[key],
      name: o.tiers[key],
      capabilities: { tools: true, input: ['text'], output: ['text'] },
      limit: { context: 128_000, output: 16_000 },
    };
  }
  const config = {
    update: 'disable',
    share: 'disabled',
    snapshots: false,
    formatter: false,
    lsp: false,
    warming: false,
    instructions: [],
    skills: [],
    default_agent: HIVE_AGENT,
    plugins: [
      '-opencode.tool.*',
      '-opencode.tools.mcp-resources',
      '-opencode.websearch.*',
      '-opencode.skill',
      '-opencode.provider.ollama',
      '-opencode.provider.lmstudio',
      '-opencode.provider.vllm',
    ],
    permissions: rules,
    policies: [
      // OpenCode 2.2.5 (checked against its source and a real run): the last matching statement wins.
      // A bare `integration.use` "*" also covers providers, so our provider's own integration (named like the
      // provider; its key comes from an env var, no account) is allowed by name, or the model is "unavailable".
      // MCP servers and skills have their own actions (the old `integration.use` "mcp:<name>" form is legacy).
      { action: 'provider.use', resource: '*', effect: 'deny' },
      { action: 'provider.use', resource: RUN_PROVIDER, effect: 'allow' },
      { action: 'integration.use', resource: '*', effect: 'deny' },
      { action: 'integration.use', resource: RUN_PROVIDER, effect: 'allow' },
      { action: 'mcp.use', resource: '*', effect: 'deny' },
      ...servers.map((s) => ({ action: 'mcp.use', resource: s, effect: 'allow' })),
      { action: 'skill.use', resource: '*', effect: 'deny' },
    ],
    agents: {
      [HIVE_AGENT]: { mode: 'primary', model: `${RUN_PROVIDER}/standard`, permissions: rules, ...(o.maxSteps ? { steps: o.maxSteps } : {}) },
      // Session titles come from the same provider and model (no other provider is allowed anyway).
      title: { model: `${RUN_PROVIDER}/light`, permissions: [deny('*')] },
    },
    mcp: { servers: mcp },
    providers: {
      [RUN_PROVIDER]: {
        name: 'The Insectoids (via the local broker)',
        // OpenCode 2.2.x offers a configured provider's models only when its integration has a connection:
        // naming the run pass's variable gives it one (the value is the per-run pass, never a real key).
        env: [PASS_ENV],
        // Built into the OpenCode binary: nothing is downloaded from npm at run time.
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: o.baseUrl, apiKey: `{env:${PASS_ENV}}` },
        models,
      },
    },
  };
  assertNoSubstitution(config);
  return config;
}

/** Refuses any value OpenCode would rewrite, except the run's own pass placeholder. */
export function assertNoSubstitution(value: unknown, path = 'config'): void {
  if (typeof value === 'string') {
    if (value === `{env:${PASS_ENV}}`) return;
    if (substitutes(value)) throw new Error(`${path} contains "{env:" or "{file:", which OpenCode would replace. Refusing to run.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSubstitution(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (substitutes(k)) throw new Error(`${path} has a key OpenCode would replace. Refusing to run.`);
      assertNoSubstitution(v, `${path}.${k}`);
    }
  }
}

export function buildOpenCodeArgs(o: { modelKey: string; title: string }): string[] {
  return [
    'run',
    // A private server for this run only; without it `run` joins the user's shared background service,
    // which carries the user's own config and environment.
    '--standalone',
    '--format', 'json',
    '--agent', HIVE_AGENT,
    '-m', `${RUN_PROVIDER}/${o.modelKey}`,
    // A title saves OpenCode a separate title-writing call. It comes from the Queen's plan (outside text),
    // so it can never start with "-": a title like "--yolo" must not be read as a flag.
    '--title', o.title.replace(/[\r\n]+/g, ' ').replace(/^[\s-]+/, '').slice(0, 80).trim() || 'Hive card',
  ];
}

/** Variables never passed to OpenCode: provider keys, telemetry, Electron-as-Node, other runs' secrets. */
const SCRUB_EXACT = new Set([
  'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'INSECTOIDS_GUARD', 'INSECTOIDS_BRAIN_TOKEN', 'INSECTOIDS_BROKER_TOKEN',
  'OPENCODE_CONFIG', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_PASSWORD', 'OPENCODE_API_KEY',
]);
const SCRUB_PATTERN = /(^OTEL_|^OPENCODE_|_API_KEY$|_API_TOKEN$|_ACCESS_TOKEN$|^AWS_|^AZURE_|^GOOGLE_|^GEMINI_|^ANTHROPIC_|^OPENAI_|^OPENROUTER_|^GROQ_|^MISTRAL_|^DEEPSEEK_|^XAI_|^HF_TOKEN$|^HUGGINGFACE)/i;

/**
 * The run's environment: the user's environment minus anything secret or OpenCode-specific, plus folders
 * that point every config, data and cache location at an empty per-run folder, so the user's own
 * OpenCode setup (providers, plugins, MCP servers, rules, sessions) never loads into a hive run.
 */
export function buildOpenCodeEnv(o: {
  base: NodeJS.ProcessEnv;
  runDir: string;
  workspace: string;
  pass: string;
  config: string;
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const dir = (name: string) => `${o.runDir}${(o.platform ?? process.platform) === 'win32' ? '\\' : '/'}${name}`;
  const own: Record<string, string> = {
    XDG_CONFIG_HOME: dir('config'),
    XDG_DATA_HOME: dir('data'),
    XDG_STATE_HOME: dir('state'),
    XDG_CACHE_HOME: dir('cache'),
    OPENCODE_CONFIG_DIR: dir('opencode'),
    OPENCODE_TEST_HOME: dir('home'),
    // The machine-wide config folder (%ProgramData%\opencode) outranks everything; point it at nothing.
    ProgramData: dir('programdata'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_FREE_MODELS: '1',
    OPENCODE_DISABLE_FILEWATCHER: '1',
    OPENCODE_DB: ':memory:',
    PWD: o.workspace,
    [PASS_ENV]: o.pass,
    OPENCODE_CONFIG_CONTENT: o.config,
  };
  // Windows variable names ignore case: never keep a copy of a name we set ourselves (e.g. PROGRAMDATA).
  const ours = new Set(Object.keys(own).map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.base)) {
    const up = k.toUpperCase();
    if (v === undefined || ours.has(up) || SCRUB_EXACT.has(up) || SCRUB_PATTERN.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...own };
}

/**
 * What each MCP server's own environment adds on top of OpenCode's: OpenCode merges the server's
 * `environment` over its whole process environment, so the run's pass and OpenCode's private folders
 * are blanked here, and anything the server itself needs (e.g. Electron-as-Node) is set only here.
 */
export function mcpEnvironment(own: Record<string, string>, userProgramData: string | undefined): Record<string, string> {
  return {
    [PASS_ENV]: '',
    OPENCODE_CONFIG_CONTENT: '',
    OPENCODE_CONFIG_DIR: '',
    OPENCODE_TEST_HOME: '',
    OPENCODE_DB: '',
    XDG_CONFIG_HOME: '',
    XDG_DATA_HOME: '',
    XDG_STATE_HOME: '',
    XDG_CACHE_HOME: '',
    ...(userProgramData ? { ProgramData: userProgramData } : {}),
    ...own,
  };
}
