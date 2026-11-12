# Root Cause Tracing

Load when an error shows up deep in a call chain and it is unclear where the bad value came from.

Bugs often surface far from their cause: a command runs in the wrong directory, a file lands in the wrong place, a database opens with the wrong path. The instinct is to patch where the error appears. That treats a symptom.

**Principle:** trace backward through the call chain to the original trigger, fix it there, then consider guards at each layer.

## The process

1. **Observe the symptom.** Example: `git init failed in ~/project/packages/core`.
2. **Find the immediate cause.** The line that directly does it: `execFile('git', ['init'], { cwd: projectDir })`.
3. **Ask what called it, and with what value.**
   ```
   WorktreeManager.createSessionWorktree(projectDir, sessionId)
     <- Session.initializeWorkspace()
     <- Session.create()
     <- test calling Project.create()
   ```
4. **Keep tracing up.** `projectDir` was `''`. An empty `cwd` falls back to the process working directory, which was the source tree.
5. **Find the original trigger.** The test read `context.tempDir` before the setup hook ran, so it was still `''`.

Fix at the source (here: make `tempDir` throw if read before setup). Then add guards at the layers in between (see defense-in-depth.md).

## When you cannot trace by reading

Add instrumentation just **before** the dangerous operation, not after it fails:

```typescript
async function gitInit(directory: string) {
  console.error('DEBUG git init', {
    directory,
    cwd: process.cwd(),
    env: process.env.NODE_ENV,
    stack: new Error().stack,
  });
  await execFile('git', ['init'], { cwd: directory });
}
```

- In tests, write to stderr directly; a configured logger may be silenced.
- Include the inputs, the working directory, relevant environment and a stack trace.
- Run, filter the output for your marker, and read the stacks: which test file, which line, which parameter repeats.
- Remove the instrumentation before submitting.

## Finding which test causes pollution

If a stray artifact (file, directory, global state) appears during a test run but you do not know which test makes it: run the test files one at a time, check for the artifact after each, and stop at the first that creates it. For long lists, bisect (run half, check, narrow down).

## Rule

Never fix only where the error appears when you can trace one more level up. If you truly hit a dead end, fix at the symptom, document the dead end, and add instrumentation so the next occurrence is traceable.
