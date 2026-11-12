---
name: django-patterns
description: Build and review Django and Django REST Framework apps securely. Covers settings layout, models and DB constraints, migrations, custom QuerySets, N+1 prevention, service layer with transactions, serializers and viewsets, caching, signals, middleware and a production security checklist. Use when working on any Django or DRF code, migrations, permissions or deployment settings.
metadata:
  kind: skill
  castes: [coder, tester, reviewer]
  tags: [python, django, drf, security, orm]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/django-patterns/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: skills/django-security/SKILL.md
      license: MIT
---

# Django Patterns

Fat models for data rules, services for workflows, thin views, the database enforcing integrity, and secure defaults left on.

## When to use

- Writing or reviewing Django models, views, serializers, admin, middleware, signals or settings.
- Creating migrations or tuning ORM queries.
- Preparing a Django app for production or reviewing its security.

Also load: python-patterns, python-testing (pytest-django), postgres-patterns, reversible-migration.

## Before you start

1. Check the Django and DRF versions in the lock file. Use only APIs that version supports.
2. Find the settings module in use (`DJANGO_SETTINGS_MODULE`) and the app layout.
3. Run `python manage.py check` and the test suite to get a baseline.

## Project and settings

- Layout: `config/` (settings, urls, asgi/wsgi) and `apps/<name>/` with `models.py`, `services.py`, `views.py`, `serializers.py`, `permissions.py`, `urls.py`, `tests/`.
- Split settings: `base.py`, `development.py`, `production.py`, `test.py`. Production is the strict one; development relaxes it.
- All secrets and environment-specific values come from environment variables (django-environ or similar). Fail at startup if `SECRET_KEY` or the database URL is missing.
- `DEBUG = False` in base; turn it on only in development. `ALLOWED_HOSTS` from the environment.
- Log to stdout/stderr in containers; let the platform collect logs.

## Models

- Set a custom user model (`AUTH_USER_MODEL`) before the first migration of a new project. Changing it later is painful.
- Put integrity rules in the database: `UniqueConstraint`, `CheckConstraint(condition=Q(...))` (the `check=` argument was renamed `condition=` in Django 5.1), `NOT NULL` by default.
- Money: `DecimalField`, never `FloatField`.
- Choose `on_delete` deliberately: `PROTECT` for records others depend on (orders, invoices), `CASCADE` only for owned children.
- Use `TextChoices` / `IntegerChoices` for enumerations.
- Add indexes for real query patterns (filter and order columns, composite in query order). `unique=True` already creates an index; do not add a duplicate.
- `__str__` on every model. Keep `save()` overrides small; move workflows to services.

## Migrations

- Generate with `makemigrations`, then read the file. One concern per migration.
- Never edit a migration that has been applied anywhere shared.
- Data migrations use `RunPython` with a reverse function and `apps.get_model()`, never direct model imports.
- Large tables: add nullable column → backfill in batches → add constraint. Create indexes concurrently on Postgres (`AddIndexConcurrently`, non-atomic migration).
- Dropping columns, tables or data destroys data: get user approval and follow expand/contract (see reversible-migration).

## Querying

- Custom `QuerySet` methods chained via `objects = MyQuerySet.as_manager()`: `Product.objects.active().with_category()`.
- N+1: `select_related` for FK/one-to-one, `prefetch_related` (with `Prefetch` for filtered sets) for many-to-many and reverse FK. Assert query counts in tests (`django_assert_num_queries` / `assertNumQueries`).
- Fetch only what you need: `.only()`, `.values()`, `.exists()` instead of `len(qs)` or truthiness, `.count()` instead of `len()`.
- Atomic updates with `F()` expressions or `queryset.update()`; avoid read-modify-write in Python.
- Bulk: `bulk_create` / `bulk_update` with `batch_size`; `.iterator(chunk_size=...)` for large scans. Note: bulk operations and `update()` skip `save()` and signals.
- No queries inside loops in templates, serializers (`SerializerMethodField`) or properties without prefetching.
- Async views: use the async ORM methods (`aget`, `acreate`, `async for`) or `sync_to_async`; never call the sync ORM directly from async code.

## Services and transactions

- Business workflows live in `services.py` functions, not in views, serializers or signals.
- Wrap multi-write operations in `transaction.atomic()`.
- Read-modify-write on contended rows: `select_for_update()` inside the atomic block (stock, balances).
- Side effects (email, task enqueue, webhooks) go in `transaction.on_commit(...)` so they never fire for rolled-back data.
- Do not call slow external services (payment gateways) while holding row locks; record intent, call out, then update.
- Background work: a task queue (Celery is common). As of Django 6.0 there is a built-in tasks API, but production still needs a third-party backend.

## Django REST Framework

- Default `DEFAULT_PERMISSION_CLASSES = [IsAuthenticated]`; open endpoints explicitly.
- Serializers: explicit `fields` lists, never `"__all__"`; `read_only_fields` for ids, owners, timestamps; separate read and write serializers when shapes differ (`get_serializer_class`).
- Validation: `validate_<field>` and `validate()` in serializers; the DB constraint is the final guard.
- Passwords: `write_only=True`, run `validate_password`, store with `set_password()`.
- **Object access:** `get_queryset()` filters to what the user may see (`.filter(owner=request.user)`), plus object permissions (`has_object_permission`) for writes. Filtering the queryset turns other users' objects into 404 instead of leaking existence.
- Set owner fields server-side in `perform_create(serializer.save(owner=request.user))`, never from request data.
- Always paginate list endpoints; set throttles for anonymous and authenticated users.
- Custom `@action`s still go through permissions and the scoped queryset.

## Caching

- `cache_page` for anonymous, identical pages; template fragment caching for expensive partials; low-level `cache.get/set` for computed data.
- Version or namespace keys; invalidate on write (or keep timeouts short).
- Never cache per-user or permission-dependent data under a shared key.

## Signals and middleware

- Use signals only for decoupled cross-app reactions. Prefer an explicit service call; signals hide control flow and do not fire on bulk operations. Register receivers in `AppConfig.ready()`.
- Middleware: new-style callable class (`__init__(get_response)`, `__call__`). Keep it cheap; no DB write on every request.

## Security essentials

- Run `python manage.py check --deploy` against production settings; fix every warning or document why not.
- Leave CSRF, auto-escaping, clickjacking and security middleware on. Do not `csrf_exempt` except for signed webhooks that verify the signature.
- Never build SQL with string formatting; use the ORM or `raw()`/`cursor.execute()` with parameters.
- Never `mark_safe` user input; build HTML with `format_html`; pass data to JS with `json_script`.
- Validate uploads by content and size; serve user media from a separate domain or storage.
- Full checklist with settings: [references/security-checklist.md](references/security-checklist.md).

## Testing

- pytest-django (or Django's `TestCase`); model factories instead of fixtures files.
- Test permissions explicitly: anonymous, owner, other user, staff.
- Assert query counts on list endpoints.

## Red flags (review)

- Logic in views or serializers that writes multiple tables without `atomic`.
- `fields = "__all__"`, missing `get_queryset` scoping, owner taken from request body.
- Queries in loops; missing `select_related`/`prefetch_related`.
- Emails or tasks sent inside a transaction without `on_commit`.
- `DEBUG=True`, hardcoded `SECRET_KEY`, `ALLOWED_HOSTS=["*"]` in production settings.
- Edited applied migrations; destructive migrations without approval.

## Done when

- `manage.py check` (and `check --deploy` for production settings) is clean; `makemigrations --check` shows nothing pending.
- Tests cover permissions and query counts for changed endpoints; suite passes.

Code examples (settings, models, QuerySets, services, DRF, middleware, caching): [references/examples.md](references/examples.md).
