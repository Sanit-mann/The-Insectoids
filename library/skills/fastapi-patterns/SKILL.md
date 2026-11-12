---
name: fastapi-patterns
description: Build and review FastAPI services. Covers project layout, app factory and lifespan, pydantic-settings config, Pydantic v2 schemas, Annotated dependencies, thin routers over a service layer, async database sessions, auth (401 vs 403), error handlers and tests with httpx and dependency overrides. Use when creating or changing FastAPI endpoints, schemas, dependencies or their tests.
metadata:
  kind: skill
  castes: [coder, tester, reviewer]
  tags: [python, fastapi, api, pydantic]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/fastapi-patterns/SKILL.md
      license: MIT
---

# FastAPI Patterns

Thin routes, typed schemas at the edges, business logic in services, the database as the source of truth for constraints.

## When to use

- Adding or changing FastAPI routers, schemas, dependencies, middleware or startup code.
- Reviewing a FastAPI app for correctness, security or async mistakes.

Also load: python-patterns (general Python), python-testing (pytest), api-design (URL and status conventions), postgres-patterns (queries and schema).

## Layout

```text
app/
  main.py          # create_app(), lifespan, middleware, routers, exception handlers
  config.py        # Settings (pydantic-settings)
  database.py      # engine, session factory
  dependencies.py  # shared Depends + Annotated aliases
  routers/         # HTTP only: parse, call service, map result
  schemas/         # Pydantic request/response models
  models/          # ORM models
  services/        # business logic, transactions
tests/
```

Follow the project's existing layout if it differs.

## App factory and lifespan

- Build the app in `create_app()` so tests can make fresh instances.
- Use the `lifespan` async context manager for startup/shutdown (open clients, dispose the engine). `@app.on_event` is deprecated.
- Do not call `Base.metadata.create_all()` at startup outside throwaway demos. Manage schema with migrations (Alembic); see reversible-migration.

## Configuration

- One `Settings(BaseSettings)` class; values come from environment variables (optionally a local `.env` that is never committed).
- Secrets (`secret_key`, `database_url`) have **no default** so a missing value fails at startup.
- Inject settings with a cached `get_settings()` dependency so tests can override them.

## Schemas (Pydantic v2)

- Separate models per direction: `UserCreate`, `UserUpdate` (all fields optional), `UserResponse`. Never return ORM objects or input models directly.
- Set `response_model` (or a return annotation) on every route. It filters output, so password hashes and internal fields cannot leak, and it documents the API.
- Response models read ORM objects with `model_config = ConfigDict(from_attributes=True)`.
- Input models: constrain fields (`Field(min_length=..., max_length=...)`, `EmailStr`, `ge/le`) and consider `extra="forbid"` so unknown fields are rejected.
- Cross-field rules use `@model_validator(mode="after")`; single-field rules use `@field_validator`.
- Partial updates: `payload.model_dump(exclude_unset=True)`.

## Dependencies

- Declare with `Annotated` and reuse aliases: `DbDep = Annotated[AsyncSession, Depends(get_db)]`.
- Resources with cleanup (DB session, client) are `yield` dependencies.
- Chain small dependencies: `get_current_user` (authentication, 401) → `get_current_active_user` (state check, 403) → route-level permission checks (403).
- Keep dependencies free of business logic; they fetch and validate context.

## Async rules

- `async def` routes must only `await` non-blocking calls. A sync DB driver, `requests`, `time.sleep` or heavy CPU work inside `async def` blocks every request on that worker.
- If you must use a blocking library, declare the route with plain `def` (FastAPI runs it in a threadpool) or use `await asyncio.to_thread(...)`.
- Use async drivers and clients end to end (SQLAlchemy `AsyncSession` with asyncpg/psycopg, `httpx.AsyncClient`), with timeouts on every outbound call.
- Long work belongs in a job queue, not `BackgroundTasks`, if it must survive restarts or retry.

## Routers and services

- Route handler: parse input, call one service method, map domain errors to HTTP. No queries or hashing in the route.
- Service: owns the transaction (`commit` / `rollback`), raises domain exceptions (`DuplicateUserError`, `NotFoundError`), knows nothing about HTTP.
- Map domain errors once, with exception handlers registered in `create_app()`, or explicitly in the route. Status codes: validation 422 (FastAPI default), unauthenticated 401, forbidden 403, missing 404, unique conflict 409.
- Pagination: bounded `limit` (`Query(ge=1, le=100)`), and a deterministic `order_by` (for example by id) or keyset pagination for large tables.

## Database

- Enforce uniqueness and integrity with database constraints; catch `IntegrityError` and translate it. A "check then insert" in Python is a race.
- One session per request via the `get_db` dependency; roll back on error.
- `async_sessionmaker(..., expire_on_commit=False)` so returned objects are readable after commit.
- Avoid lazy loading in async code (it raises); load relationships explicitly (`selectinload`).

## Authentication and authorization

- As of 2025 the FastAPI docs use **PyJWT** for tokens and **pwdlib** (Argon2) for password hashing. `python-jose` and `passlib` are no longer maintained; flag them in new code.
- Decode with an explicit algorithm list; require `exp`; treat any decode failure as 401 with `WWW-Authenticate: Bearer`.
- Login failure returns the same message for unknown user and wrong password. Verify against a dummy hash when the user is missing so timing does not reveal which.
- Authorization (ownership, roles) is a separate check that returns 403. Scope queries to the caller rather than fetching then checking where possible.
- Never log tokens, passwords or full request bodies containing them.

## CORS and middleware

- List explicit origins from settings. Never combine `allow_origins=["*"]` with `allow_credentials=True`.
- Keep middleware cheap; add a request-id middleware and pass the id into logs.

## Errors

- Register handlers for your base `AppError` and a catch-all that logs the exception and returns a generic 500 body. Never return stack traces. See error-handling.

## Testing

- `httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")` for async tests; `TestClient` is fine for sync suites.
- Replace dependencies with `app.dependency_overrides[get_db] = override` (and clear them after).
- `ASGITransport` does not run lifespan; wrap with `asgi_lifespan.LifespanManager` if startup matters.
- Integration tests use the same database engine as production. SQLite in memory is acceptable only for fast unit-level checks.
- Test the error paths: 401 without token, 403 for another user's resource, 404, 409 duplicate, 422 bad input.

## Anti-patterns

- Business logic or SQL inside route functions.
- Blocking I/O in `async def`.
- Missing `response_model`; returning ORM objects with sensitive columns.
- `create_all()` in production startup.
- Secrets with default values in `Settings`.
- `HTTPException` raised deep inside services (couples domain to HTTP).
- Offset pagination without `order_by`.
- 400 for every error; use the specific status.

## Done when

- Every route has typed input, a response model, and documented error statuses.
- No blocking calls in async paths; outbound calls have timeouts.
- Tests cover success and each error status; the suite passes.

Full worked example (config, schemas, dependencies, router, service, handlers, conftest): [references/examples.md](references/examples.md).
