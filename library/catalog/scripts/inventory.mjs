// Inventory agents, skills and commands across cloned repos.
// Usage: node inventory.mjs <reposDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const [, , reposDir, outDir] = process.argv;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'target']);
const LANG = /^(ja-JP|zh-CN|zh-TW|ko-KR|tr|es|pt-BR|pt|fr|de|ru|vi|it|id|ar|hi|ja|zh|ko)$/;
// Mirror folders that duplicate a canonical copy (lower priority = preferred).
function priority(rel) {
  if (/(^|\/)(skills|agents|commands)\//.test(rel) && !/^\.|\/\./.test(rel.split('/').slice(0, 1).join('/'))) return 0;
  if (rel.startsWith('.claude/')) return 1;
  if (rel.startsWith('plugins/')) return 2;
  if (rel.startsWith('.agents/')) return 3;
  return 5;
}

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || LANG.test(e.name)) continue;
      walk(p, out);
    } else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) { key = kv[1]; fm[key] = kv[2].replace(/^["'>|-]\s*|["']$/g, '').trim(); }
    else if (key && /^\s+\S/.test(line)) fm[key] = (fm[key] + ' ' + line.trim()).trim();
  }
  return fm;
}

const rows = [];
for (const repo of fs.readdirSync(reposDir)) {
  const root = path.join(reposDir, repo);
  if (!fs.statSync(root).isDirectory()) continue;
  for (const f of walk(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const segs = rel.split('/');
    if (segs[0] === 'docs' || segs[0] === 'pi' || segs[0] === '.kiro' || segs[0] === '.cursor' || segs[0] === 'legacy-command-shims') continue;
    const base = path.basename(f);
    let type = null;
    if (base === 'SKILL.md') type = 'skill';
    else if (/^(README|CHANGELOG|CONTRIBUTING|LICENSE|CODE_OF_CONDUCT|SECURITY|MIGRATION_SUMMARY)/i.test(base)) continue;
    else if (segs.includes('commands')) type = 'command';
    else if (segs.slice(0, -1).some(s => s === 'agents' || s.endsWith('-agents')) || repo.includes('agency-agents')) type = 'agent';
    if (!type) continue;
    const text = fs.readFileSync(f, 'utf8');
    const fm = frontmatter(text);
    if (type === 'agent' && !(fm.name && fm.description)) continue;
    let name = fm.name || (type === 'skill' ? path.basename(path.dirname(f)) : path.basename(f, '.md'));
    name = name.replace(/["']/g, '').trim();
    let desc = fm.description || (text.replace(/^---[\s\S]*?---/, '').split(/\r?\n/).find(l => l.trim() && !l.startsWith('#')) || '');
    desc = desc.replace(/\s+/g, ' ').replace(/\t/g, ' ').slice(0, 220);
    rows.push({ repo, type, name, desc, rel, lines: text.split('\n').length, prio: priority(rel) });
  }
}

// Dedupe within each repo by (type, normalized name), keeping preferred path.
const norm = s => s.toLowerCase().replace(/^(agent|v3|ruflo|claude-flow|sparc)[-_ ]/, '').replace(/[^a-z0-9]/g, '');
const best = new Map();
for (const r of rows) {
  const k = `${r.repo}|${r.type}|${norm(r.name)}`;
  const cur = best.get(k);
  if (!cur || r.prio < cur.prio || (r.prio === cur.prio && r.lines > cur.lines)) best.set(k, r);
}
const uniq = [...best.values()].sort((a, b) => a.type.localeCompare(b.type) || norm(a.name).localeCompare(norm(b.name)));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'inventory.tsv'),
  'repo\ttype\tname\tlines\tpath\tdescription\n' + uniq.map(r => [r.repo, r.type, r.name, r.lines, r.rel, r.desc].join('\t')).join('\n'));

// Cross-repo exact-name duplicates.
const byName = new Map();
for (const r of uniq) { const k = norm(r.name); (byName.get(k) || byName.set(k, []).get(k)).push(r); }
const dups = [...byName.entries()].filter(([, v]) => new Set(v.map(x => x.repo)).size > 1);
fs.writeFileSync(path.join(outDir, 'exact-dups.tsv'),
  dups.map(([k, v]) => k + '\t' + v.map(x => `${x.repo.split('__')[1]}:${x.type}:${x.name}(${x.lines})`).join(' | ')).join('\n'));

const summary = {};
for (const r of uniq) { summary[r.repo] ??= { skill: 0, agent: 0, command: 0 }; summary[r.repo][r.type]++; }
console.log(JSON.stringify(summary, null, 1));
console.log('total unique items:', uniq.length, '| cross-repo exact-name duplicate groups:', dups.length);
