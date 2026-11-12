---
name: error-handling
description: Language-neutral error handling. Classifying failures, where to catch, typed errors, propagating with context, API error responses, logging once, user vs developer messages, timeouts, retries with backoff, circuit breakers and fallbacks. Use when designing error types, adding try/catch, retries or fallbacks, mapping errors to HTTP responses, or reviewing code for silent failures.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [errors, reliability, api, resilience]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/error-handling/SKILL.md
      license: MIT
---

# Error Handling

Every failure is either handled on purpose or reported loudly, with enough context to fix it and nothing a user should not see.

## When to use

- Designing error types or an exception hierarchy for a module or service.
- Writing `try/catch`, retries, fallbacks or timeouts around I/O.
- Mapping errors to HTTP or RPC responses, or to messages in a UI.
- Reviewing code for swallowed errors, cascading failures or leaky messages.

Language examples: [references/typescript.md](references/typescript.md), [references/python.md](references/python.md). Framework specifics: fastapi-patterns, django-patterns.

## Principles

1. **Fail fast at the source.** Validate inputs at the boundary and raise immediately; do not carry bad state forward.
2. **Errors are typed values.** A stable machine-readable code plus a message, not a bare string.
3. **Handle where you can act.** Catch only when this layer can recover, add context, translate, or clean up.
4. **Never swallow.** Every `catch` handles, re-throws (with context) or reports. An empty `catch` is a bug.
5. **Users and developers get different messages.** Users get safe, actionable text; logs get the full detail.
6. **Errors are part of the contract.** Document the codes and statuses a caller can receive.

## Classify the failure first

| Kind | Examples | Response |
|---|---|---|
| Expected domain outcome | not found, validation failed, conflict, not permitted, insufficient funds | Typed error or result value; mapped to a 4xx / user message; log at info or not at all |
| Transient infrastructure | timeout, connection reset, 503, 429, deadlock/serialization failure | Retry with backoff if the operation is safe to repeat; otherwise fail with a clear upstream error (502/503/504) |
| Programmer bug | null dereference, broken invariant, type error | Do not catch locally; let it reach the boundary handler, return 500, log with stack, fix the code |
| Fatal environment | missing config, cannot bind port | Exit at startup with a clear message |

## Where to catch

- **Boundaries:** HTTP/RPC handler, job or message consumer, CLI entry point, scheduled task, UI error boundary. Each has one catch-all that logs the unexpected error and returns a safe generic failure.
- **Inside the code**, catch only to:
  - translate a low-level error into a domain error (`IntegrityError` → `EmailTaken`), chaining the cause;
  - add context the caller lacks (which file, which id);
  - release resources (prefer `finally`, `with`, `using`, `defer`);
  - recover with a real, correct fallback.
- Keep `try` blocks small so you know which call failed.

## Designing error types

- One base error per application or package with: `code` (stable string such as `NOT_FOUND`), `message`, optional `details` (field errors), and the original `cause`.
- Subclass only for conditions callers handle differently. Keep the hierarchy shallow.
- Domain errors do not know about HTTP. Map to status codes at the edge:

| Code | HTTP |
|---|---|
| `VALIDATION_ERROR` | 400 or 422 (pick one per API) |
| `UNAUTHENTICATED` | 401 |
| `FORBIDDEN` | 403 (or 404 to avoid revealing existence) |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `RATE_LIMITED` | 429 with `Retry-After` |
| upstream failure / timeout | 502 / 503 / 504 |
| anything unexpected | 500 |

- **Exceptions vs result values:** use exceptions (or the language's error return) for failures the immediate caller usually cannot handle. Use a result/union type where failure is common and the caller must decide (parsing, validation, lookups), so the type system forces the check. Follow the codebase's existing style.

## Propagating

- Chain the cause when wrapping (`raise X from e`, `new Error(msg, { cause })`, `fmt.Errorf("...: %w", err)`), so the original stack survives.
- Add context once per layer, in words that help: "loading invoice 42 from billing API" beats "error occurred".
- **Log once**, at the boundary that handles it. Log-and-rethrow at every layer creates duplicate noise.
- Never include secrets, tokens, passwords or full personal data in messages or logs; include ids and the operation.

## API error responses

- One consistent shape per API, for example `{"error": {"code", "message", "details"?, "request_id"}}`, or RFC 9457 Problem Details (`application/problem+json`). Do not mix shapes.
- Validation errors list each field and reason.
- 5xx responses carry a generic message and the request id, never stack traces, SQL, file paths or internal hostnames.
- Return the request id to clients so support can find the log entry.

## Logging

- Unexpected errors: level error, with stack trace, request id, operation and relevant ids.
- Expected 4xx outcomes: info or debug (or metrics), not error, or alerts become noise.
- Count errors by code in metrics; alert on rate changes, not single events.

## Timeouts

- Every network call, query and lock wait has a timeout. Libraries often default to none or to minutes.
- Propagate a deadline or cancellation through the call chain (cancellation tokens, abort signals, context deadlines) so work stops when the caller has given up.
- The sum of retries and timeouts must fit inside the caller's own timeout.

## Retries

Retry only when **both** hold: the failure is transient, and repeating the operation is safe (reads, idempotent writes, or writes carrying an idempotency key).
- Exponential backoff with jitter (full jitter: random delay between 0 and `base * 2^attempt`, capped).
- Cap attempts (typically 3–5) and total elapsed time.
- Honour `Retry-After` on 429/503.
- Never retry other 4xx; they will fail again.
- Retry at one layer only; retries at several layers multiply load during an outage.
- Log each retry at debug/warn with attempt number; report the final failure with the last cause.
- Prefer a maintained retry library over hand-rolled loops when the project has one.

## Circuit breakers and fallbacks

- When a dependency keeps failing, a circuit breaker stops calling it for a cool-down (open), then lets a few trial calls through (half-open), and closes again on success. This protects both the dependency and your own threads/connections. Use a maintained library.
- A fallback (cached value, default, degraded feature) is allowed only if it is correct for the user. Make degraded mode visible in logs and metrics.
- Never fake success: do not return empty lists, zeros or `true` to hide a failure the caller needs to know about.
- Bulkheads: separate pools or concurrency limits per dependency so one slow service cannot exhaust everything.

## Async and concurrency pitfalls

- Every promise/task is awaited or explicitly supervised. Fire-and-forget work loses its errors; if you must detach, attach an error handler that logs.
- Choose deliberately between fail-fast group operations (`Promise.all`, task groups) and collect-all (`Promise.allSettled`, `gather(return_exceptions=True)`), and inspect every result in the latter.
- Install a process-level handler for unhandled rejections/exceptions that logs and exits; it is a last resort, not a strategy.

## User-facing messages

- Map error codes to plain-language messages: what happened and what the user can do next ("Please sign in again", "Try again in a minute").
- Never show stack traces, raw upstream messages or ids of internal systems. Showing the request id as a "reference" is fine.
- In UIs, catch render errors with an error boundary and show a fallback with a retry action.

## Review checklist

- [ ] No empty or log-only `catch` that continues as if nothing happened.
- [ ] Catches are narrow; broad catch-alls exist only at boundaries.
- [ ] Wrapped errors keep their cause.
- [ ] Each error is logged once, with context and without secrets.
- [ ] API errors use the project's single envelope and correct status codes.
- [ ] Network calls have timeouts; retries only for transient, idempotent operations, with backoff and a cap.
- [ ] No fallback hides a failure the caller needs to see.
- [ ] Promises/tasks are awaited or supervised.
- [ ] Error paths are covered by tests (forced failures, timeouts, bad input).

## Done when

- Each failure mode of the changed code is classified, handled at the right layer, and covered by a test.
- Users see safe messages; logs have enough context to diagnose without reproducing.
