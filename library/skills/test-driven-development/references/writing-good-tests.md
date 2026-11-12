# Writing Good Tests

Load when writing or changing tests, adding mocks, or adding test helpers or cleanup code.

A test exists to catch a specific break. Two principles:

```
1. Every test names the break it catches
2. Every test exercises the real thing
```

Strict TDD gives both: a test written first and watched failing against real code has proven it can fail, and only earns a mock when the real dependency turns out slow or external.

## Principle 1: name the break

Before writing the test body, answer: **what production change would make this test fail, and is that change a bug or a decision?** A test earns its place by catching a wrong branch, a missing side effect, a wrong argument, a boundary case or a broken contract.

**Derive expectations independently.** Use literals and hand-checked fixtures. Table-driven tests with literal expected values are the preferred shape. An expectation computed by the code under test (or its helpers) passes no matter what the code does.

```typescript
// Bad: the same builder computes both sides, always true
const expected = buildSearchQuery({ tag: 'urgent' });
expect(buildSearchQuery({ tag: 'urgent' })).toBe(expected);

// Good: hand-derived literal
expect(buildSearchQuery({ tag: 'urgent' })).toBe('tag:"urgent"');
```

**No change detectors.** If only intentional decisions can fail a test (a constant's value, exact message wording, private structure), it fires on every redesign and sleeps through bugs. Test the behavior that depends on the decision: not "MAX_RETRIES is 5" but "a failing call is retried 5 times and a 6th attempt never happens".

**Behavior, not text.** Asserting that a script or config file contains an exact line only proves the source is the source. Run it against controlled inputs and assert outputs, side effects or exit codes.

**Your code, not the framework.** Test the contract your code makes at its boundary: the route you register, the query you emit, the payload you produce. Do not test that the router calls a registered handler; that is the framework's job. If upstream behavior surprised you, write one narrow characterization test naming the assumption. Constructors, getters, constants and trivial forwarding earn tests only when they validate, normalize, default, derive or cause side effects.

### Gate: before writing the test body

```
Name the production change that would make this test fail.
  Cannot name one            -> redesign around an observable behavior
  "The source text changed"  -> run the artifact and assert its effects
  Only intentional decisions -> change detector; test the dependent behavior
Is the expected value derived without the code under test?
  No -> replace with a literal or hand-checked fixture
```

## Principle 2: exercise the real thing

**A mock earns no assertions.** Asserting on a mock passes when the mock exists and fails when it does not; it says nothing about your code. Assert the real component's behavior. If the mock is what you are checking, unmock it or delete the assertion.

```typescript
// Good: real behavior
expect(screen.getByRole('navigation')).toBeInTheDocument();
// Bad: mock existence
expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
```

**Mock at the right level.** Learn every side effect of the real method before replacing it. Mock the slow or external operation and keep what the test depends on real. When unsure, run against the real implementation first and observe what must happen.

**Make doubles specific.** When arguments, call counts or ordering are part of the contract, assert them. Give each branch (success, error, malformed) its own fixture so the wrong branch cannot satisfy the test.

**Mirror real data completely.** Mock responses carry the full real structure, not just the fields this test reads. Partial mocks pass while integration breaks.

**Production classes carry production methods only.** Cleanup only tests need goes in test utilities. Ask: is this method called only from tests? Does this class own the resource's lifecycle?

**Prefer real components over complex mocks.** When mock setup outgrows the test logic, switch to an integration test with real components.

### Gate: before adding a mock or helper

```
List the real method's side effects; keep the ones the test needs real,
mock the slow/external level below them.
Mock responses mirror the complete real structure.
A method only tests call lives in test utilities.
About to assert on the mock itself? Unmock it or delete the assertion.
```

## The mutation check

Before finishing, mentally mutate the production code. At least one test should fail for each realistic mutation:

- Wrong constant or argument
- Wrong branch taken
- Missing state change or side effect
- Empty or default return
- Missing validation for zero, empty, null, unauthorized or malformed input

A mutation nothing catches marks the behavior as unprotected, or the test as tautological.

## Common mistakes

| Wrong | Right |
|---|---|
| `expect(component.state.count).toBe(5)` (internal state) | `expect(screen.getByText('Count: 5'))...` (what users see) |
| `click('.css-class-xyz')` (brittle selector) | Click by role, label text or a stable test id |
| Test B depends on data created by test A | Each test creates its own data |
| Arbitrary `sleep(500)` before asserting | Wait for the actual condition (see systematic-debugging references) |

## Warning signs

- Setup and assertion share the same object, guaranteeing equality.
- The test can only fail through a crash or a missing selector.
- The test fails on every intentional change but never on accidental breakage.
- Expected values hidden behind loops, builders or helpers.
- The test greps source text.
- The test would still matter if only the framework remained.
- The test exists for coverage and checks no outcome.
- An assertion checks a `*-mock` id or fails if the mock is removed.
- Mock setup is more than half the test, or "mocking just to be safe".
