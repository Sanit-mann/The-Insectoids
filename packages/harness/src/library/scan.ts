import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { detectSecrets } from '@insectoids/brain';

/**
 * The import safety scan (Capabilities 03-D5; Phase 2 C3). Plain code, deterministic, no AI: it reads every
 * file of a skill or agent folder and looks for five kinds of trouble:
 * - hidden-instructions: invisible characters, instructions tucked into HTML comments, "ignore your previous
 *   instructions" / "don't tell the user", long encoded blobs, turning safety off, following rules fetched
 *   from the internet;
 * - exfiltration: sending files, environment variables or secrets to an outside address; known drop sites;
 *   reading credentials in a file that also talks to the network;
 * - risky-script: in scripts and fenced code blocks, piping a download into a shell, encoded PowerShell,
 *   eval of fetched code, deleting broad paths, persistence, admin rights, turning off the firewall;
 * - secret: keys, tokens and passwords (the Brain's secrets guard); the value itself is never repeated;
 * - format: SKILL.md / AGENT.md with valid frontmatter (library/FORMAT.md), and size limits.
 *
 * A `block` finding means the item can never be approved; `warn` findings are shown to the user first.
 * Built-in items are vetted before shipping and are not scanned at run time.
 */
export type ScanSeverity = 'block' | 'warn';
export type ScanRule = 'hidden-instructions' | 'exfiltration' | 'risky-script' | 'secret' | 'format';

export interface ScanFinding {
  severity: ScanSeverity;
  rule: ScanRule;
  message: string;
  /** Path inside the item, forward slashes (e.g. "SKILL.md", "scripts/setup.sh"). */
  file: string;
  line: number | null;
}

export interface ScanResult {
  verdict: 'clean' | 'warn' | 'blocked';
  findings: ScanFinding[];
  scannedAt: number;
}

export const SCAN_LIMITS = {
  /** Most files an item may hold. */
  maxFiles: 50,
  /** Largest single file the scanner reads. */
  maxFileBytes: 256 * 1024,
  /** All files together. */
  maxTotalBytes: 1024 * 1024,
  /** Longest description (Agent Skills standard). */
  maxDescription: 1024,
} as const;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl']);
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.txt', '']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
const EXECUTABLE_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.app', '.com', '.scr', '.jar']);

// ---- patterns ------------------------------------------------------------------------------------

/** Invisible characters that can hide text from a human reader (zero-width, bidi controls). A leading BOM is fine. */
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

const INSTRUCTION_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions|rules|messages|prompts?|directions)/i, 'tells the agent to ignore its earlier instructions'],
  [/\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to|show\s+(?:this\s+)?to|let)\s+(?:the\s+)?user\b/i, 'tells the agent to keep something from the user'],
  [/\bwithout\s+(?:telling|informing|asking|notifying)\s+the\s+user\b/i, 'tells the agent to act without telling the user'],
  [/\b(?:hide|conceal)\s+(?:this|it|that|these|your\s+(?:actions|changes|steps))\s+from\s+the\s+user\b/i, 'tells the agent to hide what it does from the user'],
  [/\b(?:disable|turn\s+off|bypass|circumvent|skip|get\s+around|work\s+around)\s+(?:the\s+|any\s+|all\s+)?(?:safety|security)?\s*(?:guard|guards|sandbox|approval|approvals|permission\s+checks?|hooks?|safety\s+checks?)\b/i, 'tells the agent to get around the safety guard or approvals'],
  [/\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|unrestricted|god)\s*mode\b/i, 'tries to switch the agent into an "unrestricted" mode'],
];

/** Following rules fetched from the internet at run time (they can change after the scan). */
const REMOTE_RULES: ReadonlyArray<RegExp> = [
  /\b(?:follow|obey|apply|use|load)\s+(?:the\s+)?(?:latest\s+)?(?:instructions|rules|guidelines|prompt)\s+(?:at|from|in|found\s+at)\s+(?:`|<)?https?:\/\//i,
  /\b(?:fetch|download|curl|wget|read|load|get)\b[^\n]{0,80}https?:\/\/\S+[^\n]{0,80}\b(?:and\s+)?(?:follow|obey|apply|execute)\s+(?:the\s+|its\s+|those\s+|these\s+)?(?:instructions|rules|guidelines|steps)/i,
];

/** Instruction-like words inside an HTML comment (comments don't show in rendered Markdown). */
const COMMENT_INSTRUCTION = /\b(?:you\s+(?:must|should|will)|ignore|always|never|run|execute|send|upload|post|curl|wget|do\s+not\s+tell|assistant|agent|system\s+prompt|instructions?)\b/i;

const BASE64_BLOB = /[A-Za-z0-9+/]{160,}={0,2}/;
const HEX_BLOB = /\b[0-9a-fA-F]{160,}\b/;

/** Places that collect data sent to them (paste bins, tunnels, request catchers, chat webhooks). */
const DROP_SITES = /\b(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/(?:services|workflows)|api\.telegram\.org\/bot|pastebin\.com|paste\.ee|hastebin\.|ghostbin\.|ngrok(?:-free)?\.(?:io|app|dev)|requestbin\.|pipedream\.net|webhook\.site|transfer\.sh|file\.io|0x0\.st|interact\.sh|oast\.(?:fun|me|pro|live|site|online)|oastify\.com|burpcollaborator\.net|requestcatcher\.com|beeceptor\.com)/i;

/** A command that sends data somewhere. */
const NETWORK_SEND: ReadonlyArray<RegExp> = [
  /\bcurl\b[^\n]*?(?:\s-d\b|\s--data(?:-binary|-raw|-urlencode)?\b|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s-X\s*POST\b|\s--request\s+POST\b)/i,
  /\bwget\b[^\n]*?--post-(?:data|file)\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]*?(?:-Method\s+(?:Post|Put)|-Body\b|-InFile\b)/i,
  /\brequests\.(?:post|put)\s*\(/i,
  /\bfetch\s*\([^\n]*?method\s*:\s*['"](?:POST|PUT)['"]/i,
  /\b(?:nc|ncat|netcat)\s+(?:-\w+\s+)*[\w.-]+\s+\d{2,5}\b/i,
  /\bscp\s+[^\n]*\s[\w.-]+@[\w.-]+:/i,
];

/** Any network use at all (for "reads credentials in a file that also talks to the network"). */
const NETWORK_ANY = /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Net\.WebClient|requests\.(?:get|post|put)|urllib\.request|http\.request|https\.request|fetch\s*\(|axios\.|XMLHttpRequest|nc\s|ncat\s|netcat\s|scp\s|ftp\s)/i;

/** Files and stores that hold credentials, and dumps of the whole environment. */
const SENSITIVE_SOURCES = /(?:~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)[\\/]\.(?:ssh|aws|azure|gnupg|kube|docker|npmrc|netrc|pypirc|git-credentials|config[\\/]gh)|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|(?:^|[\s"'`/\\])\.env(?:\.[\w-]+)?\b(?!\.example)|\bcredentials\.json\b|\b(?:Login\s+Data|Cookies)\b|\bsecurity\s+find-(?:generic|internet)-password\b|\bcmdkey\s+\/list\b|\bprintenv\b|\bGet-ChildItem\s+env:|\bJSON\.stringify\(\s*process\.env\s*\)|\bos\.environ\b(?!\s*\.get\b|\s*\[)|(?:^|[\s;|&])env\s*\|/i;

/** Sending a file from the home folder or system folders, or a dump of files or the environment. */
const DUMP_PAYLOAD = /\$\(\s*(?:cat|type|Get-Content|base64|env|printenv|set)\b|`\s*(?:cat|env|printenv)\b|@~|@"?\$HOME|@%USERPROFILE%|@\/(?:etc|home|Users|root)\//i;
/** Sending an environment variable (often a token for the API it belongs to; shown to the user). */
const ENV_PAYLOAD = /\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Z_][A-Z0-9_]*%|\$env:[A-Z_]/;

/** Fenced code blocks that are plain listings, not commands (a .gitignore, sample output). */
const LISTING_FENCE = /^(?:text|txt|plain|plaintext|output|console-output|gitignore|dockerignore|ignore|csv|diff)$/i;

/** References to a password rather than a password (code, variables, secret files, placeholders). */
const PASSWORD_REFERENCE = /^(?:[`$%]|process\.|os\.|env\b|settings\.|config\.|z\.|\/run\/secrets|\w+\(|\w+\.\w+\()/i;

const RISKY_SCRIPT: ReadonlyArray<readonly [RegExp, ScanSeverity, string]> = [
  [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, 'block', 'pipes a download straight into a shell'],
  [/\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i, 'block', 'runs a downloaded script without saving or checking it'],
  [/\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString|DownloadFile)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i, 'block', 'pipes a download into Invoke-Expression'],
  [/\b(?:iex|Invoke-Expression)\b\s*\(?\s*\(?\s*(?:New-Object\b|iwr\b|irm\b|Invoke-WebRequest\b|Invoke-RestMethod\b|\[System\.Net)/i, 'block', 'runs code downloaded from the internet with Invoke-Expression'],
  [/\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedcommand)\s+[A-Za-z0-9+/=]{8,}/i, 'block', 'runs an encoded (hidden) PowerShell command'],
  [/\beval\s*\(\s*(?:await\s+)?(?:fetch|axios|require\s*\(\s*['"]https?:)|\beval\s*\(\s*(?:await\s+)?\(?\s*await\s+fetch/i, 'block', 'runs code fetched from the internet with eval'],
  [/\bexec\s*\(\s*(?:urllib\.request\.urlopen|requests\.get|urlopen)\b|\bexec\s*\(\s*base64\.b64decode\b/i, 'block', 'runs downloaded or encoded code with exec'],
  [/\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|$|\*)|~\/?(?:\s|$|\*)|"?\$HOME"?\/?(?:\s|$|\*)|\*(?:\s|$)|\.\.?\/?(?:\s|$))/i, 'block', 'deletes a whole folder tree (the home folder, the root or everything here)'],
  [/\bRemove-Item\b[^\n]*-Recurse\b[^\n]*(?:\s[A-Za-z]:\\?(?:\s|$|\*)|\$env:(?:USERPROFILE|HOMEPATH|SystemRoot)|\s~\\?(?:\s|$))/i, 'block', 'deletes a whole drive or the home folder'],
  [/\b(?:rd|rmdir)\s+\/s\b[^\n]*\s[A-Za-z]:\\?(?:\s|$)|\bdel\s+\/[sfq][^\n]*\s[A-Za-z]:\\\*?(?:\s|$)|\bformat\s+[A-Za-z]:/i, 'block', 'wipes a whole drive'],
  [/\bcrontab\b|\/etc\/cron\.|\bschtasks(?:\.exe)?\s+\/create\b|\bRegister-ScheduledTask\b|CurrentVersion\\Run(?:Once)?\b|\bLaunch(?:Agents|Daemons)\b|\blaunchctl\s+(?:load|bootstrap)\b|\bsystemctl\s+(?:--user\s+)?enable\b|>>\s*~\/\.(?:bashrc|zshrc|profile|bash_profile)\b|\bStartup\\/i, 'block', 'sets itself up to run again later (persistence)'],
  [/\bSet-MpPreference\b[^\n]*-Disable|\bAdd-MpPreference\b[^\n]*-Exclusion|\bnetsh\s+(?:adv)?firewall\b[^\n]*\b(?:off|disable)\b|\bufw\s+disable\b|\bsetenforce\s+0\b|\bspctl\s+--master-disable\b|\bSet-ExecutionPolicy\s+(?:Unrestricted|Bypass)\b/i, 'block', 'turns off the antivirus, the firewall or a security policy'],
  [/\bchmod\s+(?:\+x|[0-7]*7[0-7]{2})\b/i, 'warn', 'makes a file executable'],
  [/(?:^|[\s;&|(])sudo\s+\S/i, 'warn', 'asks for admin rights (sudo)'],
  [/\bStart-Process\b[^\n]*-Verb\s+RunAs\b|\brunas\s+\/user/i, 'warn', 'asks for admin rights'],
];

/** Wording that shows a line only talks about something rather than asking for it. */
const NEGATION = /\b(?:never|not|don't|do\s+not|must\s+not|mustn't|avoid|no|refuse|reject|watch\s+(?:out\s+)?for|look\s+for|detect|flag|beware)\b/i;

const PLACEHOLDER_SECRET = /\b(?:example|changeme|change-me|your[-_]?|placeholder|dummy|sample|redacted|xxx+|\*\*\*)|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}/i;

// ---- helpers -------------------------------------------------------------------------------------

/** A short, single-line excerpt of what matched, with invisible characters removed (never used for secrets). */
const excerpt = (s: string): string => {
  const clean = s.replace(new RegExp(HIDDEN_CHARS.source, 'g'), '').replace(/\s+/g, ' ').trim();
  return clean.length > 70 ? `${clean.slice(0, 69)}…` : clean;
};

/** Whether the match sits in quotes or backticks (an example being discussed, not an instruction). */
function quoted(line: string, index: number, length: number): boolean {
  const before = line.slice(0, index);
  const after = line.slice(index + length);
  // An odd number of a quote mark before the match, and one after it.
  const open = (c: string): boolean => before.split(c).length % 2 === 0 && after.includes(c);
  if (open('`') || open('"')) return true;
  return before.lastIndexOf('“') > before.lastIndexOf('”') && after.includes('”');
}

function negated(line: string, index: number): boolean {
  return NEGATION.test(line.slice(Math.max(0, index - 40), index));
}

type FileKind = 'markdown' | 'script' | 'other';

function fileKind(path: string): FileKind {
  const ext = extname(path).toLowerCase();
  if (SCRIPT_EXT.has(ext)) return 'script';
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  return 'other';
}

/**
 * For each line of a Markdown file: the number of the fenced code block (``` or ~~~) it is in, or 0 in prose.
 * Plain listings (```text, ```gitignore …) count as prose: they hold no commands.
 */
function fenceBlocks(lines: readonly string[]): number[] {
  const out: number[] = [];
  let fence: string | null = null;
  let block = 0;
  let listing = false;
  for (const l of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(l);
    if (m) {
      if (!fence) {
        fence = m[1]![0]!;
        block++;
        listing = LISTING_FENCE.test(m[2] ?? '');
        out.push(0);
        continue;
      }
      if (m[1]![0] === fence) {
        fence = null;
        out.push(0);
        continue;
      }
    }
    out.push(fence !== null && !listing ? block : 0);
  }
  return out;
}

/**
 * What a password-like assignment holds: 'ignore' for code and references (`password = form.get(...)`,
 * `$DB_PASSWORD`, `/run/secrets/…`), 'block' for a literal that looks real, 'warn' for a weak literal
 * (a dev default like `postgres`).
 */
function passwordLiteral(line: string): 'ignore' | 'warn' | 'block' {
  const m = /(?:PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_TOKEN)[A-Za-z_]*\s*[:=]\s*(.+)$/i.exec(line);
  if (!m) return 'ignore';
  const raw = m[1]!.trim();
  if (PASSWORD_REFERENCE.test(raw) || PLACEHOLDER_SECRET.test(raw)) return 'ignore';
  const value = (/^(['"])(.*?)\1/.exec(raw)?.[2] ?? raw.split(/[\s,;)]/)[0] ?? '').trim();
  if (value.length < 6 || /[()]/.test(value)) return 'ignore';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  return value.length >= 8 && classes >= 3 ? 'block' : 'warn';
}

// ---- scanning one file ---------------------------------------------------------------------------

/**
 * Scan one text file of an item. `file` is its path inside the item (for findings). Markdown prose gets the
 * instruction checks; scripts and Markdown code blocks also get the risky-script checks.
 */
export function scanText(file: string, text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const add = (severity: ScanSeverity, rule: ScanRule, message: string, line: number | null): void => {
    // One finding per rule and line is enough to explain it.
    if (findings.some((f) => f.rule === rule && f.line === line && f.message === message)) return;
    findings.push({ severity, rule, message, file, line });
  };
  const kind = fileKind(file);
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  // A script is one block; in Markdown each fenced code block is its own (0 = prose).
  const blocks = kind === 'markdown' ? fenceBlocks(lines) : lines.map(() => (kind === 'script' ? 1 : 0));
  const networkBlocks = new Set(blocks.filter((b, i) => b > 0 && NETWORK_ANY.test(lines[i]!)));

  lines.forEach((line, i) => {
    const n = i + 1;
    const block = blocks[i] ?? 0;
    const code = block > 0;

    // hidden instructions
    if (HIDDEN_CHARS.test(line)) add('block', 'hidden-instructions', 'Contains invisible characters that can hide text from you (zero-width or text-direction marks).', n);
    for (const [re, what] of INSTRUCTION_PHRASES) {
      const m = re.exec(line);
      if (!m) continue;
      if (quoted(line, m.index, m[0].length)) add('warn', 'hidden-instructions', `Quotes a phrase that ${what}: "${excerpt(m[0])}".`, n);
      else if (!negated(line, m.index)) add('block', 'hidden-instructions', `It ${what}: "${excerpt(m[0])}".`, n);
    }
    for (const re of REMOTE_RULES) {
      const m = re.exec(line);
      if (m && !negated(line, m.index)) add('block', 'hidden-instructions', `Follows rules fetched from the internet at run time (they can change after this check): "${excerpt(m[0])}".`, n);
    }
    if (BASE64_BLOB.test(line) || HEX_BLOB.test(line)) add('warn', 'hidden-instructions', 'Holds a long encoded blob that can hide content from a reader.', n);

    // exfiltration
    const drop = DROP_SITES.exec(line);
    if (drop) add('block', 'exfiltration', `Uses a service that collects data sent to it: ${excerpt(drop[0])}.`, n);
    for (const re of NETWORK_SEND) {
      const m = re.exec(line);
      if (!m) continue;
      const sent = line.slice(m.index);
      if (SENSITIVE_SOURCES.test(line) || DUMP_PAYLOAD.test(sent)) {
        add('block', 'exfiltration', `Sends private files or the environment to an outside address: "${excerpt(sent)}".`, n);
      } else if (ENV_PAYLOAD.test(sent) || /https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/i.test(line)) {
        add('warn', 'exfiltration', `Sends data to an outside address: "${excerpt(sent)}".`, n);
      }
    }
    const src = code ? SENSITIVE_SOURCES.exec(line) : null;
    if (src && !negated(line, src.index)) {
      // Reading credentials is only a leak risk where the same script or code block also talks to the network.
      if (networkBlocks.has(block)) add('block', 'exfiltration', `Reads credentials or the whole environment (${excerpt(src[0])}) in code that also sends data over the network.`, n);
      else add('warn', 'exfiltration', `Reads credentials or the whole environment: ${excerpt(src[0])}.`, n);
    }

    // risky scripts: only in scripts and Markdown code blocks
    if (code) {
      for (const [re, severity, what] of RISKY_SCRIPT) {
        const m = re.exec(line);
        if (!m) continue;
        // A comment that only mentions the command is not running it.
        if (/^\s*(?:#|\/\/|::|REM\b|<#)/i.test(line) && negated(line, m.index)) continue;
        add(severity, 'risky-script', `It ${what}: "${excerpt(line.trim())}".`, n);
      }
    }

    // secrets: report the kind, never the value
    const kinds = detectSecrets(line);
    const keys = kinds.filter((k) => k !== 'password-assignment');
    if (keys.length) {
      if (PLACEHOLDER_SECRET.test(line)) add('warn', 'secret', `Looks like a placeholder for a secret (${keys.join(', ')}); check it holds no real value.`, n);
      else add('block', 'secret', `Holds a secret (${keys.join(', ')}). Keys belong in the Vault, never in a skill.`, n);
    } else if (kinds.length) {
      const pw = passwordLiteral(line);
      if (pw === 'block') add('block', 'secret', 'Holds a password in plain text. Passwords belong in the Vault, never in a skill.', n);
      else if (pw === 'warn') add('warn', 'secret', 'Sets a password in plain text (it looks like an example value); check it is not a real one.', n);
    }
  });

  // HTML comments (they don't show when Markdown is rendered), which can span lines.
  if (kind === 'markdown') {
    const re = /<!--([\s\S]*?)-->/g;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      if (!COMMENT_INSTRUCTION.test(m[1]!)) continue;
      const line = body.slice(0, m.index).split(/\r?\n/).length;
      add('block', 'hidden-instructions', `Hides instructions in an HTML comment, which doesn't show when the text is displayed: "${excerpt(m[1]!)}".`, line);
    }
  }
  return findings;
}

// ---- frontmatter ---------------------------------------------------------------------------------

export interface ItemHeader {
  name: string;
  description: string;
  kind: 'skill' | 'agent';
  castes: string[];
}

/** Read the frontmatter fields the library needs (name, description, castes), or null when there is none. */
export function readHeader(md: string, kind: 'skill' | 'agent'): ItemHeader | null {
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1];
  if (fm === undefined) return null;
  const field = (key: string): string => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
    if (!m) return '';
    let v = m[1]!.trim();
    // A folded or literal block: the indented lines after it.
    if (/^[>|][+-]?$/.test(v)) {
      const rest = fm.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
      const block: string[] = [];
      for (const l of rest) {
        if (!/^\s+\S/.test(l)) break;
        block.push(l.trim());
      }
      v = block.join(' ');
    }
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    return v.trim();
  };
  const castesRaw = /^\s+castes:\s*\[([^\]]*)\]/m.exec(fm)?.[1] ?? '';
  return {
    name: field('name'),
    description: field('description'),
    kind,
    castes: castesRaw
      .split(',')
      .map((c) => c.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean),
  };
}

// ---- scanning a folder ---------------------------------------------------------------------------

export interface FolderScan extends ScanResult {
  /** The item's header, when its main file could be read. */
  header: ItemHeader | null;
  /** 'SKILL.md' or 'AGENT.md' (null when neither is there). */
  mainFile: string | null;
}

const verdictOf = (findings: readonly ScanFinding[]): ScanResult['verdict'] =>
  findings.some((f) => f.severity === 'block') ? 'blocked' : findings.length ? 'warn' : 'clean';

/**
 * Scan a whole item folder: every file (symbolic links and oversized or binary files are findings, not
 * followed or read), plus the format of its SKILL.md or AGENT.md. `expectedName` (the folder's own name)
 * is only checked when given.
 */
export function scanFolder(dir: string, opts: { expectedName?: string; now?: () => number } = {}): FolderScan {
  const findings: ScanFinding[] = [];
  const add = (severity: ScanSeverity, rule: ScanRule, message: string, file: string, line: number | null = null): void => {
    findings.push({ severity, rule, message, file, line });
  };
  const files: string[] = [];
  let total = 0;
  const walk = (d: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      add('block', 'format', 'The folder could not be read.', relative(dir, d).replace(/\\/g, '/') || '.');
      return;
    }
    for (const e of entries.sort()) {
      const full = join(d, e);
      const rel = relative(dir, full).replace(/\\/g, '/');
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        add('block', 'format', 'Is a link to somewhere else on the computer; items must hold real files only.', rel);
        continue;
      }
      if (st.isDirectory()) {
        if (depth >= 4) add('block', 'format', 'Folders are nested too deeply.', rel);
        else walk(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      files.push(rel);
      total += st.size;
      if (files.length > SCAN_LIMITS.maxFiles) continue;
      const ext = extname(e).toLowerCase();
      if (EXECUTABLE_EXT.has(ext)) {
        add('block', 'risky-script', 'Is a program file; skills and agents must be readable text.', rel);
        continue;
      }
      if (st.size > SCAN_LIMITS.maxFileBytes) {
        add('block', 'format', `Is too big to check (${Math.round(st.size / 1024)} KB; the limit is ${SCAN_LIMITS.maxFileBytes / 1024} KB).`, rel);
        continue;
      }
      const buf = readFileSync(full);
      if (buf.subarray(0, 8192).includes(0)) {
        if (!IMAGE_EXT.has(ext)) add('block', 'format', "Is a binary file the scanner can't read.", rel);
        continue;
      }
      findings.push(...scanText(rel, buf.toString('utf8')));
    }
  };
  walk(dir, 0);
  if (files.length > SCAN_LIMITS.maxFiles) add('block', 'format', `Holds too many files (${files.length}; the limit is ${SCAN_LIMITS.maxFiles}).`, '.');
  if (total > SCAN_LIMITS.maxTotalBytes) add('block', 'format', `Is too big altogether (${Math.round(total / 1024)} KB; the limit is ${SCAN_LIMITS.maxTotalBytes / 1024} KB).`, '.');

  // Format: exactly one main file with valid frontmatter (library/FORMAT.md).
  const hasSkill = files.includes('SKILL.md');
  const hasAgent = files.includes('AGENT.md');
  let header: ItemHeader | null = null;
  let mainFile: string | null = null;
  if (hasSkill && hasAgent) add('block', 'format', 'Has both SKILL.md and AGENT.md; an item is one or the other.', '.');
  else if (!hasSkill && !hasAgent) add('block', 'format', 'Has no SKILL.md or AGENT.md at the top of the folder.', '.');
  else {
    mainFile = hasSkill ? 'SKILL.md' : 'AGENT.md';
    let md = '';
    try {
      md = readFileSync(join(dir, mainFile), 'utf8');
    } catch {
      // Reported below as missing frontmatter.
    }
    header = readHeader(md, hasSkill ? 'skill' : 'agent');
    if (!header) add('block', 'format', 'Has no frontmatter (the --- block with name and description at the top).', mainFile, 1);
    else {
      if (!header.name) add('block', 'format', 'Its frontmatter has no name.', mainFile, 1);
      else if (!NAME_RE.test(header.name)) add('block', 'format', `Its name "${excerpt(header.name)}" must be lowercase letters, digits and hyphens.`, mainFile, 1);
      else if (opts.expectedName && header.name !== opts.expectedName) add('warn', 'format', `Its name "${header.name}" differs from its folder "${opts.expectedName}"; the name is used.`, mainFile, 1);
      if (!header.description) add('block', 'format', 'Its frontmatter has no description (what it does and when to use it).', mainFile, 1);
      else if (header.description.length > SCAN_LIMITS.maxDescription) add('warn', 'format', `Its description is long (${header.description.length} characters; keep it under ${SCAN_LIMITS.maxDescription}).`, mainFile, 1);
    }
  }
  findings.sort((a, b) => Number(a.severity === 'warn') - Number(b.severity === 'warn') || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  return { verdict: verdictOf(findings), findings, scannedAt: (opts.now ?? Date.now)(), header, mainFile };
}

/** The folder name an item should live in, from its header (or the folder it came from). */
export const itemFolderName = (scan: FolderScan, dir: string): string => scan.header?.name && NAME_RE.test(scan.header.name) ? scan.header.name : basename(dir);
