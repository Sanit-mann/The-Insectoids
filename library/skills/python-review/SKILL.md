---
name: python-review
description: 'Python review checks on top of code-review: injection and unsafe APIs, error handling, type hints, mutable defaults, concurrency and async pitfalls, plus FastAPI (async, dependencies, Pydantic models, CORS) and Django (ORM, migrations, DRF, settings) sections. Use when a diff touches .py files, migrations or Python project config.'
metadata:
  kind: skill
  castes: [reviewer, inspector]
  tags: [review, python, fastapi, django, quality]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: agents/python-reviewer.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/fastapi-reviewer.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/django-reviewer.md
      license: MIT
---

# Python Review

Language-specific checks for a code review. Follow code-review for the process, the confidence gate, the output format (`path:line: severity: problem. fix.`) and verdicts. This skill only adds what to look for in Python, FastAPI and Django code. Report findings; do not rewrite the code.

## Before reviewing

1. **Scope.** Use the card's range; list changed `.py` files and related migrations, settings and dependency files.
2. **Run what the project has** (through its runner: `uv run`, `poetry run`, or the venv):
   - lint: `ruff check .` (or the configured linter)
   - types: `mypy .` or `pyright` if configured
   - security: `bandit -r . -ll` if available
   - tests: `pytest` (with coverage if configured)
   - Django: `python manage.py check` and `python manage.py makemigrations --check --dry-run`
3. **Failing checks:** report them first. Do not install new tools without approval.
4. Read changed files in full plus callers before commenting.

## Critical: security

- SQL built with f-strings, `%` or `.format()` and user input: use bound parameters or the ORM.
- `subprocess` with `shell=True` or a string command containing input: pass an argument list, allowlist values.
- `eval` / `exec` / `compile` on untrusted input.
- Unsafe deserialization of untrusted data: `pickle`, `marshal`, `shelve`, `yaml.load` without `SafeLoader` (use `yaml.safe_load`).
- Path traversal: user input joined into paths without resolving and checking it stays under the allowed root.
- XML parsing of untrusted input with external entities enabled: use a hardened parser (e.g. `defusedxml`).
- Hardcoded secrets; `MD5` / `SHA1` for passwords or signatures (fine for checksums); `random` for tokens (use `secrets`).
- `requests` / `httpx` to user-supplied URLs without a host allowlist (SSRF); `verify=False` on TLS.

## Critical / high: error handling

- Bare `except:` or `except Exception: pass`: catch specific exceptions and handle or re-raise.
- Exceptions swallowed and replaced by a default that hides the failure.
- Re-raising without `from err`, losing the cause.
- Files, sockets, locks or sessions managed manually instead of `with`.

## High: correctness

- Mutable default arguments (`def f(items=[])`, `def f(opts={})`): use `None` and create inside.
- Late-binding closures in loops (lambdas capturing the loop variable).
- `is` used to compare values (`x is 5`, `s is "a"`); `== None` where `is None` is meant.
- Modifying a list or dict while iterating it.
- Naive and aware `datetime` mixed; `datetime.now()` where UTC is required.
- Float used for money: use `Decimal`.

## High: types

- Public functions without type hints in a typed codebase.
- `Any` where a precise type or `Protocol` fits.
- Nullable parameters or returns not typed as `X | None` (`Optional[X]`).
- `# type: ignore` without an error code and reason.

## High: concurrency and async

- Shared mutable state across threads without a lock.
- Blocking calls inside `async def` (sync database drivers, `requests`, `time.sleep`, heavy CPU): use async clients, `asyncio.sleep`, or offload to a thread.
- Coroutines created but never awaited; tasks created without keeping a reference or handling their exceptions.
- N+1 queries: related data fetched per item in a loop instead of batched.

## Medium

- Functions with many responsibilities, more than ~5 parameters (consider a dataclass), or nesting deeper than 4 levels.
- `print()` in library or server code: use `logging.getLogger(__name__)`.
- `from module import *`; shadowing builtins (`list`, `dict`, `id`, `type`) in non-trivial scope.
- Duplicate logic that will drift.

Low or skip: PEP 8 spacing, import order, quote style, comprehension-versus-loop taste, docstring presence on small helpers. Linters and formatters own these.

## FastAPI

**Critical**
- Response models that expose password hashes, tokens or internal auth fields: use a separate output schema.
- Auth dependencies that can be bypassed, or that do not verify token signature and expiry.
- SQL built through string interpolation; hardcoded secrets in settings.

**High**
- Blocking database or HTTP clients inside `async def` routes (use async drivers, or make the route `def` so it runs in the threadpool).
- Database sessions created inline in handlers instead of through a dependency with proper close/rollback.
- Write endpoints without a Pydantic request model (raw `dict` or `Request.json()`).
- `allow_origins=["*"]` together with `allow_credentials=True`.
- Test `dependency_overrides` targeting the wrong callable, so tests silently use the real dependency.

**Medium**
- List endpoints without pagination limits.
- Routes without `response_model` or documented error responses (OpenAPI quality).
- Route logic duplicated instead of moved into a service or dependency.
- External HTTP clients without timeouts; clients created per request instead of shared via lifespan.

## Django

**Critical: security**
- Raw SQL (`raw()`, `cursor.execute`, `extra()`) with f-strings or `%` formatting: pass parameters separately (`%s` placeholders with a params list).
- `mark_safe` / `|safe` on user input without `escape()` first.
- `@csrf_exempt` on a view that is not a signed webhook.
- `DEBUG = True` or a hardcoded `SECRET_KEY` in production settings; `ALLOWED_HOSTS = ['*']`.
- DRF views without explicit `permission_classes` where the global default does not match intent.
- File uploads without extension and size validation.

**Critical: ORM and data**
- N+1: related objects accessed in loops without `select_related` (foreign keys) or `prefetch_related` (many-related).
- Multi-step writes without `transaction.atomic()`.
- `bulk_create` that can silently drop or duplicate rows on key conflicts (check `ignore_conflicts` / `update_conflicts` intent).
- `.get()` without handling `DoesNotExist` / `MultipleObjectsReturned` (or `get_object_or_404` in views).
- Check-then-write races: use `select_for_update()` inside a transaction, or `F()` expressions for counters.

**Critical: migrations**
- Model changes without a migration (`makemigrations --check` fails).
- Column drops or renames that break the running version: do it in two deploys (stop using, then drop).
- `RunPython` without `reverse_code`; `atomic = False` without a reason.

**High: DRF**
- Serializers with `fields = '__all__'`: list fields explicitly so sensitive columns never leak.
- Auto-generated fields (`id`, `created_at`, owner) writable: set `read_only_fields`.
- Request-user injection done in `validate()` instead of `perform_create` / serializer context.
- No pagination on list endpoints; no throttling on login and registration.
- Nested writable serializers without a custom `update()`: nested data silently ignored.

**High: performance and quality**
- `len(queryset)` instead of `.count()`; `if queryset:` instead of `.exists()`.
- Filtered or joined fields without an index.
- Synchronous external API calls inside views: offload to a task queue.
- `save()` without `update_fields` where concurrent writes can clobber other columns.
- Business logic buried in views, serializers or signals: prefer explicit service functions; register any signals in `AppConfig.ready()`.
- Mutable model field defaults (`default=[]`): use `default=list`.
- Celery tasks that are not idempotent or retry without `bind=True` and `self.retry()`.

**Medium**
- `blank=True` without `null=True` on non-string fields; missing `related_name`; missing `__str__`.
- Hardcoded URLs instead of `reverse()`; sensitive fields editable in the admin.
- Tests: no test for the permission boundary (401/403), `force_authenticate` bypassing the real auth path, missing `django_db` marker, raw object creation where the project uses factories.

## End of report

Add to the code-review report:

```
checks:   <commands run and results, or why skipped>
residual: <what could not be verified, e.g. migration on production-size data>
```

## Done when

- [ ] Lint, types, tests (and Django checks) run or marked unavailable.
- [ ] Changed Python read in context; FastAPI / Django sections applied where relevant.
- [ ] Findings pass the code-review confidence gate; verdict recorded per code-review.
