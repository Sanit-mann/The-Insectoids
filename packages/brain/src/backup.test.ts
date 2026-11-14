import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_FILE_PATTERN, backupFileName } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Brain, backupFiles, openBrain, pruneBackups, writeBackup } from './index';

/** Maintenance in the Brain (Cadence 05-D7; Phase 3 A5): backups, folding agent-only duplicates, closing stale cards. */
const user = { type: 'user' } as const;
const ant = { type: 'agent', id: 'Ant-1' } as const;
const T0 = Date.UTC(2026, 10, 14, 3, 0, 0);

let dir: string;
let brain: Brain;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-backup-'));
  clock = T0;
  let n = 0;
  brain = openBrain(':memory:', { now: () => clock, newId: () => `r${++n}` });
});

afterEach(() => {
  brain.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('backups (01-D8; A5)', () => {
  it('a backup opens as a fresh Brain with the same records', () => {
    const a = brain.write({ kind: 'decision', shelf: 'site', title: 'Card payments only', body: 'No bank transfers at launch.' }, user).id;
    const b = brain.write({ kind: 'update', shelf: 'site', title: 'Checkout progress', body: 'The layout is done.' }, ant).id;
    brain.cadences.create({ id: 'maint-backup', shelf: 'global', name: 'Daily backup', when: { type: 'interval', everyMinutes: 60 }, goal: 'Copies the Brain.', budgetTokens: 1_000, autonomy: 'ask', enabled: true, nextRunAt: null });
    const w = writeBackup(brain, join(dir, 'backups'), T0);
    expect(w.file).toBe(join(dir, 'backups', 'brain-backup-2026-11-14T03-00-00Z.db'));
    expect(w.sizeBytes).toBeGreaterThan(0);
    expect(w).toMatchObject({ kept: 1, removed: [] });
    const copy = openBrain(w.file);
    try {
      expect(copy.get(a)).toMatchObject({ title: 'Card payments only', trust: 'confirmed' });
      expect(copy.get(b)).toMatchObject({ title: 'Checkout progress' });
      expect(copy.search('bank transfers', { shelf: 'site' }).map((h) => h.id)).toEqual([a]);
      expect(copy.cadences.get('maint-backup')).toMatchObject({ name: 'Daily backup' });
    } finally {
      copy.close();
    }
  });

  it('keeps the newest 7, and never touches files that are not backups', () => {
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, 'brain-backup-old.db'), 'not a stamped name');
    writeFileSync(join(dir, 'brain.db'), 'not a backup');
    for (let i = 0; i < 9; i++) writeBackup(brain, dir, T0 + i * 86_400_000);
    const backups = backupFiles(dir);
    expect(backups).toHaveLength(7);
    expect(backups[0]).toBe(backupFileName(T0 + 2 * 86_400_000));
    expect(backups.at(-1)).toBe(backupFileName(T0 + 8 * 86_400_000));
    expect(readdirSync(dir).filter((n) => !BACKUP_FILE_PATTERN.test(n)).sort()).toEqual(['brain-backup-old.db', 'brain.db', 'notes.txt']);
    expect(pruneBackups(dir, 7)).toEqual([]);
  });

  it('refuses to overwrite a backup from the same second', () => {
    writeBackup(brain, dir, T0);
    expect(() => writeBackup(brain, dir, T0)).toThrow(/already there/);
    expect(backupFiles(dir)).toHaveLength(1);
  });

  it('makes a missing folder', () => {
    const nested = join(dir, 'a', 'b');
    writeBackup(brain, nested, T0);
    expect(existsSync(join(nested, backupFileName(T0)))).toBe(true);
  });
});

describe('folding agent-only near-duplicates (01-E5; A5 consolidate)', () => {
  /** Two agent notes that only became near-duplicates through edits (writes would have folded them at once). */
  const pair = (owner: typeof user | typeof ant = ant) => {
    const x = brain.write({ kind: 'update', shelf: 'site', title: 'Checkout notes', body: 'The checkout page uses Stripe Elements for card entry.' }, ant).id;
    clock += 1_000;
    const y = brain.write({ kind: 'update', shelf: 'site', title: 'Deploy notes', body: 'Deploys go out on Fridays.' }, owner).id;
    clock += 1_000;
    brain.update(y, { title: 'Checkout notes', body: 'the checkout page uses stripe elements, for card entry' }, ant);
    return { x, y };
  };

  it('archives the less used one, pointing at the kept one; the user can bring it back', () => {
    const { x, y } = pair();
    brain.noteRead([y]);
    const folded = brain.foldDuplicates('site');
    expect(folded).toEqual([{ id: x, title: 'Checkout notes', into: y }]);
    expect(brain.get(x)).toMatchObject({ archived: true, archivedReason: `merged into ${y}` });
    expect(brain.links(x)).toContainEqual({ id: y, rel: 'merged_into', direction: 'out' });
    expect(brain.get(y)!.archived).toBe(false);
    expect(brain.foldDuplicates('site')).toEqual([]);
    brain.unarchive(x, user);
    expect(brain.get(x)!.archived).toBe(false);
  });

  it('never folds records the user wrote, edited or confirmed', () => {
    pair(user);
    expect(brain.foldDuplicates('site')).toEqual([]);
    const { y } = pair();
    brain.update(y, { body: 'the checkout page uses stripe elements, for card entry!' }, user);
    expect(brain.foldDuplicates('site')).toEqual([]);
  });
});

describe('stale task cleanup (A5)', () => {
  const card = (id: string, goalId: string) => ({ id, goalId, wave: 1, title: `Card ${id}`, brief: 'b', caste: 'coder' as const, priority: 'normal' as const, acceptance: ['ok'], dependsOn: [] });

  it('closes an open card as failed with a note, never deleting it; done and failed cards stay', () => {
    const board = brain.taskboard;
    board.post(card('G-1.C-01', 'G-1'));
    board.post(card('G-1.C-02', 'G-1'));
    board.claim('G-1.C-02', { agentId: 'Ant-1', caste: 'coder', leaseMs: 60_000 });
    expect(board.close('G-1.C-01', 'stale-tasks', 'Closed by stale task cleanup: its goal ended.')).toBe(true);
    expect(board.close('G-1.C-02', 'stale-tasks', 'Closed.')).toBe(true);
    expect(board.get('G-1.C-01')).toMatchObject({ status: 'failed', escalated: false });
    expect(board.get('G-1.C-02')!.status).toBe('failed');
    expect(board.get('G-1.C-02')!.claimedBy).toBeUndefined();
    expect(board.events('G-1.C-01').at(-1)).toMatchObject({ from: 'open', to: 'failed', actor: 'stale-tasks', note: 'Closed by stale task cleanup: its goal ended.' });
    expect(board.close('G-1.C-01', 'stale-tasks', 'again')).toBe(false);
    expect(board.escalated()).toEqual([]);
  });
});
