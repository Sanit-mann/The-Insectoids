# Database Migrations: Detail

Zero-downtime patterns for relational databases (examples in PostgreSQL) and short workflows for common migration tools. Read with the main `reversible-migration` skill.

## Safety checklist (before applying any migration)

- [ ] Has both up and down, or is explicitly marked irreversible.
- [ ] No long full-table locks on large tables (use non-blocking operations).
- [ ] New columns on existing tables are nullable or have a default.
- [ ] Indexes on existing large tables are built without blocking writes.
- [ ] Data backfill is a separate migration from the schema change.
- [ ] Tested against a copy of realistic (production-sized) data.
- [ ] Rollback plan written down.

## PostgreSQL patterns

### Add a column

```sql
-- Good: nullable, no rewrite
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- Good: constant default (instant on PostgreSQL 11+, no rewrite)
ALTER TABLE users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

-- Bad: NOT NULL without default on an existing table (fails or rewrites, locks)
ALTER TABLE users ADD COLUMN role TEXT NOT NULL;
```

To make a column `NOT NULL` later: add nullable, backfill, then add the constraint (on large tables, add a `CHECK (col IS NOT NULL) NOT VALID` constraint, `VALIDATE` it, then set `NOT NULL`).

### Add an index

```sql
-- Bad: blocks writes for the whole build on a large table
CREATE INDEX idx_users_email ON users (email);

-- Good: non-blocking
CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
```

`CONCURRENTLY` cannot run inside a transaction block. Most migration tools need a special flag or a hand-written SQL migration for it. If it fails midway it leaves an invalid index: drop it and retry.

### Rename a column (expand-contract)

```sql
-- Migration 1 (expand): add new column
ALTER TABLE users ADD COLUMN display_name TEXT;
-- Deploy code that writes both username and display_name.

-- Migration 2 (data): backfill in batches (see below)
-- Deploy code that reads display_name, still writes both.

-- Migration 3 (contract, needs approval, later deploy): drop old column
ALTER TABLE users DROP COLUMN username;
```

### Remove a column

1. Remove all code references to the column.
2. Deploy that code.
3. Drop the column in a later migration (approved destructive step).

### Batched backfill

```sql
-- Bad: one huge transaction, long locks
UPDATE users SET normalized_email = LOWER(email);

-- Good: batches, resumable, idempotent (only touches unconverted rows)
DO $$
DECLARE
  batch_size INT := 10000;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE users
    SET normalized_email = LOWER(email)
    WHERE id IN (
      SELECT id FROM users
      WHERE normalized_email IS NULL
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Updated % rows', rows_updated;
    EXIT WHEN rows_updated = 0;
    COMMIT;
  END LOOP;
END $$;
```

(`COMMIT` inside a `DO` block needs PostgreSQL 11+ and must not run inside an outer transaction.)

## Expand-contract timeline example

```
Day 1  migration adds new_status (nullable)
Day 1  deploy v2: writes status and new_status
Day 2  backfill migration for existing rows
Day 3  deploy v3: reads new_status only, still writes both
Day 7  (approved) migration drops status; deploy v4 stops writing it
```

## Tool workflows

Use the project's own tool and scripts. Commands below are the usual shape.

| Tool | Create | Apply | Notes |
|---|---|---|---|
| Prisma | `prisma migrate dev --name <name>` | `prisma migrate deploy` (production) | For SQL Prisma can't generate (concurrent indexes, backfills): `migrate dev --create-only`, then edit the SQL. `migrate reset` wipes data: dev only. |
| Drizzle | `drizzle-kit generate` | `drizzle-kit migrate` | `drizzle-kit push` skips migration files: dev only. |
| Kysely | `kysely migrate make <name>` | `kysely migrate latest` | Write migrations against an untyped database handle, not the current typed schema: migrations are frozen in time. Keep timestamp ordering enforced outside dev. |
| Django | `manage.py makemigrations` (`--empty <app> -n <name>` for custom) | `manage.py migrate` | Data migrations use `RunPython(forward, reverse)` with `apps.get_model`, never direct model imports. Use `SeparateDatabaseAndState` to drop a field from the model before dropping the column. |
| golang-migrate | `migrate create -ext sql -dir migrations -seq <name>` | `migrate ... up` | Writes `.up.sql` and `.down.sql` pairs. `force VERSION` only fixes a known dirty state; confirm the real DB state first. |

### Django data migration (batched, reversible)

```python
from django.db import migrations

def backfill_display_names(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    batch_size = 5000
    last_pk = 0
    while True:
        # Walk forward by primary key so every row is visited once, even if a
        # row's new value is still empty (e.g. blank username). Filtering on
        # display_name="" alone could loop forever on such rows.
        batch = list(
            User.objects.filter(pk__gt=last_pk, display_name="")
            .order_by("pk")[:batch_size]
        )
        if not batch:
            break
        for user in batch:
            user.display_name = user.username
        User.objects.bulk_update(batch, ["display_name"], batch_size=batch_size)
        last_pk = batch[-1].pk

class Migration(migrations.Migration):
    dependencies = [("accounts", "0015_add_display_name")]
    operations = [
        migrations.RunPython(backfill_display_names, migrations.RunPython.noop),
    ]
```

### Down migration example (golang-migrate)

```sql
-- 000003_add_user_avatar.up.sql
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- 000003_add_user_avatar.down.sql
ALTER TABLE users DROP COLUMN IF EXISTS avatar_url;
```

(A concurrent index needs its own migration, since it can't share a transaction.)

## Anti-patterns

| Anti-pattern | Why it fails | Instead |
|---|---|---|
| Manual SQL in production | No audit trail, can't repeat | Migration files |
| Editing an applied migration | Environments drift apart | New migration |
| `NOT NULL` without default | Locks and rewrites the table | Nullable, backfill, then constraint |
| Blocking index on a big table | Writes stall during build | Non-blocking (concurrent) build |
| Schema and data in one migration | Long transactions, hard rollback | Separate migrations |
| Dropping a column before removing code | Running app errors on missing column | Remove code first, drop next deploy |
| Resetting or "zeroing" migrations outside dev | Destroys data | Never without explicit approval |
