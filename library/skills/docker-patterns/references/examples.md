# Docker examples

For [docker-patterns](../SKILL.md). Versions are examples as of late 2026; pin to what the project supports.

## Local dev stack (compose.yaml)

```yaml
services:
  app:
    build:
      context: .
      target: dev
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - .:/app                         # hot reload
      - /app/node_modules              # keep container-installed deps
    environment:
      DATABASE_URL: postgres://postgres:postgres@db:5432/app_dev   # local-only credentials
      REDIS_URL: redis://redis:6379/0
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started

  db:
    image: postgres:17-alpine
    ports:
      - "127.0.0.1:5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app_dev
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data

  mail:                                # local SMTP catcher with web UI
    image: axllent/mailpit:v1.21
    ports:
      - "127.0.0.1:8025:8025"
    profiles: [mail]                   # start with: docker compose --profile mail up

volumes:
  pgdata:
  redisdata:
```

Override for production-like runs (`compose.prod.yaml`, used with `-f compose.yaml -f compose.prod.yaml`):

```yaml
services:
  app:
    build:
      target: production
    restart: unless-stopped
    volumes: !reset []                 # drop dev bind mounts
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
```

## Node.js multi-stage Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npm", "run", "dev"]

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/livez || exit 1
CMD ["node", "dist/server.js"]
```

Private registry token at build time without leaking it:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc .
```

## Python multi-stage Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.13-slim AS builder
WORKDIR /app
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" PIP_NO_CACHE_DIR=1
COPY requirements.lock ./
RUN pip install --require-hashes -r requirements.lock
# With uv instead: COPY pyproject.toml uv.lock ./ && uv sync --frozen --no-dev

FROM python:3.13-slim AS runtime
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN useradd --system --uid 1001 --create-home app
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY --chown=app:app src/ ./src/
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD \
  python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8000/livez', timeout=2)" || exit 1
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "4"]
```

For ASGI apps use an ASGI server instead (for example `uvicorn app.main:app --host 0.0.0.0 --port 8000`, or gunicorn with uvicorn workers).

## Go multi-stage Dockerfile

```dockerfile
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
```

Distroless images have no shell, so use orchestrator probes (or a `healthcheck` subcommand in the binary) rather than `wget` in `HEALTHCHECK`.

## Hardened service

```yaml
services:
  api:
    image: registry.example.com/api@sha256:<digest>
    user: "1001:1001"
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]
    pids_limit: 256
    environment:
      LOG_LEVEL: info
      API_KEY: ${API_KEY:?API_KEY must be set}     # from host env / CI secret store
    secrets:
      - db_password                                  # mounted at /run/secrets/db_password
    networks: [frontend, backend]

  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    networks: [backend]                              # not reachable from frontend
    volumes: [pgdata:/var/lib/postgresql/data]

secrets:
  db_password:
    file: ./secrets/db_password.txt                  # git-ignored

networks:
  frontend:
  backend:
    internal: true

volumes:
  pgdata:
```

## Isolated test container

```yaml
services:
  sandbox:
    build: ./sandbox                                 # base pinned by digest inside
    user: "1000:1000"
    network_mode: none
    read_only: true
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    pids_limit: 128
    volumes:
      - ./project:/src:ro                            # source is read-only
    tmpfs:
      - /workspace:size=1g,mode=0700,uid=1000,gid=1000
      - /tmp:size=512m
    command: ["/usr/local/bin/run-tests", "--source", "/src", "--workdir", "/workspace"]

  sandbox-networked:                                 # opt-in only, never the default
    extends:
      service: sandbox
    network_mode: bridge
    profiles: [networked]
```

The entry script copies `/src` into `/workspace` before any step mutates files. Run it with an explicit project name and clean up only that project:

```bash
docker compose -p sandbox-run-123 run --rm sandbox
docker compose -p sandbox-run-123 down --remove-orphans
```

## .dockerignore

```text
.git
.env
.env.*
!.env.example
node_modules
.venv
__pycache__
dist
build
coverage
*.log
.cache
.next
```

## Network debugging

```bash
docker compose exec app getent hosts db             # DNS inside the network
docker compose exec app wget -qO- http://api:3000/readyz
docker network ls
docker network inspect <project>_default
```
