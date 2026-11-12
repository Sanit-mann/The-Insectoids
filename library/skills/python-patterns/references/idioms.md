# Python idioms: examples

Examples for [python-patterns](../SKILL.md). Adapt names to the project.

## Typing

```python
from collections.abc import Iterable, Mapping
from typing import Protocol


def active_names(users: Iterable["User"]) -> list[str]:
    """Return names of active users."""
    return [u.name for u in users if u.is_active]


def first[T](items: list[T]) -> T | None:        # Python 3.12+ syntax
    return items[0] if items else None

# Before 3.12:
# T = TypeVar("T")
# def first(items: list[T]) -> T | None: ...


type JSON = dict[str, "JSON"] | list["JSON"] | str | int | float | bool | None  # 3.12+


class Renderable(Protocol):
    def render(self) -> str: ...


def render_all(items: Iterable[Renderable]) -> str:
    return "\n".join(item.render() for item in items)
```

## Exceptions

```python
import json
from pathlib import Path


class AppError(Exception):
    """Base error for this package."""


class ConfigError(AppError):
    """Configuration is missing or invalid."""


class NotFoundError(AppError):
    """A requested resource does not exist."""


def load_config(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise ConfigError(f"config file not found: {path}") from e
    except json.JSONDecodeError as e:
        raise ConfigError(f"invalid JSON in {path}: {e.msg}") from e
```

Bad: `except: return None` — the caller cannot tell a missing file from a syntax error, and real bugs are hidden.

## Context managers

```python
import time
from contextlib import contextmanager


@contextmanager
def timer(name: str, log):
    start = time.perf_counter()
    try:
        yield
    finally:                                   # runs even if the block raises
        log.info("%s took %.4fs", name, time.perf_counter() - start)


class Transaction:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        self.conn.begin()
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.conn.commit()
        else:
            self.conn.rollback()
        return False                           # never suppress the exception
```

## Generators and large data

```python
from collections.abc import Iterator
from pathlib import Path


def read_lines(path: Path) -> Iterator[str]:
    with path.open(encoding="utf-8") as f:
        for line in f:
            yield line.rstrip("\n")


total = sum(x * x for x in range(1_000_000))   # no intermediate list
csv_row = ",".join(str(v) for v in values)     # not += in a loop
```

## Dataclasses and records

```python
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import NamedTuple


@dataclass(frozen=True, slots=True)
class User:
    id: str
    email: str
    age: int
    tags: list[str] = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        if "@" not in self.email:
            raise ValueError(f"invalid email: {self.email!r}")
        if not 0 <= self.age <= 150:
            raise ValueError(f"invalid age: {self.age}")


class Point(NamedTuple):
    x: float
    y: float
```

Use timezone-aware datetimes (`datetime.now(UTC)`), not naive `datetime.now()` or the deprecated `datetime.utcnow()`.

## Decorators

```python
import functools
import time
from collections.abc import Callable


def timed[**P, R](func: Callable[P, R]) -> Callable[P, R]:     # 3.12+ syntax
    @functools.wraps(func)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        start = time.perf_counter()
        try:
            return func(*args, **kwargs)
        finally:
            log.debug("%s took %.4fs", func.__name__, time.perf_counter() - start)
    return wrapper


def retry(times: int):                         # parameterised decorator
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(1, times + 1):
                try:
                    return func(*args, **kwargs)
                except TransientError:
                    if attempt == times:
                        raise
        return wrapper
    return decorator
```

## Concurrency

```python
import asyncio
import concurrent.futures

import httpx


# Threads: I/O-bound work in a sync codebase
def fetch_all(urls: list[str]) -> dict[str, bytes | Exception]:
    results: dict[str, bytes | Exception] = {}
    with httpx.Client(timeout=10) as client, \
         concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(client.get, u): u for u in urls}
        for fut in concurrent.futures.as_completed(futures):
            url = futures[fut]
            try:
                results[url] = fut.result().content
            except httpx.HTTPError as e:
                results[url] = e               # keep the error, don't hide it
    return results


# asyncio: high fan-out, bounded
async def fetch_all_async(urls: list[str], limit: int = 20) -> list[bytes]:
    sem = asyncio.Semaphore(limit)
    async with httpx.AsyncClient(timeout=10) as client:
        async def one(url: str) -> bytes:
            async with sem:
                r = await client.get(url)
                r.raise_for_status()
                return r.content
        async with asyncio.TaskGroup() as tg:   # 3.11+; failures raise ExceptionGroup
            tasks = [tg.create_task(one(u)) for u in urls]
    return [t.result() for t in tasks]


# Processes: CPU-bound
def crunch_all(datasets: list[list[int]]) -> list[int]:
    with concurrent.futures.ProcessPoolExecutor() as pool:
        return list(pool.map(sum_of_squares, datasets))
```

Blocking call inside async code: `data = await asyncio.to_thread(blocking_read, path)`.

## Package layout

```text
myproject/
├── src/mypackage/
│   ├── __init__.py        # public API + __all__
│   ├── api/
│   ├── models/
│   └── services/
├── tests/
│   ├── conftest.py
│   └── test_*.py
└── pyproject.toml
```

## pyproject.toml

Sample only; keep whatever tools the project already uses.

```toml
[project]
name = "mypackage"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.27",
    "pydantic>=2.6",
]

[dependency-groups]          # PEP 735; older projects use [project.optional-dependencies]
dev = ["pytest>=8", "pytest-cov>=5", "ruff>=0.6", "mypy>=1.10"]

[tool.ruff]
line-length = 88
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "N", "UP", "B", "S"]

[tool.mypy]
python_version = "3.11"
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = ["--strict-markers"]
```

Typical commands (run through your terminal tool):

```bash
ruff format . && ruff check .
mypy src
pytest --cov=mypackage --cov-report=term-missing
pip-audit
```
