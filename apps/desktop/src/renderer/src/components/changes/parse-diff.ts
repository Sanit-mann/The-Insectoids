/** A unified diff (as `git diff` prints it) split into files, hunks and numbered lines. */

export type DiffLineType = 'add' | 'remove' | 'context' | 'note';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** Line number in the old file (null for added lines and notes). */
  old: number | null;
  /** Line number in the new file (null for removed lines and notes). */
  new: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  binary: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Path from a `diff --git a/x b/x` line; handles quoted paths with spaces. */
function pathFromHeader(line: string): string {
  const quoted = /^diff --git "a\/(.+)" "b\/(.+)"$/.exec(line);
  if (quoted) return quoted[2]!;
  const plain = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return plain ? plain[2]! : line.replace(/^diff --git /, '');
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = { path: pathFromHeader(raw), hunks: [], binary: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '');
      if (p !== '/dev/null') file.path = p;
      continue;
    }
    if (raw.startsWith('--- ') && !hunk) continue;
    if (raw.startsWith('Binary files ')) {
      file.binary = true;
      continue;
    }
    const h = HUNK.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('+')) hunk.lines.push({ type: 'add', text: raw.slice(1), old: null, new: newNo++ });
    else if (raw.startsWith('-')) hunk.lines.push({ type: 'remove', text: raw.slice(1), old: oldNo++, new: null });
    else if (raw.startsWith('\\')) hunk.lines.push({ type: 'note', text: raw.slice(1).trim(), old: null, new: null });
    else if (raw.startsWith(' ') || raw === '') {
      // A bare empty line is the last line of the patch, not a context line, unless more hunk lines follow;
      // git always prefixes context with a space, so skip bare empties.
      if (raw === '') continue;
      hunk.lines.push({ type: 'context', text: raw.slice(1), old: oldNo++, new: newNo++ });
    }
  }
  return files;
}

export function countLines(file: DiffFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of file.hunks)
    for (const l of h.lines) {
      if (l.type === 'add') added++;
      else if (l.type === 'remove') removed++;
    }
  return { added, removed };
}
