/**
 * Claude Code PreToolUse hook process. Bundled to dist/guard-hook.mjs and registered per insect.
 * Reads the tool request on stdin and the insect's policy from INSECTOIDS_GUARD.
 * It must never crash: a crashed hook lets the tool run, so every failure path exits 2 (which blocks).
 */
import { fsRealpath, runHook } from '../hook';

function fail(reason: string): never {
  process.stderr.write(`Blocked by the Insectoids guard: ${reason}\n`);
  process.exit(2);
}

try {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (c: Buffer) => chunks.push(c));
  process.stdin.on('error', () => fail('could not read the tool request'));
  process.stdin.on('end', () => {
    try {
      const out = runHook(Buffer.concat(chunks).toString('utf8'), process.env, fsRealpath);
      process.stdout.write(out.stdout);
      process.exitCode = out.exitCode;
    } catch {
      fail('internal error');
    }
  });
} catch {
  fail('internal error');
}
