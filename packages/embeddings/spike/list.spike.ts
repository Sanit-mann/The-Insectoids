import { it } from 'vitest';
import { buildCorpus } from './corpus';
it.skipIf(process.env['SPIKE'] !== '1')('list corpus', () => {
  const c = buildCorpus();
  console.log('PASSAGES', c.length);
  for (const p of c) console.log(`${p.id}\t${p.title.slice(0, 90)}`);
});
