# Deployment examples

For [deployment-patterns](../SKILL.md). Platform-specific snippets are illustrations, not endorsements; translate to whatever CI and runtime the project uses.

## Sample pipeline (GitHub Actions syntax)

Action versions shown are major tags for readability; in real pipelines pin third-party actions to full commit SHAs and check for current majors.

```yaml
name: ci-cd

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test -- --coverage
      - run: npm audit --audit-level=high

  build:
    needs: test
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        run: echo "image=ghcr.io/${{ github.repository }}:${{ github.sha }}" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ${{ steps.meta.outputs.image }}      # immutable SHA tag
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: ./scripts/deploy.sh staging "${{ needs.build.outputs.image }}"
      - run: ./scripts/smoke-test.sh "https://staging.example.com"

  deploy-production:
    needs: [build, deploy-staging]
    runs-on: ubuntu-latest
    environment: production      # configure required reviewers on this environment = approval gate
    steps:
      - run: ./scripts/deploy.sh production "${{ needs.build.outputs.image }}"
      - run: ./scripts/smoke-test.sh "https://app.example.com"
```

`deploy.sh` wraps the platform's own command (for example `kubectl set image ...`, or a PaaS CLI). The same image reference goes to both environments.

## Health endpoints (TypeScript, Express-style)

```typescript
let shuttingDown = false

app.get('/livez', (_req, res) => {
  res.status(200).json({ status: 'ok' })            // no dependency checks
})

app.get('/readyz', async (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'draining' })
  const checks = await Promise.allSettled([
    withTimeout(db.query('SELECT 1'), 1000),
    withTimeout(redis.ping(), 1000),
  ])
  const ok = checks.every(c => c.status === 'fulfilled')
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' })   // no details publicly
})

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}
```

## Graceful shutdown (TypeScript)

```typescript
const server = app.listen(port)

process.on('SIGTERM', () => {
  shuttingDown = true                                // readiness now fails
  setTimeout(() => {                                 // let the load balancer notice
    server.close(async () => {                       // stop accepting, finish in-flight
      await db.end()
      process.exit(0)
    })
  }, 5_000)
  setTimeout(() => process.exit(1), 30_000).unref() // hard deadline
})
```

## Health endpoints (Python, FastAPI)

```python
import asyncio

from fastapi import FastAPI, Response
from sqlalchemy import text

app = FastAPI()
state = {"draining": False}


@app.get("/livez")
async def livez() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
async def readyz(response: Response) -> dict[str, str]:
    if state["draining"]:
        response.status_code = 503
        return {"status": "draining"}
    try:
        async with asyncio.timeout(1):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
    except Exception:
        response.status_code = 503
        return {"status": "unavailable"}
    return {"status": "ok"}
```

Set `state["draining"] = True` in the lifespan shutdown phase; servers such as uvicorn and gunicorn handle `SIGTERM` and drain in-flight requests within their graceful timeout.

## Probe configuration (Kubernetes)

```yaml
startupProbe:
  httpGet: { path: /livez, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30          # up to 150 s to boot
livenessProbe:
  httpGet: { path: /livez, port: 8080 }
  periodSeconds: 20
  timeoutSeconds: 2
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /readyz, port: 8080 }
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 2
lifecycle:
  preStop:
    exec: { command: ["sleep", "5"] }   # give endpoints time to drop the pod
terminationGracePeriodSeconds: 30
```

## Config validation at startup

TypeScript (zod):

```typescript
import { z } from 'zod'

const Env = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production']),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  // print which keys are wrong, never their values
  console.error('Invalid configuration:', parsed.error.issues.map(i => i.path.join('.')))
  process.exit(1)
}
export const env = parsed.data
```

Python (pydantic-settings):

```python
from pydantic import Field, PostgresDsn
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_env: str = Field(pattern="^(development|staging|production)$")
    database_url: PostgresDsn
    jwt_secret: str = Field(min_length=32)
    log_level: str = "info"


settings = Settings()   # raises ValidationError at startup if anything is missing
```

## Environment variables

```bash
# .env.example (committed, placeholders only)
APP_ENV=development
PORT=3000
DATABASE_URL=postgres://user:password@localhost:5432/app_dev
JWT_SECRET=change-me-at-least-32-characters-long
LOG_LEVEL=debug
```

## Rollback commands (illustrations)

```bash
# Kubernetes: previous ReplicaSet
kubectl rollout undo deployment/app
kubectl rollout status deployment/app

# Any platform: redeploy the previous known-good SHA tag
./scripts/deploy.sh production ghcr.io/org/app:<previous-sha>
```

Both are production actions and need approval unless the approved deploy plan pre-authorised them.
