# TypeScript Patterns: Examples

Code for the rules in [../SKILL.md](../SKILL.md).

## Strict tsconfig baseline

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true
    // optional: "exactOptionalPropertyTypes": true
    // runtime type stripping: "erasableSyntaxOnly": true (TS 5.8+)
  }
}
```

Living with `noUncheckedIndexedAccess`:

```ts
const [first] = items
if (first === undefined) throw new Error('expected at least one item')
// first is narrowed to the element type here
```

## unknown + narrowing instead of any

```ts
interface Config { timeout: number; retries: number }
const DEFAULT_CONFIG: Config = { timeout: 30_000, retries: 3 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`Expected ${field} to be a positive integer`)
  }
  return value
}

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG }
  return {
    timeout: raw['timeout'] === undefined ? DEFAULT_CONFIG.timeout : toPositiveInt(raw['timeout'], 'timeout'),
    retries: raw['retries'] === undefined ? DEFAULT_CONFIG.retries : toPositiveInt(raw['retries'], 'retries'),
  }
}
```

## Schema at the boundary

```ts
import { z } from 'zod' // or any schema library, used consistently

const userInputSchema = z.object({
  email: z.string().email(),
  age: z.number().int().min(0).max(150),
})
export type UserInput = z.infer<typeof userInputSchema>

const input: UserInput = userInputSchema.parse(rawBody) // validate once at the edge
```

## Discriminated union + exhaustiveness

```ts
type Transaction =
  | { kind: 'draft'; id: string }
  | { kind: 'submitted'; id: string; submittedAt: Date }
  | { kind: 'paid'; id: string; paidAt: Date; amountCents: number }

function describe(t: Transaction): string {
  switch (t.kind) {
    case 'draft': return 'Saved but not sent'
    case 'submitted': return `Submitted on ${t.submittedAt.toISOString()}`
    case 'paid': return `Paid ${t.amountCents} cents on ${t.paidAt.toISOString()}`
    default: return assertNever(t) // new member => compile error
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled member: ${JSON.stringify(value)}`)
}
```

## Brands

```ts
declare const brand: unique symbol
export type CustomerId = string & { [brand]: 'CustomerId' }

export function toCustomerId(value: string): CustomerId {
  if (!/^cus_[a-z0-9]+$/.test(value)) throw new TypeError(`Invalid customer id: ${value}`)
  return value as CustomerId // cast lives next to the check that justifies it
}
```

## Generics instead of caller casts

```ts
// Bad: returns unknown, every caller casts
export function getCached(key: string): unknown { return cache.get(key) }

// Good: caller's type flows through a parser
export function getCached<T>(key: string, parse: (raw: string) => T): T | undefined {
  const raw = cache.get(key)
  return raw === undefined ? undefined : parse(raw)
}
```

## Type predicate and assertion function

```ts
function isConfig(value: unknown): value is Config {
  if (typeof value !== 'object' || value === null) return false
  if (!('timeout' in value) || !('retries' in value)) return false
  const { timeout, retries } = value
  return typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0 &&
         typeof retries === 'number' && Number.isInteger(retries) && retries > 0
}

function assertIsStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new TypeError('Expected an array of strings')
  }
}
```

## satisfies and readonly

```ts
const statusByAction = {
  new: 'open',
  reopen: 'open',
  close: 'closed',
} as const satisfies Record<Action, Status>

export function totalAmount(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + item.amountCents, 0)
}
```

## Result for expected failures

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

function createUser(input: UserInput): Result<User, ValidationIssue[]> {
  const issues = validate(input)
  if (issues.length > 0) return { ok: false, error: issues }
  return { ok: true, value: { id: generateId(), ...input } }
}
```

## Boundary fetch with validation and error cause

```ts
async function loadUser(userId: string): Promise<User> {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new TypeError('Invalid user id')
  const response = await fetch(`/users/${encodeURIComponent(userId)}`)
  if (!response.ok) throw new Error(`Failed to load user ${userId}: ${response.status}`)
  const data: unknown = await response.json()
  if (!isUser(data)) throw new TypeError(`Invalid user payload for ${userId}`)
  return data
}

export async function getUser(userId: string): Promise<User> {
  try {
    return await loadUser(userId)
  } catch (error: unknown) {
    throw new Error('user lookup failed', { cause: error })
  }
}
```

## allSettled for independent fan-out

```ts
const results = await Promise.allSettled(sourceIds.map((id) => fetchCount(id)))
const total = results.reduce((sum, r) => {
  if (r.status === 'fulfilled') return sum + r.value
  log.warn('count fetch failed', r.reason)
  return sum
}, 0)
```

## Bounded concurrency pool

```ts
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Bad limit: ${limit}`)
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await mapper(items[i] as T, i)
    }
  })
  // Fail-fast: first rejection rejects the pool, but other workers keep running.
  // Pass an AbortSignal into mapper if in-flight work must stop.
  await Promise.all(workers)
  return results
}
```

## Timeouts and cancellation

```ts
// Abortable operation: prefer AbortSignal
const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })

// Combine a caller's signal with a timeout
const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(5_000)])

// Non-abortable operation: race with a timer and always clear it
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
```

## Sync vs async throws

```ts
async function asyncFails(): Promise<never> {
  throw new Error('always a rejection')
}
function lazyFails(): Promise<never> {
  throw new Error('throws synchronously: callers need try/catch AND .catch')
}
```

## Public module surface

```ts
// user/index.ts
export type { UserAccount, UserRole } from './model'
export { createUser, findUser, updateUser } from './service'
```

## Type-level test

```ts
import { expectTypeOf } from 'vitest'

expectTypeOf<Result<User, ValidationIssue[]>>().toEqualTypeOf<
  { ok: true; value: User } | { ok: false; error: ValidationIssue[] }
>()
```
