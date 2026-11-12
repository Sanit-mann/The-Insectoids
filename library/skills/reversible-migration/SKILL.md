---
name: reversible-migration
description: Move a schema, data set, API, protocol, configuration or dependency from old to new safely - expand, migrate, verify, then contract - with a rollback path, no data loss and old and new versions working side by side. Use for any migration that existing data, readers or deployed clients depend on, including zero-downtime database changes.
metadata:
  kind: skill
  castes: [coder]
  tags: [migration, database, compatibility, rollback, zero-downtime]
  version: 1
  status: vetted
  sources:
    - repo: juliusbrussee/caveman
      path: skills/migration/SKILL.md
      license: Apache-2.0
    - repo: affaan-m/ecc
      path: skills/database-migrations/SKILL.md
      license: MIT
---

# Reversible Migration

Get from the old shape to the new one in steps that can each be undone, while everything that reads or writes the old shape keeps working.

## When to use

- Database schema or data changes (columns, tables, indexes, backfills).
- API or protocol changes that deployed clients depend on.
- Configuration format changes, dependency or library version moves.
- Any change where old and new versions may run at the same time during rollout.

Database specifics (PostgreSQL patterns, migration-tool workflows): [references/database.md](references/database.md).

## Step 1: Map before editing

Write down:
- **Readers and writers:** every service, job, client and script that reads or writes the thing being migrated.
- **Current shape:** schema, data volume, formats, invariants.
- **Compatibility window:** how long old and new versions will overlap (rolling deploys, mobile clients, cached data, queued messages).
- **Ownership:** who owns each piece, and which parts are outside your task.

## Step 2: Define both paths

- **Forward path:** the ordered stages to reach the new shape.
- **Rollback path:** how to undo each stage. In production, roll back with a *new forward migration*, not by editing history.
- Mark any stage that cannot be undone (dropping a column, deleting data, removing an endpoint) as **destructive**.

## Step 3: Expand, migrate, verify, contract

| Stage | What happens | Old version still works? |
|---|---|---|
| **Expand** | Add the new alongside the old: new column (nullable or with default), new table, new endpoint or field, new config key. Code writes to both. | Yes |
| **Migrate** | Backfill or convert existing data in batches. Switch reads to the new, keep writing both. | Yes |
| **Verify** | Check data consistency and that both paths behave correctly. | Yes |
| **Contract** | Stop using the old, then remove it in a separate, later change. | No (destructive) |

Ship each stage as its own change. A rename, for example, is: add new column, write both, backfill, read new, stop writing old, drop old. Never a direct rename.

## Rules

- **Every change is a migration file** (or versioned change). Never alter production state by hand.
- **Migrations are immutable once applied** anywhere shared. Fix mistakes with a new migration.
- **Keep schema changes and data changes in separate migrations.** Long data updates inside a schema transaction lock tables and are hard to roll back.
- **Preserve existing data.** Destructive steps are explicit, separate, and **need user approval** (requested through the Queen). Never perform the contract stage implicitly.
- **Keep mixed versions safe.** At every stage, the previous version of the code must still work against the current shape.
- **Make retries idempotent.** Running a step twice must not corrupt or duplicate data ("only rows not yet migrated", "create if not exists").
- **Make partial failure observable.** Batch work logs progress; a failed run can be found and resumed.
- **Test against realistic data volume.** A change that is instant on 100 rows can lock a table for minutes on 10 million.
- **Remove code references before removing the thing.** Deploy code that no longer uses a column or endpoint before dropping it.
- **Run migrations only against environments your task allows.** Never point a migration at a shared or production system without approval.

## API and protocol migrations

- Add new fields, endpoints or message versions; keep accepting the old ones.
- New readers tolerate missing new fields; old readers ignore unknown fields.
- Mark the old path deprecated with a date, measure remaining use, then remove it as an approved contract stage.
- Breaking changes are announced in the commit and changelog (`!` / `BREAKING CHANGE:`).

## Dependency and configuration migrations

- Upgrade one dependency (or tightly coupled group) at a time; read its changelog for breaking changes first.
- Support old and new config keys during the window; warn when the old key is used.
- Keep the lockfile change in the same commit as the code that needs it, so a revert is clean.

## Verification

Check the required stages explicitly:
- after expand: old code and new code both pass their tests against the new shape;
- after migrate: row counts and spot checks match; no rows left unconverted;
- rollback rehearsed (at least in a local or test environment) for each non-destructive stage.

## Red flags

- One migration both changes the schema and rewrites millions of rows.
- `NOT NULL` added to an existing column without a default or backfill.
- An index created on a large live table without a non-blocking option.
- A dropped column or endpoint that code still references.
- Editing a migration that has already run somewhere shared.
- "We'll clean up the old column now too" without approval.

## Stop condition and output

Stop after the stage the task asked for passes its verification. Do not continue to later stages, especially contract, on your own.

In the task card result: the map (readers, writers, window), forward and rollback paths, stages completed with evidence, and the remaining stages with which ones are destructive and need approval.
