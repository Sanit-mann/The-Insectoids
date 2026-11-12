# Condition-Based Waiting

Load when tests are flaky, time out under parallel runs, or contain arbitrary sleeps.

Fixed delays guess how long something takes. They pass on a fast machine and fail under load or in CI. Wait for the condition you actually care about.

## When to use

- Tests contain `setTimeout`, `sleep`, `time.sleep()` or similar before an assertion.
- Tests pass sometimes and fail under load.
- Tests wait for async work to complete.

Not when testing timing itself (debounce, throttle, intervals). Then a fixed wait is correct, but document why.

## Pattern

```typescript
// Before: guessing
await new Promise(r => setTimeout(r, 50));
expect(getResult()).toBeDefined();

// After: waiting for the condition
await waitFor(() => getResult() !== undefined, 'result to be set');
expect(getResult()).toBeDefined();
```

| Waiting for | Condition |
|---|---|
| An event | `() => events.find(e => e.type === 'DONE')` |
| A state | `() => machine.state === 'ready'` |
| A count | `() => items.length >= 5` |
| A file | `() => fs.existsSync(path)` |

Generic helper (most test frameworks ship an equivalent; prefer the framework's):

```typescript
async function waitFor<T>(
  condition: () => T | undefined | null | false,
  description: string,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  while (true) {
    const result = condition();
    if (result) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}
```

## Common mistakes

- Polling too fast (every 1 ms) wastes CPU. About 10 ms is fine.
- No timeout: the test hangs forever. Always time out with a clear message naming what was awaited.
- Stale data: reading state once before the loop. Call the getter inside the loop.

## When a fixed wait is correct

```typescript
await waitForEvent(manager, 'TOOL_STARTED'); // first wait for the trigger
await new Promise(r => setTimeout(r, 200));   // then 2 ticks of a known 100 ms interval
```

Requirements: wait for the triggering condition first, base the duration on known timing (not a guess), and comment why.
