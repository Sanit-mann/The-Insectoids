import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { type ReadyProvider, demoEngine } from '@insectoids/harness';
import { BrainAskEstimateSchema, BrainAskResultSchema } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FALLBACK_TOKENS, askEstimate, cutQuestion } from '../brain-host/brain-ask';
import { HiveManager } from '../brain-host/hive-manager';

/** Ask the Brain in the host (Phase 4 A1): a real Brain, the scripted engine, no AI calls. */
const libraryDir = fileURLToPath(new URL('../../../../library', import.meta.url));
const FAKE_OPENCODE = fileURLToPath(new URL('../../../../packages/harness/src/opencode/fake-opencode.mjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const me = { type: 'user' } as const;

let root: string;
let repo: string;
let brain: Brain;
let manager: HiveManager | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'insectoids-ask-'));
  repo = join(root, 'site');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# Site\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  brain = openBrain(':memory:');
  manager = null;
});

afterEach(async () => {
  await manager?.dispose();
  await new Promise((r) => setTimeout(r, 50));
  brain.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function make(o: { project?: boolean; providers?: ReadyProvider[] } = {}): HiveManager {
  manager = new HiveManager({
    brain,
    tokens: null,
    doors: null,
    userDataDir: join(root, 'userData'),
    libraryDir,
    engine: 'fake',
    engineOverride: demoEngine({ queenMs: 5, insectMs: 20, inspectorMs: 5 }),
    ...(o.project === false ? {} : { project: repo }),
    push: () => {},
    tickMs: 20,
    seed: 1,
    geminiDetect: async () => ({ status: 'missing' }),
    librarian: { reviewEveryCards: 1000 },
    ...(o.providers
      ? {
          opencodeDetect: async () => ({ status: 'installed' as const, command: process.execPath, version: '2.2.1', args: [FAKE_OPENCODE] }),
          opencodeSystemConfig: () => null,
          providers: async () => o.providers!,
        }
      : {}),
  });
  return manager;
}

async function until<T>(what: string, read: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function ready(m: HiveManager): Promise<void> {
  await m.init();
  await until('engines checked', () => m.snapshot().engines.every((e) => e.state !== 'checking'));
}

const ask = async (m: HiveManager, question: string) => BrainAskResultSchema.parse(await m.brainAsk({ question }));
const runs = () => brain.outcomes.recent(100).length;

function seed(): { deploy: string; checklist: string } {
  const deploy = brain.write({ kind: 'decision', shelf: 'site', title: 'Deploys go through the staging server', body: 'Every deploy goes to the staging server first, then production after a check.' }, me).id;
  const checklist = brain.write({ kind: 'fact', shelf: 'global', title: 'Deploy checklist lives in the wiki', body: 'The checklist for deploys is kept in the team wiki.' }, me).id;
  return { deploy, checklist };
}

describe('Ask the Brain in the host (Phase 4 A1)', () => {
  it('needs an open project', async () => {
    const m = make({ project: false });
    await ready(m);
    expect(await ask(m, 'How do deploys work?')).toEqual({ status: 'error', question: 'How do deploys work?', message: 'Open a project first.' });
    const e = BrainAskEstimateSchema.parse(m.brainAskEstimate());
    expect(e).toMatchObject({ canAsk: false, message: 'Open a project first.' });
  });

  it("an empty Brain doesn't know, with no AI run and no tokens", async () => {
    const m = make();
    await ready(m);
    const before = runs();
    const r = await ask(m, 'How do deploys work?');
    expect(r).toEqual({ status: 'unknown', question: 'How do deploys work?', message: "The Brain doesn't know: nothing in it matches that question.", sources: [], tokens: 0, costUsd: 0 });
    expect(runs()).toBe(before);
  });

  it('answers from the records it found, citing real records that match the markers', async () => {
    const m = make();
    await ready(m);
    const ids = seed();
    // Another project's record never reaches the run.
    brain.write({ kind: 'fact', shelf: 'other-project', title: 'Deploys on the other project use FTP', body: 'deploy deploys' }, me);
    const r = await ask(m, 'How do deploys work?');
    if (r.status !== 'answered') throw new Error(`expected an answer, got ${JSON.stringify(r)}`);
    expect(r.sourcesGiven).toBe(2);
    expect(r.citations.map((c) => c.n)).toEqual([...r.citations.map((c) => c.n)].sort((a, b) => a - b));
    for (const c of r.citations) {
      expect([ids.deploy, ids.checklist]).toContain(c.id);
      expect(brain.get(c.id)?.title).toBe(c.title);
      expect(r.answer).toContain(`[${c.n}]`);
    }
    const markers = [...r.answer.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
    for (const n of markers) expect(r.citations.map((c) => c.n)).toContain(n);
    expect(r.engine).toBe('fake');
    // Asking writes nothing to the Brain.
    expect(brain.recent({ shelf: 'site', limit: 50 }).map((h) => h.id).sort()).toEqual([ids.deploy, ids.checklist].sort());
  });

  it("an answer the records don't hold comes back unknown, with the sources found", async () => {
    const m = make();
    await ready(m);
    seed();
    const r = await ask(m, 'Is the deploy schedule unknowable?');
    if (r.status !== 'unknown') throw new Error(`expected unknown, got ${JSON.stringify(r)}`);
    expect(r.message).toBe("The records found don't answer it.");
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.map((s) => s.n)).toEqual(r.sources.map((_s, i) => i + 1));
  });

  it('one question at a time', async () => {
    const m = make();
    await ready(m);
    seed();
    const [a, b] = await Promise.all([ask(m, 'How do deploys work?'), ask(m, 'Where is the deploy checklist?')]);
    expect(a.status).toBe('answered');
    expect(b).toEqual({ status: 'error', question: 'Where is the deploy checklist?', message: 'One question at a time.' });
  });

  it('saving an answer writes an unconfirmed update, as the Librarian, linked to the cited records', async () => {
    const m = make();
    await ready(m);
    const ids = seed();
    const r = await ask(m, 'How do deploys work?');
    if (r.status !== 'answered') throw new Error('expected an answer');
    const question = 'How do deploys work on this site, and who checks them before production goes live?';
    const saved = await m.command({ type: 'saveBrainAnswer', question, answer: r.answer, citationIds: r.citations.map((c) => c.id) });
    expect(saved).toEqual({ ok: true });
    const note = brain.recent({ shelf: 'site', kinds: ['update'], limit: 5 })[0]!;
    const rec = brain.get(note.id)!;
    expect(rec).toMatchObject({ kind: 'update', shelf: 'site', trust: 'unconfirmed', source: 'Ask the Brain', title: `Answer: ${cutQuestion(question)}` });
    expect(rec.owner).not.toBe('user');
    expect(rec.title.length).toBeLessThanOrEqual('Answer: '.length + 80);
    expect(rec.body.startsWith(r.answer)).toBe(true);
    expect(rec.body).toContain('Sources');
    for (const c of r.citations) expect(rec.body).toContain(`- ${c.title}`);
    const cites = brain.links(rec.id).filter((l) => l.rel === 'cites' && l.direction === 'out').map((l) => l.id);
    expect(cites.sort()).toEqual(r.citations.map((c) => c.id).sort());
    expect([ids.deploy, ids.checklist]).toEqual(expect.arrayContaining(cites));
  });

  it('refuses to save with a citation that is not a record of this project', async () => {
    const m = make();
    await ready(m);
    const other = brain.write({ kind: 'fact', shelf: 'other-project', title: 'Not here', body: 'Elsewhere.' }, me).id;
    for (const id of ['R-nope', other]) {
      const r = await m.command({ type: 'saveBrainAnswer', question: 'Where?', answer: 'There [1].', citationIds: [id] });
      expect(r).toEqual({ ok: false, error: `Not saved: ${id} is not a record in this project's Brain.` });
    }
    expect(brain.recent({ shelf: 'site', kinds: ['update'], limit: 5 })).toEqual([]);
  });

  it('the estimate names the scripted engine and the fallback range', async () => {
    const m = make();
    await ready(m);
    const e = BrainAskEstimateSchema.parse(m.brainAskEstimate());
    expect(e).toMatchObject({ canAsk: true, free: true, tokensLow: FALLBACK_TOKENS.low, tokensHigh: FALLBACK_TOKENS.high, costUsdHigh: null });
  });

  it('the estimate says free when a local model answers', async () => {
    const m = make({ providers: [{ id: 'ollama', label: 'Ollama', local: true, models: { strongest: 'qwen3:8b', standard: 'qwen3:8b', light: 'qwen3:8b' } }] });
    await ready(m);
    expect(m.snapshot().engines.find((e) => e.id === 'opencode')).toMatchObject({ state: 'ready' });
    const e = BrainAskEstimateSchema.parse(m.brainAskEstimate());
    expect(e).toMatchObject({ canAsk: true, engine: 'OpenCode', free: true, costUsdHigh: null, tokensLow: 3_000, tokensHigh: 8_000 });
    expect(e.message).toBe('Free: about 3,000–8,000 tokens per question on OpenCode, a model on this computer.');
  });
});

describe('the ask estimate (plain code)', () => {
  const run = (engine: string, tokens: number, costUsd = 0, role = 'librarian') => ({ role, engine, tokens, costUsd });

  it("gives a range around the median of the engine's own Librarian runs", () => {
    const e = askEstimate({ project: true, engine: { id: 'claude', name: 'Claude Code', free: false, subscription: true }, runs: [run('claude', 4_000), run('claude', 6_000), run('claude', 5_000), run('claude', 90_000, 0, 'queen')] });
    expect(e).toMatchObject({
      canAsk: true,
      free: false,
      tokensLow: 2_500,
      tokensHigh: 7_500,
      costUsdHigh: null,
      message: "About 2,500–7,500 tokens per question on Claude Code (your subscription). Most of them are Claude Code's own instructions, read again from its cache.",
    });
  });

  it('prices a per-token engine from its own past runs', () => {
    const e = askEstimate({ project: true, engine: { id: 'opencode', name: 'OpenCode', free: false, subscription: false }, runs: [run('opencode', 10_000, 0.1, 'builder')] });
    expect(e).toMatchObject({ tokensLow: 3_000, tokensHigh: 8_000, costUsdHigh: 0.08, message: 'About 3,000–8,000 tokens per question on OpenCode, up to about $0.08 (billed by your API provider).' });
  });

  it('says "your subscription" for any engine whose capabilities say so, not a fixed list of ids', () => {
    const copilot = askEstimate({ project: true, engine: { id: 'copilot', name: 'GitHub Copilot CLI', free: false, subscription: true }, runs: [] });
    expect(copilot).toMatchObject({ costUsdHigh: null, message: 'About 3,000–8,000 tokens per question on GitHub Copilot CLI (your subscription).' });
    const unmarked = askEstimate({ project: true, engine: { id: 'claude', name: 'Claude Code', free: false, subscription: false }, runs: [] });
    expect(unmarked.message).toBe("About 30,000–60,000 tokens per question on Claude Code (billed by your API provider per token). Most of them are Claude Code's own instructions, read again from its cache.");
  });

  it("Claude Code's fallback counts its own instructions, which it reads on every run (Phase 4 demo: about 46,000 tokens)", () => {
    const e = askEstimate({ project: true, engine: { id: 'claude', name: 'Claude Code', free: false, subscription: true }, runs: [run('claude', 90_000, 0, 'queen')] });
    expect(e).toMatchObject({ tokensLow: 30_000, tokensHigh: 60_000, costUsdHigh: null });
    expect(e.message).toBe("About 30,000–60,000 tokens per question on Claude Code (your subscription). Most of them are Claude Code's own instructions, read again from its cache.");
  });

  it('says why when nothing can answer', () => {
    expect(askEstimate({ project: true, engine: null, runs: [] })).toMatchObject({ canAsk: false, engine: null, message: 'No AI engine is ready to answer. Set one up in Connections.' });
  });
});
