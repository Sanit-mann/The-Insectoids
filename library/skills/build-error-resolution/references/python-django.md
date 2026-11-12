# Python and Django Build and Startup Errors

Detail for `build-error-resolution`. Work inside the project's virtual environment and against a local or test database only.

## Diagnose (in this order)

```bash
python --version
python -m django --version
python -c "import sys; print(sys.prefix)"   # confirm the project's virtualenv is active
pip check                                   # broken or conflicting requirements

python manage.py check                      # configuration problems
python manage.py showmigrations             # applied vs pending
python manage.py migrate --plan             # what migrate would do (no changes)
python manage.py collectstatic --dry-run --noinput   # static file problems
```

Workflow: reproduce and capture the exact message, identify the category below, read the affected file or setting, apply the minimal fix, run `python manage.py check`, then run the test suite.

## Dependency errors

| Error | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'x'` | Package missing from the environment or manifest | Install into the virtualenv; add it to the requirements/pyproject if the code already uses it (a new dependency needs approval) |
| `ImportError: cannot import name 'X' from 'Y'` | Version mismatch | Pin a compatible version |
| pip resolver conflict | Incompatible pins | Upgrade pip, then relax or align the conflicting pins |
| Poetry: no solution found | Conflicting constraints | Relax the narrowest constraint in `pyproject.toml` |
| `DistributionNotFound` | Installed outside the virtualenv | Reinstall inside it |

A corrupt virtualenv inside your own workspace can be recreated (`python -m venv .venv`, then install requirements). Don't touch shared or system environments.

## Migration errors

| Error | Cause | Fix |
|---|---|---|
| `MigrationSchemaMissing` | Migration table not created | `python manage.py migrate` (local/test DB) |
| `no such column` / `relation does not exist` | Unapplied migration | `python manage.py migrate` (local/test DB) |
| `Multiple leaf nodes in the migration graph` | Two branches each added a migration | `python manage.py makemigrations --merge` |
| `dependencies reference nonexistent parent node` | A migration file is missing (often not committed) | Restore the missing file from version control; don't regenerate history |
| `InconsistentMigrationHistory` | Applied out of order | Investigate the real DB state first; `migrate --fake <app> <name>` only when the DB already matches, and only on non-shared databases |
| `Table already exists` | Created outside Django | `migrate --fake-initial`, after confirming the table matches the migration |

Rules:
- **Never delete migration files** to make an error go away.
- `--fake` changes Django's record, not the database. Use it only when you have verified the database already matches.
- `migrate <app> zero` drops tables and data: local development only, and never as a build fix without approval.
- A conflict that needs destructive database changes: stop and report.

## Configuration errors

| Error | Fix |
|---|---|
| `ImproperlyConfigured` | Read which setting it names; set it correctly |
| `DJANGO_SETTINGS_MODULE` not set | Set the environment variable to the project's settings module |
| `SECRET_KEY must not be empty` | Provide it through the project's environment mechanism (never hard-code a real secret) |
| `Invalid HTTP_HOST header` | Add the host to `ALLOWED_HOSTS` for that environment |
| `Apps aren't loaded yet` | Model imported before `django.setup()`; move the import inside the function or call setup first |
| `Model class doesn't declare an explicit app_label` | Add the app to `INSTALLED_APPS` |

```bash
python -c "import django; django.setup(); print('OK')"   # settings import cleanly?
python manage.py diffsettings                           # what differs from defaults
```

## Import errors and circular imports

```bash
python -c "import <module>"     # shows the real import chain
```

Break a circular import with the smallest change: move the import inside the function that needs it, or look the model up through the app registry:

```python
from django.apps import apps
User = apps.get_model("users", "User")
```

## Database connection errors

| Error | Fix |
|---|---|
| `could not connect to server` | Database not running or wrong host/port in `DATABASES`; if the service needs setup, stop and report |
| `role "x" does not exist` | Wrong database user in settings |
| Database driver not installed | Install the project's chosen driver into the virtualenv |

Never print full settings to logs or results: `DATABASES` contains credentials.

## Static files

| Error | Fix |
|---|---|
| `staticfiles.E001` (directory in both `STATICFILES_DIRS` and `STATIC_ROOT`) | Remove it from `STATICFILES_DIRS` |
| `FileNotFoundError` during collectstatic | A template or manifest references a missing file: fix the reference or add the file |
| Storage attribute errors on Django 4.2+ | Configure the `STORAGES` setting instead of the old storage settings |

## Dev server will not start

- Port busy: use another port (`runserver 8080`) rather than killing processes you didn't start.
- Hidden startup error: `python manage.py runserver --verbosity 2`.

## Output line

```text
[FIXED] apps/orders/migrations/0012_merge.py
Error: Multiple leaf nodes in the migration graph (0011_a, 0011_b)
Fix: makemigrations --merge
Remaining errors: 0
```
