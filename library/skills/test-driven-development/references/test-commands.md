# Test Commands by Language

Load when you need the run-one-test, run-all, watch or coverage command for a project. Always confirm against the project's own scripts and CI config first; the project's command wins over anything here.

## How to detect the runner

1. Look for the project's declared commands: `scripts` in `package.json`, `[tool.*]` sections in `pyproject.toml`, `Makefile`/`justfile` targets, CI workflow steps.
2. Look at existing test files: their imports name the framework (`vitest`, `jest`, `bun:test`, `pytest`, `unittest`, `testing`).
3. Look at lockfiles and config files to pick the package manager (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`/`bun.lock`, `uv.lock`, `poetry.lock`).

The package manager is not the test runner. A project can install with Bun and still run Jest or Vitest.

## JavaScript / TypeScript

| Setup | Run all | Watch | Coverage |
|---|---|---|---|
| npm | `npm test` | `npm test -- --watch` | `npm run test:coverage` (if defined) |
| pnpm | `pnpm test` | `pnpm test --watch` | `pnpm test:coverage` |
| yarn | `yarn test` | `yarn test --watch` | `yarn test:coverage` |
| Bun running a jest/vitest script | `bun run test` | `bun run test --watch` | `bun run test:coverage` |
| Bun native runner (`bun:test` imports) | `bun test` | `bun test --watch` | `bun test --coverage` |

`bun test` (built-in runner) and `bun run test` (the package.json script) are different. Check which the project expects before the RED step.

Single test:
- Vitest: `npx vitest run path/to/file.test.ts -t "test name"`
- Jest: `npx jest path/to/file.test.ts -t "test name"`
- Bun: `bun test path/to/file.test.ts -t "test name"`
- Playwright (end-to-end): `npx playwright test path/to/spec.ts -g "test name"`

Coverage thresholds: Jest uses `coverageThreshold` in its config; Vitest uses `test.coverage.thresholds`; Bun uses `coverageThreshold` under `[test]` in `bunfig.toml`.

Typecheck and lint usually travel with tests: `npm run typecheck` / `tsc --noEmit -p <tsconfig>`, `npm run lint`.

## Python

| Task | Command |
|---|---|
| Run all | `pytest` (or `uv run pytest`, `poetry run pytest`) |
| Single file / test | `pytest path/to/test_file.py::test_name` |
| By keyword | `pytest -k "keyword"` |
| Stop on first failure, verbose | `pytest -x -v` |
| Coverage | `pytest --cov=<package> --cov-report=term-missing` |
| Coverage gate | `pytest --cov=<package> --cov-fail-under=80` |
| unittest projects | `python -m unittest discover`, single: `python -m unittest pkg.tests.test_mod.TestCls.test_name` |
| Django | `python manage.py test` or `pytest` with `pytest-django` |

Async tests need the project's plugin (`pytest-asyncio`, `anyio`). Database tests in Django need `@pytest.mark.django_db`.

## Go

| Task | Command |
|---|---|
| Run all | `go test ./...` |
| Single test | `go test ./pkg/foo -run '^TestName$'` |
| Verbose, no cache | `go test -v -count=1 ./...` |
| Race detector | `go test -race ./...` |
| Coverage | `go test -cover ./...`, profile: `go test -coverprofile=cover.out ./... && go tool cover -func=cover.out` |

## Rust

| Task | Command |
|---|---|
| Run all | `cargo test` |
| Single test | `cargo test test_name` (substring match), exact: `cargo test test_name -- --exact` |
| Show output | `cargo test -- --nocapture` |
| Coverage | `cargo llvm-cov` or `cargo tarpaulin` (if installed in the project) |

## Java / Kotlin

| Task | Maven | Gradle |
|---|---|---|
| Run all | `mvn test` | `./gradlew test` |
| Single test | `mvn test -Dtest=ClassName#method` | `./gradlew test --tests 'pkg.ClassName.method'` |
| Coverage | JaCoCo report goal configured in the build | `./gradlew jacocoTestReport` |

## C# / .NET

| Task | Command |
|---|---|
| Run all | `dotnet test` |
| Single test | `dotnet test --filter "FullyQualifiedName~Namespace.Class.Method"` |
| Coverage | `dotnet test --collect:"XPlat Code Coverage"` |

## Reading results

- Record the exact command and the summary line (passed / failed / skipped counts, exit code).
- "No tests ran" or "0 collected" is not a pass. Check the path, pattern and markers.
- Skipped or disabled tests count as gaps; list them in the card result.
