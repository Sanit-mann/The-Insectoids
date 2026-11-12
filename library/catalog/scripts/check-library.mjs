// Check library files against FORMAT.md basics and scan for risky content.
// Usage: node check-library.mjs <libraryDir>
import fs from 'node:fs';
import path from 'node:path';

const lib = process.argv[2];
const files = [];
for (const [dir, fname] of [['agents', 'AGENT.md'], ['skills', 'SKILL.md']]) {
  const d = path.join(lib, dir);
  for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) files.push({ name: n, file: path.join(d, n, fname), dir: path.join(d, n) });
}
for (const n of fs.readdirSync(path.join(lib, 'tools'))) if (n.endsWith('.md')) files.push({ name: n.replace(/\.md$/, ''), file: path.join(lib, 'tools', n), dir: null });

const problems = [];
const castes = {};
const RISK = [
  [/curl[^\n|]*\|\s*(ba)?sh|wget[^\n|]*\|\s*(ba)?sh/i, 'pipe-to-shell'],
  [/ignore (all |any )?(previous|prior) instructions/i, 'injection phrase'],
  [/\b(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})/, 'secret-like token'],
  [/base64\s+-d|eval\s*\(\s*atob/i, 'obfuscation'],
  [/raw\.githubusercontent\.com/i, 'remote raw fetch'],
  [/webhook\.site|ngrok\.io|requestbin/i, 'exfil host'],
];
let total = 0;
for (const f of files) {
  if (!fs.existsSync(f.file)) { problems.push(`${f.name}: missing file`); continue; }
  const t = fs.readFileSync(f.file, 'utf8');
  total++;
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) { problems.push(`${f.name}: no frontmatter`); continue; }
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  if (name !== f.name) problems.push(`${f.name}: name field "${name}" != folder`);
  const dm = fm.match(/^description:\s*([\s\S]*?)(?=^\S[\w-]*:)/m);
  const desc = dm ? dm[1].replace(/\s+/g, ' ').trim() : '';
  if (!desc) problems.push(`${f.name}: no description`);
  else if (desc.length > 450) problems.push(`${f.name}: description ${desc.length} chars`);
  if (!/^\s+kind:\s*(agent|skill|tool)/m.test(fm)) problems.push(`${f.name}: missing metadata.kind`);
  if (!/repo:/.test(fm)) problems.push(`${f.name}: no sources`);
  if (/^\s+-?\s*[\w-]+:\s+[^"'\n[{][^\n]*:\s/m.test(fm.replace(/^description:.*$/m, ''))) {} // loose
  const cm = fm.match(/^\s+castes:\s*\[([^\]]*)\]/m);
  if (cm) for (const c of cm[1].split(',').map(s => s.trim()).filter(Boolean)) castes[c] = (castes[c] || 0) + 1;
  const body = t.slice(m[0].length).split('\n').length;
  if (body > 210) problems.push(`${f.name}: body ${body} lines`);
  // broken reference links
  for (const lm of t.matchAll(/\]\((references\/[^)#\s]+)\)/g)) if (f.dir && !fs.existsSync(path.join(f.dir, lm[1]))) problems.push(`${f.name}: broken link ${lm[1]}`);
  // risk scan over the whole folder
  const scanFiles = f.dir ? [f.file, ...(fs.existsSync(path.join(f.dir, 'references')) ? fs.readdirSync(path.join(f.dir, 'references')).map(x => path.join(f.dir, 'references', x)) : [])] : [f.file];
  for (const sf of scanFiles) { const st = fs.readFileSync(sf, 'utf8'); for (const [re, label] of RISK) if (re.test(st)) problems.push(`${path.relative(lib, sf)}: RISK ${label}`); }
  // other files in skill folder (scripts?)
  if (f.dir) for (const x of fs.readdirSync(f.dir)) if (!['SKILL.md', 'AGENT.md', 'references'].includes(x)) problems.push(`${f.name}: extra file ${x}`);
  // $N placeholders in SKILL.md body (some hosts substitute them)
  if (/\$\d/.test(t.slice(m[0].length)) && f.file.endsWith('SKILL.md')) problems.push(`${f.name}: contains $N placeholder in SKILL.md body`);
}
console.log('files checked:', total);
console.log('castes values:', JSON.stringify(castes));
console.log(problems.length ? problems.join('\n') : 'no problems');
