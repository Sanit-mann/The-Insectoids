---
name: docker-patterns
description: Write and review Dockerfiles and Compose files. Covers multi-stage builds, layer caching, pinned minimal base images, non-root read-only containers, build and runtime secrets, networks, volumes, healthchecks, local dev stacks and isolated throwaway test containers. Use when creating, changing or debugging container images or Compose setups. For releasing to environments, load deployment-patterns.
metadata:
  kind: skill
  castes: [coder, tester, reviewer]
  tags: [docker, containers, compose, devops, security]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/docker-patterns/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: skills/deployment-patterns/SKILL.md
      license: MIT
      note: Dockerfile sections only
---

# Docker Patterns

Small, reproducible images that run as non-root with nothing secret inside; Compose stacks that start in the right order and keep data where you expect it.

## When to use

- Writing or changing a `Dockerfile`, `.dockerignore` or `compose.yaml`.
- Setting up a local development stack (app + database + cache + mail catcher).
- Debugging container builds, networking or volumes.
- Running tests or untrusted tooling in an isolated container.

Not for: pipelines, environments and rollouts (deployment-patterns).

## Approval rules

- Pushing images to a shared or production registry needs user approval.
- `docker compose down -v`, `docker volume rm`, `docker system prune` and similar delete data: ask first, and name exactly what will be removed. Scope commands to a project (`-p name`) or a named container, never global cleanup.

## Dockerfile rules

1. **Pin the base image** to a specific version (`python:3.13-slim`, `node:22-alpine`), never `latest`. For reproducible or security-sensitive builds pin by digest (`image@sha256:...`) and update deliberately.
2. **Use multi-stage builds.** Build tools and dev dependencies stay in the builder stage; the runtime stage gets only the artefact and production dependencies.
3. **Order layers for caching.** Copy dependency manifests (`package.json` + lock, `pyproject.toml` + lock, `go.mod`/`go.sum`) and install before copying source.
4. **Install reproducibly** from the lock file (`npm ci`, `pip install --require-hashes -r requirements.txt`, `uv sync --frozen`, `go mod download`). Clean package caches in the same `RUN` step.
5. **Run as non-root.** Create a user with a fixed numeric UID, `COPY --chown`, then `USER`. Do not `chmod 777`.
6. **No secrets in layers.** Never `COPY .env`, `ARG`/`ENV` a token, or `RUN` a command with a secret on the command line. Use BuildKit secret mounts at build time (`RUN --mount=type=secret,id=...`) and inject runtime secrets from the environment or a secrets file.
7. **Exec-form `CMD`/`ENTRYPOINT`** (`["node", "server.js"]`) so the process is PID 1 and receives `SIGTERM`. Make the app shut down gracefully on `SIGTERM`.
8. **Add a `HEALTHCHECK`** (or rely on the orchestrator's probes) that hits a cheap endpoint.
9. **Keep it small.** Slim or distroless runtime bases, no editors or curl unless needed, `--no-install-recommends` for apt.
10. **Language specifics:** Python sets `PYTHONUNBUFFERED=1` and installs into a virtualenv copied to the runtime stage; Node sets `NODE_ENV=production` and prunes dev dependencies (`npm prune --omit=dev`).

Use a `.dockerignore` that excludes `.git`, `.env*`, `node_modules`, virtualenvs, build output, coverage and logs, so they neither bloat the context nor leak into the image.

## Compose for local development

- File name `compose.yaml`; the top-level `version:` key is obsolete, omit it.
- `depends_on` with `condition: service_healthy` plus a `healthcheck` on the database, so the app starts after the DB is ready.
- Named volumes for data (`pgdata:/var/lib/postgresql/data`); bind mounts only for source code hot reload. Protect container-installed dependencies with an anonymous volume (`/app/node_modules`).
- Bind published ports to loopback (`"127.0.0.1:5432:5432"`) so dev databases are not exposed to the network. Publish only what you need.
- Dev-only credentials (`postgres/postgres`) are fine in a local compose file; never reuse them anywhere else.
- `compose.override.yaml` is loaded automatically for dev tweaks; use explicit `-f compose.yaml -f compose.prod.yaml` for other setups, and `profiles:` for optional services.
- Target the dev stage of a multi-stage Dockerfile with `build.target`.

## Networking

- Services on the same Compose network resolve each other by service name (`db:5432`), not `localhost`.
- Split networks to limit reach: the database on a `backend` network only the API joins.
- Inside a container, `localhost` is the container itself. To reach the host use `host.docker.internal` (Docker Desktop; on Linux add `extra_hosts: ["host.docker.internal:host-gateway"]`).

## Runtime hardening

Apply to production-like services and to anything running untrusted code:

```yaml
security_opt: ["no-new-privileges:true"]
read_only: true
tmpfs: ["/tmp"]
cap_drop: [ALL]
pids_limit: 256
mem_limit: 512m
```

Add back only capabilities the app needs (`NET_BIND_SERVICE` for ports below 1024; better to listen on a high port). Never mount the Docker socket into an application container; it grants root on the host.

## Secrets

- Runtime: environment variables injected from the host or CI secret store, or Compose `secrets:` (file-based secrets mounted at `/run/secrets/<name>`; work without Swarm).
- `.env` files are local only and git-ignored. Commit `.env.example` with placeholders.
- Build time: `docker build --secret id=npmrc,src=$HOME/.npmrc` with `RUN --mount=type=secret,id=npmrc ...`.
- Check an image for leaks before pushing: `docker history --no-trunc <image>` and inspect `ENV`.

## Isolated test containers

When a task runs installers, generated code or other untrusted tooling in a container:
- Pin base images by digest and pin tool versions.
- Mount the source read-only; copy it into a writable `tmpfs` workspace before anything mutates it.
- Default to `network_mode: none`. Add network access only through a separate, clearly named service that must be chosen on purpose.
- Do not mount host credential directories (`~/.ssh`, `~/.aws`, `~/.config`) or pass host secrets by default.
- Run as a numeric non-root UID with `read_only`, `no-new-privileges`, `cap_drop: [ALL]` and a `pids_limit`.
- Pass arguments as arrays, never by interpolating paths into a shell string.
- A Linux container does not validate macOS or Windows behaviour. Use native CI runners for those platforms and say so in the report.
- Remove the exact containers and project you created when done.

## Debugging

| Need | Command |
|---|---|
| Follow logs | `docker compose logs -f app` |
| Shell in a running service | `docker compose exec app sh` |
| Status and resource use | `docker compose ps`, `docker stats` |
| Rebuild | `docker compose up --build`; clean build `docker compose build --no-cache app` |
| Effective config | `docker compose config` |
| DNS / reachability | `docker compose exec app getent hosts db` |
| Layer sizes | `docker history <image>` |
| Stop stack, keep data | `docker compose down` |

## Red flags (review)

- `FROM x:latest`, unpinned tool installs, `curl | sh` in a Dockerfile.
- Running as root; Docker socket mounted; `privileged: true`.
- Secrets in `ENV`, `ARG`, copied files or compose YAML committed to git.
- `COPY . .` before dependency install (cache busting) or no `.dockerignore`.
- Shell-form `CMD` (signals not delivered); no healthcheck on services others depend on.
- Databases published on `0.0.0.0` or data stored without a volume.

## Done when

- Image builds from a clean checkout, runs as non-root, passes its healthcheck, and contains no secrets (`docker history` checked).
- `docker compose config` validates; `docker compose up` brings the stack to healthy.

Full examples (dev stack, Node and Python Dockerfiles, hardened and isolated services, `.dockerignore`): [references/examples.md](references/examples.md).
