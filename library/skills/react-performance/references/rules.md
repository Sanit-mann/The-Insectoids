# React Performance: Rule Examples

Code for [../SKILL.md](../SKILL.md), in the same priority order. Adapted from Vercel's react-best-practices rules (MIT) via ECC (MIT).

## 1. Waterfalls

Cheap condition first:

```ts
// Bad
const flag = await getFlag('show-page')
if (!flag || !id) return null

// Good
if (!id) return null
const flag = await getFlag('show-page')
if (!flag) return null
```

Defer the await into the branch that uses it:

```ts
if (mode === 'guest') return renderGuest()
const user = await getUser(id)
return renderUser(user)
```

Independent work in parallel:

```ts
const [user, posts, followers] = await Promise.all([getUser(id), getPosts(id), getFollowers(id)])
```

Partial dependencies: start early, await late, chain dependents:

```ts
const userP = fetchUser()
const profileP = userP.then((u) => fetchProfile(u.id)) // does not wait for config
const [user, config, profile] = await Promise.all([userP, fetchConfig(), profileP])
```

API route or Server Action:

```ts
export async function GET() {
  const sessionP = auth()
  const configP = fetchConfig()
  const session = await sessionP
  const [config, data] = await Promise.all([configP, fetchData(session.user.id)])
  return Response.json({ data, config })
}
```

Server Components fetch in parallel through composition:

```tsx
// Bad: sequential inside one component
export default async function Page() {
  const user = await getUser()
  const cart = await getCart()
  return <View user={user} cart={cart} />
}

// Good: siblings fetch concurrently, each can stream behind its own Suspense
export default function Page() {
  return (
    <View>
      <Suspense fallback={<UserSkeleton />}><UserSection /></Suspense>
      <Suspense fallback={<CartSkeleton />}><CartSection /></Suspense>
    </View>
  )
}
```

## 2. Bundle size

```ts
// Bad: pulls the library's whole entry module graph
import { Check, X, Menu } from 'icon-library'

// Good (framework option, Next.js example)
// next.config.js
module.exports = { experimental: { optimizePackageImports: ['icon-library'] } }

// Good (no framework support): direct paths, if they ship types
import Button from 'ui-kit/Button'
```

Statically analyzable dynamic imports:

```ts
// Bad
const mod = await import(`./pages/${name}`)
// Good
const mod = name === 'home' ? await import('./pages/home') : await import('./pages/about')
```

Lazy heavy components and feature-gated modules:

```tsx
const HeavyChart = lazy(() => import('./HeavyChart'))
// <Suspense fallback={<ChartSkeleton />}><HeavyChart data={data} /></Suspense>

if (user.role === 'admin') {
  const { AdminPanel } = await import('./admin/AdminPanel')
}
```

Preload on intent:

```tsx
const loadEditor = () => import('./Editor')
<button onMouseEnter={loadEditor} onFocus={loadEditor} onClick={openEditor}>Edit</button>
```

## 3. Server-side

Auth inside every Server Action:

```ts
'use server'
export async function deleteUser(formData: FormData) {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  const targetId = String(formData.get('id'))
  if (session.user.role !== 'admin' && session.user.id !== targetId) throw new Error('Forbidden')
  await db.user.delete({ where: { id: targetId } })
}
```

Per-request dedup:

```ts
import { cache } from 'react'
export const getUser = cache(async (id: string) => db.user.findUnique({ where: { id } }))
```

Cross-request LRU (process-local; use a shared cache across instances):

```ts
import { LRUCache } from 'lru-cache'
const users = new LRUCache<string, User>({ max: 1000, ttl: 5 * 60_000 })

export async function getUserCached(id: string) {
  const hit = users.get(id)
  if (hit) return hit
  const user = await db.user.findUnique({ where: { id } })
  if (user) users.set(id, user)
  return user
}
```

Minimize serialization:

```tsx
// Bad: serializes all 50 fields
return <Profile user={user} />
// Good
return <Profile name={user.name} avatarUrl={user.avatarUrl} />
```

Duplicate serialization (dedup is by reference):

```tsx
// Bad: sends the strings twice
<ClientList usernames={usernames} sorted={usernames.toSorted()} />
// Good: send once, sort on the client
<ClientList usernames={usernames} />
```

No request data in module state:

```tsx
// Bad: concurrent requests overwrite each other
let currentUser: User | null = null
export default async function Page() { currentUser = await auth(); return <Dashboard /> }

// Good: pass it down
export default async function Page() { const user = await auth(); return <Dashboard user={user} /> }
```

Hoist static I/O:

```ts
const fontData = await readFile(fontPath) // module scope, runs once
```

Nested fetches in parallel:

```ts
const users = await getUsers()
const enriched = await Promise.all(users.map(async (u) => ({ ...u, posts: await getPostsFor(u.id) })))
// If this is N queries against your own DB, prefer one batched query instead.
```

Non-blocking work after the response (Next.js):

```ts
import { after } from 'next/server'
export async function GET() {
  const data = await getData()
  after(() => logAnalytics(data))
  return Response.json(data)
}
```

## 4. Client fetching

```tsx
// Bad: every instance fetches, no cache
useEffect(() => { fetch('/api/users').then((r) => r.json()).then(setUsers) }, [])

// Good: shared cache and dedup
const { data: users } = useSWR('/api/users', fetcher)       // or useQuery({ queryKey: ['users'], ... })
```

Passive listener:

```ts
window.addEventListener('scroll', onScroll, { passive: true })
```

Versioned storage:

```ts
const KEY = 'prefs:v2'
function readPrefs(): Prefs | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? PrefsSchema.parse(JSON.parse(raw)) : null
  } catch { return null } // private mode, quota, corrupt data
}
```

## 5. Re-renders

Read in the callback, not via subscription:

```tsx
// Bad: re-renders whenever count changes
const count = useStore((s) => s.count)
const onClick = () => doSomething(count)
// Good
const onClick = () => doSomething(useStore.getState().count)
```

Subscribe to a derived boolean:

```tsx
const hasItems = useStore((s) => s.cart.length > 0)
```

Memoized subtree enables early return:

```tsx
const UserAvatar = memo(function UserAvatar({ user }: { user: User }) {
  const id = useMemo(() => computeAvatarId(user), [user])
  return <Avatar id={id} />
})
function Profile({ user, loading }: Props) {
  if (loading) return <Skeleton />
  return <UserAvatar user={user} />
}
```

Stable defaults, primitive deps, functional updates, lazy init:

```tsx
const EMPTY: Item[] = []
<List items={items ?? EMPTY} />

useEffect(() => { /* ... */ }, [id, name])          // not [{ id, name }]

const increment = useCallback(() => setCount((c) => c + 1), [])

const [tree] = useState(() => parseTree(largeInput))
```

Transitions and deferred values:

```tsx
const [isPending, startTransition] = useTransition()
startTransition(() => setFilters(next))

const deferredQuery = useDeferredValue(query)
const results = useMemo(() => expensiveSearch(deferredQuery), [deferredQuery])
```

No inline components:

```tsx
// Bad: Inner is a new type every render, so its subtree remounts
function Outer() { const Inner = () => <span />; return <Inner /> }
```

## 6. Rendering

```css
.row { content-visibility: auto; contain-intrinsic-size: auto 80px; }
```

```tsx
const STATIC_HEADER = <h1>Title</h1> // hoisted static JSX

{count > 0 ? <Badge>{count}</Badge> : null} // not {count && ...}

<time suppressHydrationWarning>{new Date().toLocaleString()}</time> // single leaf only

<Activity mode={isOpen ? 'visible' : 'hidden'}><ExpensiveMenu /></Activity> // React 19.2+
```

No-flicker theme before hydration:

```tsx
<script
  dangerouslySetInnerHTML={{
    __html: `try{document.documentElement.dataset.theme=localStorage.getItem('theme')||'light'}catch(e){}`,
  }}
/>
```

The script content must be a constant string; never interpolate user data into it.

Resource hints:

```tsx
import { preload, preconnect } from 'react-dom'
preconnect('https://api.example.com')
preload('/fonts/inter.woff2', { as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' })
```

## 7. JS hot paths

```ts
const byId = new Map(users.map((u) => [u.id, u]))      // repeated lookups
const allowed = new Set(ids); allowed.has(x)             // membership
const names = rows.flatMap((r) => (r.active ? [r.name] : [])) // filter+map in one pass
const RE = /\s+/g                                        // hoisted out of the loop
let min = Infinity; for (const n of nums) if (n < min) min = n // not sort()[0]
const sorted = props.items.toSorted(compare)             // do not mutate props
requestIdleCallback(() => warmCache())                   // non-critical work
```

## 8. Advanced

```tsx
// React 19.2+: stable event function, never in deps
function SearchInput({ onSearch }: { onSearch: (q: string) => void }) {
  const [query, setQuery] = useState('')
  const onSearchEvent = useEffectEvent(onSearch)
  useEffect(() => {
    const t = setTimeout(() => onSearchEvent(query), 300)
    return () => clearTimeout(t)
  }, [query])
}

// One-time app init: module guard, not a plain mount effect
let didInit = false
export function initApp() {
  if (didInit) return
  didInit = true
  startTelemetry()
}
```
