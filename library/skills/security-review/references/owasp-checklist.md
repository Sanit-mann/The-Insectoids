# Security Checklist (detailed)

Load when walking a specific area in depth, writing the fix, or adding security tests. Examples are TypeScript-flavored; the rules apply to any stack.

Note for authors: write SQL placeholders as `?` or name the driver's form in prose. Some skill hosts substitute dollar-sign-number sequences, which would turn a parameterized example into a concatenated one.

## 1. Secrets

```typescript
// Never
const apiKey = "sk-live-xxxxx";
// Always: load from the environment or a secret manager, fail fast if missing
const apiKey = process.env.PAYMENT_API_KEY;
if (!apiKey) throw new Error('PAYMENT_API_KEY not configured');
```

- [ ] No keys, tokens, passwords or connection strings in source, config committed to the repo, or tests that hit real services.
- [ ] Local env files (`.env`, `.env.local`) ignored by version control; only `.env.example` with placeholders committed.
- [ ] No secrets in version history (check the diff's history if a secret was just removed: it must still be rotated).
- [ ] Production secrets live in the hosting platform's secret store, ideally with rotation and access audit.
- [ ] Client bundles carry no private secrets (check public env prefixes such as `NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`).

## 2. Input validation

```typescript
import { z } from 'zod';
const CreateUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  age: z.number().int().min(0).max(150),
});
export async function createUser(input: unknown) {
  const parsed = CreateUser.safeParse(input);
  if (!parsed.success) return { status: 400, errors: parsed.error.issues };
  return db.users.create(parsed.data);
}
```

File uploads:

```typescript
function validateUpload(file: File) {
  if (file.size > 5 * 1024 * 1024) throw new Error('File too large (max 5MB)');
  const types = ['image/jpeg', 'image/png', 'image/gif'];
  if (!types.includes(file.type)) throw new Error('Invalid file type');
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext || !['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) throw new Error('Invalid extension');
}
```

- [ ] All external input (body, query, params, headers, files, webhook payloads, messages) schema-validated at the boundary.
- [ ] Allowlists, not denylists.
- [ ] Uploads: size, MIME type and extension checked; content sniffed where it matters; stored outside the web root under generated names.
- [ ] Validation errors do not echo sensitive data or internals.

## 3. Injection

```typescript
// Dangerous
await db.query(`SELECT * FROM users WHERE email = '${email}'`);
// Safe: value in the params array, never in the string
await db.query('SELECT * FROM users WHERE email = ?', [email]);
```

- [ ] Every query uses bound parameters or a query builder / ORM used correctly (no raw fragments built from input).
- [ ] Shell: argument-list APIs (no shell string), fixed executable, allowlisted arguments.
- [ ] No `eval`, `new Function`, dynamic `import()` or template compilation on user input.
- [ ] NoSQL: operators from user input stripped (`$where`, `$ne` objects in JSON bodies).
- [ ] Untrusted object merges guarded against prototype pollution (schema validation or null-prototype objects).

## 4. Authentication and sessions

```typescript
// Wrong: readable by any injected script
localStorage.setItem('token', token);
// Right: httpOnly cookie
res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`);
```

- [ ] Passwords hashed with bcrypt, scrypt or argon2; compared with the library's compare function.
- [ ] Tokens: signature, expiry, issuer and audience verified; algorithm pinned.
- [ ] Session cookies httpOnly, Secure, SameSite; rotated on login and privilege change; invalidated on logout.
- [ ] Login, reset and signup throttled; reset tokens single-use and short-lived.
- [ ] Multi-factor available for privileged accounts where the product supports it.

## 5. Authorization

```typescript
export async function deleteUser(targetId: string, requester: User) {
  if (requester.role !== 'admin') return { status: 403 };
  await db.users.delete({ where: { id: targetId } });
}
```

- [ ] Every protected route has authentication middleware and an explicit authorization check.
- [ ] Object-level checks: the requester owns or may access *this* record (prevents changing an id in the URL to read someone else's data).
- [ ] Row-level policies enabled where the database supports them and the app relies on them (e.g. "users read only their own rows").
- [ ] Role checks server-side, never trusted from the client.
- [ ] Server actions, RPC handlers and background job triggers treated as public endpoints.

## 6. XSS and headers

```typescript
import DOMPurify from 'isomorphic-dompurify';
function renderUserContent(html: string) {
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p'], ALLOWED_ATTR: [] });
  return <div dangerouslySetInnerHTML={{ __html: clean }} />;
}
```

Content Security Policy: start strict and loosen only with a documented reason. Treat `unsafe-inline` and `unsafe-eval` as temporary debt.

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self';
connect-src 'self' https://api.example.com
```

- [ ] User content rendered as text by default; raw HTML only through an allowlist sanitizer at the same call site.
- [ ] User-supplied URLs in links and sources restricted to `http:`/`https:`.
- [ ] CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, frame protection set.
- [ ] `target="_blank"` links carry `rel="noopener noreferrer"`.

## 7. CSRF

- [ ] State-changing requests authenticated by cookies carry a CSRF token (synchronizer or double-submit) or rely on SameSite cookies with a documented reason.
- [ ] CSRF exemptions only for endpoints authenticated another way (signed webhooks), each with a comment.

## 8. Rate limiting and resource limits

- [ ] All public API endpoints rate limited; stricter limits on search, login, export and other expensive operations.
- [ ] Limits per IP and per authenticated user.
- [ ] Request body size, pagination size and query complexity bounded.
- [ ] Timeouts on outbound calls.

## 9. Sensitive data in logs and errors

```typescript
// Wrong
log.info('login', { email, password });
// Right
log.info('login', { userId });
// Wrong: leaks internals
return { status: 500, body: { error: err.message, stack: err.stack } };
// Right
log.error('internal error', err);
return { status: 500, body: { error: 'An error occurred. Please try again.' } };
```

- [ ] No passwords, tokens, card numbers or full personal data in logs; payment data limited to last 4 digits.
- [ ] Clients get generic errors; details go to server logs only.
- [ ] No stack traces or SQL in responses.

## 10. Value transfers and payments

- [ ] Recipient, amount and currency validated server-side against limits.
- [ ] Balance or stock check and the debit happen in one transaction with a row lock (no check-then-act race).
- [ ] Idempotency keys on payment and transfer requests.
- [ ] Payment provider webhooks signature-verified; amounts re-read from the provider, not trusted from the payload.
- [ ] Signed messages verified (signature, nonce, expiry) before acting; nothing signed blindly.

## 11. Dependencies

- [ ] Audit clean at high severity and above, or each exception documented.
- [ ] Lockfiles committed; CI installs from the lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`).
- [ ] New dependencies justified, maintained and from the official registry.
- [ ] Automated update alerts enabled where the platform supports them.

## Security tests to add

```typescript
test('requires authentication', async () => {
  expect((await fetch('/api/protected')).status).toBe(401);
});
test('requires admin role', async () => {
  const res = await fetch('/api/admin', { headers: { Authorization: `Bearer ${userToken}` } });
  expect(res.status).toBe(403);
});
test('cannot read another user\'s record', async () => {
  const res = await fetch(`/api/orders/${otherUsersOrderId}`, { headers: authAs(userA) });
  expect([403, 404]).toContain(res.status);
});
test('rejects invalid input', async () => {
  const res = await fetch('/api/users', { method: 'POST', body: JSON.stringify({ email: 'not-an-email' }) });
  expect(res.status).toBe(400);
});
test('enforces rate limits', async () => {
  const responses = await Promise.all(Array.from({ length: 101 }, () => fetch('/api/endpoint')));
  expect(responses.some(r => r.status === 429)).toBe(true);
});
```

## Scanning tools

Run what the project already has; adding tools needs approval.

| Stack | Dependencies | Code | Notes |
|---|---|---|---|
| JavaScript / TypeScript | `npm audit --audit-level=high` (or pnpm / yarn / bun equivalent) | ESLint with a security plugin | Check public env prefixes for leaked secrets |
| Python | `pip-audit` | `bandit -r . -ll` | Django: `python manage.py check --deploy` |
| Go | `govulncheck ./...` | `gosec ./...` | |
| Rust | `cargo audit` | `cargo clippy` | |
| Any | | A secret scanner on the diff, or a search for key-shaped strings | Never paste matches into reports |

## Pre-release checklist

- [ ] Secrets: none in code; all from env or secret store.
- [ ] Input validation on every external input.
- [ ] All queries parameterized.
- [ ] User content escaped or sanitized.
- [ ] CSRF protection on cookie-authenticated state changes.
- [ ] Token and session handling as in section 4.
- [ ] Authorization checks, including per-object.
- [ ] Rate limiting on public and expensive endpoints.
- [ ] HTTPS enforced; security headers set; CORS restricted.
- [ ] Errors and logs free of sensitive data.
- [ ] Dependencies audited; lockfiles committed.
- [ ] Row-level or per-object policies in place where relied on.
- [ ] Uploads validated.
- [ ] Payment and transfer checks as in section 10, if applicable.
