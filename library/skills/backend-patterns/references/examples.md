# Backend Patterns: Examples

Code for [../SKILL.md](../SKILL.md). Framework calls are illustrative; adapt to the project's framework, ORM, queue and logger.

## Layers

```ts
// domain/market.ts
export interface Market { id: string; ownerId: string; name: string; status: 'active' | 'closed' }

// repositories/market-repository.ts (interface the service depends on)
export interface MarketRepository {
  findById(id: string): Promise<Market | undefined>
  findByIds(ids: readonly string[]): Promise<Market[]>
  list(filter: { status?: Market['status']; limit: number; cursor?: string }): Promise<Market[]>
  update(id: string, patch: Partial<Pick<Market, 'name' | 'status'>>): Promise<Market>
}

// services/market-service.ts (business rules + resource authorization; no HTTP)
export class MarketService {
  constructor(private readonly markets: MarketRepository) {}

  async rename(principal: Principal, id: string, name: string): Promise<Market> {
    const market = await this.markets.findById(id)
    if (!market) throw new NotFoundError('market')
    if (market.ownerId !== principal.userId && !principal.roles.includes('admin')) {
      throw new ForbiddenError('market')
    }
    if (market.status === 'closed') throw new ConflictError('market_closed', 'Closed markets cannot be renamed')
    return this.markets.update(id, { name })
  }
}

// routes/markets.ts (HTTP only: validate, call service, map result)
const RenameBody = z.object({ name: z.string().trim().min(1).max(200) }).strict()

router.patch('/markets/:id', requireAuth, async (req, res) => {
  const { name } = RenameBody.parse(req.body)          // ZodError -> 400/422 in the central handler
  const market = await marketService.rename(req.principal, req.params.id, name)
  res.json({ data: market })
})
```

## Typed errors and one central handler

```ts
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = new.target.name
  }
}
export class NotFoundError extends AppError {
  constructor(resource: string) { super(404, 'not_found', `${resource} not found`) }
}
export class ForbiddenError extends AppError {
  constructor(resource: string) { super(403, 'forbidden', `Not allowed to access ${resource}`) }
}
export class ConflictError extends AppError {
  constructor(code: string, message: string) { super(409, code, message) }
}

// Central handler (Express-style signature)
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).type('application/problem+json').json({
      type: `https://errors.example.com/${err.code}`, title: err.message, status: err.status, code: err.code,
    })
  }
  if (err instanceof z.ZodError) {
    return res.status(422).type('application/problem+json').json({
      type: 'https://errors.example.com/validation_error', title: 'Request validation failed', status: 422,
      code: 'validation_error',
      errors: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message, code: i.code })),
    })
  }
  req.log.error({ err, requestId: req.id }, 'unhandled error')   // full detail stays in logs
  return res.status(500).type('application/problem+json').json({
    type: 'about:blank', title: 'Internal Server Error', status: 500,
  })
}

process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'unhandled rejection'); process.exit(1) })
```

## Authentication middleware (JWT)

```ts
import { jwtVerify, createRemoteJWKSet } from 'jose'

const JWKS = createRemoteJWKSet(new URL(config.AUTH_JWKS_URL))

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return next(new UnauthorizedError())
  try {
    const { payload } = await jwtVerify(header.slice(7), JWKS, {
      algorithms: ['RS256'],              // pinned
      issuer: config.AUTH_ISSUER,
      audience: config.AUTH_AUDIENCE,     // expiry is checked by default
    })
    req.principal = PrincipalSchema.parse({ userId: payload.sub, roles: payload['roles'] ?? [] })
    next()
  } catch (cause) {
    next(new UnauthorizedError({ cause }))
  }
}
```

## Role-to-permission check

```ts
type Permission = 'market:read' | 'market:write' | 'market:delete'
const rolePermissions: Record<Role, readonly Permission[]> = {
  admin: ['market:read', 'market:write', 'market:delete'],
  member: ['market:read', 'market:write'],
}
export function requirePermission(p: Permission) {
  return (req: Request, _res: Response, next: NextFunction) =>
    req.principal.roles.some((r) => rolePermissions[r]?.includes(p)) ? next() : next(new ForbiddenError('resource'))
}
// Role checks gate the route; ownership checks still happen in the service.
```

## N+1 fix

```ts
// Bad: one query per market
for (const m of markets) m.creator = await users.findById(m.creatorId)

// Good: one batched query
const creators = await users.findByIds([...new Set(markets.map((m) => m.creatorId))])
const byId = new Map(creators.map((c) => [c.id, c]))
const withCreators = markets.map((m) => ({ ...m, creator: byId.get(m.creatorId) }))
```

## Transaction (no network calls inside)

```ts
await db.transaction(async (tx) => {
  const market = await tx.markets.create(marketData)
  await tx.positions.create({ ...positionData, marketId: market.id })
  await tx.outbox.create({ type: 'market.created', payload: { marketId: market.id } }) // outbox row
})
// A separate relay publishes outbox rows to the queue and marks them sent.
```

## Cache-aside with scoped keys and single-flight

```ts
const inflight = new Map<string, Promise<Market | undefined>>()

export async function getMarketCached(tenantId: string, id: string): Promise<Market | undefined> {
  const key = `t:${tenantId}:market:${id}`
  try {
    const hit = await cache.get(key)
    if (hit) return MarketSchema.parse(JSON.parse(hit))
  } catch (err) {
    logger.warn({ err, key }, 'cache read failed') // treat as a miss
  }
  let p = inflight.get(key)
  if (!p) {
    p = repo.findById(id).finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  const market = await p
  if (market) await cache.set(key, JSON.stringify(market), { ttlSeconds: 300 }).catch(() => {})
  return market
}

export async function invalidateMarket(tenantId: string, id: string) {
  await cache.del(`t:${tenantId}:market:${id}`)
}
```

## Retry with backoff, jitter and a retryable check

```ts
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  { attempts = 3, baseMs = 200, maxMs = 5_000, timeoutMs = 5_000, isRetryable = defaultRetryable } = {},
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(AbortSignal.timeout(timeoutMs))
    } catch (err) {
      lastError = err
      if (attempt === attempts - 1 || !isRetryable(err)) break
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt)
      await new Promise((r) => setTimeout(r, Math.random() * backoff)) // full jitter
    }
  }
  throw lastError
}
// defaultRetryable: network errors, timeouts, HTTP 429/502/503/504. Only wrap idempotent operations.
```

## Durable, idempotent job

```ts
// Producer: enqueue ids, not records; dedupe with a job id
await queue.add('index-market', { marketId }, {
  jobId: `index-market:${marketId}:${version}`,
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
})

// Worker: safe to run twice
worker.process('index-market', async ({ marketId }, { signal }) => {
  const market = await repo.findById(marketId)
  if (!market) return                          // deleted meanwhile: nothing to do
  await searchIndex.upsert(market, { signal }) // upsert, not insert
})
// Exhausted jobs go to a dead-letter queue with their payload for replay.
```

## Structured logging with request context

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
const requestContext = new AsyncLocalStorage<{ requestId: string; userId?: string }>()

app.use((req, res, next) => {
  const requestId = req.get('x-request-id') ?? crypto.randomUUID()
  res.setHeader('x-request-id', requestId)
  requestContext.run({ requestId }, next)
})

export const log = {
  info: (msg: string, fields: Record<string, unknown> = {}) =>
    logger.info({ ...requestContext.getStore(), ...redact(fields) }, msg),
}
```

## Config validation at startup

```ts
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.string().url(),
  AUTH_ISSUER: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
})
export const config = Env.parse(process.env) // crash on boot, not on first request
```

## Graceful shutdown

```ts
const server = app.listen(config.PORT)

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  server.close()                              // stop accepting; in-flight requests finish
  const deadline = setTimeout(() => process.exit(1), 25_000)
  await Promise.allSettled([worker.close(), queue.close(), db.end(), cache.quit()])
  clearTimeout(deadline)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
```
