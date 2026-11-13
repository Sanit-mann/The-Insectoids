import { type ReactNode, Fragment } from 'react';

/**
 * A library item's Markdown, shown as readable text without a Markdown dependency: headings, lists,
 * code blocks and paragraphs. Never renders HTML from the text (React escapes everything).
 */
export function MarkdownText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!);
      i++;
      blocks.push(
        <pre className="m-0 overflow-x-auto rounded-[10px] border border-line bg-ground p-2.5 font-mono text-xs" key={key++}>
          {code.join('\n')}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(
        <p className={level <= 2 ? 'm-0 mt-2 font-display text-[15px] font-semibold' : 'm-0 mt-1 text-sm font-semibold'} key={key++}>
          {inline(heading[2]!)}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*]|\d+\.)\s+/, ''));
      blocks.push(
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5" key={key++}>
          {items.map((it, n) => (
            <li key={n}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s+)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(
      <p className="m-0" key={key++}>
        {inline(para.join(' '))}
      </p>,
    );
  }
  return <div className="flex flex-col gap-2 text-sm leading-relaxed">{blocks}</div>;
}

/** `code` and **bold**; everything else stays as written. */
function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, n) =>
    p.startsWith('`') && p.endsWith('`') && p.length > 1 ? (
      <code className="rounded bg-surface-2 px-1 font-mono text-[12px]" key={n}>
        {p.slice(1, -1)}
      </code>
    ) : p.startsWith('**') && p.endsWith('**') && p.length > 3 ? (
      <strong key={n}>{p.slice(2, -2)}</strong>
    ) : (
      <Fragment key={n}>{p}</Fragment>
    ),
  );
}
