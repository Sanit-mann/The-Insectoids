import { type Brain, cardReadKey, openBrain } from '@insectoids/brain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainClient, BrainServiceError, type BrainService, startBrainService } from './index';

let brain: Brain;
let service: BrainService;
const clients: BrainClient[] = [];
const user = { type: 'user' } as const;

const open = async (token: string) => {
  const c = await BrainClient.connect({ endpoint: service.endpoint, token });
  clients.push(c);
  return c;
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof BrainServiceError ? e.code : String(e)),
  );

beforeEach(async () => {
  brain = openBrain(':memory:');
  service = await startBrainService({ brain });
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await service.close();
  brain.close();
});

describe('B2 through the service: reads, supersede, history, unarchive', () => {
  it('an agent with a read key: get and read count, and a pass credits them', async () => {
    const { id } = brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: 'Dev server on port 5173.' }, user);
    const key = cardReadKey('G.C-01', 0);
    const ant = await open(service.issueAgentToken({ agentId: 'Ant-1', shelf: 'site', write: true, readKey: key }));
    await ant.get(id);
    await ant.read({ query: 'dev server port' });
    expect(brain.get(id)!.reads).toBe(2);
    expect(brain.creditHelped(key)).toBe(1);
    expect(brain.get(id)!.helped).toBe(1);
  });

  it("the user's lookups in the app don't count as hive use", async () => {
    const { id } = brain.write({ kind: 'fact', shelf: 'site', title: 'Port', body: 'Dev server on port 5173.' }, user);
    const app = await open(service.masterToken);
    await app.get(id);
    expect(brain.get(id)!.reads).toBe(0);
  });

  it('an agent supersedes its own record; history only on request', async () => {
    const ant = await open(service.issueAgentToken({ agentId: 'Ant-1', shelf: 'site', write: true }));
    const old = await ant.write({ kind: 'fact', title: 'Hosting', body: 'Netlify.' });
    const next = await ant.write({ kind: 'fact', title: 'Hosting', body: 'Moved to Vercel.', supersedes: old.id });
    expect(next.created).toBe(true);
    expect((await ant.search({ query: 'hosting' })).map((h) => h.id)).toEqual([next.id]);
    expect((await ant.search({ query: 'hosting', includeHistory: true })).map((h) => h.status).sort()).toEqual(['current', 'superseded']);
  });

  it("an agent can't supersede what the user confirmed (proposal), or another shelf's record (forbidden)", async () => {
    const mine = brain.write({ kind: 'decision', shelf: 'site', title: 'Keep the brand', body: 'No rebrand.' }, user).id;
    const global = brain.write({ kind: 'fact', shelf: 'global', title: 'Style', body: 'Plain words.' }, user).id;
    const ant = await open(service.issueAgentToken({ agentId: 'Ant-1', shelf: 'site', write: true }));
    const r = await ant.write({ kind: 'decision', title: 'Rebrand', body: 'Blue.', supersedes: mine });
    expect(r.note).toMatch(/confirmed by the user/);
    expect(brain.get(mine)!.validTo).toBeNull();
    expect(await code(ant.write({ kind: 'fact', title: 'Style', body: 'Fancy words.', supersedes: global }))).toBe('forbidden');
  });

  it('near-duplicates come back as "already known"', async () => {
    const ant = await open(service.issueAgentToken({ agentId: 'Ant-1', shelf: 'site', write: true }));
    const a = await ant.write({ kind: 'update', title: 'Checkout', body: 'The checkout page uses Stripe Elements for card entry.' });
    const b = await ant.write({ kind: 'update', title: 'Checkout', body: 'the checkout page uses stripe elements, for card entry' });
    expect(b).toMatchObject({ id: a.id, created: false, merged: true });
    expect(b.note).toMatch(/Already known as/);
  });

  it('only the user can unarchive', async () => {
    const { id } = brain.write({ kind: 'update', shelf: 'site', title: 'Old', body: 'Scratch.' }, { type: 'agent', id: 'Ant-1' });
    brain.archive(id, user);
    const ant = await open(service.issueAgentToken({ agentId: 'Ant-1', shelf: 'site', write: true }));
    expect(await code(ant.unarchive(id))).toBe('forbidden');
    const app = await open(service.masterToken);
    await app.unarchive(id);
    expect(brain.get(id)!.archived).toBe(false);
  });
});
