import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppSettingsStore, checkBrainFolder, limitsFor, parseAppSettings } from './app-settings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'insectoids-app settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('app.json', () => {
  it('starts with defaults: Balanced, default Brain folder, setup not done', () => {
    const s = new AppSettingsStore(dir);
    expect(s.value).toEqual({ preset: 'balanced', onboarding: {} });
    expect(s.brainDir).toBe(join(dir, 'brain'));
  });

  it('saves atomically and reads back', () => {
    const s = new AppSettingsStore(dir);
    s.update((v) => ({ ...v, preset: 'careful', brainDir: join(dir, 'my brain'), onboarding: { completedAt: 5 } }));
    const again = new AppSettingsStore(dir);
    expect(again.value).toEqual({ preset: 'careful', brainDir: join(dir, 'my brain'), onboarding: { completedAt: 5 } });
    expect(again.brainDir).toBe(join(dir, 'my brain'));
    expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8')).preset).toBe('careful');
  });

  it('bad JSON gives defaults; bad fields are dropped, good ones kept', () => {
    writeFileSync(join(dir, 'app.json'), '{ not json');
    expect(new AppSettingsStore(dir).value).toEqual({ preset: 'balanced', onboarding: {} });
    expect(parseAppSettings({ preset: 'reckless', brainDir: 7, onboarding: { completedAt: 9 } })).toEqual({ preset: 'balanced', onboarding: { completedAt: 9 } });
    expect(parseAppSettings(null)).toEqual({ preset: 'balanced', onboarding: {} });
  });

  it('keeps the backups folder only as a full path (A5), and defaults to <userData>/backups', () => {
    const s = new AppSettingsStore(dir);
    expect(s.backupDir).toBe(join(dir, 'backups'));
    expect(s.defaultBackupDir).toBe(join(dir, 'backups'));
    s.update((v) => ({ ...v, backupDir: join(dir, 'elsewhere') }));
    expect(new AppSettingsStore(dir).backupDir).toBe(join(dir, 'elsewhere'));
    expect(parseAppSettings({ backupDir: 'relative/backups' })).not.toHaveProperty('backupDir');
    expect(parseAppSettings({ backupDir: '' })).not.toHaveProperty('backupDir');
    expect(parseAppSettings({ backupDir: 7 })).not.toHaveProperty('backupDir');
  });

  it('keeps the keep-awake switch only when it is really on (A2)', () => {
    expect(parseAppSettings({ keepAwake: true })).toMatchObject({ keepAwake: true });
    expect(parseAppSettings({ keepAwake: 'yes' })).not.toHaveProperty('keepAwake');
    expect(parseAppSettings({ keepAwake: false })).not.toHaveProperty('keepAwake');
  });

  it('keeps webhook secret handles and the webhook port (A4), and drops broken ones', () => {
    const webhookSecrets = { 'CAD-1': 'sec_0123456789ab', 'bad id!': 'sec_0123456789ab', 'CAD-2': 'whsec_plain', 'CAD-3': 7 };
    expect(parseAppSettings({ webhookSecrets, webhookPort: 48000 })).toMatchObject({ webhookSecrets: { 'CAD-1': 'sec_0123456789ab' }, webhookPort: 48000 });
    expect(parseAppSettings({ webhookSecrets: { x: 'nope' }, webhookPort: 70_000 })).not.toHaveProperty('webhookSecrets');
    expect(parseAppSettings({ webhookPort: 1.5 })).not.toHaveProperty('webhookPort');
  });

  it('keeps the sample goal and the previous project (C5), and drops broken ones', () => {
    const sample = { goalId: 'g1', practicePath: '/d/practice-project', startedAt: 5 };
    expect(parseAppSettings({ preset: 'careful', onboarding: {}, sample, previousProject: '/d/site' })).toEqual({
      preset: 'careful',
      onboarding: {},
      sample,
      previousProject: '/d/site',
    });
    expect(parseAppSettings({ sample: { goalId: 'g1', practicePath: '', startedAt: 5 }, previousProject: '' })).toEqual({ preset: 'balanced', onboarding: {} });
    expect(parseAppSettings({ sample: { goalId: 'g1', practicePath: '/p', startedAt: 'soon' } })).toEqual({ preset: 'balanced', onboarding: {} });
  });

  it('maps presets to hive limits', () => {
    expect(limitsFor('careful')).toEqual({ insectCap: 2, goalBudgetTokens: 1_000_000, approveEveryPlan: true });
    expect(limitsFor('balanced')).toEqual({ insectCap: 3, goalBudgetTokens: 2_000_000, approveEveryPlan: false });
    expect(limitsFor('hands-off')).toEqual({ insectCap: 5, goalBudgetTokens: 4_000_000, approveEveryPlan: false });
  });
});

describe('Brain folder check', () => {
  it('accepts a writable folder (creating it) and an existing Brain file', () => {
    expect(checkBrainFolder(join(dir, 'new brain'))).toBeNull();
    writeFileSync(join(dir, 'brain.db'), '');
    expect(checkBrainFolder(dir)).toBeNull();
  });

  it('refuses relative paths, files, and a brain.db that is a folder', () => {
    expect(checkBrainFolder('relative/brain')).toMatch(/full folder path/);
    const file = join(dir, 'a file');
    writeFileSync(file, 'x');
    expect(checkBrainFolder(file)).toMatch(/is a file/);
    const odd = join(dir, 'odd');
    rmSync(odd, { force: true, recursive: true });
    checkBrainFolder(odd);
    // A folder named brain.db inside it.
    mkdirSync(join(odd, 'brain.db'));
    expect(checkBrainFolder(odd)).toMatch(/not a Brain file/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a folder it cannot write to', () => {
    const ro = join(dir, 'read only');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    expect(checkBrainFolder(ro)).toMatch(/can't be saved/);
    chmodSync(ro, 0o700);
  });
});
