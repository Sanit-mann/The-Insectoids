---
name: python-testing
description: Write and review pytest tests for Python. Covers test structure, fixtures and scopes, parametrize, mocking only at real boundaries, async tests, temp files, markers, database isolation and coverage. Use when writing, fixing or reviewing Python tests, or setting up pytest config. Pair with test-driven-development for the red-green-refactor cycle.
metadata:
  kind: skill
  castes: [tester, coder, reviewer]
  tags: [python, testing, pytest]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/python-testing/SKILL.md
      license: MIT
---

# Python Testing with pytest

Tests that check behaviour, run fast, never depend on each other, and fail for one clear reason.

## When to use

- Adding or changing tests in a Python project.
- Reviewing test quality or coverage.
- Setting up or fixing pytest configuration.

The workflow (failing test first, minimal fix, refactor) lives in test-driven-development. This skill is the pytest how-to.

## Steps

1. Read the test config (`[tool.pytest.ini_options]` in `pyproject.toml`, or `pytest.ini`) and the nearest `conftest.py` files. Reuse existing fixtures before writing new ones.
2. Run the existing suite (or the relevant file) first so you know the baseline.
3. Write the test. Watch it fail for the right reason.
4. Make it pass; run the file, then the full suite.
5. Check coverage of the changed code.

## Writing a test

- One behaviour per test. Arrange, act, assert, with a blank line between parts if it helps.
- Name it for the behaviour: `test_login_with_wrong_password_returns_401`.
- Plain `assert`. pytest shows both sides on failure.
- Exceptions: `with pytest.raises(ValueError, match="invalid email"):`. Inspect attributes via `as exc_info`.
- Floats: `assert result == pytest.approx(0.3)`.
- No logic in tests (no `if`, loops that hide which case failed). Use parametrize instead.
- No `try/except` in tests and no `print` debugging left behind.
- Test behaviour through the public interface, not private helpers or call order.

## Fixtures

- Use a fixture for shared setup; use `yield` for teardown (code after `yield` runs even if the test fails).
- Put shared fixtures in `conftest.py` at the narrowest directory that needs them.
- **Scope rule:** default `function` scope. Widen to `module`/`session` only for expensive resources that tests cannot mutate (a database engine, a container), and reset state per test with a function-scoped fixture on top.
- `autouse=True` only for true global hygiene (resetting a registry, isolating env vars). Hidden setup makes tests hard to read.
- Factory fixtures (a fixture that returns a function) when tests need several variants of an object.
- Prefer built-ins:
  - `tmp_path` for files (the older `tmpdir` returns legacy `py.path` objects).
  - `monkeypatch` for env vars, attributes and `sys.path`; it undoes itself.
  - `caplog` for log assertions, `capsys` for stdout/stderr.

## Parametrize

- `@pytest.mark.parametrize("raw, expected", [...], ids=[...])` for input/output tables. Give readable ids.
- Cover edges: empty, `None`, zero, negative, boundary values, unicode, very long input, duplicates.
- Mark single cases with `pytest.param(..., marks=pytest.mark.xfail(reason=...))`.
- Parametrized fixtures (`@pytest.fixture(params=[...])`) run every dependent test once per value; use them for "same tests against several backends".

## Mocking: only at boundaries

Mock what is slow, non-deterministic or outside your control:
- network calls and third-party APIs, email/SMS/payment providers
- the clock, randomness, UUIDs
- sometimes the filesystem (but `tmp_path` is usually simpler and more honest)

Do **not** mock:
- your own pure logic (call it for real)
- the database in integration tests (use a real test database of the same engine)
- the unit under test, or so many collaborators that the test only checks wiring

Rules:
- Prefer dependency injection with a small fake class over `patch`. Fakes stay valid when internals change.
- Patch where the name is **looked up**, not where it is defined: `patch("myapp.services.send_email")`, not `patch("myapp.email.send_email")`, if `services` did `from myapp.email import send_email`.
- Use `autospec=True` (or `create_autospec`) so the mock rejects calls with wrong signatures.
- `patch` on an `async def` target yields an `AsyncMock` automatically; assert with `assert_awaited_once_with`.
- Wrap third-party clients in your own thin adapter and mock the adapter ("don't mock what you don't own").
- Assert on outcomes first; assert on calls only when the call *is* the behaviour (an email was sent).
- `side_effect` to simulate errors and sequences; test the error paths, not only the happy path.

## Async code

- Use pytest-asyncio or the AnyIO pytest plugin, whichever the project has. As of pytest-asyncio 1.x, set `asyncio_mode = "auto"` or mark tests with `@pytest.mark.asyncio`; the old `event_loop` fixture is gone.
- Async fixtures use `@pytest_asyncio.fixture` (strict mode) or plain `@pytest.fixture` (auto mode).
- ASGI apps: `httpx.AsyncClient(transport=ASGITransport(app=app))`. This does not run lifespan startup/shutdown; wrap with `asgi_lifespan.LifespanManager` if the app needs it.

## Databases

- Isolate each test: wrap it in a transaction (or savepoint) and roll back, or truncate between tests.
- Run integration tests against the same engine as production (for example Postgres in a container). SQLite in memory behaves differently (types, constraints, locking) and hides real bugs.
- Never point tests at a shared or production database.

## Markers and selection

- Register every marker in config and run with `--strict-markers` so typos fail.
- Common markers: `unit`, `integration`, `slow`. Run fast feedback with `pytest -m "not slow"`.
- Use `skipif` with a reason for platform-specific tests; never skip a failing test to get green.

## Coverage

- Measure with pytest-cov / coverage.py; enable branch coverage.
- Use the project's threshold (`--cov-fail-under`). If none is set, aim for 80%+ overall and full coverage of critical paths (auth, payments, data loss, permissions).
- Coverage is a floor, not the goal. Never add assertion-free tests to raise the number.
- Read the missing-lines report for the code you changed; untested branches are where bugs hide.

## Flaky test causes

- `time.sleep` waits → wait for a condition or control the clock.
- Order dependence or shared state → isolate fixtures; optionally run with random ordering.
- Real network or wall-clock time → mock at the boundary.
- Unseeded randomness → seed or inject.

## Useful commands

| Goal | Command |
|---|---|
| Whole suite | `pytest` |
| One file / test | `pytest tests/test_users.py::test_create` |
| By keyword | `pytest -k "login and not admin"` |
| Stop at first failure | `pytest -x` |
| Rerun last failures | `pytest --lf` |
| Coverage | `pytest --cov=mypackage --cov-branch --cov-report=term-missing` |
| Show slowest tests | `pytest --durations=10` |
| Debugger on failure | `pytest --pdb` |

## Red flags (review)

- Tests that pass with the implementation deleted or broken.
- Mocks of internal functions; asserting call counts instead of results.
- `--disable-warnings` hiding deprecations; tests with no assertions.
- Fixtures with broad scope that tests mutate.
- Sleeping, real HTTP, or dependence on test order.

## Done when

- New behaviour has a test that failed before the change and passes after.
- Full suite passes locally with no new warnings.
- Changed code meets the coverage threshold, including error branches.

Examples (fixtures, parametrize, mocking, async, DB rollback, config): [references/pytest-examples.md](references/pytest-examples.md).
