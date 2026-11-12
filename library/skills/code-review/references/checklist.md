# Code Review Checklist (full)

Load when you want the detailed checklist, examples, or the list of common false positives. The confidence gate in SKILL.md still applies to every item: no exact line and concrete failure, no finding.

## Critical: security

- **Hardcoded credentials:** API keys, passwords, tokens, connection strings in source. Report the location only; never paste the secret value.
- **SQL / NoSQL injection:** string concatenation or interpolation in queries.
- **Command injection:** user input reaching a shell.
- **XSS:** unescaped user input rendered as HTML.
- **Path traversal:** user-controlled file paths without resolve-and-prefix checks.
- **CSRF:** state-changing endpoints without CSRF protection where cookies authenticate.
- **Authentication or authorization bypass:** protected routes or operations without checks.
- **Insecure dependencies:** known-vulnerable packages added or kept.
- **Sensitive data in logs:** tokens, passwords, personal data.

```typescript
// Bad: injection via interpolation
const q = `SELECT * FROM users WHERE id = ${userId}`;
// Good: bound parameter
const result = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
```

## Critical / high: correctness and data

- Data loss or corruption: missing transaction around multi-step writes, overwrite of concurrent changes, destructive migration without a safe path.
- Race conditions and deadlocks: check-then-act without a lock, shared mutable state across async work.
- Broken API contracts: changed response shape, removed field, changed status codes without versioning.
- Missing error handling on critical paths: unhandled promise rejections, empty catch blocks, errors swallowed and replaced with defaults.
- Requirement mismatch: planned behavior missing, or a deviation the card did not ask for. Flag it so the author can confirm intent. If the plan itself looks wrong, say so.

## High: quality

- Large functions doing several things; large files mixing responsibilities.
- Deep nesting (more than 4 levels): early returns, extracted helpers.
- Mutation of shared or input data where the codebase expects immutability.
- Debug output left in (`console.log`, `print`).
- Missing tests for new code paths.
- Dead code: commented-out blocks, unused imports, unreachable branches.

```typescript
// Bad: deep nesting and mutation of inputs
function processUsers(users) {
  if (users) { for (const u of users) { if (u.active) { if (u.email) { u.verified = true; out.push(u); } } } }
  return out;
}
// Good: flat, no input mutation
function processUsers(users) {
  if (!users) return [];
  return users.filter(u => u.active && u.email).map(u => ({ ...u, verified: true }));
}
```

## High: backend

- Request body or params used without schema validation.
- Public or expensive endpoints without rate limiting.
- Unbounded queries (no limit, no pagination) on user-facing endpoints.
- N+1 queries: related data fetched in a loop instead of a join or batch.
- External HTTP calls without timeouts.
- Internal error details (stack traces, SQL) returned to clients.
- CORS open to unintended origins.

## Medium: performance

- Quadratic algorithms where a map or sort gives linear or n log n, on data that can grow.
- Repeated expensive computation without caching.
- Whole-library imports where a tree-shakeable import exists (frontend bundles).
- Unoptimized large images, no lazy loading (frontend).
- Synchronous or blocking I/O inside async code.

## Low: practices

- TODO / FIXME without a tracking reference.
- Public API without documentation, where the project documents its public API.
- Single-letter or vague names in non-trivial logic.
- Unexplained magic numbers that are not obvious.

## AI-generated changes: look harder at

1. Behavioral regressions and edge-case handling.
2. Security assumptions and trust boundaries.
3. Hidden coupling or accidental architecture drift.
4. Needless complexity: extra abstraction layers, options nobody asked for, code that will cost more model calls or tokens to run or maintain.

## Common false positives: skip unless you have evidence

- "Add error handling" where the caller, framework middleware, an error boundary or an upstream `.catch` already handles it.
- "Missing input validation" on an internal function whose callers validate. Trace at least one caller first.
- "Magic number" for well-known values: HTTP status codes, 1000 ms, 60, 24, 1024, index 0 or -1, single-use constants named clearly.
- "Function too long" for exhaustive switches, configuration objects, test tables or generated code.
- "Missing doc comment" on small internal helpers with self-describing names.
- "Prefer const" on a variable that is reassigned later.
- "Possible null dereference" when a guard or type narrowing is in scope.
- "N+1 query" on fixed small loops (a 4-value enum) or already-batched paths.
- "Missing await" on deliberate fire-and-forget calls (logging, metrics, queue push) marked as such.
- "Should use TypeScript / types" in a plain JavaScript project.
- "Hardcoded value" in tests, fixtures, examples or docs. Tests should hardcode expectations.
- Security theater: non-cryptographic `Math.random()` (jitter, animation, sampling); `eval` in a surface that is explicitly a code loader.
- Example env files (`.env.example`) and clearly marked test credentials.

## Project conventions

Read the project's own rules (contributing guide, lint config, agent instruction files, the Brain's notes for this repo) and match them: file size limits, immutability, error-handling patterns, state management, database policies. When in doubt, match what the rest of the codebase does.
