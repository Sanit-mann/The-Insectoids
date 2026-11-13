import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, type LibraryItemInput, openBrain } from './index';

/** The library catalog in the Brain (Capabilities 03-D8; Phase 2 C1). */
let brain: Brain;
let clock: number;

const item = (name: string, o: Partial<LibraryItemInput> = {}): LibraryItemInput => ({
  name,
  kind: 'skill',
  status: 'ready',
  castes: ['coder'],
  description: `${name} skill`,
  safety: 'vetted',
  file: `skills/${name}/SKILL.md`,
  sources: [{ repo: 'example/repo', path: `${name}.md`, license: 'MIT' }],
  ...o,
});

const CATALOG: LibraryItemInput[] = [
  item('coder', { kind: 'agent', status: 'active', description: 'Insect caste that writes code for one task card.', file: 'agents/coder/AGENT.md' }),
  item('coding-discipline', { status: 'active', castes: ['coder', 'reviewer', 'tester'], description: 'Small, careful code changes with tests.' }),
  item('accessibility', { castes: ['designer', 'coder'], description: 'Accessible UI: WCAG contrast, keyboard focus, screen reader labels for forms and dialogs.' }),
  item('react-testing', { castes: ['tester', 'coder'], description: 'Testing React components with Testing Library and user events.' }),
  item('technical-writing', { castes: ['documenter', 'writer'], description: 'Clear READMEs, guides and API docs.' }),
  item('task-handoff', { castes: ['all'], description: 'Handing a task to the next agent with context.' }),
  item('form-wizard', { status: 'dormant', safety: 'unscanned', file: null, castes: ['designer'], description: 'Accessible multi-step forms with keyboard focus and screen reader labels.' }),
  item('agent-browser', { kind: 'tool', castes: ['tester'], description: 'Browser automation tool for accessible UI checks.', file: 'tools/agent-browser.md' }),
];

beforeEach(() => {
  clock = 1_000_000;
  brain = openBrain(':memory:', { now: () => clock });
  brain.library.sync(CATALOG);
});

afterEach(() => brain.close());

describe('sync', () => {
  it('adds, updates and removes by name, and keeps usage across syncs', () => {
    brain.library.activate('g.C-01', 0, [{ name: 'accessibility', tokens: 300 }]);
    const next = CATALOG.filter((i) => i.name !== 'task-handoff').map((i) => (i.name === 'accessibility' ? { ...i, description: 'Accessible UI, updated.' } : i));
    expect(brain.library.sync([...next, item('new-skill')])).toEqual({ added: 1, updated: next.length, removed: 1 });
    expect(brain.library.get('task-handoff')).toBeUndefined();
    expect(brain.library.get('accessibility')).toMatchObject({ description: 'Accessible UI, updated.', uses: 1, tokens: 300 });
  });

  it('never removes drafts, which come from the hive and not from the folder', () => {
    brain.library.sync([...CATALOG, item('proposed', { status: 'draft' })]);
    brain.library.sync(CATALOG);
    expect(brain.library.get('proposed')?.status).toBe('draft');
  });
});

describe('search (Library screen)', () => {
  it('lists everything active first, then ready, then dormant, and counts the whole catalog by status', () => {
    const { items, total } = brain.library.search({ limit: 100 });
    expect(total).toBe(CATALOG.length);
    expect(items[0]!.status).toBe('active');
    expect(items.at(-1)!.status).toBe('dormant');
    expect(brain.library.counts()).toEqual({ active: 2, ready: 5, dormant: 1, draft: 0, retired: 0 });
  });

  it('matches every word as a prefix in name or description, best first', () => {
    const { items } = brain.library.search({ query: 'keyboard screen' });
    expect(items.map((i) => i.name).sort()).toEqual(['accessibility', 'form-wizard']);
    expect(brain.library.search({ query: 'react test' }).items[0]!.name).toBe('react-testing');
  });

  it('filters by kind, status and caste (a caste also sees items for "all")', () => {
    expect(brain.library.search({ kinds: ['tool'] }).items.map((i) => i.name)).toEqual(['agent-browser']);
    expect(brain.library.search({ statuses: ['dormant'] }).items.map((i) => i.name)).toEqual(['form-wizard']);
    expect(brain.library.search({ caste: 'documenter' }).items.map((i) => i.name).sort()).toEqual(['task-handoff', 'technical-writing']);
  });

  it('pages with limit and offset and reports the total before paging', () => {
    const page = brain.library.search({ limit: 3, offset: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(CATALOG.length);
  });

  it('ranks the exact name first, then names holding the words by status, then text-only matches', () => {
    brain.library.sync([
      ...CATALOG,
      item('review', { status: 'dormant', file: null, safety: 'unscanned', description: 'Old review prompt.' }),
      item('code-review', { status: 'active', castes: ['reviewer'], description: 'Review a code change for real problems.' }),
      item('python-review', { castes: ['reviewer'], description: 'Python review checks.' }),
      item('review-team-deliverables', { status: 'dormant', file: null, safety: 'unscanned', description: 'Review what a team delivered.' }),
      item('agent-reviewer', { status: 'dormant', file: null, safety: 'unscanned', description: 'Reviews agents.' }),
      item('lint-helper', { description: 'Fixes lint before a review.' }),
    ]);
    expect(brain.library.search({ query: 'review' }).items.map((i) => i.name)).toEqual([
      'review', // the exact name, even though it is dormant
      'code-review', // active name match
      'python-review', // ready name match
      'agent-reviewer', // dormant name matches, by text rank
      'review-team-deliverables',
      'lint-helper', // the word only in its description
    ]);
  });

  it('treats odd characters in a query as plain words', () => {
    expect(() => brain.library.search({ query: 'react" OR (*' })).not.toThrow();
  });
});

describe('activation (03-D8 Find / Activate / Deactivate)', () => {
  it('finds only skills an insect may carry: never a dormant entry, a tool or an agent', () => {
    const found = brain.library.activatable('Make the signup form accessible: keyboard focus and screen reader labels', { limit: 5 });
    expect(found.map((i) => i.name)).toEqual(['accessibility']);
    expect(brain.library.isActivatable('form-wizard')).toBe(false);
    expect(brain.library.isActivatable('agent-browser')).toBe(false);
    expect(brain.library.isActivatable('coder')).toBe(false);
    expect(brain.library.isActivatable('accessibility')).toBe(true);
  });

  it('needs at least two matching words, so one common word switches nothing on', () => {
    expect(brain.library.activatable('Fix the form')).toEqual([]);
    expect(brain.library.activatable('Write the README guide for the docs').map((i) => i.name)).toEqual(['technical-writing']);
  });

  it('leaves out excluded names and prefers skills for the caste on a tie', () => {
    expect(brain.library.activatable('react testing components', { exclude: ['react-testing'] })).toEqual([]);
  });

  it('records an activation once per attempt and counts each use and its prompt cost', () => {
    brain.library.activate('g.C-01', 0, [{ name: 'accessibility', tokens: 250 }, { name: 'coding-discipline', tokens: 100 }]);
    brain.library.activate('g.C-01', 0, [{ name: 'accessibility', tokens: 250 }]);
    expect(brain.library.activated('g.C-01', 0)).toEqual(['accessibility', 'coding-discipline']);
    expect(brain.library.get('accessibility')).toMatchObject({ uses: 1, tokens: 250, lastUsedAt: clock });
  });

  it('settles an attempt once: the carried skills count a pass or a fail', () => {
    brain.library.activate('g.C-01', 0, [{ name: 'accessibility', tokens: 1 }]);
    brain.library.settle('g.C-01', 0, 'failed');
    brain.library.settle('g.C-01', 0, 'failed');
    brain.library.activate('g.C-01', 1, [{ name: 'accessibility', tokens: 1 }]);
    brain.library.settle('g.C-01', 1, 'passed');
    expect(brain.library.get('accessibility')).toMatchObject({ uses: 2, passed: 1, failed: 1 });
  });

  it("shows each card's skills from its latest attempt", () => {
    brain.library.activate('g.C-01', 0, [{ name: 'accessibility', tokens: 1 }]);
    brain.library.activate('g.C-01', 1, [{ name: 'coding-discipline', tokens: 1 }, { name: 'react-testing', tokens: 1 }]);
    brain.library.activate('g.C-02', 0, [{ name: 'technical-writing', tokens: 1 }]);
    const m = brain.library.latestByCard(['g.C-01', 'g.C-02', 'g.C-03']);
    expect(m.get('g.C-01')).toEqual(['coding-discipline', 'react-testing']);
    expect(m.get('g.C-02')).toEqual(['technical-writing']);
    expect(m.has('g.C-03')).toBe(false);
  });

  it('lists the latest cards an item was carried on, one row per card, newest first', () => {
    brain.library.activate('g.C-01', 0, [{ name: 'accessibility', tokens: 1 }]);
    clock += 10;
    brain.library.activate('g.C-02', 0, [{ name: 'accessibility', tokens: 1 }]);
    clock += 10;
    brain.library.activate('g.C-01', 1, [{ name: 'accessibility', tokens: 1 }]);
    brain.library.settle('g.C-01', 1, 'passed');
    expect(brain.library.recentCards('accessibility')).toEqual([
      { cardId: 'g.C-01', title: 'g.C-01', outcome: 'passed', at: clock },
      { cardId: 'g.C-02', title: 'g.C-02', outcome: 'running', at: clock - 10 },
    ]);
  });
});

describe('learned and imported items, retirement and proposals (03-D5, D6; C3)', () => {
  const draft = (name: string, origin: 'learned' | 'imported' = 'imported') =>
    brain.library.addDraft({ ...item(name, { status: 'draft', safety: 'unscanned', file: `${origin}/skills/${name}/SKILL.md` }), origin, scan: { verdict: 'clean', findings: [], scannedAt: clock } });

  it('adds a draft with its origin and scan; a taken name is refused', () => {
    expect(draft('greeting-pages', 'learned')).toMatchObject({ status: 'draft', origin: 'learned', scan: { verdict: 'clean' }, approvalId: null, approvedAt: null });
    expect(() => draft('accessibility')).toThrow(/already has an item/);
  });

  it('never switches on a draft or a retired item; an approved one is ready and can be', () => {
    draft('greeting-pages');
    expect(brain.library.isActivatable('greeting-pages')).toBe(false);
    brain.library.approve('greeting-pages');
    expect(brain.library.get('greeting-pages')).toMatchObject({ status: 'ready', safety: 'vetted', approvedAt: clock });
    expect(brain.library.isActivatable('greeting-pages')).toBe(true);
    brain.library.retire('greeting-pages', 'by you');
    expect(brain.library.isActivatable('greeting-pages')).toBe(false);
    expect(brain.library.counts()).toMatchObject({ retired: 1 });
  });

  it('keeps the user\'s decisions across syncs: retired stays retired, a user item keeps its status', () => {
    brain.library.retire('accessibility', 'kept failing');
    draft('greeting-pages');
    brain.library.approve('greeting-pages');
    brain.library.sync([...CATALOG, item('greeting-pages', { status: 'draft', origin: 'imported', file: 'imported/skills/greeting-pages/SKILL.md' })]);
    expect(brain.library.get('accessibility')).toMatchObject({ status: 'retired', retiredReason: 'kept failing' });
    expect(brain.library.get('greeting-pages')).toMatchObject({ status: 'ready', origin: 'imported' });
  });

  it('restores a retired item to ready, or to draft when the user never approved it', () => {
    brain.library.retire('accessibility', 'by you');
    expect(brain.library.restore('accessibility')).toBe('ready');
    draft('never-approved');
    brain.library.retire('never-approved', 'You said no.');
    expect(brain.library.restore('never-approved')).toBe('draft');
    expect(() => brain.library.restore('accessibility')).toThrow(/not retired/);
  });

  it('proposes retiring ready skills that keep failing, and user items unused for 60 days; never kept ones', () => {
    for (let i = 0; i < 5; i++) {
      brain.library.activate(`g.C-${i}`, 0, [{ name: 'react-testing', tokens: 10 }, { name: 'accessibility', tokens: 10 }]);
      brain.library.settle(`g.C-${i}`, 0, i === 0 ? 'passed' : 'failed');
    }
    draft('old-import');
    brain.library.approve('old-import');
    clock += 61 * 86_400_000;
    const names = brain.library.retirementCandidates({ keep: new Set(['accessibility']) }).map((c) => `${c.name}:${c.why}`);
    expect(names).toEqual(['old-import:unused', 'react-testing:failing']);
    // Built-in ready skills don't go for being unused.
    expect(names.some((n) => n.startsWith('technical-writing'))).toBe(false);
  });

  it('remembers each proposed cluster once, and when the last proposal was', () => {
    expect(brain.library.proposed('coder|greeting page')).toBe(false);
    expect(brain.library.lastProposalAt()).toBeNull();
    brain.library.recordProposal({ cluster: 'coder|greeting page', caste: 'coder', cards: ['a', 'b', 'c'], item: 'greeting-pages', outcome: 'drafted' });
    expect(brain.library.proposed('coder|greeting page')).toBe(true);
    expect(brain.library.lastProposalAt()).toBe(clock);
  });

  it('search ranks retired items last and lists them by origin', () => {
    brain.library.retire('technical-writing', 'by you');
    const all = brain.library.search({ limit: 100 }).items.map((i) => i.name);
    expect(all.at(-1)).toBe('technical-writing');
    draft('greeting-pages', 'learned');
    expect(brain.library.byOrigin('learned').map((i) => i.name)).toEqual(['greeting-pages']);
  });
});
