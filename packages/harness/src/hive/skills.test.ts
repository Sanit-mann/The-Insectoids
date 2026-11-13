import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Brain, openBrain } from '@insectoids/brain';
import { CasteSchema } from '@insectoids/shared';
import { Workspace } from '@insectoids/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_CASTES, CASTE_NETWORK, MAX_ACTIVE_SKILLS, chooseSkills, cleanDescription, firstSentence, frontmatterDescription, licenseFor, loadCatalog, readNoticeLicenses } from './catalog';
import { DEMO_TEAM_PLAN, demoEngine } from './demo';
import { type EngineRequest, FakeEngine, type FakeReply } from './engine';
import { Hive } from './hive';
import { Library, ROLE_SKILLS, queenPrompt } from './prompts';
import { MAX_PLAN_SKILLS, parsePlan } from './protocol';

/** All 8 castes and library activation (Capabilities 03-D3, D7, D8; Phase 2 C1). */
const LIBRARY_DIR = fileURLToPath(new URL('../../../../library', import.meta.url));
const library = new Library(LIBRARY_DIR);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const cardOf = (req: EngineRequest): string => /# (?:Verify card|Card) (C-\d+)/.exec(req.task)?.[1] ?? '';
const skillsIn = (req: EngineRequest): string[] => [...req.system.matchAll(/^## Skill: (\S+)$/gm)].map((m) => m[1]!);

describe('the catalog from the library folder', () => {
  const items = loadCatalog(LIBRARY_DIR);
  const byName = new Map(items.map((i) => [i.name, i]));

  it('lists every catalog entry, each once', () => {
    expect(items.length).toBeGreaterThan(900);
    expect(byName.size).toBe(items.length);
  });

  it('marks caste agents, hive roles and default skills active; other rewritten items ready; the rest dormant', () => {
    for (const c of ALL_CASTES) expect(byName.get(c)).toMatchObject({ kind: 'agent', status: 'active', safety: 'vetted' });
    for (const s of new Set(Object.values(ROLE_SKILLS).flat())) expect(byName.get(s)?.status, s).toBe('active');
    expect(byName.get('accessibility')).toMatchObject({ status: 'ready', safety: 'vetted', file: 'skills/accessibility/SKILL.md' });
    // C2: the Scout and the Foreman run in the hive now; the Watchdog has no LLM brain yet, so it stays ready.
    expect(byName.get('foreman')?.status).toBe('active');
    expect(byName.get('scout')?.status).toBe('active');
    expect(byName.get('watchdog')?.status).toBe('ready');
    const dormant = items.filter((i) => i.status === 'dormant');
    expect(dormant.length).toBeGreaterThan(800);
    expect(dormant.every((i) => i.file === null && i.safety === 'unscanned')).toBe(true);
    expect(items.some((i) => i.status === 'draft')).toBe(false);
  });

  it('keeps each source with its license, from THIRD-PARTY-NOTICES.md when the catalog has none', () => {
    expect(byName.get('analyst')!.sources[0]).toMatchObject({ repo: 'msitarzewski/agency-agents', license: 'MIT' });
    expect(byName.get('agent-browser')!.sources.find((s) => s.repo === 'vercel-labs/agent-browser')?.license).toBe('Apache-2.0');
    // Every source of a rewritten (active or ready) item has a recorded license.
    const onDisk = items.filter((i) => i.status !== 'dormant');
    expect(onDisk.flatMap((i) => i.sources).filter((s) => s.license === null)).toEqual([]);
  });

  it('reads the notices table as SPDX ids, and the project\'s own notes as MIT', () => {
    const licenses = readNoticeLicenses(LIBRARY_DIR);
    expect(licenses.get('obra/superpowers')).toBe('MIT');
    expect(licenses.get('juliusbrussee/caveman')).toBe('Apache-2.0');
    expect(licenses.get('vercel-labs/agent-skills')).toBe('MIT');
    expect(licenseFor(licenses, 'the-insectoids/functions')).toBe('MIT');
    expect(licenseFor(licenses, 'someone/else')).toBeNull();
  });

  it('descriptions are plain text: no stray quotes from YAML', () => {
    expect(byName.get('code-review')!.description.endsWith('finished work.')).toBe(true);
    for (const i of items) expect(i.description, i.name).not.toMatch(/^["']|["']$/);
    expect(cleanDescription(`'It''s fine.'`)).toBe("It's fine.");
    expect(cleanDescription('"Say \\"hi\\"."')).toBe('Say "hi".');
    expect(cleanDescription(`Ends with a lone quote.'`)).toBe('Ends with a lone quote.');
    expect(cleanDescription(`Uses "quotes" inside`)).toBe('Uses "quotes" inside');
  });
});

describe('castes (03-D3)', () => {
  it('the hive knows all 8 castes, each with a network policy and a role on disk', () => {
    expect([...ALL_CASTES]).toEqual(CasteSchema.options);
    expect(ALL_CASTES).toHaveLength(8);
    for (const c of ALL_CASTES) {
      expect(['none', 'docs', 'web']).toContain(CASTE_NETWORK[c]);
      expect(() => library.role(c)).not.toThrow();
      expect(firstSentence(frontmatterDescription(`---\ndescription: ${'Insect caste. Use it.'}\n---\n`))).toBe('Insect caste.');
    }
  });
});

describe('choosing skills for a card (03-D8 budget rule)', () => {
  it('defaults first, then the Queen\'s picks, then search matches; no repeats; never more than 5', () => {
    expect(chooseSkills({ defaults: ['a', 'b'], picked: ['c', 'a'], found: ['d', 'e', 'f'] })).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(MAX_ACTIVE_SKILLS).toBe(5);
  });
});

describe("the Queen's skill picks", () => {
  const plan = (skills: unknown) => `\`\`\`json\n${JSON.stringify({ summary: 'S', waves: [{ cards: [{ title: 'T', brief: 'B', caste: 'coder', acceptance: ['ok'], skills }] }] })}\n\`\`\``;

  it('keeps known, switchable names (at most 3) and drops the rest without failing the plan', () => {
    const allowed = new Set(['accessibility', 'react-testing', 'api-design', 'typescript-patterns']);
    const r = parsePlan(plan(['accessibility', 'no-such-skill', 42, 'accessibility', 'react-testing', 'api-design', 'typescript-patterns']), { castes: ['coder'], skillAllowed: (n) => allowed.has(n) });
    expect(r.ok && r.plan.waves[0]!.cards[0]!.skills).toEqual(['accessibility', 'react-testing', 'api-design']);
    expect(MAX_PLAN_SKILLS).toBe(3);
  });

  it('a plan without skills, or a hive that can\'t check them, gives cards none', () => {
    const r = parsePlan(plan(['accessibility']), { castes: ['coder'] });
    expect(r.ok && r.plan.waves[0]!.cards[0]!.skills).toEqual([]);
  });

  it('the planner prompt lists the skills that fit the goal, or says to leave skills empty', () => {
    const base = { goal: 'g', bootCard: '', context: '', castes: ['coder'] as const, projectListing: '' };
    expect(queenPrompt(library, { ...base, skills: [{ name: 'accessibility', description: 'Accessible UI.' }] }).system).toContain('- accessibility: Accessible UI.');
    expect(queenPrompt(library, base).system).toContain('Leave every card\'s "skills" as [].');
  });
});

describe('activation in the hive', () => {
  let root: string;
  let repo: string;
  let brain: Brain;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'insectoids-skills-'));
    repo = join(root, 'project');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'user@example.com');
    writeFileSync(join(repo, 'README.md'), '# Site\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial');
    brain = openBrain(':memory:');
    brain.library.sync(loadCatalog(LIBRARY_DIR));
    ws = new Workspace({ repoDir: repo, worktreesRoot: join(root, 'worktrees') });
  });

  afterEach(async () => {
    await ws.dispose();
    brain.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const makeHive = (engine: FakeEngine) =>
    new Hive({
      brain, workspace: ws, engine, library, repoDir: repo, dataDir: join(root, 'data'), shelf: 'site', home: join(root, 'home'),
      models: { strongest: 'opus', standard: 'sonnet', light: 'haiku' }, insectCap: 3, castes: [...ALL_CASTES], leaseMs: 60_000,
    });

  const reply = (plan: unknown): FakeReply => ({ text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` });

  it('an insect carries its defaults, the Queen\'s picks and search matches (≤ 5), never a dormant entry; the next card starts fresh', async () => {
    // A dormant catalog entry the Queen tries to add: it must never reach an insect.
    const dormant = brain.library.search({ statuses: ['dormant'], kinds: ['skill'], limit: 1 }).items[0]!.name;
    const queenSaw: string[] = [];
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') {
        queenSaw.push(req.system);
        return reply({
          summary: 'UI work',
          waves: [{ cards: [
            { id: 'C-01', title: 'Make the signup form accessible', brief: 'Keyboard focus, WCAG contrast and screen reader labels for the signup form.', caste: 'designer', acceptance: ['ok'], skills: ['react-testing', dormant, 'no-such-skill'] },
            { id: 'C-02', title: 'Write the changelog', brief: 'Note the change.', caste: 'writer', acceptance: ['ok'] },
          ] }],
        });
      }
      if (req.role === 'inspector') return { text: 'VERDICT: PASS' };
      return { text: 'Done.\nSTATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `${cardOf(req)}.txt`), 'x\n') };
    });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Make the signup form accessible with keyboard focus and screen reader labels');
    await hive.runUntilIdle();

    expect(queenSaw[0]).toContain('## Library skills');
    expect(queenSaw[0]).toContain('- accessibility:');
    const designer = engine.calls.find((c) => c.role === 'designer')!;
    const carried = skillsIn(designer);
    expect(carried.slice(0, ROLE_SKILLS.designer.length)).toEqual(ROLE_SKILLS.designer);
    expect(carried).toContain('react-testing');
    expect(carried).toContain('accessibility');
    expect(carried).not.toContain(dormant);
    expect(carried.length).toBeLessThanOrEqual(MAX_ACTIVE_SKILLS);
    // The writer's card shares nothing with the designer's: it carries only its own defaults (03-D7).
    expect(skillsIn(engine.calls.find((c) => c.role === 'writer')!)).toEqual(ROLE_SKILLS.writer);

    const latest = brain.library.latestByCard([`${goal.id}.C-01`, `${goal.id}.C-02`]);
    expect(latest.get(`${goal.id}.C-01`)).toEqual(carried);
    expect(brain.library.get('react-testing')).toMatchObject({ uses: 1, passed: 1, failed: 0 });
    expect(brain.library.get('react-testing')!.tokens).toBeGreaterThan(0);
    expect(brain.library.get(dormant)!.uses).toBe(0);
  });

  it('a rejected attempt counts as a fail for the skills it carried; the retry carries a fresh set', async () => {
    let inspections = 0;
    const engine = new FakeEngine((req) => {
      if (req.role === 'queen') return reply({ summary: 'S', waves: [{ cards: [{ id: 'C-01', title: 'Build it', brief: 'Build.', caste: 'coder', acceptance: ['ok'] }] }] });
      if (req.role === 'inspector') return { text: ++inspections === 1 ? 'VERDICT: FAIL: not yet' : 'VERDICT: PASS' };
      return { text: 'STATUS: DONE', effects: (cwd) => writeFileSync(join(cwd, `try${inspections}.txt`), 'x\n') };
    });
    const hive = makeHive(engine);
    await hive.submitGoal('Build it');
    await hive.runUntilIdle();
    expect(brain.library.get('coding-discipline')).toMatchObject({ uses: 2, passed: 1, failed: 1 });
  });

  it('a goal across three castes (coder, tester, documenter) runs to done (C1 done-when)', async () => {
    const engine = demoEngine({ queenMs: 1, insectMs: 5, inspectorMs: 1 });
    const hive = makeHive(engine);
    const goal = await hive.submitGoal('Write the welcome docs');
    expect(goal.status).toBe('running');
    await hive.runUntilIdle();

    const cards = brain.taskboard.list({ goalId: goal.id });
    expect(cards.map((c) => c.caste).sort()).toEqual(['coder', 'documenter', 'tester']);
    expect(cards.every((c) => c.status === 'done')).toBe(true);
    expect(engine.calls.filter((c) => c.role !== 'queen' && c.role !== 'inspector').map((c) => c.role).sort()).toEqual(['coder', 'documenter', 'tester']);
    // The Queen's picks reached the cards she named them for.
    expect(skillsIn(engine.calls.find((c) => c.role === 'documenter')!)).toContain('writing-guidelines');
    expect(skillsIn(engine.calls.find((c) => c.role === 'coder')!)).toContain('surgical-patch');

    const merge = brain.approvals.list({ status: 'waiting' }).find((a) => a.kind === 'merge')!;
    await hive.approve(merge.id);
    expect(brain.goals.get(goal.id)!.status).toBe('done');
    expect(DEMO_TEAM_PLAN.waves).toHaveLength(1);
  });
});
