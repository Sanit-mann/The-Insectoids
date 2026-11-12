# React Testing: Examples

Code for [../SKILL.md](../SKILL.md). Uses Vitest (`vi`); with Jest use `jest.fn()` / `jest.spyOn`.

## Queries

```tsx
screen.getByRole('button', { name: /save/i })   // best
screen.getByLabelText('Email')                   // inputs
screen.queryByText('Loading')                    // assert absence: expect(...).not.toBeInTheDocument()
await screen.findByText('Loaded')                // appears after async work
screen.getByTestId('save-btn')                   // last resort
```

## user-event

```tsx
import userEvent from '@testing-library/user-event'

test('submits the form', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  render(<UserForm onSubmit={onSubmit} />)

  await user.type(screen.getByLabelText('Email'), 'user@example.com')
  await user.click(screen.getByRole('button', { name: /save/i }))

  expect(onSubmit).toHaveBeenCalledWith({ email: 'user@example.com' })
})
```

With fake timers:

```tsx
vi.useFakeTimers()
const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
```

## Async waits

```tsx
expect(await screen.findByText('Loaded')).toBeInTheDocument()
await waitFor(() => expect(saveSpy).toHaveBeenCalled())
await waitForElementToBeRemoved(() => screen.queryByText('Loading'))
```

## MSW setup

```ts
// test/msw.ts
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

export const handlers = [
  http.get('/api/users/:id', ({ params }) => HttpResponse.json({ id: params.id, name: 'Alice' })),
  http.post('/api/users', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    return HttpResponse.json({ id: 'new-id', ...body }, { status: 201 })
  }),
]

export const server = setupServer(...handlers)

// test/setup.ts (registered as the runner's setup file)
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

Per-test override:

```tsx
test('renders error on 500', async () => {
  server.use(http.get('/api/users/:id', () => new HttpResponse(null, { status: 500 })))
  renderWithProviders(<UserPage id="1" />)
  expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument()
})
```

## Shared providers

```tsx
// test/test-utils.tsx
import { render, type RenderOptions } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

export function renderWithProviders(
  ui: React.ReactElement,
  { route = '/', ...options }: RenderOptions & { route?: string } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }) // fresh per render
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={lightTheme}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
    options,
  )
}

export * from '@testing-library/react'
```

## Hook tests

```tsx
import { renderHook, act, waitFor } from '@testing-library/react'

test('useCounter increments and decrements', () => {
  const { result } = renderHook(() => useCounter(0))
  act(() => result.current.increment())
  expect(result.current.count).toBe(1)
  act(() => result.current.decrement())
  expect(result.current.count).toBe(0)
})

test('useUser fetches user data', async () => {
  // Create the client once per test, outside the wrapper, so it survives re-renders.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useUser('1'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data).toEqual({ id: '1', name: 'Alice' })
})
```

## axe

```tsx
// jest-axe: import { axe, toHaveNoViolations } from 'jest-axe'; expect.extend(toHaveNoViolations)
// vitest-axe: import { axe } from 'vitest-axe' and register its matchers once in the setup file
import { axe } from 'vitest-axe'

test('UserCard has no a11y violations', async () => {
  const { container } = render(<UserCard user={mockUser} />)
  expect(await axe(container)).toHaveNoViolations()
})
```

## Form flow with MSW

```tsx
test('submits user form and shows success', async () => {
  server.use(http.post('/api/users', () => HttpResponse.json({ id: '1', name: 'Alice' }, { status: 201 })))
  const user = userEvent.setup()
  renderWithProviders(<UserForm />)

  await user.type(screen.getByLabelText('Name'), 'Alice')
  await user.type(screen.getByLabelText('Email'), 'alice@example.com')
  await user.click(screen.getByRole('button', { name: /save/i }))

  expect(await screen.findByText(/saved successfully/i)).toBeInTheDocument()
})
```

## Error boundary

```tsx
function Broken(): never { throw new Error('boom') }

test('error boundary renders fallback', () => {
  // Silence the expected React error log, then restore so real errors stay visible.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(
      <ErrorBoundary fallback={<div>Something went wrong</div>}>
        <Broken />
      </ErrorBoundary>,
    )
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
  } finally {
    spy.mockRestore()
  }
})
```

## Suspense boundary

```tsx
test('shows loading then content', async () => {
  renderWithProviders(
    <Suspense fallback={<div>Loading...</div>}>
      <UserDetail id="1" />
    </Suspense>,
  )
  expect(screen.getByText('Loading...')).toBeInTheDocument()
  expect(await screen.findByText('Alice')).toBeInTheDocument()
})
```

## Coverage config (Vitest)

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
})
```
