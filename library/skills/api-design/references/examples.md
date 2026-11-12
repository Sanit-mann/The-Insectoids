# API Design: Examples

Payloads and implementation sketches for [../SKILL.md](../SKILL.md). Paths use an `/api/v1` prefix and `snake_case` fields as an example convention.

## URLs

```
GET    /api/v1/users                 list
GET    /api/v1/users/{id}            read
POST   /api/v1/users                 create
PUT    /api/v1/users/{id}            replace
PATCH  /api/v1/users/{id}            partial update
DELETE /api/v1/users/{id}            delete

GET    /api/v1/users/{id}/orders     owned sub-collection
POST   /api/v1/orders/{id}/cancel    non-CRUD action

# Bad: /api/v1/getUsers  /api/v1/user  /api/v1/team_members  /api/v1/users/123/getOrders
```

## Single resource

```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "a1b2c3"

{ "data": { "id": "usr_abc123", "email": "alice@example.com", "name": "Alice", "created_at": "2025-01-15T10:30:00Z" } }
```

## Created

```http
HTTP/1.1 201 Created
Location: /api/v1/users/usr_abc123

{ "data": { "id": "usr_abc123", "email": "alice@example.com", "name": "Alice" } }
```

## Cursor-paginated list

```http
GET /api/v1/orders?status=open&sort=-created_at&limit=20&cursor=eyJrIjoiMjAyNS0wMS0xNVQxMDozMDowMFoiLCJpZCI6Im9yZF85In0
```

```json
{
  "data": [{ "id": "ord_8", "status": "open", "created_at": "2025-01-15T10:29:00Z" }],
  "meta": { "has_more": true, "next_cursor": "eyJrIjoiMjAyNS0wMS0xNVQxMDoyOTowMFoiLCJpZCI6Im9yZF84In0" },
  "links": { "next": "/api/v1/orders?status=open&sort=-created_at&limit=20&cursor=eyJr..." }
}
```

```sql
-- descending sort with a unique tie-breaker; fetch one extra row to compute has_more
SELECT id, status, created_at
FROM orders
WHERE status = :status
  AND (created_at, id) < (:cursor_created_at, :cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT :limit + 1;
```

## Offset-paginated list (small admin lists)

```json
{
  "data": [{ "id": "usr_1", "name": "Alice" }],
  "meta": { "page": 2, "per_page": 20, "total": 142 },
  "links": { "prev": "/api/v1/users?page=1&per_page=20", "next": "/api/v1/users?page=3&per_page=20" }
}
```

## Problem details (RFC 9457)

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://errors.example.com/validation_error",
  "title": "Request validation failed",
  "status": 422,
  "detail": "2 fields are invalid.",
  "instance": "/api/v1/users",
  "code": "validation_error",
  "request_id": "req_7f3a",
  "errors": [
    { "field": "email", "code": "invalid_format", "message": "Must be a valid email address" },
    { "field": "age", "code": "out_of_range", "message": "Must be between 0 and 150" }
  ]
}
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json

{ "type": "https://errors.example.com/not_found", "title": "User not found", "status": 404, "code": "not_found" }
```

## Rate limited

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/problem+json

{ "type": "https://errors.example.com/rate_limited", "title": "Rate limit exceeded", "status": 429, "code": "rate_limited" }
```

## Conditional update

```http
PATCH /api/v1/documents/doc_1
If-Match: "a1b2c3"
Content-Type: application/merge-patch+json

{ "title": "New title" }
```

Stale ETag returns `412 Precondition Failed`; the client refetches, merges and retries.

## Long-running operation

```http
POST /api/v1/reports
HTTP/1.1 202 Accepted
Location: /api/v1/operations/op_42

GET /api/v1/operations/op_42
{ "data": { "id": "op_42", "status": "succeeded", "result_url": "/api/v1/reports/rep_9" } }
```

## Deprecation headers

```http
Deprecation: @1767225600
Sunset: Fri, 01 Jan 2027 00:00:00 GMT
Link: <https://docs.example.com/migrate-v2>; rel="deprecation"; type="text/html"
```

## Handler sketch (TypeScript, route-handler style)

```ts
const CreateUser = z.object({ email: z.string().email(), name: z.string().min(1).max(100) }).strict()

export async function POST(req: Request): Promise<Response> {
  const principal = await authenticate(req)                  // 401 on failure
  const parsed = CreateUser.safeParse(await req.json().catch(() => undefined))
  if (!parsed.success) {
    return problem(422, 'validation_error', 'Request validation failed', {
      errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), code: i.code, message: i.message })),
    })
  }
  const user = await userService.create(principal, parsed.data) // ConflictError -> 409 in central handler
  return Response.json({ data: user }, { status: 201, headers: { Location: `/api/v1/users/${user.id}` } })
}

function problem(status: number, code: string, title: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ type: `https://errors.example.com/${code}`, title, status, code, ...extra }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}
```

## Idempotency-Key flow

```ts
// POST /api/v1/payments with header Idempotency-Key: <uuid>
export async function createPayment(req: Request): Promise<Response> {
  const principal = await authenticate(req)
  const key = req.headers.get('Idempotency-Key')
  if (!key) return problem(400, 'idempotency_key_required', 'Idempotency-Key header is required')

  const body = await req.text()
  const fingerprint = sha256(`${req.method} ${new URL(req.url).pathname} ${body}`)
  const scope = `${principal.clientId}:${key}`

  // Atomically claim the key (unique constraint or set-if-absent); store fingerprint + "in_progress".
  const claim = await idempotency.claim(scope, fingerprint, { ttlHours: 24 })
  if (claim.kind === 'existing') {
    if (claim.fingerprint !== fingerprint) return problem(422, 'idempotency_key_reused', 'Key used with a different request')
    if (claim.state === 'in_progress') return problem(409, 'idempotency_key_in_progress', 'Original request still processing')
    return new Response(claim.responseBody, { status: claim.responseStatus, headers: claim.responseHeaders })
  }

  try {
    const response = await processPayment(principal, PaymentSchema.parse(JSON.parse(body)))
    await idempotency.complete(scope, response)        // store status, headers, body
    return response
  } catch (err) {
    await idempotency.release(scope)                   // let the client retry if nothing was committed
    throw err
  }
}
```
