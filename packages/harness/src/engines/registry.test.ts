import { describe, expect, it } from 'vitest';
import { FakeEngine } from '../hive/engine';
import { type EngineCandidate, pickEngine, routeCard } from '../hive/router';
import { claudeAdapter, fakeAdapter, plannedAdapters } from './adapters';
import { type EngineAdapter, type EngineDetection, EngineRegistry } from './registry';

const reply = () => ({ text: 'STATUS: DONE' });

/** A runnable adapter with a scripted detection. */
function adapter(id: EngineAdapter['id'], detection: EngineDetection, o: { guard?: EngineAdapter['capabilities']['guard']; engine?: FakeEngine } = {}): EngineAdapter {
  const engine = o.engine ?? new FakeEngine(reply);
  return {
    id,
    name: `${id} engine`,
    vendor: 'test',
    capabilities: { guard: o.guard === undefined ? 'hook' : o.guard, mcp: true, effort: ['low', 'medium', 'high', 'max'], reportsCost: true },
    models: { strongest: `${id}-big`, standard: `${id}-mid`, light: `${id}-small` },
    availableIn: null,
    install: null,
    signIn: null,
    privacyNote: null,
    detect: async () => detection,
    create: () => engine,
  };
}
const ready: EngineDetection = { state: 'ready', version: '1.0.0', message: 'ready' };
const signedOut: EngineDetection = { state: 'signed-out', version: '1.0.0', message: 'signed out' };

describe('engine registry (Connections 04-D2, Phase 2 A1)', () => {
  it('keeps the user\'s order, with unknown ids ignored and the rest appended', () => {
    const r = new EngineRegistry([adapter('claude', ready), adapter('gemini', ready), ...plannedAdapters()]);
    expect(r.order).toEqual(['claude', 'gemini', 'codex', 'opencode']);
    r.setOrder(['opencode', 'gemini', 'fake', 'gemini']);
    expect(r.order).toEqual(['opencode', 'gemini', 'claude', 'codex']);
  });

  it('restores saved preferences', () => {
    const r = new EngineRegistry([adapter('claude', ready), adapter('gemini', ready)], { order: ['gemini', 'claude'], disabled: ['claude'] });
    expect(r.order).toEqual(['gemini', 'claude']);
    expect(r.isEnabled('claude')).toBe(false);
    expect(r.prefs()).toEqual({ order: ['gemini', 'claude'], disabled: ['claude'] });
  });

  it('shows "checking" before the first detection and "unsupported" for engines without an adapter', async () => {
    const r = new EngineRegistry([adapter('claude', ready), ...plannedAdapters()]);
    expect(r.cards().map((c) => [c.id, c.state])).toEqual([['claude', 'checking'], ['codex', 'unsupported'], ['opencode', 'unsupported']]);
    await r.detectAll();
    const cards = r.cards();
    expect(cards[0]).toMatchObject({ id: 'claude', state: 'ready', version: '1.0.0', enabled: true });
    expect(cards[1]).toMatchObject({ id: 'codex', state: 'unsupported' });
    expect(cards[1]!.install?.command).toBe('npm install -g @openai/codex');
  });

  it('a detection that throws becomes "missing" with the reason', async () => {
    const broken: EngineAdapter = { ...adapter('claude', ready), detect: () => Promise.reject(new Error('spawn failed')) };
    const r = new EngineRegistry([broken]);
    await r.detectAll();
    expect(r.cards()[0]).toMatchObject({ state: 'missing', message: expect.stringMatching(/spawn failed/) });
  });

  it('the default engine is the first enabled, ready one', async () => {
    const r = new EngineRegistry([adapter('claude', signedOut), adapter('gemini', ready), adapter('codex', ready)]);
    expect(r.defaultEngine()).toBeNull();
    await r.detectAll();
    expect(r.defaultEngine()?.id).toBe('gemini');
    r.setEnabled('gemini', false);
    expect(r.defaultEngine()?.id).toBe('codex');
    expect(r.anyEnabledNotReady).toBe(true);
  });

  it('routes with the picked engine\'s model tiers', async () => {
    const r = new EngineRegistry([adapter('claude', signedOut), adapter('gemini', ready)]);
    await r.detectAll();
    expect(r.route({ role: 'coder', priority: 'normal', attempts: 0 }, routeCard)).toMatchObject({ engine: 'gemini', model: 'gemini-mid', effort: 'medium' });
  });

  it('with no engine able to run, the route still names one and the run fails as not ready', async () => {
    const r = new EngineRegistry([adapter('claude', signedOut)]);
    await r.detectAll();
    const route = r.route({ role: 'coder', priority: 'normal', attempts: 0 }, routeCard);
    expect(route.engine).toBe('claude');
    const res = await r.engine().run({ role: 'coder', agentId: 'Ant-1', cwd: '.', system: '', task: '', route, guard: {} as never }).done;
    expect(res).toMatchObject({ ok: false, error: 'auth', stderrTail: 'claude engine is not ready.' });
  });

  it('dispatches each run to the engine its route names, never to a switched-off one', async () => {
    const a = new FakeEngine(reply);
    const b = new FakeEngine(reply);
    const r = new EngineRegistry([adapter('claude', ready, { engine: a }), adapter('gemini', ready, { engine: b })]);
    await r.detectAll();
    const req = (engine: 'claude' | 'gemini') => ({ role: 'coder' as const, agentId: 'Ant-1', cwd: '.', system: '', task: '', route: { ...routeCard({ role: 'coder', priority: 'normal', attempts: 0 }, { strongest: 'x', standard: 'y', light: 'z' }), engine }, guard: {} as never });
    await r.engine().run(req('gemini')).done;
    expect([a.calls.length, b.calls.length]).toEqual([0, 1]);
    r.setEnabled('gemini', false);
    expect(await r.engine().run(req('gemini')).done).toMatchObject({ ok: false, stderrTail: 'gemini engine is switched off.' });
    expect(b.calls.length).toBe(1);
  });

  it('a scripted engine is ready at once and never needs a sign-in', async () => {
    const r = new EngineRegistry([fakeAdapter(new FakeEngine(reply))]);
    await r.detectAll();
    expect(r.cards()[0]).toMatchObject({ id: 'fake', state: 'fake', enabled: true });
    expect(r.defaultEngine()?.id).toBe('fake');
  });

  it('the Claude adapter reports missing, outdated, signed out and ready in plain words', async () => {
    const make = (install: Parameters<typeof claudeAdapter>[0]['detect'], loggedIn = true) =>
      claudeAdapter({ hook: { command: 'node', args: [] }, promptDir: '.', detect: install!, auth: async () => ({ loggedIn }) });
    expect(await make(async () => ({ status: 'missing' })).detect!()).toMatchObject({ state: 'missing' });
    expect(await make(async () => ({ status: 'outdated', command: 'claude', version: '2.0.0', minimum: '2.1.295' })).detect!()).toMatchObject({ state: 'outdated', message: expect.stringMatching(/claude update/) });
    expect(await make(async () => ({ status: 'installed', command: 'claude', version: '2.1.322' }), false).detect!()).toMatchObject({ state: 'signed-out', message: expect.stringMatching(/claude auth login/) });
    const good = make(async () => ({ status: 'installed', command: 'claude', version: '2.1.322' }));
    expect(await good.detect!()).toMatchObject({ state: 'ready', version: '2.1.322' });
    expect(good.create!()).toBe(good.create!());
  });
});

describe('which engine runs what (pickEngine)', () => {
  const c = (id: EngineCandidate['id'], over: Partial<EngineCandidate> = {}): EngineCandidate => ({ id, enabled: true, ready: true, guard: 'hook', ...over });

  it('takes the first enabled, ready, guarded engine in the user\'s order', () => {
    expect(pickEngine('coder', [c('claude'), c('gemini')])).toBe('claude');
    expect(pickEngine('coder', [c('claude', { enabled: false }), c('gemini')])).toBe('gemini');
    expect(pickEngine('coder', [c('claude', { ready: false }), c('gemini')])).toBe('gemini');
  });

  it('never an engine without a guard', () => {
    expect(pickEngine('coder', [c('gemini', { guard: null })])).toBeNull();
  });

  it('a read-only engine only takes work that changes nothing', () => {
    const list = [c('gemini', { guard: 'read-only' })];
    expect(pickEngine('coder', list)).toBeNull();
    expect(pickEngine('tester', list)).toBeNull();
    expect(pickEngine('inspector', list)).toBeNull();
    expect(pickEngine('reviewer', list)).toBe('gemini');
    expect(pickEngine('queen', list)).toBe('gemini');
    expect(pickEngine('coder', [...list, c('claude')])).toBe('claude');
  });

  it('none qualifying gives null', () => {
    expect(pickEngine('coder', [])).toBeNull();
  });
});
