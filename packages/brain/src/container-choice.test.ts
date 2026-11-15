import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBrain } from './brain';

/** Phase 4 D2 storage: the goal's container choice and the Watchdog's move kept on a card (schema v16). */
describe('container choices in the Brain', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'insectoids-box-brain-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const card = { id: 'G-1.C-01', goalId: 'G-1', wave: 1, title: 'Install the linter', brief: 'Add eslint.', caste: 'coder' as const, priority: 'normal' as const, acceptance: ['lint runs'], dependsOn: [] };

  it('a goal follows the setting by default; the user can force containers at creation or later', () => {
    const brain = openBrain(':memory:');
    try {
      const plain = brain.goals.create({ title: 'a', text: 'a', shelf: 's' });
      expect(plain.containers).toBe('auto');
      const forced = brain.goals.create({ title: 'b', text: 'b', shelf: 's', containers: 'always' });
      expect(brain.goals.get(forced.id)!.containers).toBe('always');
      expect(brain.goals.setContainers(plain.id, 'always').containers).toBe('always');
      expect(brain.goals.setContainers(plain.id, 'auto').containers).toBe('auto');
      expect(() => brain.goals.setContainers('G-none', 'always')).toThrow(/No goal G-none/);
    } finally {
      brain.close();
    }
  });

  it("the Watchdog's move and the goal's choice survive closing and reopening the Brain", () => {
    const file = join(dir, 'brain.db');
    let brain = openBrain(file);
    const goal = brain.goals.create({ id: 'G-1', title: 'g', text: 'g', shelf: 's', containers: 'always' });
    brain.taskboard.post(card);
    expect(brain.taskboard.get(card.id)!.containerMove).toBeNull();
    const moved = brain.taskboard.moveToContainer(card.id, 'Watchdog', 'The Watchdog moved it after it got stuck: it looped.');
    expect(moved).toMatchObject({ status: 'open', attempts: 0, containerMove: 'The Watchdog moved it after it got stuck: it looped.' });
    brain.taskboard.note(card.id, 'Watchdog', 'A plain note.');
    brain.close();

    brain = openBrain(file);
    try {
      expect(brain.goals.get(goal.id)!.containers).toBe('always');
      expect(brain.taskboard.get(card.id)!.containerMove).toBe('The Watchdog moved it after it got stuck: it looped.');
      const notes = brain.taskboard.events(card.id).slice(1).map((e) => `${e.from}->${e.to} by ${e.actor}: ${e.note}`);
      expect(notes).toEqual(['open->open by Watchdog: container: The Watchdog moved it after it got stuck: it looped.', 'open->open by Watchdog: A plain note.']);
    } finally {
      brain.close();
    }
  });

  it('migration v16: a v15 Brain gets the columns, its goals follow the setting and no card is moved', () => {
    const file = join(dir, 'old.db');
    const old = openBrain(file);
    old.goals.create({ id: 'G-1', title: 'g', text: 'g', shelf: 's' });
    old.taskboard.post(card);
    old.close();
    const raw = new DatabaseSync(file);
    try {
      raw.exec('ALTER TABLE goals DROP COLUMN containers; ALTER TABLE tasks DROP COLUMN container_move; PRAGMA user_version = 15;');
    } finally {
      raw.close();
    }
    const brain = openBrain(file);
    try {
      expect(brain.goals.get('G-1')!.containers).toBe('auto');
      expect(brain.taskboard.get(card.id)!.containerMove).toBeNull();
    } finally {
      brain.close();
    }
    const db = new DatabaseSync(file);
    try {
      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(16);
    } finally {
      db.close();
    }
  });
});
