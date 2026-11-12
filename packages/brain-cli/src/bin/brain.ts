/**
 * The `brain` command. Bundled to dist/brain.mjs; insects reach it through the shims in
 * shims.ts, which the hive puts first on their PATH together with INSECTOIDS_BRAIN_* variables.
 */
import { BrainClient } from '@insectoids/brain-service/client';
import { runCli } from '../cli';
import { cmdShimArgs } from '../shims';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

// Started through brain.cmd: the arguments arrive raw in BRAIN_SHIM_ARGS (see shims.ts).
const argv = cmdShimArgs(process.env) ?? process.argv.slice(2);

process.exitCode = await runCli(argv, {
  connect: () => BrainClient.fromEnv(),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin,
  stdinIsTTY: process.stdin.isTTY === true,
});
