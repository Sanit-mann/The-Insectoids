import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative import: the spike only, so embeddings doesn't depend on the Brain package.
import { openBrain } from '../../brain/src/index';
import { describe, expect, it } from 'vitest';
import { MODELS, OnnxEmbedder, isModelPresent, modelDir, rrf, topK } from '../src';
import { buildCorpus } from './corpus';
import { MODELS_DIR } from './paths';
import { type EvalQuery, QUERIES } from './queries';

type Ranker = (q: string) => Promise<string[]>;

function score(ranked: string[], q: EvalQuery): { recall5: number; rr10: number } {
  const top5 = ranked.slice(0, 5);
  const recall5 = q.relevant.filter((r) => top5.includes(r)).length / q.relevant.length;
  const first = ranked.slice(0, 10).findIndex((id) => q.relevant.includes(id));
  return { recall5, rr10: first < 0 ? 0 : 1 / (first + 1) };
}

async function evaluate(rank: Ranker, kind?: EvalQuery['kind']): Promise<{ recall5: number; mrr10: number; n: number }> {
  const qs = QUERIES.filter((q) => !kind || q.kind === kind);
  let r = 0;
  let m = 0;
  for (const q of qs) {
    const s = score(await rank(q.q), q);
    r += s.recall5;
    m += s.rr10;
  }
  return { recall5: r / qs.length, mrr10: m / qs.length, n: qs.length };
}

describe.skipIf(process.env['SPIKE'] !== '1')('B1 spike: keyword vs meaning vs hybrid', () => {
  it('measures quality and speed on the repo’s own text', async () => {
    const corpus = buildCorpus();
    const ids = new Set(corpus.map((c) => c.id));
    for (const q of QUERIES) for (const r of q.relevant) expect(ids.has(r), `query "${q.q}" points at unknown ${r}`).toBe(true);

    // 1. Keyword (FTS5) through the real Brain.
    const brain = openBrain(':memory:');
    const recToPassage = new Map<string, string>();
    let skipped = 0;
    for (const c of corpus) {
      try {
        const { id } = brain.write({ kind: 'file', shelf: 'eval', title: c.title, body: c.text, source: c.id }, { type: 'user' });
        recToPassage.set(id, c.id);
      } catch {
        skipped++;
      }
    }
    const fts: Ranker = async (q) => brain.search(q, { shelf: 'eval', limit: 20 }).map((h) => recToPassage.get(h.id)!).filter(Boolean);
    // "Any word" keyword search for hybrid: today's Brain search needs every word to match (implicit AND),
    // so a natural sentence finds nothing. OR over the meaningful words lets bm25 rank partial matches.
    const STOP = new Set('a an and are as at be by can do does for from how i in into is it its me my of on or so that the then their they this to was what when where which while who why will with without you your'.split(' '));
    const ftsAny: Ranker = async (q) => {
      const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
      if (!words.length) return [];
      return brain.search(words.join(' OR '), { shelf: 'eval', limit: 20 }).map((h) => recToPassage.get(h.id)!).filter(Boolean);
    };

    const rows: string[] = [];
    const results: Record<string, unknown> = { passages: corpus.length, skippedBySecretGuard: skipped, queries: QUERIES.length };
    const line = (name: string, all: Awaited<ReturnType<typeof evaluate>>, para: Awaited<ReturnType<typeof evaluate>>, kw: Awaited<ReturnType<typeof evaluate>>) =>
      rows.push(`| ${name} | ${all.recall5.toFixed(3)} | ${all.mrr10.toFixed(3)} | ${para.recall5.toFixed(3)} | ${para.mrr10.toFixed(3)} | ${kw.recall5.toFixed(3)} | ${kw.mrr10.toFixed(3)} |`);
    line('FTS5 keyword (all words, today)', await evaluate(fts), await evaluate(fts, 'paraphrase'), await evaluate(fts, 'keyword'));
    line('FTS5 keyword (any word)', await evaluate(ftsAny), await evaluate(ftsAny, 'paraphrase'), await evaluate(ftsAny, 'keyword'));

    // Only models still on disk (the losing model is deleted after the first full run).
    const present = [];
    for (const mm of Object.values(MODELS)) if (await isModelPresent(MODELS_DIR, mm)) present.push(mm);
    for (const m of present) {
      global.gc?.();
      const rss0 = process.memoryUsage().rss;
      const t0 = performance.now();
      const e = await OnnxEmbedder.load(m, modelDir(MODELS_DIR, m));
      const loadMs = performance.now() - t0;
      const t1 = performance.now();
      const vecs = await e.embed(corpus.map((c) => `${c.title}\n${c.text}`), 'passage');
      const passageMs = (performance.now() - t1) / corpus.length;
      const rssMb = (process.memoryUsage().rss - rss0) / 1e6;
      const items = corpus.map((c, i) => ({ item: c.id, vector: vecs[i]! }));
      let qTime = 0;
      let qCount = 0;
      const vec: Ranker = async (q) => {
        const t = performance.now();
        const [qv] = await e.embed([q], 'query');
        qTime += performance.now() - t;
        qCount++;
        return topK(qv!, items, 20).map((s) => s.item);
      };
      const hybrid: Ranker = async (q) => rrf([await fts(q), await vec(q)]).map((s) => s.item);
      const hybridAny: Ranker = async (q) => rrf([await ftsAny(q), await vec(q)]).map((s) => s.item);
      line(`${m.id} vectors`, await evaluate(vec), await evaluate(vec, 'paraphrase'), await evaluate(vec, 'keyword'));
      line(`Hybrid FTS5 (all words) + ${m.id}`, await evaluate(hybrid), await evaluate(hybrid, 'paraphrase'), await evaluate(hybrid, 'keyword'));
      line(`Hybrid FTS5 (any word) + ${m.id}`, await evaluate(hybridAny), await evaluate(hybridAny, 'paraphrase'), await evaluate(hybridAny, 'keyword'));
      results[m.id] = { loadMs: Math.round(loadMs), msPerPassage: +passageMs.toFixed(1), msPerQuery: +(qTime / qCount).toFixed(1), rssDeltaMb: Math.round(rssMb) };
      await e.dispose();
    }
    brain.close();

    const table = [
      '| Ranker | recall@5 (all) | MRR@10 (all) | recall@5 (paraphrase) | MRR@10 (paraphrase) | recall@5 (keyword) | MRR@10 (keyword) |',
      '|---|---|---|---|---|---|---|',
      ...rows,
    ].join('\n');
    console.log(`${table}\n\n${JSON.stringify(results, null, 2)}`);
    writeFileSync(join(import.meta.dirname, 'results.md'), `# B1 spike results (${new Date().toISOString().slice(0, 10)})\n\n${table}\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`);
  });
});
