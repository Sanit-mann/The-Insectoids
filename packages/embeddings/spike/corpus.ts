import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Passage {
  id: string;
  title: string;
  text: string;
}

const ROOT = join(import.meta.dirname, '..', '..', '..');
const clean = (s: string) => s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();

/** Spec sections (## / ###) of functions/*.md, and the description + intro of every library agent and skill. */
export function buildCorpus(): Passage[] {
  const out: Passage[] = [];
  const fnDir = join(ROOT, 'functions');
  for (const f of readdirSync(fnDir).filter((n) => /^\d\d-.*\.md$/.test(n))) {
    const doc = readFileSync(join(fnDir, f), 'utf8').replace(/\r/g, '');
    const parts = doc.split(/\n(?=#{2,3} )/);
    parts.forEach((p, i) => {
      const title = (p.match(/^#{2,3} (.+)/)?.[1] ?? p.split('\n')[0] ?? f).trim();
      if (/^(Open questions|Change log|Inputs \/ Outputs|Status)/i.test(title)) return;
      const text = clean(p).slice(0, 1500);
      if (text.length < 120) return;
      out.push({ id: `${f.slice(0, 2)}#${i}`, title: `${f.slice(0, 2)} ${title}`, text });
    });
  }
  for (const kind of ['agents', 'skills'] as const) {
    const dir = join(ROOT, 'library', kind);
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, kind === 'agents' ? 'AGENT.md' : 'SKILL.md');
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8').replace(/\r/g, '');
      } catch {
        continue;
      }
      const desc = raw.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
      const body = raw.replace(/^---[\s\S]*?\n---\n/, '');
      const intro = clean(body).split('\n\n').slice(0, 3).join('\n\n').slice(0, 900);
      out.push({ id: `${kind[0]}:${name}`, title: `${kind === 'agents' ? 'Agent' : 'Skill'} ${name}`, text: clean(`${name}: ${desc}\n\n${intro}`) });
    }
  }
  return out;
}
