---
name: deployment-patterns
description: Vendor-neutral release practice. CI/CD stages, build-once artefacts, environments, rolling/blue-green/canary rollouts, liveness and readiness checks, config and secrets via environment, backward-compatible migrations, rollbacks and production readiness. Use when setting up or changing a pipeline, planning a release, or checking production readiness. Production deploys need user approval.
metadata:
  kind: skill
  castes: [coder, reviewer, tester]
  tags: [deployment, ci-cd, devops, operations, release]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/deployment-patterns/SKILL.md
      license: MIT
---

# Deployment Patterns

Build once, promote the same artefact through environments, release gradually, watch, and be able to go back in minutes.

## Approval rule (read first)

In this hive these always need **user approval** before they happen:
- deploying to production, or rolling production back or forward
- changing production configuration, secrets, scaling or infrastructure
- running migrations or data fixes against production
- pushing to shared repositories or shared/production image registries

A worker prepares everything (pipeline changes, deploy plan, rollback steps) and then stops and requests approval through the task card. Never trigger a production deploy from a worker, never bypass a pipeline's approval gate, and never treat a merged PR as approval to deploy. Preview and staging deploys may run automatically if the task card allows it.

## When to use

- Creating or changing a CI/CD pipeline.
- Planning a release, migration rollout or rollback.
- Adding health checks, graceful shutdown or startup config validation.
- Reviewing production readiness.

Not for: writing Dockerfiles or Compose files (docker-patterns), migration mechanics (reversible-migration).

## Pipeline stages

**On every pull request:** install from lock file → lint → type check → unit tests → integration tests → build → security checks (dependency audit, secret scan) → optional preview deploy.

**On merge to the main branch:** the same checks → build the artefact **once**, tag it with the commit SHA (immutable; never reuse tags like `latest` for deploys) → deploy to staging → smoke tests → **approval gate** → production rollout → post-deploy verification.

Pipeline rules:
- Fail the pipeline on any failing check; no "allowed to fail" tests on the release path.
- Promote the identical artefact; never rebuild per environment.
- Pin versions of CI actions, plugins and tools (commit SHAs for third-party actions).
- Least-privilege CI credentials, scoped per environment; prefer short-lived federated credentials (OIDC) over long-lived keys.
- Secrets come from the CI secret store, are masked in logs, and are never echoed or written to artefacts.
- Protect the production environment with required reviewers so the gate is enforced by the platform, not by convention.
- Cache dependencies to keep feedback fast; keep the PR pipeline under about 10 minutes where possible.

## Environments

- Typical set: local → preview (per PR, optional) → staging (production-like) → production.
- Same artefact and same code path everywhere; only configuration differs, through environment variables.
- Separate credentials, databases and third-party accounts per environment. Never point staging at production data stores.
- Production data in lower environments only if anonymised and approved.

## Choosing a rollout strategy

| Strategy | How | Use when | Cost |
|---|---|---|---|
| Rolling | Replace instances a few at a time | Default for stateless, backward-compatible changes | Two versions run at once |
| Blue-green | Stand up the new stack, switch traffic at once | Need instant switch-back; critical services | Double capacity during switch |
| Canary | Send a small share (e.g. 5%) of traffic, watch, then widen | Risky changes, high traffic, good metrics | Needs traffic splitting and monitoring |
| Recreate | Stop old, start new | Downtime acceptable; incompatible versions | Downtime |
| Feature flag | Deploy dark, enable per user/percentage | Decouple deploy from release; quick kill switch | Flag debt; clean up later |

Every strategy except recreate runs old and new code side by side, so code and schema must be backward compatible for one release.

## Health checks and shutdown

- **Liveness** (`/livez`): the process is alive and not deadlocked. Do **not** check dependencies here, or a database blip restarts every instance.
- **Readiness** (`/readyz`): can serve traffic now (dependencies reachable, warm-up done). Return 503 while starting and while draining.
- **Startup** probe for slow boots so liveness does not kill the process early.
- Keep checks cheap with short timeouts; do not expose detailed dependency status publicly.
- Graceful shutdown on `SIGTERM`: fail readiness, stop accepting new work, finish in-flight requests and jobs within a deadline, close pools, exit.

## Configuration and secrets

- All config through environment variables (twelve-factor). Nothing environment-specific in code or images.
- Validate config at startup and exit with a clear error if anything required is missing or malformed.
- Secrets come from a secret manager or the platform's secret store at runtime. Never in source, images, logs, error messages or committed `.env` files. Ship `.env.example` with placeholders.
- Rotate secrets on a schedule and immediately after any exposure; deleting the commit is not enough.

## Database changes (expand / contract)

1. **Expand:** add new tables/columns/indexes in a backward-compatible way; old code keeps working.
2. Deploy code that writes both or reads the new shape; backfill in batches.
3. **Contract:** in a later release, remove old columns or code paths. This step deletes data and needs approval.

Run migrations as a separate pipeline step before the new code rolls out, with a timeout. Confirm a recent, restorable backup before risky migrations. See reversible-migration and postgres-patterns.

## Rollback

- Decide the rollback triggers **before** deploying: error rate, latency, failed health checks, key business metric, each with a threshold and a watch window.
- Rollback = redeploy the previous known-good artefact (kept and tagged), or flip the feature flag off. It should be one command or button, tested in staging.
- Expand/contract keeps rollback possible; a contract step or irreversible data migration makes rollback a restore, so separate them.
- Choose roll-forward only when the fix is small, understood and faster than rolling back.
- Rolling back production also needs approval, unless an approved deploy plan already authorises automatic rollback on the stated triggers.

## Post-deploy verification

- Run smoke tests against the new version.
- Watch error rate, latency, saturation and the key business metric against the pre-deploy baseline for the agreed window.
- Record the deploy: version/SHA, time, strategy, who approved, result.

## Deploy plan (what to hand in for approval)

- What changes and why; artefact version/SHA; target environment.
- Strategy and steps, including migrations and their order.
- Verification steps and the watch window.
- Rollback triggers, the exact rollback action, and anything that makes rollback impossible.
- Risks and blast radius; who/what is affected.

## Production readiness checklist

- **Application:** all tests pass; no hardcoded secrets; structured (JSON) logs without PII or secrets; health endpoints; graceful shutdown; config validated at startup.
- **Build:** reproducible, pinned dependencies and base images; artefact tagged by SHA; dependency audit and secret scan clean.
- **Infrastructure:** resource requests/limits; autoscaling bounds; TLS everywhere; backups configured and a restore tested.
- **Observability:** request rate, errors and latency metrics; alerts with owners; log aggregation; uptime check on readiness.
- **Security:** CORS limited to known origins; rate limiting on public endpoints; authn/authz verified; security headers (HSTS, CSP, frame options).
- **Operations:** rollback tested; migration tested on production-sized data; runbook for common failures; on-call and escalation path known.

## Red flags (review)

- Deploy job without an environment protection or approval gate for production.
- Rebuilding the image per environment; deploying `latest`.
- Secrets in pipeline YAML, build args, images or logs.
- Liveness probe that checks the database.
- Destructive migration in the same release as the code change that stops using the column.
- No defined rollback trigger or untested rollback.

## Done when

- The pipeline enforces checks and the production approval gate.
- A deploy plan with verification and rollback steps exists and has been approved before any production action.

Examples (sample pipeline, health endpoints in TypeScript and Python, probe config, startup config validation, graceful shutdown): [references/examples.md](references/examples.md).
