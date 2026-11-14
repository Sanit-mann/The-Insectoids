import type { BrainClient } from '@insectoids/brain-service';
import { ABOUT_QUESTIONS, type AboutQuestionId, type ChecklistItem } from '@insectoids/shared';

/** Short labels for "About you" facts on the Global shelf (Onboarding 08-D4). */
export const ABOUT_LABELS: Record<AboutQuestionId, string> = {
  role: 'Role and work',
  goals: 'Current goals',
  updates: 'How you like updates',
  voice: 'Writing voice',
  tools: 'Tools you use',
};
export const aboutTitle = (id: AboutQuestionId): string => `About you: ${ABOUT_LABELS[id]}`;
export const ABOUT_SOURCE = 'onboarding';

/** The "finish setup" checklist (08-D2). Later-phase items are shown, never faked as done. */
export function buildChecklist(i: {
  completed: boolean;
  /** At least one engine can work (08-D5). */
  engineReady: boolean;
  aboutAnswered: number;
  hasProject: boolean;
  /** Switched-on API providers (C5). */
  providers?: number;
  /** The sample goal was started (C5, 08-D8). */
  sampleStarted?: boolean;
}): ChecklistItem[] {
  return [
    { id: 'brain', label: 'Choose where the Brain lives', done: i.completed, phase: 1 },
    { id: 'engine', label: 'Connect at least one AI engine', done: i.engineReady, phase: 1 },
    { id: 'about', label: 'Tell the hive about you', done: i.aboutAnswered > 0, phase: 1 },
    { id: 'preset', label: 'Pick a safety preset', done: true, phase: 1 },
    { id: 'project', label: 'Choose your first project', done: i.hasProject, phase: 1 },
    { id: 'backup', label: 'Choose a backup folder for the Brain', done: false, phase: 2 },
    { id: 'providers', label: 'Add other AI providers or local models (optional)', done: (i.providers ?? 0) > 0, phase: 2 },
    { id: 'sample-goal', label: 'Try a sample goal on a practice project (optional)', done: i.sampleStarted ?? false, phase: 2 },
  ];
}

/**
 * Engines that can work right now (08-D5), by id. The scripted test engine counts only under e2e, where it is
 * the one that runs everything.
 */
export function readyEngineIds(engines: ReadonlyArray<{ id: string; state: string }>, countScripted: boolean): string[] {
  return engines.filter((e) => e.state === 'ready' || (countScripted && e.state === 'fake')).map((e) => e.id);
}

/** Existing "About you" records on the Global shelf, by question id. */
export async function findAboutRecords(client: BrainClient): Promise<Map<AboutQuestionId, string>> {
  const found = new Map<AboutQuestionId, string>();
  const hits = await client.search({ query: 'About you', shelf: 'global', kinds: ['fact'], limit: 50 });
  for (const q of ABOUT_QUESTIONS) {
    const hit = hits.find((h) => h.shelf === 'global' && h.title === aboutTitle(q.id));
    if (!hit) continue;
    const rec = await client.get(hit.id);
    if (rec && !rec.archived && rec.source === ABOUT_SOURCE) found.set(q.id, rec.id);
  }
  return found;
}
