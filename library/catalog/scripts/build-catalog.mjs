// Build the Insectoids library catalog: rewritten core items + dormant harvested items.
// Usage: node build-catalog.mjs <libraryDir>
import fs from 'node:fs';
import path from 'node:path';

const lib = process.argv[2];
const LICENSE = {
  ruvnet__ruflo: 'MIT', 'affaan-m__ecc': 'MIT', 'msitarzewski__agency-agents': 'MIT', obra__superpowers: 'MIT',
  juliusbrussee__caveman: 'Apache-2.0', 'multica-ai__andrej-karpathy-skills': 'MIT',
  'vercel-labs__agent-browser': 'Apache-2.0', 'vercel-labs__agent-skills': 'MIT', 'microsoft__playwright-mcp': 'Apache-2.0',
};
const repoName = r => r.replace('__', '/');

// --- 1. Rewritten items (frontmatter of AGENT.md / SKILL.md / tools/*.md)
function fm(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}
const field = (block, key) => { const m = block.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
const list = (block, key) => { const v = field(block, key); return v.startsWith('[') ? v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : []; };
const rewritten = [];
const usedSources = new Set();
// A YAML scalar as plain text: drop a block marker, or a wrapping pair of quotes and undo their escapes
// (stripping only the opening quote used to leave a stray closing one in the catalog).
function unquote(v) {
  const t = v.replace(/^[>|]-?\s*/, '').trim();
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}
function addRewritten(file, kind) {
  const text = fs.readFileSync(file, 'utf8');
  const f = fm(text);
  const desc = (f.match(/^description:\s*([\s\S]*?)(?=^\w[\w-]*:|$(?![\s\S]))/m) || [, ''])[1].replace(/\s+/g, ' ').trim();
  const sources = [...f.matchAll(/repo:\s*(\S+)\s*\n\s*path:\s*(\S+)/g)].map(m => ({ repo: m[1], path: m[2] }));
  sources.forEach(s => usedSources.add(`${s.repo}|${s.path}`));
  rewritten.push({
    name: field(f, 'name'), kind, rank: field(f, 'rank') || undefined,
    castes: list(f, 'castes').length ? list(f, 'castes') : [field(f, 'caste') || field(f, 'name')].filter(Boolean),
    description: unquote(desc), status: 'active-library', rewritten: true,
    lines: text.split('\n').length, file: path.relative(lib, file).split(path.sep).join('/'), sources,
  });
}
for (const [dir, kind, fname] of [['agents', 'agent', 'AGENT.md'], ['skills', 'skill', 'SKILL.md']]) {
  const d = path.join(lib, dir);
  if (!fs.existsSync(d)) continue;
  for (const n of fs.readdirSync(d)) { const f = path.join(d, n, fname); if (fs.existsSync(f)) addRewritten(f, kind); }
}
if (fs.existsSync(path.join(lib, 'tools'))) for (const n of fs.readdirSync(path.join(lib, 'tools'))) if (n.endsWith('.md')) addRewritten(path.join(lib, 'tools', n), 'tool');

// --- 2. Dormant items from the triaged inventory
const rows = fs.readFileSync(path.join(lib, 'catalog', 'source-inventory.tsv'), 'utf8').trim().split('\n').slice(1)
  .map(l => { const [repo, type, name, n, locked, group, rel, desc] = l.split('\t'); return { repo, type, name, lines: +n, locked: locked === 'Y', group, rel, desc }; });

function guessCastes(r) {
  const s = `${r.rel} ${r.name}`.toLowerCase();
  const c = new Set();
  if (/review|audit/.test(s)) c.add('reviewer');
  if (/test|tdd|e2e|qa\b|benchmark/.test(s)) c.add('tester');
  if (/research|academic|trend|scientific|osint/.test(s)) c.add('researcher');
  if (/doc|writer|readme/.test(s)) c.add('documenter');
  if (/design|ui|ux|brand|visual|motion|figma/.test(s)) c.add('designer');
  if (/financ|analy|data|metric|sales|product|pricing|account/.test(s)) c.add('analyst');
  if (/market|seo|content|social|email|copy|support|paid-media|tiktok|linkedin/.test(s)) c.add('writer');
  if (/engineer|developer|pattern|build|resolver|refactor|code|api|backend|frontend|devops|security|database|docker|kubernetes|lang|rust|go-|java|kotlin|swift|python|typescript|react|django|laravel/.test(s)) c.add('coder');
  if (/game|gis|spatial|healthcare|xr|unity|unreal|godot|roblox|blockchain|legal|tax/.test(s)) c.add('specialist');
  return c.size ? [...c] : ['specialist'];
}

const dormant = new Map();
let skippedLocked = 0, skippedThin = 0, skippedUsed = 0;
for (const r of rows) {
  if (r.locked) { skippedLocked++; continue; }
  if (r.type === 'command' && r.lines < 60) { skippedThin++; continue; }
  if (usedSources.has(`${repoName(r.repo)}|${r.rel}`)) { skippedUsed++; continue; }
  const key = r.group || r.name.toLowerCase();
  const src = { repo: repoName(r.repo), path: r.rel, license: LICENSE[r.repo] || 'unknown', type: r.type, lines: r.lines };
  const cur = dormant.get(key);
  if (!cur) {
    dormant.set(key, { name: r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), kind: r.type === 'agent' ? 'agent' : 'skill',
      castes: guessCastes(r), description: r.desc, status: 'dormant', rewritten: false, safety: 'unscanned', sources: [src] });
  } else {
    cur.sources.push(src);
    if ((r.desc || '').length > (cur.description || '').length) cur.description = r.desc;
  }
}

// Skip dormant groups whose name collides with a rewritten item (already covered).
const coveredNames = new Set(rewritten.map(x => x.name));
const dormantList = [...dormant.values()].filter(d => !coveredNames.has(d.name)).sort((a, b) => a.name.localeCompare(b.name));

const catalog = { generated: new Date().toISOString().slice(0, 10), counts: {
  rewritten: rewritten.length, dormant: dormantList.length,
  skipped: { productLocked: skippedLocked, thinCommands: skippedThin, mergedIntoCore: skippedUsed } },
  items: [...rewritten.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), ...dormantList] };
fs.writeFileSync(path.join(lib, 'catalog', 'catalog.json'), JSON.stringify(catalog, null, 1));

// Human-readable summary
const byCaste = {};
for (const d of dormantList) for (const c of d.castes) byCaste[c] = (byCaste[c] || 0) + 1;
const md = [
  '# Library Catalog', '', `Generated ${catalog.generated} from [catalog.json](catalog.json).`, '',
  '| | Count |', '|---|---|',
  `| Rewritten core items (active library) | ${rewritten.length} |`,
  `| Dormant, not yet rewritten | ${dormantList.length} |`,
  `| Skipped: tied to another product | ${skippedLocked} |`,
  `| Skipped: thin command shortcuts | ${skippedThin} |`,
  `| Sources already merged into core items | ${skippedUsed} |`, '',
  '## Rewritten core items', '', '| Kind | Name | Castes | Lines |', '|---|---|---|---|',
  ...rewritten.map(x => `| ${x.kind}${x.rank ? ' (' + x.rank + ')' : ''} | [${x.name}](../${x.file}) | ${x.castes.join(', ')} | ${x.lines} |`), '',
  '## Dormant items by likely caste', '', '| Caste | Items |', '|---|---|',
  ...Object.entries(byCaste).sort((a, b) => b[1] - a[1]).map(([c, n]) => `| ${c} | ${n} |`), '',
  'Dormant items keep their original source paths and are rewritten in later batches or on first use (03-D9). Their castes are an automatic guess.',
].join('\n');
fs.writeFileSync(path.join(lib, 'catalog', 'CATALOG.md'), md);
console.log(JSON.stringify(catalog.counts));
