# Error handling in Python

Examples for [error-handling](../SKILL.md). Framework details: fastapi-patterns, django-patterns.

## Exception hierarchy

```python
class AppError(Exception):
    """Base error. `code` is stable and machine-readable."""

    code = "INTERNAL_ERROR"
    status = 500

    def __init__(self, message: str = "", *, details: list[dict] | None = None) -> None:
        super().__init__(message or self.code)
        self.details = details or []


class NotFoundError(AppError):
    code, status = "NOT_FOUND", 404


class ValidationError(AppError):
    code, status = "VALIDATION_ERROR", 422


class ConflictError(AppError):
    code, status = "CONFLICT", 409


class UpstreamError(AppError):
    code, status = "UPSTREAM_UNAVAILABLE", 503
```

Keep `status` on the class only if the codebase maps at the edge from it; otherwise keep a separate `code → status` table in the web layer so domain code stays HTTP-free.

## Translating with the cause

```python
from sqlalchemy.exc import IntegrityError

try:
    session.commit()
except IntegrityError as e:
    session.rollback()
    raise ConflictError("email already registered") from e     # keeps the original traceback
```

Narrow catches only. Never:

```python
try:
    process(order)
except Exception:
    pass                    # silent failure: the order is lost and nobody knows
```

## Logging once at the boundary

```python
import logging

log = logging.getLogger(__name__)


def run_job(job_id: str) -> None:
    try:
        handle(job_id)
    except AppError as e:
        log.warning("job %s failed: %s (%s)", job_id, e, e.code)   # expected, no stack
        mark_failed(job_id, e.code)
    except Exception:
        log.exception("job %s crashed", job_id)                   # unexpected: stack included
        mark_failed(job_id, "INTERNAL_ERROR")
        raise
```

`log.exception` records the current traceback; use it inside `except` only.

## FastAPI handlers

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


def register_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content={"error": {"code": exc.code, "message": str(exc), "details": exc.details,
                               "request_id": request.state.request_id}},
        )

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error, request_id=%s", request.state.request_id)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "INTERNAL_ERROR", "message": "An unexpected error occurred",
                               "request_id": request.state.request_id}},
        )
```

## Timeouts

```python
import asyncio

import httpx

client = httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0))   # never unbounded

async def load_profile(user_id: int) -> dict:
    async with asyncio.timeout(8):              # 3.11+: overall deadline for several calls
        r = await client.get(f"/profiles/{user_id}")
        r.raise_for_status()
        return r.json()
```

Sync code: pass `timeout=` to every client call (`requests`, `httpx`, DB drivers); set statement timeouts in the database.

## Retry with backoff and jitter

Prefer a maintained library (for example tenacity) if the project has one. Hand-rolled version:

```python
import random
import time
from collections.abc import Callable

import httpx

TRANSIENT_STATUS = {408, 429, 500, 502, 503, 504}


def is_transient(e: Exception) -> bool:
    if isinstance(e, httpx.HTTPStatusError):
        return e.response.status_code in TRANSIENT_STATUS
    return isinstance(e, (httpx.TimeoutException, httpx.TransportError))


def with_retry[T](fn: Callable[[], T], *, attempts: int = 3, base: float = 0.3,
                  cap: float = 5.0) -> T:
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == attempts or not is_transient(e):
                raise
            delay = random.uniform(0, min(cap, base * 2 ** (attempt - 1)))   # full jitter
            if isinstance(e, httpx.HTTPStatusError) and (ra := e.response.headers.get("retry-after")):
                if ra.isdigit():
                    delay = float(ra)
            log.warning("attempt %d failed (%s); retrying in %.2fs", attempt, e, delay)
            time.sleep(delay)
    raise AssertionError("unreachable")


# Only for idempotent calls (GET, or POST with an Idempotency-Key header)
def fetch_rates() -> dict:
    def call() -> dict:
        r = httpx.get("https://rates.example.com/latest", timeout=5)
        r.raise_for_status()
        return r.json()
    return with_retry(call)
```

Database serialization failures and deadlocks: retry the whole transaction, not the single statement.

## Concurrent tasks and exception groups

```python
async def refresh_all(ids: list[int]) -> None:
    try:
        async with asyncio.TaskGroup() as tg:          # 3.11+: cancels siblings on first failure
            for i in ids:
                tg.create_task(refresh(i))
    except* UpstreamError as eg:                        # handle one kind from the group
        log.warning("%d refreshes hit an unavailable upstream", len(eg.exceptions))
        raise


# Collect-all alternative: inspect every result
results = await asyncio.gather(*(refresh(i) for i in ids), return_exceptions=True)
failures = [r for r in results if isinstance(r, BaseException)]
```

Background tasks created with `asyncio.create_task` must be kept referenced and have a done-callback that logs exceptions, or their errors vanish.

## Cleanup

```python
from contextlib import ExitStack

with open(src) as f_in, open(dst, "w") as f_out:   # closed even on error
    copy(f_in, f_out)

with ExitStack() as stack:                           # variable number of resources
    files = [stack.enter_context(open(p)) for p in paths]
    merge(files)
```

## Testing error paths

```python
def test_duplicate_email_raises_conflict(service, existing_user):
    with pytest.raises(ConflictError) as exc_info:
        service.create(email=existing_user.email)
    assert isinstance(exc_info.value.__cause__, IntegrityError)


def test_retry_gives_up_after_three_attempts(monkeypatch):
    calls = []
    def boom():
        calls.append(1)
        raise httpx.ConnectTimeout("slow")
    monkeypatch.setattr(time, "sleep", lambda s: None)
    with pytest.raises(httpx.ConnectTimeout):
        with_retry(boom, attempts=3)
    assert len(calls) == 3
```
