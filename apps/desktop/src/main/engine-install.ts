import { spawn } from 'node:child_process';
import { detectSecrets } from '@insectoids/brain';
import type { EngineCard, EngineInstallResult, HivePush } from '@insectoids/shared';

/**
 * One-click engine install with consent (Connections 04-D6; Phase 2 C4).
 *
 * The user has already seen the exact command on the engine's card and said yes in the app. Main runs only
 * the engine adapter's own official install command (never a string from the renderer), and only when it
 * matches a known shape below, as an argument list. It follows the install ladder: the tool the command
 * needs (npm, PowerShell, bash and curl) must already be here, otherwise nothing runs and the user gets
 * plain advice. Output streams to the window as 'install-output' pushes; then the engine is checked again.
 */

export const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_LINE = 400;

/** How a known install command is run: a program and fixed arguments, plus the tools it needs first. */
export interface InstallPlan {
  file: string;
  args: string[];
  needs: string[];
  /** What to tell the user when a needed tool is missing. */
  advice: string;
}

/** npm package names (optionally scoped, optionally with a pinned version): nothing a shell would read. */
const NPM_PKG = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[0-9][0-9A-Za-z.+-]*)?$/;
const CLAUDE_PS = 'irm https://claude.ai/install.ps1 | iex';
const CLAUDE_SH = 'curl -fsSL https://claude.ai/install.sh | bash';
const NODE_ADVICE = "npm isn't on this computer, so nothing was run. Install Node.js (it includes npm) from nodejs.org, then try again.";

/** The plan for an adapter's install command, or null when it isn't one the app may run itself. */
export function installPlan(command: string, platform: NodeJS.Platform = process.platform): InstallPlan | null {
  const npm = /^npm install -g (\S+)$/.exec(command.trim());
  if (npm && NPM_PKG.test(npm[1]!)) {
    const pkg = npm[1]!;
    // On Windows npm is a .cmd script, which Node only starts through cmd.exe. The arguments are fixed and checked above.
    return platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'install', '-g', pkg], needs: ['npm'], advice: NODE_ADVICE }
      : { file: 'npm', args: ['install', '-g', pkg], needs: ['npm'], advice: NODE_ADVICE };
  }
  if (command === CLAUDE_PS && platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', CLAUDE_PS],
      needs: ['powershell'],
      advice: "Windows PowerShell isn't available, so nothing was run. Run the command yourself in a terminal.",
    };
  }
  if (command === CLAUDE_SH && platform !== 'win32') {
    return { file: 'bash', args: ['-c', CLAUDE_SH], needs: ['bash', 'curl'], advice: 'bash and curl are needed, so nothing was run. Install curl, then try again.' };
  }
  return null;
}

/** A line safe to show: no secrets (the whole line is hidden if one shows up), trimmed, capped. */
export function safeLine(line: string): string {
  const t = line.replace(/\s+$/, '').slice(0, MAX_LINE);
  return detectSecrets(t).length ? '[a line that looked like a secret was hidden]' : t;
}

export interface RunResult {
  code: number | null;
  timedOut: boolean;
}

export interface InstallDeps {
  /** The engine's card as the hive sees it now (its install command comes from the adapter). */
  card: (engineId: string) => Promise<EngineCard | null>;
  /** Ask the hive to check its engines again (after a successful install of this engine). */
  recheck: (engineId: string) => Promise<void>;
  push: (p: HivePush) => void;
  hasTool: (tool: string) => Promise<boolean>;
  run: (plan: InstallPlan, onLine: (line: string) => void, timeoutMs: number) => Promise<RunResult>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export class EngineInstaller {
  readonly #d: InstallDeps;
  #busy: string | null = null;

  constructor(d: InstallDeps) {
    this.#d = d;
  }

  get busy(): string | null {
    return this.#busy;
  }

  async install(engineId: string): Promise<EngineInstallResult> {
    if (this.#busy) return { status: 'not-run', message: `Another install (${this.#busy}) is running. Wait for it to finish.` };
    const card = await this.#d.card(engineId);
    if (!card) return { status: 'not-run', message: 'The hive does not know that engine.' };
    if (card.availableIn) return { status: 'not-run', message: `${card.name} can't be used by the hive yet (${card.availableIn}), so there is nothing to install.` };
    if (card.state === 'ready' || card.state === 'signed-out' || card.state === 'fake') {
      return { status: 'not-run', message: `${card.name} is already installed${card.version ? ` (${card.version})` : ''}.` };
    }
    if (!card.install) return { status: 'not-run', message: `${card.name} has no install command here. See its card for how to get it.` };
    const plan = installPlan(card.install.command, this.#d.platform ?? process.platform);
    if (!plan) return { status: 'not-run', message: `The app can't run this install itself. Copy the command from the card and run it in a terminal: ${card.install.command}` };
    for (const tool of plan.needs) {
      if (!(await this.#d.hasTool(tool))) return { status: 'not-run', message: plan.advice };
    }

    this.#busy = card.name;
    const send = (lines: string[]): void => {
      if (lines.length) this.#d.push({ type: 'install-output', engineId, lines });
    };
    try {
      send([`$ ${card.install.command}`]);
      let pending: string[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        timer = null;
        const out = pending;
        pending = [];
        send(out);
      };
      const res = await this.#d.run(
        plan,
        (line) => {
          pending.push(safeLine(line));
          if (pending.length >= 50) flush();
          else timer ??= setTimeout(flush, 100);
        },
        this.#d.timeoutMs ?? INSTALL_TIMEOUT_MS,
      );
      if (timer) clearTimeout(timer);
      flush();
      if (res.timedOut) {
        const minutes = Math.round((this.#d.timeoutMs ?? INSTALL_TIMEOUT_MS) / 60_000);
        return { status: 'failed', exitCode: null, message: `The install took longer than ${minutes} minutes and was stopped. Try again, or run the command yourself.` };
      }
      if (res.code !== 0) return { status: 'failed', exitCode: res.code, message: `The installer stopped with an error (exit code ${res.code ?? 'unknown'}). The output above says why.` };
      await this.#d.recheck(engineId);
      const after = await this.#d.card(engineId);
      if (!after || after.state === 'missing' || after.state === 'checking') {
        return {
          status: 'failed',
          exitCode: 0,
          message: `The installer finished, but ${card.name} still isn't found. Restart the app so it sees the new program, then check again.`,
        };
      }
      return {
        status: 'installed',
        version: after.version,
        message:
          after.state === 'signed-out' ? `${card.name} is installed. Sign in next (see its card).` : `${card.name} is installed${after.version ? ` (${after.version})` : ''}.`,
      };
    } finally {
      this.#busy = null;
    }
  }
}

/** Runs a plan for real: no shell for our arguments, a timeout, and every line handed back. */
export function runPlan(plan: InstallPlan, onLine: (line: string) => void, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(plan.file, plan.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const lines = (chunk: Buffer, carry: { s: string }): void => {
      carry.s += chunk.toString('utf8');
      const parts = carry.s.split(/\r?\n/);
      carry.s = parts.pop() ?? '';
      for (const p of parts) if (p.trim()) onLine(p);
    };
    const out = { s: '' };
    const err = { s: '' };
    child.stdout?.on('data', (c: Buffer) => lines(c, out));
    child.stderr?.on('data', (c: Buffer) => lines(c, err));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      for (const rest of [out.s, err.s]) if (rest.trim()) onLine(rest);
      resolve({ code, timedOut });
    });
  });
}

/** Whether a tool is on PATH (where/which), with no shell. */
export function hasToolOnPath(tool: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(platform === 'win32' ? 'where.exe' : 'which', [tool], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * e2e only (INSECTOIDS_E2E=1): never runs a real installer. INSECTOIDS_E2E_FAKE_INSTALL scripts the outcome:
 * ok = a few lines, then the engine shows as installed (the caller's recheck marks it); fail = an error exit;
 * missing-npm = npm "isn't here", so nothing runs. Any other value behaves like ok.
 */
export function fakeInstallDeps(mode: string): Pick<InstallDeps, 'hasTool' | 'run'> {
  return {
    hasTool: async (tool) => !(mode === 'missing-npm' && tool === 'npm'),
    run: async (_plan, onLine) => {
      onLine('Fetching the package (test: nothing is downloaded)…');
      onLine('Installing (test)…');
      if (mode === 'fail') {
        onLine('npm ERR! code E404 (test)');
        return { code: 1, timedOut: false };
      }
      onLine('added 1 package (test)');
      return { code: 0, timedOut: false };
    },
  };
}
