---
name: python-patterns
description: Idiomatic, typed, maintainable Python. Covers readability rules, type hints, exceptions, context managers, generators, dataclasses, choosing a concurrency model, project layout and tooling. Use when writing, refactoring or reviewing Python code. For tests load python-testing; for FastAPI or Django load those skills.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [python, style, typing]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/python-patterns/SKILL.md
      license: MIT
---

# Python Patterns

Write Python that is obvious to read, typed at its boundaries, and fails loudly.

## When to use

- Writing or changing Python modules, packages or scripts.
- Reviewing Python for idiom, typing and structure.

Not for: test design (python-testing), framework specifics (fastapi-patterns, django-patterns), cross-language error design (error-handling).

## Before you write

1. Read `pyproject.toml` (or `setup.cfg` / requirements files): `requires-python`, formatter, linter, type checker, test runner.
2. Use only language features the project's minimum Python version supports. For new projects pick a supported version (3.11 or newer as of late 2026; 3.10 reached end of life in October 2026).
3. Follow the tools and layout already in use. Do not introduce a new tool in the same change as a feature.

## Core rules

- **Readability beats cleverness.** Descriptive names. A comprehension only when the logic stays simple; otherwise a loop or a helper function.
- **Explicit beats implicit.** No side effects at import time (no DB connections, no config loading, no logging setup in library modules). Do setup in a function called from the entry point.
- **EAFP where it fits.** `try/except KeyError` is idiomatic for lookups and races (file may vanish). Use `dict.get(key, default)` for simple defaults. Use a check first (LBYL) when the check is cheap and a broad `except` would hide other bugs.
- **Formatting is the formatter's job.** Do not hand-format against PEP 8; run the project formatter.

## Type hints

- Annotate parameters and return types of every public function; internal helpers too unless trivial.
- Use built-in generics and union syntax: `list[str]`, `dict[str, int]`, `X | None`. `typing.List`, `Dict`, `Optional`, `Union` are legacy forms.
- Accept abstract, return concrete: parameters as `Iterable[T]`, `Sequence[T]`, `Mapping[K, V]` (from `collections.abc`); return `list[T]`, `dict[K, V]`.
- Use `typing.Protocol` for duck-typed interfaces instead of inheritance added only for typing.
- Generics and aliases: on 3.12+ use `def first[T](items: list[T]) -> T | None` and `type JSON = ...`; on older versions use `TypeVar` and `TypeAlias`.
- Avoid `Any` except at true boundaries (parsed JSON, untyped libraries) and narrow it straight away.
- Run the project's type checker (mypy or pyright) on changed code before calling it done.

## Exceptions

- Catch the narrowest exception you can actually handle. Never bare `except:`. `except Exception` only at a top-level boundary that logs and re-raises or converts.
- Chain when translating: `raise ConfigError(f"bad config: {path}") from e`. Use `from None` only to deliberately hide irrelevant internals.
- One base exception per package (`class AppError(Exception)`) and specific subclasses for conditions callers act on.
- Do not return `None` to signal failure when the caller needs to know why; raise instead.
- For envelopes, retries and user-facing messages, load error-handling.

## Resources and data

- Use `with` for files, locks, connections and transactions. Write custom managers with `contextlib.contextmanager` (wrap the `yield` in `try/finally`) or a class whose `__exit__` returns `False` so exceptions propagate. Use `contextlib.ExitStack` for a variable number of resources.
- `pathlib.Path` for paths. f-strings for formatting, but pass lazy arguments to logging: `log.info("user=%s", user_id)`.
- Generators for large or streaming data: `sum(x * x for x in xs)`, not `sum([...])`. Read big files line by line.
- Build strings with `"".join(parts)`, not `+=` in a loop.
- Data containers: `@dataclass` (prefer `frozen=True, slots=True`; `field(default_factory=list)` for mutable defaults; check invariants in `__post_init__`). `NamedTuple` for small immutable records. Pydantic or attrs when you need validation of untrusted input at a boundary.
- `__slots__` only when there are many instances and memory matters.
- `enum.Enum` / `StrEnum` instead of bare string constants for closed sets of values.

## Decorators

- Always use `functools.wraps`. Keep the wrapper thin; put real logic in plain functions so it can be tested directly.
- Prefer `functools.cache` / `lru_cache` to hand-rolled memoisation. Do not cache instance methods without care: the cache holds `self` alive.

## Concurrency: pick by workload

| Workload | Use |
|---|---|
| I/O-bound, modest fan-out, sync codebase | `concurrent.futures.ThreadPoolExecutor` |
| I/O-bound, high fan-out, async codebase | `asyncio` with `asyncio.TaskGroup` (3.11+) or `gather(..., return_exceptions=True)` |
| CPU-bound | `ProcessPoolExecutor`, or a native/vectorised library |

Rules:
- Never call blocking I/O inside `async def`. Use an async client or `asyncio.to_thread`.
- Every network call has a timeout.
- Bound concurrency (pool size, `asyncio.Semaphore`).
- Do not swallow per-task errors; collect them and report or re-raise.

## Project layout

- `src/<package>/` layout, `tests/` beside it, all tool config in `pyproject.toml`.
- Import order: standard library, third-party, local; let the linter sort them. No `from module import *`. Absolute imports for package code.
- `__init__.py` exposes only the public API; set `__all__` when re-exporting.
- Lock dependencies with the project's tool (uv, Poetry, pip-tools or similar). Adding a new dependency needs approval in the hive.

## Tooling (as of late 2026; use what the project already has)

- Format and lint: Ruff (`ruff format`, `ruff check`) commonly replaces black, isort and flake8.
- Types: mypy or pyright.
- Tests and coverage: pytest (see python-testing).
- Security: `pip-audit` for dependency CVEs; Ruff's `S` rules (bandit) for code.

Sample `pyproject.toml`: [references/idioms.md](references/idioms.md#pyprojecttoml).

## Anti-patterns (flag in review)

- Mutable default argument `def f(items=[])` → default `None`, create inside.
- `type(x) == list` → `isinstance(x, list)`.
- `x == None` → `x is None`.
- Bare `except:` or `except Exception: pass`.
- `from module import *`.
- Blocking calls inside async code.
- `print` for diagnostics in library code → `logging`.
- Shadowing builtins (`list`, `id`, `type`, `input`) in non-trivial scopes.
- Module-level mutable state or connections created on import.
- Over-long comprehensions with several `if`/`for` clauses.

## Done when

- Formatter, linter and type checker pass with the project's config.
- Public functions are typed; docstrings exist where behaviour is not obvious from the name.
- No anti-pattern above remains in the changed code.

Code examples for every section: [references/idioms.md](references/idioms.md).
