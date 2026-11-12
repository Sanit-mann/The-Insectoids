// Triage inventory: flag product-locked items and group near-duplicates.
// Usage: node triage.mjs <reposDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const [, , reposDir, outDir] = process.argv;
const lines = fs.readFileSync(path.join(outDir, 'inventory.tsv'), 'utf8').trim().split('\n').slice(1);
const rows = lines.map(l => { const [repo, type, name, n, rel, desc] = l.split('\t'); return { repo, type, name, lines: +n, rel, desc }; });

// Product lock: content leans on a specific product's own CLI/runtime.
const LOCK = [
  ['ruflo', /claude-flow|ruflo|agentdb|ruvector|flow-nexus|\bsona\b|reasoningbank|neural-trader|@ruv|ruv-swarm|cognitum/gi],
  ['ecc', /\becc\b|everything-claude-code|ecc2|ecc_dashboard/gi],
  ['caveman', /caveman/gi],
];
for (const r of rows) {
  const text = fs.readFileSync(path.join(reposDir, r.repo, r.rel), 'utf8');
  r.lockHits = 0;
  for (const [, re] of LOCK) r.lockHits += (text.match(re) || []).length;
  r.lockRatio = r.lockHits / Math.max(1, r.lines);
  r.locked = r.lockHits >= 8 && r.lockRatio > 0.04;
}

// Near-duplicate key: name tokens minus generic words, singularized, sorted.
const GENERIC = new Set(['agent', 'agents', 'specialist', 'expert', 'skill', 'skills', 'workflow', 'patterns', 'pattern', 'v3', 'ruflo', 'claude', 'flow', 'the', 'and', 'for', 'with', 'coordinator', 'manager', 'pro', 'advanced', 'basic', 'helper', 'mode']);
const key = n => [...new Set(n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  .filter(t => t && !GENERIC.has(t)).map(t => t.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1')))].sort().join(' ');

const groups = new Map();
for (const r of rows) { const k = key(r.name) || r.name.toLowerCase(); (groups.get(k) || groups.set(k, []).get(k)).push(r); }

const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
const report = multi.map(([k, v]) => `${k}\t${v.length}\t` + v.map(x => `${x.repo.split('__')[1]}:${x.type}:${x.name}(${x.lines}${x.locked ? ',LOCK' : ''})`).join(' | '))
  .sort();
fs.writeFileSync(path.join(outDir, 'near-dup-groups.tsv'), report.join('\n'));
fs.writeFileSync(path.join(outDir, 'triaged.tsv'), 'repo\ttype\tname\tlines\tlocked\tgroup\tpath\tdescription\n' +
  rows.map(r => [r.repo, r.type, r.name, r.lines, r.locked ? 'Y' : '', key(r.name), r.rel, r.desc].join('\t')).join('\n'));

const locked = rows.filter(r => r.locked);
const byRepo = {};
for (const r of locked) byRepo[r.repo] = (byRepo[r.repo] || 0) + 1;
const free = rows.filter(r => !r.locked);
const freeGroups = new Set(free.map(r => key(r.name) || r.name.toLowerCase()));
console.log('items:', rows.length, '| locked:', locked.length, JSON.stringify(byRepo));
console.log('near-dup groups (size>1):', multi.length, '| items in them:', multi.reduce((s, [, v]) => s + v.length, 0));
console.log('distinct capabilities after locks removed and dups collapsed:', freeGroups.size);
const t = {}; for (const r of free) t[r.type] = (t[r.type] || 0) + 1; console.log('unlocked by type:', JSON.stringify(t));
