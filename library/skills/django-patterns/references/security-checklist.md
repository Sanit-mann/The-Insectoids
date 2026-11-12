# Django security checklist

For [django-patterns](../SKILL.md). Run `python manage.py check --deploy --settings=config.settings.production` first; it catches most setting mistakes. Changing production settings or secrets needs user approval in the hive.

## Checklist

| Area | Check |
|---|---|
| Debug | `DEBUG = False` in production |
| Hosts | `ALLOWED_HOSTS` explicit, from the environment; never `["*"]` |
| Secrets | `SECRET_KEY` and DB credentials from the environment; startup fails if missing; never committed |
| HTTPS | `SECURE_SSL_REDIRECT`, secure session and CSRF cookies, HSTS |
| Proxy | `SECURE_PROXY_SSL_HEADER` set only if the proxy strips and sets that header |
| Passwords | All four `AUTH_PASSWORD_VALIDATORS`; Argon2 hasher first |
| CSRF | Middleware on; `{% csrf_token %}` in forms; `CSRF_TRUSTED_ORIGINS` includes scheme |
| XSS | Auto-escaping on; no `mark_safe` or `safe` filter on user data; `json_script` for JS data |
| SQL | ORM or parameterised raw SQL only |
| Access | Querysets scoped to the user; object permissions on writes; default `IsAuthenticated` |
| Uploads | Validate content type and size; random filenames; serve from separate domain/storage |
| API | Throttling; pagination; authentication classes limited to what is used |
| Headers | CSP, `nosniff`, frame denial, referrer policy |
| Admin | Strong auth (MFA via a package), restricted access, not the only path to data |
| Logging | `django.security` logged; no passwords, tokens or full PII in logs |
| Dependencies | Django on a supported release; `pip-audit` clean |

## Production settings

```python
# config/settings/production.py
from .base import *  # noqa: F403

DEBUG = False
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS")
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS")   # e.g. https://app.example.com

SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True                # default; keep it
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"

SECURE_HSTS_SECONDS = 31536000                # start low (e.g. 3600) on first rollout, then raise
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = False                   # only after every subdomain is HTTPS; hard to undo
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
X_FRAME_OPTIONS = "DENY"

# Behind a TLS-terminating proxy that sets X-Forwarded-Proto:
# SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
```

Do not set `X-XSS-Protection`; browsers removed that filter and the header is deprecated.

## Passwords and sessions

```python
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",     # needs argon2-cffi installed
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",     # keeps old hashes verifiable
]

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
     "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

SESSION_COOKIE_AGE = 60 * 60 * 24 * 7         # pick per risk; shorter for sensitive apps
```

- Rotate the session on login (Django's `login()` does this).
- Rate-limit login and password-reset endpoints (DRF throttles or a dedicated package).
- Return the same response for unknown account and wrong password.

## Authorization

```python
class PostUpdateView(LoginRequiredMixin, UpdateView):
    model = Post
    raise_exception = True                    # 403 instead of redirect for APIs/AJAX

    def get_queryset(self):
        qs = Post.objects.all()
        if not self.request.user.has_perm("blog.change_others_post"):
            qs = qs.filter(author=self.request.user)
        return qs                             # other users' posts -> 404
```

- Check permission on every write path, including custom actions, admin actions and bulk endpoints.
- Use Django permissions or groups for roles; avoid ad-hoc role strings scattered through views.
- `request.user and request.user.is_staff` style checks must also confirm `is_authenticated`.

## SQL injection

```python
# Safe
User.objects.filter(email__iexact=email)
User.objects.raw("SELECT * FROM users_user WHERE email = %s", [email])
with connection.cursor() as c:
    c.execute("UPDATE t SET n = n + 1 WHERE id = %s", [obj_id])

# Vulnerable: string-built SQL
User.objects.raw(f"SELECT * FROM users_user WHERE email = '{email}'")
```

Also avoid user input in `extra()`, `RawSQL()`, column names for `order_by()` (whitelist allowed fields), and `QuerySet.annotate()` with raw expressions.

## XSS

```django
{{ comment.body }}                         {# auto-escaped: safe #}
{{ comment.body|safe }}                    {# vulnerable if user-controlled #}
{{ chart_data|json_script:"chart-data" }}  {# safe way to pass data to JS #}
```

```python
from django.utils.html import format_html

def user_badge(user):
    return format_html('<span class="badge">{}</span>', user.display_name)   # escapes args
```

Never `mark_safe()` a string that contains user input. Sanitise user-supplied rich HTML with an allow-list sanitiser library.

## CSRF

- Keep `CsrfViewMiddleware`. For fetch/AJAX, send the token in the `X-CSRFToken` header (read from the `csrftoken` cookie or a template variable).
- `CSRF_COOKIE_HTTPONLY = False` (default) only matters if JS reads the cookie; if set to `True`, read the token from the DOM instead.
- `@csrf_exempt` only for machine-to-machine endpoints such as webhooks, and only when the handler verifies the sender's signature (HMAC with a shared secret, constant-time compare) and timestamp.
- Token-authenticated APIs (no cookies) are not CSRF-prone; session-authenticated DRF views enforce CSRF automatically.

## File uploads

```python
import os

import filetype                               # pure Python; python-magic is an alternative
from django.core.exceptions import ValidationError

ALLOWED = {
    "image/jpeg": {".jpg", ".jpeg"},
    "image/png": {".png"},
    "application/pdf": {".pdf"},
}
MAX_BYTES = 5 * 1024 * 1024


def validate_upload(f):
    if f.size > MAX_BYTES:
        raise ValidationError("File too large (max 5 MB).")
    kind = filetype.guess(f.read(2048))
    f.seek(0)
    if kind is None or kind.mime not in ALLOWED:
        raise ValidationError("Unsupported file type.")
    if os.path.splitext(f.name)[1].lower() not in ALLOWED[kind.mime]:
        raise ValidationError("File extension does not match content.")
```

- Store with generated names (`upload_to` callable), outside the code directory.
- Serve user media from object storage or a separate domain, never through the app domain with executable content types.
- Set `DATA_UPLOAD_MAX_MEMORY_SIZE` / `FILE_UPLOAD_MAX_MEMORY_SIZE` and a web-server body size limit.

## Content Security Policy

- As of Django 6.0, CSP is built in: add `django.middleware.csp.ContentSecurityPolicyMiddleware` and configure `SECURE_CSP` (or `SECURE_CSP_REPORT_ONLY` to trial it). Nonces are available to templates for inline scripts.
- On older versions use the `django-csp` package rather than a hand-written header middleware.
- Start in report-only mode, fix violations, then enforce. Avoid `'unsafe-inline'` for scripts.

## API authentication (DRF)

- Enable only the authentication classes you use. Session auth for same-site browser clients; token or JWT (for example `djangorestframework-simplejwt`) for others.
- Short-lived access tokens; rotate and revoke refresh tokens; never put tokens in URLs.
- Throttle per user and per IP; stricter scopes for login, signup, password reset, uploads.

## Logging security events

```python
LOGGING["loggers"] = {
    "django.security": {"handlers": ["console"], "level": "WARNING", "propagate": False},
    "django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False},
}
```

Log failed logins, permission denials and suspicious operations with user id and request id, not passwords, tokens or full bodies.

## Secrets

- `.env` files are for local development only and are git-ignored; ship `.env.example` with placeholders.
- In deployed environments inject secrets from the platform's secret store.
- If a secret was ever committed, rotate it; deleting the commit is not enough.
