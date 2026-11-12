# React Patterns: Examples

Code for the rules in [../SKILL.md](../SKILL.md). Library names are examples; use what the project already has.

## Derive during render

```tsx
// Good
function Cart({ items }: { items: CartItem[] }) {
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0)
  return <span>{formatMoney(total)}</span>
}

// Bad: extra render, can desync
function Cart({ items }: { items: CartItem[] }) {
  const [total, setTotal] = useState(0)
  useEffect(() => setTotal(items.reduce((s, i) => s + i.price * i.qty, 0)), [items])
  return <span>{formatMoney(total)}</span>
}
```

## Server and Client Components

```tsx
// ProductPage.tsx (Server Component: async, no client JS)
export default async function ProductPage({ id }: { id: string }) {
  const product = await getProduct(id)
  if (!product) return <NotFound />
  return (
    <ProductView name={product.name} price={product.price}>
      <AddToCartButton productId={product.id} />
    </ProductView>
  )
}

// AddToCartButton.tsx
'use client'
import { useTransition } from 'react'
import { addToCart } from './actions'

export function AddToCartButton({ productId }: { productId: string }) {
  const [pending, startTransition] = useTransition()
  return (
    <button disabled={pending} onClick={() => startTransition(() => addToCart(productId))}>
      {pending ? 'Adding...' : 'Add to cart'}
    </button>
  )
}
```

Router-specific details (how `params` arrive, loaders) follow the framework's docs; for example, as of Next.js 15 route `params` is a Promise.

## Server Action (separate server file)

```ts
// actions.ts
'use server'
import { z } from 'zod'

const UpdateUser = z.object({ id: z.string().min(1), name: z.string().min(1).max(100) })
type State = { error: string | null }

export async function updateUserAction(_prev: State, formData: FormData): Promise<State> {
  const session = await getSession()
  if (!session) return { error: 'Not signed in' }
  const parsed = UpdateUser.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: 'Invalid input' }
  if (parsed.data.id !== session.userId) return { error: 'Not allowed' }
  await saveUser(parsed.data)
  return { error: null }
}
```

## Form with useActionState (React 19)

```tsx
'use client'
import { useActionState } from 'react'
import { updateUserAction } from './actions'

export function UserForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(updateUserAction, { error: null })
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={userId} />
      <label htmlFor="name">Name</label>
      <input id="name" name="name" required />
      <button type="submit" disabled={pending}>Save</button>
      {state.error && <p role="alert">{state.error}</p>}
    </form>
  )
}
```

## Optimistic UI (React 19)

```tsx
'use client'
import { useOptimistic } from 'react'

export function MessageList({ messages, send }: { messages: Message[]; send: (text: string) => Promise<void> }) {
  const [optimistic, addOptimistic] = useOptimistic(
    messages,
    (state, next: Message) => [...state, next],
  )
  async function action(formData: FormData) {
    const text = String(formData.get('text'))
    addOptimistic({ id: `pending-${crypto.randomUUID()}`, text, pending: true })
    await send(text) // on failure the optimistic item disappears when the action settles
  }
  return (
    <>
      <ul>{optimistic.map((m) => <li key={m.id}>{m.text}</li>)}</ul>
      <form action={action}>
        <label htmlFor="text">Message</label>
        <input id="text" name="text" />
        <button type="submit">Send</button>
      </form>
    </>
  )
}
```

## Suspense + error boundary per region

```tsx
<ErrorBoundary fallback={<ErrorView retry />}>
  <Suspense fallback={<UserSkeleton />}>
    <UserDetail id={id} />
  </Suspense>
</ErrorBoundary>
```

## Debounced search with a server-state library

```tsx
function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

function SearchBox() {
  const [query, setQuery] = useState('')
  const q = useDebounce(query)
  const { data } = useQuery({
    queryKey: ['search', q],
    queryFn: ({ signal }) => searchApi(q, { signal }),
    enabled: q.length > 0,
  })
  return (
    <>
      <label htmlFor="search">Search</label>
      <input id="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <Results items={data ?? []} />
    </>
  )
}
```

## Split contexts by change rate

```tsx
const ThemeContext = createContext<Theme>('light')            // rarely changes
const NotificationsContext = createContext<Notification[]>([]) // changes often
// Theme consumers do not re-render when notifications change.
```

## Latest callback in an effect without re-subscribing

```tsx
// React 19.2+
function useWindowEvent(event: string, handler: (e: Event) => void) {
  const onEvent = useEffectEvent(handler)
  useEffect(() => {
    window.addEventListener(event, onEvent)
    return () => window.removeEventListener(event, onEvent)
  }, [event])
}

// Older React: keep the handler in a ref updated in an effect (not during render)
function useWindowEventLegacy(event: string, handler: (e: Event) => void) {
  const ref = useRef(handler)
  useEffect(() => { ref.current = handler }, [handler])
  useEffect(() => {
    const listener = (e: Event) => ref.current(e)
    window.addEventListener(event, listener)
    return () => window.removeEventListener(event, listener)
  }, [event])
}
```
