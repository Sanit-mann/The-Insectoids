# Error handling in TypeScript

Examples for [error-handling](../SKILL.md). Adapt to the project's framework and logger.

## Error classes

```typescript
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 500,
    public readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options)                         // ES2022 `cause` keeps the original error
    this.name = new.target.name
    Object.setPrototypeOf(this, new.target.prototype) // only needed when compiling to ES5
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404)
  }
}

export class ValidationError extends AppError {
  constructor(details: { field: string; message: string }[]) {
    super('Request validation failed', 'VALIDATION_ERROR', 422, details)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'CONFLICT', 409, undefined, options)
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super('Rate limit exceeded', 'RATE_LIMITED', 429)
  }
}

export class UpstreamError extends AppError {
  constructor(service: string, options?: { cause?: unknown }) {
    super(`${service} unavailable`, 'UPSTREAM_UNAVAILABLE', 503, undefined, options)
  }
}
```

Translating a low-level error with its cause:

```typescript
try {
  await db.user.create({ data })
} catch (e) {
  if (isUniqueViolation(e)) throw new ConflictError('Email already registered', { cause: e })
  throw e                                            // unknown: let the boundary handle it
}
```

`catch (e)` gives `unknown`; narrow with `instanceof` before reading properties.

## Result type for expected failures

```typescript
export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

function parseQuantity(raw: string): Result<number, ValidationError> {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    return err(new ValidationError([{ field: 'quantity', message: 'must be a positive integer' }]))
  }
  return ok(n)
}

const q = parseQuantity(input)
if (!q.ok) return respondWith(q.error)               // compiler forces the check
use(q.value)
```

Use results for expected outcomes; let real infrastructure failures throw.

## Boundary handler (framework-neutral core)

```typescript
import { ZodError } from 'zod'

type ErrorBody = { error: { code: string; message: string; details?: unknown; requestId: string } }

export function toErrorResponse(error: unknown, requestId: string): { status: number; body: ErrorBody } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details, requestId } },
    }
  }
  if (error instanceof ZodError) {
    return {
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
          requestId,
        },
      },
    }
  }
  logger.error({ err: error, requestId }, 'unhandled error')   // log once, with stack
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId } },
  }
}
```

Express error middleware:

```typescript
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const { status, body } = toErrorResponse(error, req.id)
  if (error instanceof RateLimitError) res.setHeader('Retry-After', String(error.retryAfterSeconds))
  res.status(status).json(body)
})
```

Next.js route handler:

```typescript
export async function POST(req: NextRequest) {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID()
  try {
    // ... handler logic
  } catch (error) {
    const { status, body } = toErrorResponse(error, requestId)
    return NextResponse.json(body, { status })
  }
}
```

## Timeouts and cancellation

```typescript
const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })

// combine the caller's signal with a timeout
const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(5_000)])
```

`fetch` does not throw on HTTP error statuses; check `res.ok` yourself.

## Retry with backoff and jitter

```typescript
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs?: number) {
    super(`HTTP ${status}`)
  }
}

const isTransient = (e: unknown) =>
  (e instanceof HttpError && (e.status === 408 || e.status === 429 || e.status >= 500)) ||
  (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'TypeError')) // network failure in fetch

export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, baseMs = 300, maxMs = 5_000, retryIf = isTransient } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (attempt >= maxAttempts || !retryIf(e)) throw e
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
      const hinted = e instanceof HttpError ? e.retryAfterMs : undefined
      const delay = hinted ?? Math.random() * backoff          // full jitter
      logger.warn({ attempt, delay, err: e }, 'retrying')
      await new Promise(r => setTimeout(r, delay))
    }
  }
}

// usage: only for idempotent requests (GET, or POST with an idempotency key)
const data = await withRetry(async () => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'))
    throw new HttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined)
  }
  return res.json()
})
```

## Minimal circuit breaker (to understand the idea; prefer a maintained library)

```typescript
export class CircuitBreaker {
  private failures = 0
  private openedAt = 0
  constructor(private threshold = 5, private coolDownMs = 30_000) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const open = this.failures >= this.threshold
    if (open && Date.now() - this.openedAt < this.coolDownMs) {
      throw new UpstreamError('dependency (circuit open)')
    }
    try {
      const result = await fn()                   // half-open trial when cool-down passed
      this.failures = 0
      return result
    } catch (e) {
      this.failures++
      if (this.failures >= this.threshold) this.openedAt = Date.now()
      throw e
    }
  }
}
```

## Async pitfalls

```typescript
// Bad: the rejection is lost
void sendWelcomeEmail(user)

// Better: supervised background work
sendWelcomeEmail(user).catch(e => logger.error({ err: e, userId: user.id }, 'welcome email failed'))

// Collect-all: inspect every result
const results = await Promise.allSettled(ids.map(fetchItem))
const failed = results.filter(r => r.status === 'rejected')
if (failed.length) logger.warn({ count: failed.length }, 'some items failed')

// Last resort only
process.on('unhandledRejection', reason => {
  logger.fatal({ err: reason }, 'unhandled rejection')
  process.exit(1)
})
```

## React error boundary

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { fallback: (reset: () => void) => ReactNode; onError?: (e: Error, i: ErrorInfo) => void; children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info)              // report to the error tracker
  }

  reset = () => this.setState({ error: null })

  render() {
    return this.state.error ? this.props.fallback(this.reset) : this.props.children
  }
}
```

Error boundaries catch render and lifecycle errors only; handle event-handler and async errors with `try/catch` and state.

## User messages

```typescript
const USER_MESSAGES: Record<string, string> = {
  NOT_FOUND: 'We could not find that item.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  FORBIDDEN: "You don't have permission to do that.",
  VALIDATION_ERROR: 'Please check the highlighted fields.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again later.',
}

export const userMessage = (code: string) => USER_MESSAGES[code] ?? USER_MESSAGES.INTERNAL_ERROR
```
