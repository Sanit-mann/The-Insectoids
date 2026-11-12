import { describe, expect, it } from 'vitest';
import { headlineFrom, parsePlan, parseStatus, parseVerdict } from './protocol';

const plan = (obj: unknown) => `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
const card = (over: Record<string, unknown> = {}) => ({
  title: 'Build the form',
  brief: 'Add a contact form component.',
  caste: 'coder',
  acceptance: ['Form renders', 'Tests pass'],
  ...over,
});

describe('the Queen\'s plan', () => {
  it('reads a valid plan, numbers the cards and defaults priority', () => {
    const r = parsePlan(plan({ summary: 'Two waves', waves: [{ cards: [card(), card({ title: 'Form tests', caste: 'tester', dependsOn: ['C-01'] })] }, { cards: [card({ title: 'Polish' })] }] }), { castes: ['coder', 'tester'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.waves.map((w) => w.cards.map((c) => c.id))).toEqual([['C-01', 'C-02'], ['C-03']]);
    expect(r.plan.waves[0]!.cards[1]).toMatchObject({ caste: 'tester', priority: 'normal', dependsOn: ['C-01'] });
  });

  it("keeps the Queen's one-line headline", () => {
    const r = parsePlan(plan({ headline: 'Add slugify with tests', summary: 'Long story. More detail.', waves: [{ cards: [card()] }] }), { castes: ['coder'] });
    expect(r.ok && r.plan.headline).toBe('Add slugify with tests');
  });

  it('derives a headline from the summary when the Queen gives none', () => {
    const r = parsePlan(plan({ summary: 'Small goal, one wave. Then lots of detail about the files.', waves: [{ cards: [card()] }] }), { castes: ['coder'] });
    expect(r.ok && r.plan.headline).toBe('Small goal, one wave.');
    expect(headlineFrom('x'.repeat(300))).toHaveLength(100);
  });

  it('refuses a caste the hive does not have yet', () => {
    const r = parsePlan(plan({ summary: 's', waves: [{ cards: [card({ caste: 'designer' })] }] }), { castes: ['coder', 'tester'] });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/designer/);
  });

  it('refuses cards without "done means"', () => {
    expect(parsePlan(plan({ summary: 's', waves: [{ cards: [card({ acceptance: [] })] }] }), { castes: ['coder'] }).ok).toBe(false);
  });

  it('refuses dependencies on cards that do not exist or come later', () => {
    const missing = parsePlan(plan({ summary: 's', waves: [{ cards: [card({ dependsOn: ['C-09'] })] }] }), { castes: ['coder'] });
    expect(!missing.ok && missing.error).toMatch(/C-09/);
    const later = parsePlan(plan({ summary: 's', waves: [{ cards: [card({ dependsOn: ['C-02'] })] }, { cards: [card()] }] }), { castes: ['coder'] });
    expect(later.ok).toBe(false);
  });

  it('refuses a dependency cycle', () => {
    const r = parsePlan(plan({ summary: 's', waves: [{ cards: [card({ id: 'C-01', dependsOn: ['C-02'] }), card({ id: 'C-02', dependsOn: ['C-01'] })] }] }), { castes: ['coder'] });
    expect(!r.ok && r.error).toMatch(/cycle/i);
  });

  it('refuses text with no plan in it', () => {
    expect(parsePlan('I could not plan this.', { castes: ['coder'] }).ok).toBe(false);
  });

  it('caps the size of a wave so each wave stays reviewable', () => {
    const many = Array.from({ length: 9 }, () => card());
    expect(parsePlan(plan({ summary: 's', waves: [{ cards: many }] }), { castes: ['coder'] }).ok).toBe(false);
  });
});

describe('insect status line', () => {
  it.each([
    ['All done.\nSTATUS: DONE', { status: 'done', detail: '' }],
    ['STATUS: BLOCKED: needs approval to add sharp', { status: 'blocked', detail: 'needs approval to add sharp' }],
    ['status: needs_context - which form library?', { status: 'needs_context', detail: 'which form library?' }],
    ['No status line at all', { status: 'done', detail: '' }],
  ])('%s', (text, expected) => {
    expect(parseStatus(text)).toEqual(expected);
  });

  it('uses the last status line if there are several', () => {
    expect(parseStatus('STATUS: BLOCKED: x\n...\nSTATUS: DONE').status).toBe('done');
  });
});

describe('Inspector verdict', () => {
  it.each([
    ['Checked.\nVERDICT: PASS', { verdict: 'pass', note: '' }],
    ['VERDICT: FAIL: the email field is not validated', { verdict: 'fail', note: 'the email field is not validated' }],
    ['I think it is fine', { verdict: 'fail', note: 'The Inspector gave no verdict.' }],
  ])('%s', (text, expected) => {
    expect(parseVerdict(text)).toEqual(expected);
  });
});
