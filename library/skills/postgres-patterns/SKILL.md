---
name: postgres-patterns
description: PostgreSQL schema design, data types, indexing, query patterns (upsert, keyset pagination, job queues), safe online migrations, connection pooling, timeouts, roles and row-level security, and reading query plans. Use when designing tables or indexes, writing SQL or migrations for Postgres, adding RLS policies, or when a Postgres query is slow.
metadata:
  kind: skill
  castes: [coder, reviewer]
  tags: [database, postgres, sql, performance, security]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/postgres-patterns/SKILL.md
      license: MIT
      note: ecc credits Supabase Agent Skills (MIT) as its basis
---

# PostgreSQL Patterns

Let the database enforce integrity, index for the queries you actually run, and prove performance with a plan, not a guess.

## When to use

- Designing or changing tables, constraints or indexes.
- Writing SQL (raw or via an ORM) or migrations that will run on Postgres.
- Adding row-level security or database roles.
- Investigating a slow query or lock contention.

Also load: reversible-migration (migration workflow), django-patterns or fastapi-patterns (ORM side).

## Safety first

- Never run exploratory writes, `EXPLAIN ANALYZE` on write statements, or schema changes against production yourself. Work on a local or staging copy. Production changes go through a reviewed migration and need user approval.
- Dropping or truncating tables or columns, or deleting data, always needs user approval.
- Always use parameterised queries (driver placeholders or an ORM). Never build SQL from user input with string formatting. Examples here write parameters as `:name`; in raw Postgres they are numbered positional parameters (dollar sign + number), and Python drivers use `%s`.

## Data types

| Use case | Use | Avoid |
|---|---|---|
| Primary keys | `bigint GENERATED ALWAYS AS IDENTITY` | `serial`, `int` (overflows) |
| Public or distributed IDs | UUIDv7 (time-ordered; built-in `uuidv7()` as of Postgres 18) | random UUIDv4 as the clustered key on hot tables |
| Text | `text`, with a `CHECK (length(col) <= n)` if a limit matters | `varchar(255)` by habit |
| Timestamps | `timestamptz` | `timestamp` without time zone |
| Money / exact decimals | `numeric(p, s)` or integer minor units | `float`, `real`, `money` |
| Flags | `boolean` | `int` or `'Y'/'N'` |
| Semi-structured | `jsonb` | `json`, or jsonb for fields you filter on constantly |
| Enumerations | lookup table or `text` + `CHECK`; native enums are hard to change | free text |

## Schema rules

- `NOT NULL` by default; allow null only when "unknown" is a real state.
- Every foreign key column gets an index (Postgres does not create one automatically). Unindexed FKs make deletes and joins slow.
- Uniqueness, ranges and relationships are constraints in the database (`UNIQUE`, `CHECK`, `FOREIGN KEY`), not only application checks.
- `snake_case` lowercase names; name constraints and indexes explicitly.
- `created_at timestamptz NOT NULL DEFAULT now()`; maintain `updated_at` in the app or a trigger.

## Indexes

| Query pattern | Index |
|---|---|
| `WHERE col = x`, ranges, `ORDER BY col` | B-tree (default) |
| `WHERE a = x AND b > y` | composite `(a, b)`: equality columns first, then range/sort |
| `WHERE jsonb_col @> '{...}'`, arrays, full-text `@@` | GIN |
| Huge append-only table filtered by time | BRIN on the time column |
| `WHERE lower(email) = ...` | expression index `(lower(email))` |
| Only a subset is queried (`WHERE deleted_at IS NULL`) | partial index |
| Avoid heap lookups for a hot read | covering index `... INCLUDE (col2, col3)` |

Rules:
- Index for real queries; every index slows writes and uses memory. Remove unused ones (check `pg_stat_user_indexes.idx_scan`).
- On live tables create and drop with `CONCURRENTLY` (cannot run inside a transaction block).
- A composite index `(a, b)` also serves queries on `a` alone; do not add a separate `(a)`.

## Query patterns

- **Select only needed columns.** `SELECT *` breaks covering indexes and wastes I/O.
- **Upsert:** `INSERT ... ON CONFLICT (key) DO UPDATE SET col = EXCLUDED.col` (needs a unique constraint on `key`).
- **Keyset pagination** for large or deep lists: `WHERE (created_at, id) < (:last_created_at, :last_id) ORDER BY created_at DESC, id DESC LIMIT 20`, with an index on `(created_at, id)`. `OFFSET` cost grows with the offset.
- **Job queue:** claim rows with `FOR UPDATE SKIP LOCKED` inside a short transaction so workers never block each other.
- **Batching:** insert many rows per statement (or `COPY`); update or delete large sets in batches of a few thousand to keep locks and WAL bursts small.
- **N+1:** fetch related rows with a join or `WHERE id = ANY(:ids)`, not one query per row.
- **Counting:** exact `count(*)` on huge tables is slow; use estimates (`pg_class.reltuples`) where exactness is not needed.

## Transactions and locking

- Keep transactions short; never wait on network calls or user input inside one.
- Default isolation is READ COMMITTED. For read-modify-write, use `SELECT ... FOR UPDATE`, an atomic `UPDATE ... SET n = n - 1 WHERE n > 0`, or SERIALIZABLE with retry on serialization failure.
- Lock rows in a consistent order to avoid deadlocks.
- Set `lock_timeout` (for example `5s`) in migrations so a blocked DDL fails fast instead of queuing every query behind it.

## Safe online migrations

- Adding a nullable column, or a column with a constant default, is fast (no table rewrite since Postgres 11).
- Adding `NOT NULL` to an existing column: add `CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT`, then `SET NOT NULL` (Postgres 12+ uses the validated check and skips the scan).
- Adding a foreign key: `ADD CONSTRAINT ... NOT VALID`, then `VALIDATE CONSTRAINT` separately.
- Indexes: `CREATE INDEX CONCURRENTLY`.
- Changing a column type usually rewrites the table: add a new column, backfill in batches, switch reads, drop the old column later (expand/contract).
- Renames and drops break the running app version; ship them in a later release after the code stops using the old name.

## Connections and timeouts

- Use a connection pool in the app and, for many app instances or serverless, a server-side pooler (for example PgBouncer in transaction mode). Transaction-mode pooling breaks session state (session-level `SET`, advisory locks, some prepared-statement setups); check driver settings.
- Size pools from database capacity: total connections across all instances must stay under `max_connections` with headroom.
- Set `statement_timeout` and `idle_in_transaction_session_timeout` per role or database (for example 30s for web traffic, longer for a batch role). Server configuration changes on production need user approval.
- Enable `pg_stat_statements` to find the most expensive queries.

## Roles and row-level security

- The application connects as a least-privilege role that does not own the tables. Migrations run as the owner role.
- Grant only needed privileges per schema/table; as of Postgres 15 the `public` schema no longer allows `CREATE` for everyone, but check older databases and revoke it.
- RLS: `ALTER TABLE t ENABLE ROW LEVEL SECURITY;` plus `FORCE ROW LEVEL SECURITY` if the owner role must also be filtered. Write a policy per operation.
- In policies, wrap function calls in a sub-select so they run once per query, not once per row: `USING (user_id = (SELECT current_setting('app.user_id')::bigint))`. On Supabase the same applies to `(SELECT auth.uid())`.
- Index the columns policies filter on.
- Test policies as the application role: one user must not read or modify another's rows.

## Investigating a slow query

1. Get the exact query and parameters (from `pg_stat_statements` or logs).
2. On a non-production copy with realistic data, run `EXPLAIN (ANALYZE, BUFFERS) <query>`. `ANALYZE` executes the statement; wrap writes in `BEGIN; ... ROLLBACK;`.
3. Look for: sequential scans on large tables with selective filters, row estimates far from actual (run `ANALYZE` on the table), nested loops over many rows, sorts or hashes spilling to disk.
4. Fix the cause (index, rewrite, fresh statistics, smaller result), then re-run the plan and compare timings.

Diagnostic queries (unindexed FKs, slow queries, unused indexes, bloat, locks): [references/diagnostics.md](references/diagnostics.md).

## Red flags (review)

- FK columns without indexes; missing `NOT NULL`/`UNIQUE` the code relies on.
- `timestamp` without time zone, `float` for money, `serial` in new tables.
- String-built SQL; `SELECT *` in hot paths; `OFFSET` deep pagination.
- `CREATE INDEX` without `CONCURRENTLY` or blocking DDL without `lock_timeout` on large live tables.
- Long transactions wrapping external calls.
- RLS enabled without tests, or app connecting as table owner or superuser.

## Done when

- Constraints express the data rules; each new query has a supporting index or a plan showing it does not need one.
- Migrations are online-safe and reversible, with destructive steps approved.
