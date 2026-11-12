---
name: backend-patterns
description: Node.js/TypeScript server structure - handler/service/repository layers, edge validation, typed errors and a central handler, auth boundaries, data access (N+1, transactions, pooling), caching, durable jobs, outbound timeouts and retries, logging and graceful shutdown. Use when building or reviewing server code, API handlers or workers in Node/TypeScript.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [backend, nodejs, typescript, architecture, security]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/backend-patterns/SKILL.md
      license: MIT
---

# Backend Patterns

Keep HTTP, business rules and storage in separate layers; validate and authorize at the right boundary; make failure, retries and restarts safe. Framework-neutral (Express, Fastify, Hono, Nest, Next.js route handlers). Code: [references/examples.md](references/examples.md).

## When to use

- Adding or changing endpoints, services, repositories, middleware or workers.
- Adding caching, background jobs, retries or rate limiting.
- Reviewing server code for auth gaps, N+1 queries, leaked errors or unsafe restarts.

Related: HTTP contract details (status codes, error bodies, pagination, idempotency keys) are in `api-design`. Type-level rules are in `typescript-patterns`. Abuse-case and vulnerability review is in `security-review`.

## 1. Layers

| Layer | Does | Never does |
|---|---|---|
| Handler / route | Parse and validate input, authenticate, call one service method, map the result or error to HTTP | Business rules, SQL |
| Service | Business rules, authorization decisions on resources, transactions, orchestration | Read `req`/`res`, know about HTTP |
| Repository / adapter | Queries, external API calls, mapping rows to domain types | Business decisions |

- Dependencies point inward: handler -> service -> repository interface. Inject dependencies (constructor or factory) so tests can swap them.
- Keep framework and ORM types out of service signatures. Services take and return plain domain types and DTOs.
- A thin app may merge service and repository; never merge the handler with SQL.

## 2. Validation at the edge

- Validate **body, query, path params and headers** with a schema in the handler. Downstream code receives typed, trusted data.
- Validate **environment and config at startup** and fail fast on missing or malformed values.
- On writes, reject or strip unknown fields so clients cannot set `role`, `ownerId` or `isAdmin` by mass assignment.
- Cap request body size and array lengths; bound pagination `limit`.
- Always use parameterized queries or the query builder's bindings. Never build SQL, shell commands or file paths from raw input.

## 3. Errors

- Define a small set of **typed application errors** (`NotFound`, `Conflict`, `ValidationFailed`, `Unauthorized`, `Forbidden`, `RateLimited`), each with a stable code and an HTTP status mapping.
- Throw them from services; translate to HTTP in **one central error handler** (middleware or a wrapper).
- Operational errors (bad input, missing record, upstream timeout) get a clean response. Programmer errors (bugs) get a generic 500, a full log with the request ID, and an alert.
- Never return stack traces, SQL messages or internal hostnames to clients.
- Preserve causes when wrapping (`new AppError(msg, { cause })`).
- Process-level: log `unhandledRejection` and `uncaughtException`, then exit and let the supervisor restart. Do not keep running in an unknown state.

## 4. Authentication and authorization

- **Authenticate once** in middleware; attach a typed principal (user id, tenant id, roles or scopes) to the request context.
- **Authorize per resource, in the service**, after loading it: check ownership or tenant on every read and write by id. Missing object-level checks (IDOR/BOLA) are the most common API vulnerability.
- Deny by default. Every route is authenticated unless explicitly marked public.
- JWTs: verify signature with a pinned algorithm list, plus issuer, audience and expiry. Keep access tokens short-lived. Never trust claims from an unverified token.
- Sessions in cookies: `HttpOnly`, `Secure`, `SameSite`, and CSRF protection for cookie-authenticated state-changing requests.
- RPC-style endpoints (Server Actions, tRPC procedures, webhooks) are public endpoints: authenticate, authorize and validate inside each. Verify webhook signatures.
- Secrets come from the environment or a secret manager, never from source code or logs.

## 5. Data access

- Select only the needed columns; always paginate list queries.
- Kill **N+1 queries**: batch by ids (`WHERE id IN (...)`), join, or use a per-request batching loader.
- Use **transactions** for multi-write invariants. Keep them short and never make network calls inside one.
- Use one pooled client per process; size the pool for the database's connection limit across all instances (serverless needs an external pooler).
- Index the columns you filter, join and sort on; check slow queries with the query plan.
- Schema changes go through migrations that stay compatible with the running code (expand, migrate, then contract).

## 6. Caching

- Cache-aside: read the cache, on miss load and store with a TTL, invalidate or overwrite on write.
- **The cache key includes everything that changes the result**: tenant, user or permission scope, locale, query params. A missing dimension leaks data between users.
- Protect hot keys from stampedes (single-flight per key, or stale-while-revalidate).
- In-process caches suit immutable or rarely changing data only; they diverge across instances. Use a shared cache for anything that must be consistent.
- Treat cache failures as misses, not errors.
- Set HTTP caching headers (`Cache-Control`, `ETag`) for public, cacheable GETs; `no-store` for personal data.

## 7. Background jobs

- Anything that must survive a restart or deploy goes to a **durable queue**, not an in-memory array or a fire-and-forget promise.
- Jobs are **idempotent** (safe to run twice) because queues deliver at least once.
- Retry with exponential backoff and jitter, cap attempts, and send exhausted jobs to a dead-letter queue with enough context to replay.
- Writing to the DB and publishing an event must not diverge: use the transactional outbox pattern (write the event row in the same transaction, publish from it).
- Give every job a timeout. Keep payloads small (ids, not full records).
- Long or CPU-heavy work runs in workers or worker threads, never on the request path's event loop.

## 8. Outbound calls

- Every outbound call has a **timeout** (abort signal). No timeout means a stuck dependency eventually stalls the whole service.
- Retry only **transient** failures (network errors, 429, 502, 503, 504) on **idempotent** operations, with exponential backoff and jitter, and honor `Retry-After`.
- Use a circuit breaker or bulkhead for flaky dependencies; fail fast with a clear error when open.
- Validate third-party responses like any other untrusted input.

## 9. Rate limiting

Use a shared store (Redis-like), the gateway or the platform's limiter. Per-process counters reset on deploy and split across replicas. Limit by user or API key, and by IP for anonymous routes. Signal limits with 429 and `Retry-After` (see `api-design`).

## 10. Observability

- **Structured JSON logs** with level, message, timestamp, request ID and principal ID. Use a fast structured logger, not string concatenation.
- Propagate a request or trace ID from the edge through services and jobs (async context storage).
- Never log secrets, tokens, passwords or full personal data; redact by default.
- Expose health (liveness) and readiness endpoints. Readiness fails when critical dependencies are down.
- Emit metrics for latency, error rate and saturation per route and per job type.

## 11. Runtime and lifecycle

- No request- or user-specific data in module-level mutable variables: requests run concurrently in one process.
- Do not block the event loop: no sync file or crypto calls on hot paths, no large `JSON.parse` in request handlers without limits.
- **Graceful shutdown** on SIGTERM: stop accepting new connections, finish in-flight requests and jobs within a deadline, close pools and queues, then exit.

## Red flags in review

- SQL or ORM calls inside route handlers; services reading `req`.
- Endpoint loads a record by id without an ownership or tenant check.
- `jwt.verify` without an algorithm list; tokens in query strings; secrets in code.
- Raw input spread into a create or update call; string-built SQL.
- Error responses containing `error.message` from the DB or a stack trace.
- `await` inside a loop issuing one query per item.
- In-memory job queues or rate-limit counters in production; retries without backoff or on non-idempotent calls.
- Outbound `fetch` without a timeout; `console.log` of request bodies.

## Done when

- Each endpoint: validated input, authenticated principal, resource-level authorization, typed errors through the central handler.
- No N+1 queries on the changed paths; multi-write invariants run in a transaction.
- Jobs are durable and idempotent; outbound calls have timeouts.
- Tests cover the authorization failure path, not just the happy path.
