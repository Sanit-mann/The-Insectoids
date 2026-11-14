import { type Brain, openBrain } from '@insectoids/brain';
import { BrainClient, type BrainService, startBrainService } from '@insectoids/brain-service';
import { ABOUT_QUESTIONS } from '@insectoids/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ABOUT_LABELS, ABOUT_SOURCE, aboutTitle, buildChecklist, findAboutRecords, readyEngineIds } from './setup-model';

describe('finish-setup checklist (Onboarding 08-D2)', () => {
  it('marks items from real state and never fakes the ones not built yet', () => {
    const fresh = buildChecklist({ completed: false, engineReady: false, aboutAnswered: 0, hasProject: false });
    expect(fresh.filter((i) => i.done).map((i) => i.id)).toEqual(['preset']);
    const done = buildChecklist({ completed: true, engineReady: true, aboutAnswered: 2, hasProject: true });
    expect(done.filter((i) => !i.done).map((i) => i.id)).toEqual(['backup', 'providers', 'sample-goal']);
    // C5: providers and the sample goal are real items now; the backup folder is still not built.
    const all = buildChecklist({ completed: true, engineReady: true, aboutAnswered: 2, hasProject: true, providers: 1, sampleStarted: true });
    expect(all.filter((i) => !i.done).map((i) => i.id)).toEqual(['backup']);
  });

  it('counts engines that can work, and the scripted test engine only when asked (e2e)', () => {
    const engines = [
      { id: 'fake', state: 'fake' },
      { id: 'claude', state: 'ready' },
      { id: 'gemini', state: 'signed-out' },
      { id: 'codex', state: 'unsupported' },
    ];
    expect(readyEngineIds(engines, false)).toEqual(['claude']);
    expect(readyEngineIds(engines, true)).toEqual(['fake', 'claude']);
    expect(readyEngineIds([{ id: 'claude', state: 'missing' }], true)).toEqual([]);
  });

  it('has a label for every question', () => {
    for (const q of ABOUT_QUESTIONS) expect(ABOUT_LABELS[q.id]).toBeTruthy();
    expect(aboutTitle('role')).toBe('About you: Role and work');
  });
});

describe('"About you" records in the Brain', () => {
  let brain: Brain;
  let service: BrainService;
  let client: BrainClient;
  beforeEach(async () => {
    brain = openBrain(':memory:');
    service = await startBrainService({ brain });
    client = await BrainClient.connect({ endpoint: service.endpoint, token: service.masterToken });
  });
  afterEach(async () => {
    client.close();
    await service.close();
    brain.close();
  });

  it('finds only onboarding facts on the Global shelf with the exact title', async () => {
    const role = await client.write({ kind: 'fact', shelf: 'global', title: aboutTitle('role'), body: 'Designer', source: ABOUT_SOURCE });
    // Same title but not from onboarding, and a project-shelf copy: both ignored.
    await client.write({ kind: 'fact', shelf: 'global', title: aboutTitle('goals'), body: 'Ship v1', source: 'someone else' });
    await client.write({ kind: 'fact', shelf: 'site', title: aboutTitle('tools'), body: 'Figma', source: ABOUT_SOURCE });
    const found = await findAboutRecords(client);
    expect([...found.entries()]).toEqual([['role', role.id]]);
    expect(brain.get(role.id)?.trust).toBe('confirmed');
  });
});
