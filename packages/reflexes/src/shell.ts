/**
 * A small, conservative shell parser for the command guard.
 * It understands enough of bash, cmd and PowerShell to split a command line into simple commands:
 * separators (; && || & newline), pipes, quotes, output redirections, $(...), `...`, <(...) and
 * PowerShell/cmd grouping. It does not execute anything. Anything it cannot read safely throws ParseError.
 */

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export interface Segment {
  /** Words after quote removal. Substitutions appear as the placeholder SUBST. */
  words: string[];
  /** Output redirection targets (> and >>). */
  redirects: string[];
  /** True when this command's input comes from a pipe. */
  pipedFrom: boolean;
}

export interface Parsed {
  segments: Segment[];
  /** Command strings found inside $(...), `...` and <(...): checked as commands of their own. */
  nested: string[];
}

export const SUBST = '\u0000SUBST\u0000';

export function parseCommand(input: string, platform: 'win32' | 'posix'): Parsed {
  const segments: Segment[] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let pipedFrom = false;
  let word = '';
  let inWord = false;
  let pendingRedirect = false;
  let i = 0;

  const endWord = (): void => {
    if (!inWord) return;
    if (pendingRedirect) {
      redirects.push(word);
      pendingRedirect = false;
    } else {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = (nextPiped: boolean): void => {
    endWord();
    if (pendingRedirect) throw new ParseError('redirection without a target');
    if (words.length || redirects.length) segments.push({ words, redirects, pipedFrom });
    words = [];
    redirects = [];
    pipedFrom = nextPiped;
  };
  /** Read until the matching close bracket, honouring nesting and quotes. */
  const readGroup = (open: string, close: string): string => {
    let depth = 1;
    let out = '';
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === "'" || ch === '"') {
        const end = input.indexOf(ch, i + 1);
        if (end < 0) throw new ParseError('unterminated quote');
        out += input.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (ch === open) depth++;
      if (ch === close && --depth === 0) {
        i++;
        return out;
      }
      out += ch;
      i++;
    }
    throw new ParseError(`unterminated ${open}`);
  };

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new ParseError('unterminated quote');
      word += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\' && platform === 'posix' && (input[i + 1] === '"' || input[i + 1] === '\\' || input[i + 1] === '$')) {
          word += input[i + 1];
          i += 2;
          continue;
        }
        if (c === '$' && input[i + 1] === '(') {
          i += 2;
          nested.push(readGroup('(', ')'));
          word += SUBST;
          continue;
        }
        word += c;
        i++;
      }
      if (!closed) throw new ParseError('unterminated quote');
      inWord = true;
      continue;
    }
    if (ch === '\\' && platform === 'posix' && next !== undefined) {
      word += next;
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === '$' && next === '(') {
      i += 2;
      nested.push(readGroup('(', ')'));
      word += SUBST;
      inWord = true;
      continue;
    }
    if (ch === '`' && platform === 'posix') {
      const end = input.indexOf('`', i + 1);
      if (end < 0) throw new ParseError('unterminated backtick');
      nested.push(input.slice(i + 1, end));
      word += SUBST;
      inWord = true;
      i = end + 1;
      continue;
    }
    if ((ch === '<' || ch === '>') && next === '(') {
      endWord();
      i += 2;
      nested.push(readGroup('(', ')'));
      words.push(SUBST);
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';') {
      endSegment(false);
      i++;
      continue;
    }
    if (ch === '&') {
      endSegment(false);
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (ch === '|') {
      if (next === '|') {
        endSegment(false);
        i += 2;
      } else {
        endSegment(true);
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      endSegment(false);
      i++;
      continue;
    }
    if (ch === '>' || (ch === '2' && next === '>' && !inWord)) {
      endWord();
      if (ch === '2') i++;
      i += input[i + 1] === '>' ? 2 : 1;
      if (input[i] === '&') {
        // 2>&1 style: duplicate a stream, no file target
        i++;
        while (i < input.length && /[0-9]/.test(input[i]!)) i++;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    if (ch === '<') {
      endWord();
      i++;
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  endSegment(false);
  return { segments, nested };
}
