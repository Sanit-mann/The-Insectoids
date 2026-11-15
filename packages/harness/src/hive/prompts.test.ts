import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Library, estimateTokens, insectPrompt, inspectorPrompt, queenPrompt } from './prompts';

const lib = new Library(fileURLToPath(new URL('../../../../library', import.meta.url)));
const card = { id: 'C-01', title: 'Contact form', brief: 'Add src/contact.ts', acceptance: ['Validates email', 'Tests pass'], attempts: 0 };

describe('prompts from the library', () => {
  it('strips frontmatter and includes the role and its skills', () => {
    const p = insectPrompt(lib, 'coder', card, '');
    expect(p.system).not.toMatch(/^---/);
    expect(p.system).toContain('# Coder');
    expect(p.system).toContain('## Skill: coding-discipline');
    expect(p.system).toContain('STATUS: DONE');
    expect(p.task).toContain('- Validates email');
  });

  it('tells a retry what went wrong last time', () => {
    const p = insectPrompt(lib, 'coder', { ...card, attempts: 1, lastFailure: 'email not validated' }, '');
    expect(p.task).toContain('attempt 2');
    expect(p.task).toContain('email not validated');
  });

  it('the Queen gets the output contract and only the castes this hive has', () => {
    const p = queenPrompt(lib, { goal: 'Add a contact form', bootCard: 'Shelf: site', context: '', castes: ['coder', 'tester'], projectListing: 'src/' });
    expect(p.system).toContain('one of: coder, tester');
    expect(p.task).toContain('# Goal');
    // Phase 1 demo: the Queen marked a small task "high" and wrote "auto-approved" into her summary.
    expect(p.system).toContain('"headline"');
    expect(p.system).toMatch(/use "normal" by default/);
    expect(p.system).toMatch(/Don't say whether the plan needs the user's approval/);
  });

  it('the Queen is told when to mark a card for a container, and to keep it rare (Phase 4 D2)', () => {
    const p = queenPrompt(lib, { goal: 'Install the linter', bootCard: '', context: '', castes: ['coder'], projectListing: '' });
    expect(p.system).toContain('"container": "<short reason>"');
    expect(p.system).toMatch(/untrusted or downloaded code, install\s+packages or tools, or run unfamiliar build scripts/);
    expect(p.system).toMatch(/Keep it rare/);
  });

  it('the Inspector must give a verdict and not change files', () => {
    const p = inspectorPrompt(lib, card, { result: 'Done', changedFiles: ['src/contact.ts'] });
    expect(p.system).toContain('VERDICT: PASS');
    expect(p.system).toMatch(/do not change files/i);
    expect(p.task).toContain('src/contact.ts');
  });

  it('keeps each role\'s instructions lean (lowest token waste)', () => {
    const sizes = {
      queen: estimateTokens(queenPrompt(lib, { goal: 'g', bootCard: '', context: '', castes: ['coder', 'tester'], projectListing: '' }).system),
      coder: estimateTokens(insectPrompt(lib, 'coder', card, '').system),
      tester: estimateTokens(insectPrompt(lib, 'tester', card, '').system),
      inspector: estimateTokens(inspectorPrompt(lib, card, { result: '', changedFiles: [] }).system),
    };
    for (const [role, tokens] of Object.entries(sizes)) expect(tokens, role).toBeLessThan(8_000);
  });
});
