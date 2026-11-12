---
name: api-design
description: HTTP/REST API contract design - resource naming, method semantics, status codes, error bodies (RFC 9457 problem details), pagination, filtering and sorting, versioning and deprecation, idempotency keys, conditional requests, long-running operations, rate-limit signals and a pre-ship checklist. Use when designing, changing or reviewing HTTP endpoints or an OpenAPI spec.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [api, rest, http, contracts]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/api-design/SKILL.md
      license: MIT
---

# API Design

Design HTTP APIs that are predictable, safe to retry and able to evolve without breaking clients. Payload and implementation examples: [references/examples.md](references/examples.md).

## When to use

- Adding or changing an endpoint, or reviewing an API contract or OpenAPI spec.
- Adding pagination, filtering, sorting, versioning, idempotency or rate limiting.
- Standardizing error responses across services.

Server-side implementation (layers, auth middleware, caching, jobs) is in `backend-patterns`.

## Start with the contract

- Write or update the OpenAPI description with the change. It is the source of truth for clients, docs, mocks and contract tests.
- Match the existing API's conventions (casing, envelope, pagination style) before inventing new ones. Consistency beats local perfection.

## Resources and URLs

- Nouns, plural, lowercase, kebab-case: `/v1/team-members`, `/v1/orders/{id}`.
- Nest only for real ownership, at most one level: `/v1/users/{id}/orders`. Otherwise filter: `/v1/orders?customer_id=...`.
- No verbs for CRUD. For actions that are not CRUD, use a sub-resource with POST: `POST /v1/orders/{id}/cancel`.
- IDs are opaque strings; do not expose sequential database ids on public APIs if enumeration matters.
- Query parameters filter, sort, paginate and select fields. They never carry secrets or tokens (URLs end up in logs).

## Methods

| Method | Safe | Idempotent | Use |
|---|---|---|---|
| GET | yes | yes | Read; never changes state |
| POST | no | no (make it so with an idempotency key) | Create, or trigger an action |
| PUT | no | yes | Full replacement at a known URL (or create at a client-chosen id) |
| PATCH | no | not by default | Partial update. Use JSON Merge Patch (RFC 7396) or JSON Patch (RFC 6902) and say which |
| DELETE | no | yes | Remove; repeating it is not an error the client must handle specially |

## Status codes

| Code | When |
|---|---|
| 200 OK | Successful read or update returning a body |
| 201 Created | Resource created; include `Location` and usually the resource |
| 202 Accepted | Work queued; return a status resource URL (see long-running operations) |
| 204 No Content | Success with no body (often DELETE) |
| 304 Not Modified | Conditional GET matched (`If-None-Match`) |
| 400 Bad Request | Malformed request: bad JSON, wrong types, unknown parameters |
| 401 Unauthorized | Missing or invalid credentials; send `WWW-Authenticate` |
| 403 Forbidden | Authenticated but not allowed |
| 404 Not Found | Missing, **or** exists but the caller may not know it exists (prevents enumeration) |
| 405 Method Not Allowed | Method not supported; send `Allow` |
| 409 Conflict | State conflict: duplicate, wrong state for the action, idempotency key in use |
| 410 Gone | Removed permanently (for example after a version sunset) |
| 412 Precondition Failed | `If-Match` ETag did not match (concurrent edit) |
| 415 Unsupported Media Type | Wrong `Content-Type` |
| 422 Unprocessable Content | Well-formed but fails validation or business rules |
| 428 Precondition Required | Endpoint requires `If-Match` and none was sent |
| 429 Too Many Requests | Rate limited; send `Retry-After` |
| 500 | Unexpected failure; no internal detail in the body |
| 502 / 503 / 504 | Upstream failure / temporarily unavailable (send `Retry-After`) / upstream timeout |

- Pick one convention for validation errors (400 or 422) and use it everywhere.
- Never return 200 with an error inside the body. Never return 500 for client mistakes.

## Response bodies

- Choose **one** shape for the whole API: an envelope (`{ "data": ..., "meta": ..., "links": ... }`) or the bare resource. Envelopes leave room for pagination and metadata; bare resources are simpler for internal APIs.
- One field casing everywhere (`snake_case` or `camelCase`), matching existing endpoints.
- Timestamps as RFC 3339 / ISO 8601 strings in UTC (`2025-01-15T10:30:00Z`).
- Money as integer minor units plus currency code, or a decimal string. Never floats.
- Enums as strings. Document whether absent and `null` mean different things.
- Clients must ignore unknown fields, so adding fields stays non-breaking. Say so in the docs.
- Return only fields the caller may see. Never echo secrets, password hashes or internal flags.

## Errors

- Use **Problem Details (RFC 9457)**, media type `application/problem+json`: `type` (URI identifying the error kind), `title`, `status`, `detail`, `instance`.
- Add extension members: a stable machine-readable `code`, and for validation an `errors` array of `{ field, code, message }` using the request's field paths.
- Codes are part of the contract: clients branch on `code`, never on `title` or `detail` text.
- Never include stack traces, SQL, internal hostnames or upstream raw errors. Include a request or trace ID so support can find the logs.

## Pagination

- Every list endpoint is paginated, with a default and a maximum `limit`.
- **Cursor pagination is the default** for feeds, large or fast-changing collections and public APIs. The cursor is opaque (base64 of the last row's sort key plus a unique tie-breaker such as the id). Query with `WHERE (sort_key, id) > (:k, :id) ORDER BY sort_key, id LIMIT :limit + 1`; the extra row tells you whether there is a next page.
- **Offset/page pagination** is acceptable for small, mostly static admin lists where users jump to page N. It is slow at large offsets and skips or repeats rows under concurrent writes.
- Return `next_cursor` (or `links.next`) and `has_more`. Total counts are expensive on large tables; make them optional.
- The cursor encodes the sort and filters it was created with. Reject a cursor reused with different parameters.

## Filtering, sorting, field selection

- Filters: `?status=active&customer_id=...`. Ranges: `?created_after=...&created_before=...` or bracket style (`price[gte]=10`). Pick one style.
- Multiple values: `?status=active,pending`.
- Sort: `?sort=-created_at,name` (`-` for descending). Allow only indexed, documented fields.
- Sparse fields: `?fields=id,name`. Embedding related resources: `?include=customer`.
- Validate every filter and sort field against an allowlist. Unknown parameters are a 400, not silently ignored.
- Free-text search: `?q=`.

## Idempotency

- GET, PUT and DELETE are idempotent by design. Make **POST and PATCH retry-safe with an `Idempotency-Key` header** (IETF httpapi draft; widely used by payment APIs).
- Server behavior: store the key scoped to the client, with a fingerprint of the request and the final response, for a fixed window (24 hours is common).
  - Same key and same request: replay the stored status and body. Do not repeat the side effect.
  - Same key, different request body: 422 (or 400).
  - Same key while the first request is still running: 409.
- Require the key on endpoints that move money, send messages or create orders.
- Clients generate a fresh key (UUID) per logical operation and reuse it only for retries of that operation.

## Concurrency control and caching

- Return an `ETag` on reads. Accept `If-Match` on PUT, PATCH and DELETE. A mismatch returns 412, which prevents lost updates. Require it (428) where overwrites are costly.
- Support `If-None-Match` on GET to answer 304.
- Set `Cache-Control` deliberately: `no-store` for personal data, `max-age`/`s-maxage` for public data.

## Long-running operations

Return 202 with `Location: /v1/operations/{id}`. The operation resource reports `status` (`pending`, `running`, `succeeded`, `failed`), progress, and the result URL or a problem-details error. Offer webhooks for completion if clients would otherwise poll heavily, and sign webhook payloads.

## Versioning and deprecation

- Version in the path by major version (`/v1/`). Header or media-type versioning is an option, but it is harder to test and to route.
- **Non-breaking, no new version:** adding endpoints, optional parameters, response fields, or enum values that clients are told to expect.
- **Breaking, needs a new version:** removing or renaming fields, changing types or meaning, making optional input required, changing auth, changing URL structure or error codes.
- Run at most two major versions at once.
- Deprecate in the open: announce (public APIs usually give six months or more), send `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers plus a `Link` to the migration guide, monitor remaining traffic, then return 410 after sunset.

## Authentication, authorization, security

- Credentials in the `Authorization` header (bearer tokens) or a dedicated header for API keys. Never in URLs.
- Check object-level authorization on every request that takes an id. Check field-level authorization on writes (clients cannot set `role` or `owner_id`).
- HTTPS only. CORS with an explicit origin allowlist; no wildcard with credentials.
- Limit body size, array lengths and page size. Validate `Content-Type`.

## Rate limiting

- Return 429 with `Retry-After` when limited.
- Advertise limits with headers. `X-RateLimit-Limit` / `-Remaining` / `-Reset` are common; the IETF `RateLimit` and `RateLimit-Policy` fields are the emerging standard. Pick one and document it.
- Limit per API key or user for authenticated calls and per IP for anonymous ones. Document the tiers.

## Pre-ship checklist

- [ ] Contract (OpenAPI) updated; naming and casing match existing endpoints
- [ ] Correct method and status codes; `Location` on 201; `Retry-After` on 429 and 503
- [ ] Input validated against a schema; unknown fields and parameters handled deliberately
- [ ] Errors use problem details with stable codes; no internal detail leaks
- [ ] Lists paginated with a maximum limit; sort and filter fields allowlisted
- [ ] Authentication required unless explicitly public; object-level authorization checked
- [ ] Non-idempotent writes accept an `Idempotency-Key` where retries could cause harm
- [ ] ETag and `If-Match` for resources edited concurrently
- [ ] Change classified as breaking or non-breaking; deprecation headers set if removing anything
- [ ] Rate limits configured and documented
- [ ] Contract tests or examples cover success, validation failure, auth failure and not found

## Red flags in review

- Verbs in paths (`/getUsers`), singular collections, mixed casing.
- 200 with `"success": false`; 500 for validation errors; 403 that reveals a hidden resource exists.
- Unbounded list endpoints; offset pagination on huge or fast-changing tables.
- Payment or order POSTs without idempotency; PATCH that blindly overwrites concurrent edits.
- Renamed or removed fields without a new version; error messages used as the contract.
