import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import type { InsectoidsApi } from '@insectoids/shared';

/** For code inside win.evaluate(): the e2e tsconfig has no DOM, so use (globalThis as unknown as AppWindow).insectoids. */
export type AppWindow = { insectoids: InsectoidsApi };

const appDir = fileURLToPath(new URL('../..', import.meta.url));

export interface LaunchedApp {
  app: ElectronApplication;
  win: Page;
  /** The temp git repo the hive works on ('' when project is 'none'). */
  repo: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** 'fresh-repo' (default): a new git repo with one commit on main is the project. 'none': no project yet. */
  project?: 'fresh-repo' | 'none';
  /**
   * true (default): setup counts as done, so specs that are not about onboarding open straight into the app.
   * false: a true first run (the setup wizard shows).
   */
  onboarded?: boolean;
  /** Extra environment for the app. */
  env?: Record<string, string>;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A new git repo with one commit on `main`. Its folder name contains a space, like the real project. */
export function makeRepo(): string {
  const repo = join(mkdtempSync(join(tmpdir(), 'insectoids-e2e-repo-')), 'sample project');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'E2E');
  git(repo, 'config', 'user.email', 'e2e@insectoids.local');
  git(repo, 'config', 'commit.gpgsign', 'false');
  // Same line endings for every git call (the hive's and the test's), whatever the machine's global setting.
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Sample project\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Initial commit');
  return repo;
}

/**
 * Launches the app for e2e: throwaway profile (INSECTOIDS_E2E), scripted fake engine (no tokens),
 * and a fresh git repo as the project. The fake engine's Queen always plans "Say hello":
 * wave 1 "Write hello.txt" (coder) + "Check hello.txt" (tester), wave 2 "Write README note" (coder).
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const repo = opts.project === 'none' ? '' : makeRepo();
  // GitHub's Linux runners block Chromium's OS sandbox; disable it there only, for tests.
  const ciLinux = Boolean(process.env['CI']) && process.platform === 'linux';
  const app = await electron.launch({
    args: ciLinux ? ['.', '--no-sandbox'] : ['.'],
    cwd: appDir,
    env: {
      ...process.env,
      INSECTOIDS_E2E: '1',
      INSECTOIDS_ENGINE: 'fake',
      ...(repo ? { INSECTOIDS_E2E_PROJECT: repo } : {}),
      ...(opts.onboarded === false ? {} : { INSECTOIDS_E2E_ONBOARDED: '1' }),
      ...opts.env,
    },
  });
  const win = await app.firstWindow();
  return {
    app,
    win,
    repo,
    close: async () => {
      await app.close().catch(() => {});
      if (repo) rmSync(join(repo, '..'), { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** Run git in the e2e repo (e.g. to check what reached main). */
export const repoGit = git;
