# Postgres diagnostic queries and snippets

For [postgres-patterns](../SKILL.md). All read-only unless marked. Run against a local or staging database, or against production only with read-only access you were given for the task.

## Foreign keys without an index

```sql
SELECT c.conrelid::regclass AS table_name, a.attname AS column_name
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum   -- FK column leads an index
  );
```

## Most expensive queries (needs pg_stat_statements)

```sql
SELECT calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 1)  AS mean_ms,
       rows,
       left(query, 200) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

Sort by `total_exec_time` to find what costs the most overall; by `mean_exec_time` to find individually slow queries.

## Unused indexes

```sql
SELECT s.relname AS table_name, s.indexrelname AS index_name,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size, s.idx_scan
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

Statistics reset on restart and are per node; check replicas before dropping anything (dropping needs approval).

## Dead tuples and vacuum health

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC;
```

## Current locks and blockers

```sql
SELECT blocked.pid AS blocked_pid, left(blocked.query, 120) AS blocked_query,
       blocking.pid AS blocking_pid, left(blocking.query, 120) AS blocking_query,
       now() - blocked.query_start AS waiting_for
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY (pg_blocking_pids(blocked.pid));
```

## Long-running and idle-in-transaction sessions

```sql
SELECT pid, state, now() - xact_start AS xact_age, left(query, 120) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 20;
```

Terminating sessions (`pg_terminate_backend`) on a shared or production database needs user approval.

## Plan for a write without changing data

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) UPDATE orders SET status = 'archived' WHERE created_at < now() - interval '1 year';
ROLLBACK;
```

## Online migration snippets

```sql
SET lock_timeout = '5s';

-- index on a live table (outside a transaction block)
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_customer_id_idx ON orders (customer_id);

-- NOT NULL without a long exclusive lock
ALTER TABLE orders ADD CONSTRAINT orders_customer_id_not_null CHECK (customer_id IS NOT NULL) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_id_not_null;
ALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;
ALTER TABLE orders DROP CONSTRAINT orders_customer_id_not_null;

-- foreign key in two steps
ALTER TABLE orders ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_fk;
```

## Query patterns

```sql
-- upsert
INSERT INTO settings (user_id, key, value)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value;

-- keyset pagination (index on (created_at, id))
SELECT id, title, created_at
FROM posts
WHERE (created_at, id) < ($1, $2)
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- job queue claim
UPDATE jobs SET status = 'running', started_at = now()
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

## Row-level security

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- only if the owner role must be filtered too

CREATE POLICY orders_select_own ON orders FOR SELECT
  USING (user_id = (SELECT current_setting('app.user_id')::bigint));

CREATE POLICY orders_insert_own ON orders FOR INSERT
  WITH CHECK (user_id = (SELECT current_setting('app.user_id')::bigint));

CREATE INDEX CONCURRENTLY orders_user_id_idx ON orders (user_id);

-- per request, inside the transaction:
-- SET LOCAL app.user_id = '42';
```

## Role and timeout defaults (example; production changes need approval)

```sql
CREATE ROLE app_user LOGIN;                     -- password set out of band, never in a migration file
GRANT USAGE ON SCHEMA app TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_user;
ALTER ROLE app_user SET statement_timeout = '30s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '30s';
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- also needs shared_preload_libraries
```
