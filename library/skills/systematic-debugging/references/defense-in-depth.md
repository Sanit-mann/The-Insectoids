# Defense in Depth

Load after finding a root cause that involved invalid data, to decide where else to add checks.

One validation point feels sufficient, but other code paths, refactors and mocks can bypass it. Validate at each layer the data passes through so the bug becomes structurally impossible, not just fixed once.

## The four layers

**1. Entry point validation.** Reject obviously invalid input at the boundary (API handler, public function, CLI parser).

```typescript
function createProject(name: string, workingDirectory: string) {
  if (!workingDirectory?.trim()) throw new Error('workingDirectory cannot be empty');
  if (!existsSync(workingDirectory)) throw new Error(`workingDirectory does not exist: ${workingDirectory}`);
  if (!statSync(workingDirectory).isDirectory()) throw new Error(`not a directory: ${workingDirectory}`);
  // ...
}
```

**2. Business logic validation.** Check the data makes sense for this specific operation.

```typescript
function initializeWorkspace(projectDir: string, sessionId: string) {
  if (!projectDir) throw new Error('projectDir required for workspace initialization');
  // ...
}
```

**3. Environment guards.** Refuse dangerous operations in contexts where they should never happen.

```typescript
async function gitInit(directory: string) {
  if (process.env.NODE_ENV === 'test') {
    const dir = normalize(resolve(directory));
    if (!dir.startsWith(normalize(resolve(tmpdir())))) {
      throw new Error(`Refusing git init outside temp dir during tests: ${directory}`);
    }
  }
  // ...
}
```

**4. Debug instrumentation.** Log context before the risky operation so the next failure is easy to trace.

## Applying it

1. Trace the data flow: where the bad value starts and everywhere it is used.
2. List every checkpoint it passes through.
3. Add the cheapest meaningful check at each layer.
4. Test each layer: bypass layer 1 on purpose and confirm layer 2 catches it.

Keep it proportionate: guards belong on paths where bad data causes real damage (wrong directory, data loss, security). Do not wrap every internal helper in redundant checks.
