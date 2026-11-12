import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { openBrain } from './brain';
import { CLAIM_SQL } from './taskboard';

/**
 * Real concurrency: several threads, each with its own database connection,
 * try to claim the same card at the same moment using the taskboard's own claim statement.
 */
const dir = mkdtempSync(join(tmpdir(), 'insectoids-race-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout = 5000');
const view = new Int32Array(workerData.gate);
Atomics.wait(view, 0, 0); // start together
const res = db.prepare(workerData.sql).run(workerData.agent, workerData.lease, workerData.now, 'C-01', 'coder');
parentPort.postMessage(Number(res.changes));
db.close();
`;

describe('claim race', () => {
  it('exactly one of 8 simultaneous insects gets the card', async () => {
    const path = join(dir, 'brain.db');
    const brain = openBrain(path);
    brain.taskboard.post({
      id: 'C-01', goalId: 'G', wave: 1, title: 't', brief: 'b', caste: 'coder', priority: 'normal', acceptance: ['ok'], dependsOn: [],
    });
    brain.close();

    const gate = new SharedArrayBuffer(4);
    const results = Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        new Promise<number>((resolve, reject) => {
          const w = new Worker(WORKER, {
            eval: true,
            workerData: { path, sql: CLAIM_SQL, agent: `Ant-${i}`, lease: Date.now() + 60_000, now: Date.now(), gate },
          });
          let changes = -1;
          w.once('message', (n: number) => (changes = n));
          w.once('error', reject);
          // Resolve only after the thread has closed its connection and exited.
          w.once('exit', () => (changes < 0 ? reject(new Error('worker exited without a result')) : resolve(changes)));
        }),
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);

    const changes = await results;
    expect(changes.reduce((a, b) => a + b, 0)).toBe(1);

    const check = openBrain(path);
    expect(check.taskboard.get('C-01')?.status).toBe('claimed');
    check.close();
  });
});
