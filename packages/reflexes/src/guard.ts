import path from 'node:path';
import {
  type PathContext,
  isGitInternals,
  isInside,
  linkedHit,
  looksLikePath,
  noGoHit,
  protectedReason,
  resolveIn,
} from './paths';
import { ParseError, SUBST, type Segment, parseCommand } from './shell';

/**
 * The command guard (Workspace & Safety 06-D5): a Watchdog reflex in plain code.
 * It decides the same way whatever the AI model wants. Three outcomes:
 *  - allow: ordinary work inside the card's workspace (auto mode);
 *  - ask:   needs the user's approval (Hive 02-D7: push, new dependency, publish, data loss, remote copy);
 *  - block: never allowed (delete outside the workspace, force-push, disk/system changes,
 *           download-and-run, privilege escalation, obfuscation, protected files).
 * It is one safety layer, not a sandbox: untrusted code runs in container mode (06-D4).
 */
export type GuardContext = PathContext;

export type Verdict =
  | { decision: 'allow' }
  | { decision: 'ask' | 'block'; rule: string; reason: string };

const ALLOW: Verdict = { decision: 'allow' };
const block = (rule: string, reason: string): Verdict => ({ decision: 'block', rule, reason });
const ask = (rule: string, reason: string): Verdict => ({ decision: 'ask', rule, reason });
const RANK = { allow: 0, ask: 1, block: 2 } as const;
const worst = (a: Verdict, b: Verdict): Verdict => (RANK[b.decision] > RANK[a.decision] ? b : a);

const platformOf = (ctx: GuardContext): 'win32' | 'posix' => ctx.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
const P = (ctx: GuardContext) => (platformOf(ctx) === 'win32' ? path.win32 : path.posix);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const PIPE_RUNNERS = new Set([...SHELLS, 'iex', 'invoke-expression', 'python', 'python3', 'node', 'perl', 'ruby']);
const PRIVILEGE = new Set(['sudo', 'doas', 'su', 'runas', 'gsudo', 'pkexec']);
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'command', 'exec', 'env', 'xargs', 'stdbuf', 'timeout']);
const DELETERS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'unlink', 'shred']);
const DEST_LAST = new Set(['cp', 'mv', 'copy', 'move', 'xcopy', 'robocopy', 'copy-item', 'move-item', 'cpi', 'mi', 'ln', 'install', 'rename-item', 'ren']);
const DEST_ALL = new Set(['tee', 'touch', 'mkdir', 'md', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer', 'logoff']);
const SYSTEM = new Set(['diskpart', 'fdisk', 'parted', 'regedit', 'bcdedit', 'set-executionpolicy', 'setx', 'netsh', 'launchctl', 'iptables', 'ufw', 'chattr', 'csrutil', 'set-itemproperty', 'new-itemproperty']);
const SCHEDULERS = new Set(['crontab', 'schtasks', 'at', 'register-scheduledtask']);
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'mongo', 'mongosh', 'duckdb', 'cockroach']);
const REMOTE = new Set(['scp', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'telnet', 'ssh']);
/** git subcommands that create commits or move branches: only the harness does these in a card workspace. */
const HIVE_OWNED_GIT: ReadonlySet<string> = new Set([
  'commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull', 'commit-tree', 'update-ref', 'switch',
]);

const PUBLISH_TOOLS: Array<[string, RegExp]> = [
  ['npm', /^(publish|unpublish|deprecate)$/],
  ['pnpm', /^publish$/],
  ['yarn', /^(publish|npm)$/],
  ['bun', /^publish$/],
  ['twine', /^upload$/],
  ['cargo', /^(publish|yank)$/],
  ['gem', /^(push|yank)$/],
  ['docker', /^push$/],
  ['podman', /^push$/],
  ['firebase', /^deploy$/],
  ['fly', /^deploy$/],
  ['flyctl', /^deploy$/],
];
const INSTALLERS: Array<[string, RegExp]> = [
  ['npm', /^(install|i|add|isntall)$/],
  ['pnpm', /^(add|install|i)$/],
  ['yarn', /^add$/],
  ['bun', /^(add|install|i)$/],
  ['pip', /^install$/],
  ['pip3', /^install$/],
  ['uv', /^(add|pip)$/],
  ['poetry', /^add$/],
  ['cargo', /^(add|install)$/],
  ['go', /^(get|install)$/],
  ['gem', /^install$/],
  ['composer', /^require$/],
  ['brew', /^install$/],
  ['apt', /^install$/],
  ['apt-get', /^install$/],
  ['dnf', /^install$/],
  ['yum', /^install$/],
  ['pacman', /^-S/],
  ['choco', /^install$/],
  ['winget', /^install$/],
  ['scoop', /^install$/],
];

const commandName = (w: string): string => w.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
const isFlag = (w: string, win: boolean): boolean => w.startsWith('-') || (win && /^\/[a-z?]{1,3}(:\S*)?$/i.test(w));

export function evaluateCommand(command: string, ctx: GuardContext, depth = 0): Verdict {
  if (depth > 4) return block('obfuscation', 'Too many nested shells to check safely.');
  let parsed;
  try {
    parsed = parseCommand(command, platformOf(ctx));
  } catch (err) {
    return ask('unparseable', `The guard could not read this command safely (${err instanceof ParseError ? err.message : 'parse error'}).`);
  }
  let verdict: Verdict = ALLOW;
  for (const inner of parsed.nested) verdict = worst(verdict, evaluateCommand(inner, ctx, depth + 1));
  for (const seg of parsed.segments) verdict = worst(verdict, checkSegment(seg, ctx, depth));
  return verdict;
}

function checkSegment(seg: Segment, ctx: GuardContext, depth: number): Verdict {
  const win = platformOf(ctx) === 'win32';
  let words = [...seg.words];
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  let name = commandName(words[0] ?? '');
  if (PRIVILEGE.has(name)) return block('privilege-escalation', `"${name}" runs commands with elevated rights; insects never do that.`);
  while (WRAPPERS.has(name) && words.length > 1) {
    words = words.slice(1);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || words[0]!.startsWith('-'))) words.shift();
    name = commandName(words[0] ?? '');
  }
  const args = words.slice(1);
  const lower = args.map((a) => a.toLowerCase());
  let v: Verdict = ALLOW;

  // The Brain CLI door: its arguments are text stored in the Brain, never paths it opens, so a title like
  // "keys live in ~/.ssh" is not a file access. Only the bare command (the shim the hive puts first on PATH)
  // gets this; a path-qualified "./brain" is any other program. Redirects are still checked below.
  const brainDoor = /^brain(\.cmd)?$/i.test(words[0] ?? '');

  // Every argument and redirect that looks like a path: protected files and no-go folders.
  for (const a of [...(brainDoor ? [] : args), ...seg.redirects]) {
    if (a.includes(SUBST) || !looksLikePath(a)) continue;
    const abs = resolveIn(a.replace(/^[A-Za-z]+=/, ''), ctx);
    const why = protectedReason(abs);
    if (why) v = worst(v, block('protected-path', `${a} is ${why}; insects never read or write it.`));
    else if (noGoHit(abs, ctx)) v = worst(v, block('no-go', `${a} is in a folder you marked no-go.`));
  }
  for (const r of seg.redirects) {
    if (/^(\/dev\/null|nul|\$null)$/i.test(r)) continue;
    v = worst(v, checkWrite(r, ctx));
  }

  // Interpreters fed from a pipe or a substitution: download-and-run or decode-and-run.
  if (seg.pipedFrom && PIPE_RUNNERS.has(name)) {
    return block('pipe-to-shell', `Piping into "${name}" runs code the guard cannot inspect (e.g. curl | bash).`);
  }
  if (SHELLS.has(name) && args.includes(SUBST)) {
    return block('pipe-to-shell', `"${name}" would run the output of another command, which the guard cannot inspect.`);
  }
  if (name === 'eval' || name === 'iex' || name === 'invoke-expression' || (name === 'source' && args.includes(SUBST))) {
    return block('obfuscation', `"${name}" runs text as code, which the guard cannot inspect.`);
  }
  if ((name === 'powershell' || name === 'pwsh') && lower.some((a) => /^-(e|ec|enc|encodedcommand)$/.test(a))) {
    return block('obfuscation', 'Encoded PowerShell commands cannot be inspected.');
  }

  // Nested shells: check the inner command too.
  if (SHELLS.has(name)) {
    const flagIdx = lower.findIndex((a) => a === '-c' || a === '/c' || a === '/k' || a === '-command' || a === '-c:');
    if (flagIdx >= 0 && args[flagIdx + 1] !== undefined) {
      return worst(v, evaluateCommand(args.slice(flagIdx + 1).join(' '), ctx, depth + 1));
    }
  }

  if (POWER.has(name)) return block('system-power', `"${name}" would shut down or restart the computer.`);
  if (SYSTEM.has(name)) return block('system-change', `"${name}" changes system settings.`);
  if (name.startsWith('mkfs') || (win && name === 'format' && args.some((a) => /^[A-Za-z]:$/.test(a)))) {
    return block('disk', 'Formatting a disk is never allowed.');
  }
  if (name === 'dd' && lower.some((a) => a.startsWith('of=/dev/'))) return block('disk', 'Writing raw data to a device is never allowed.');
  if (name === 'reg' && /^(add|delete|import|load|unload|restore)$/.test(lower[0] ?? '')) return block('system-change', 'Editing the Windows registry is never allowed.');
  if (name === 'sc' && win && /^(config|create|delete|stop|start)$/.test(lower[0] ?? '')) return block('system-change', 'Changing Windows services is never allowed.');
  if (name === 'systemctl' && /^(enable|disable|stop|start|restart|mask|unmask|edit)$/.test(lower[0] ?? '')) return block('system-change', 'Changing system services is never allowed.');
  if (name === 'sysctl' && lower.includes('-w')) return block('system-change', 'Changing kernel settings is never allowed.');
  if ((name === 'chmod' || name === 'chown' || name === 'icacls' || name === 'takeown') && args.some((a) => !isFlag(a, win) && looksLikePath(a) && !isInside(resolveIn(a, ctx), ctx.workspace, ctx))) {
    return block('system-change', `"${name}" on files outside the workspace is never allowed.`);
  }
  if (SCHEDULERS.has(name)) v = worst(v, ask('scheduled-task', `"${name}" creates or edits scheduled jobs on this computer.`));

  // Deleting.
  if (DELETERS.has(name)) {
    for (const t of args.filter((a) => !isFlag(a, win) && a !== SUBST)) {
      const abs = resolveIn(t, ctx);
      if (!isInside(abs, ctx.workspace, ctx) || P(ctx).relative(ctx.workspace, abs) === '') {
        v = worst(v, block('delete-outside', `Deleting ${t} reaches outside this card's workspace.`));
      } else if (linkedHit(abs, ctx)) {
        v = worst(v, block('delete-linked', `${t} is linked to your real files; deleting it here would delete them.`));
      }
    }
  }

  // Writing: copy/move destinations, mkdir/touch/tee targets.
  if (DEST_LAST.has(name) || DEST_ALL.has(name)) {
    const targets = args.filter((a) => !isFlag(a, win) && a !== SUBST);
    const writes = DEST_LAST.has(name) ? targets.slice(-1) : name === 'set-content' || name === 'add-content' || name === 'sc' || name === 'ac' || name === 'out-file' ? targets.slice(0, 1) : targets;
    for (const t of writes) v = worst(v, checkWrite(t, ctx));
  }

  // Links: an insect may not create a link that points outside its workspace (it could then write through it).
  if (name === 'ln' || name === 'mklink' || ((name === 'new-item' || name === 'ni') && lower.some((a) => /symboliclink|junction|hardlink/.test(a)))) {
    for (const t of args.filter((a) => !isFlag(a, win) && looksLikePath(a))) {
      if (!isInside(resolveIn(t, ctx), ctx.workspace, ctx)) {
        return block('link-outside', `A link to ${t} would point outside this card's workspace.`);
      }
    }
  }

  // git: global options may come before the subcommand (-C <dir>, -c k=v, --git-dir=...).
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) {
      const opt = args[i]!;
      if (opt === '-C' || opt === '--git-dir' || opt === '--work-tree') {
        const dir = args[i + 1] ?? '';
        if (!isInside(resolveIn(dir, ctx), ctx.workspace, ctx)) {
          return block('outside-repo', `git on ${dir} works on a repository outside this card's workspace.`);
        }
        i += 2;
      } else if (opt === '-c' || opt === '--namespace' || opt === '--exec-path') {
        i += 2;
      } else if (/^--(git-dir|work-tree)=/.test(opt)) {
        if (!isInside(resolveIn(opt.split('=')[1] ?? '', ctx), ctx.workspace, ctx)) {
          return block('outside-repo', `${opt} points outside this card's workspace.`);
        }
        i++;
      } else {
        i++;
      }
    }
    const sub = (args[i] ?? '').toLowerCase();
    const rest = args.slice(i + 1);
    const restLower = rest.map((a) => a.toLowerCase());
    // The harness is the single committer (Workspace 06): it commits each card with the hive identity and
    // Insect:/Card: trailers, then merges. An insect's own commits or branch moves would skip that trail.
    const newBranch = sub === 'checkout' && restLower.some((a) => /^(-b|-B|--orphan)$/i.test(a));
    if (HIVE_OWNED_GIT.has(sub) || newBranch) {
      return block('hive-commits', `"git ${sub}${newBranch ? ' -b' : ''}" is the hive's job: leave your changes uncommitted on this card's branch and the hive commits them with your name when you finish.`);
    }
    if (sub === 'push') {
      // Force-pushing or deleting remote refs rewrites shared history: blocked. Any push needs approval.
      if (restLower.some((a) => /^(--force|-f|--force-with-lease.*|--force-if-includes|--mirror|--delete|-d|--prune)$/.test(a)) || rest.some((a) => a.startsWith('+') || a.startsWith(':'))) {
        return block('force-push', 'Force-pushing or deleting remote branches rewrites shared history; never allowed.');
      }
      v = worst(v, ask('push', 'Pushing to a shared repository needs your approval.'));
    }
  }

  // Packages: new or global dependencies need approval; publishing too.
  for (const [tool, sub] of PUBLISH_TOOLS) {
    if (name === tool && sub.test(lower[0] ?? '')) v = worst(v, ask('publish', `"${tool} ${args[0]}" publishes outside this computer.`));
  }
  if (name === 'gh' && /^(release|pr)$/.test(lower[0] ?? '') && /^(create|merge|upload)$/.test(lower[1] ?? '')) v = worst(v, ask('publish', 'This changes things on GitHub.'));
  if ((name === 'vercel' || name === 'netlify') && lower.includes('--prod')) v = worst(v, ask('publish', 'This deploys to production.'));
  for (const [tool, sub] of INSTALLERS) {
    if (name !== tool || !sub.test(lower[0] ?? '')) continue;
    const pkgs = args.slice(1).filter((a) => !isFlag(a, win));
    const fromFile = lower.includes('-r') || lower.includes('--requirement') || lower.includes('-e') || lower.includes('--editable');
    if (lower.includes('-g') || lower.includes('--global') || lower.includes('--user')) v = worst(v, ask('global-install', 'Installing software for the whole computer needs your approval.'));
    else if (pkgs.length && !fromFile) v = worst(v, ask('new-dependency', `Adding ${pkgs.join(', ')} as a new dependency needs your approval.`));
  }

  // Databases: dropping, truncating or resetting data needs approval.
  const text = lower.join(' ');
  const usesPrisma = name === 'prisma' || lower.includes('prisma');
  if (
    (DB_CLIENTS.has(name) && /\b(drop\s+(database|table|schema|collection)|truncate|dropdatabase)\b/.test(text)) ||
    name === 'dropdb' ||
    (usesPrisma && /migrate reset|db push --force-reset/.test(text)) ||
    (/^(rails|rake)$/.test(name) && /db:(drop|reset|purge)/.test(text)) ||
    (lower.includes('manage.py') && /\bflush\b/.test(text)) ||
    (name === 'redis-cli' && /\b(flushall|flushdb)\b/.test(text))
  ) {
    v = worst(v, ask('database-destructive', 'This would delete or reset database data.'));
  }

  // Sending files off this computer.
  if (REMOTE.has(name) || (name === 'rsync' && args.some((a) => /^[^/\\]+@?[^/\\]*:/.test(a)))) {
    v = worst(v, ask('remote-transfer', `"${name}" connects to or copies files to another machine.`));
  }
  if ((name === 'curl' || name === 'wget') && lower.some((a) => /^(-t|--upload-file|-f|--form|--data-binary|-d|--data)$/.test(a)) && args.some((a) => a.includes('@'))) {
    v = worst(v, ask('remote-transfer', 'Uploading files to another machine needs your approval.'));
  }
  return v;
}

function checkWrite(target: string, ctx: GuardContext): Verdict {
  const abs = resolveIn(target, ctx);
  if (!isInside(abs, ctx.workspace, ctx)) return block('write-outside', `Writing ${target} reaches outside this card's workspace.`);
  if (linkedHit(abs, ctx)) return block('write-linked', `${target} is linked to your real files; insects can't change them.`);
  if (isGitInternals(abs, ctx)) return block('git-internals', `${target} is inside git's own folder; only the harness changes it.`);
  return ALLOW;
}

/** File tools (read, write, edit): protected files, no-go folders, and the workspace boundary for writes. */
export function evaluatePath(target: string, op: 'read' | 'write', ctx: GuardContext): Verdict {
  const abs = resolveIn(target, ctx);
  const why = protectedReason(abs);
  if (why) return block('protected-path', `${target} is ${why}; insects never read or write it.`);
  if (noGoHit(abs, ctx)) return block('no-go', `${target} is in a folder you marked no-go.`);
  return op === 'write' ? checkWrite(target, ctx) : ALLOW;
}
