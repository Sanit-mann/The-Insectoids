import type { DatabaseSync } from 'node:sqlite';

/**
 * Run fn in one immediate (write-locking) transaction; roll back on any error. Inside an open transaction
 * (e.g. a read noted while a write is under way) fn simply joins it.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if ((db as DatabaseSync & { isTransaction?: boolean }).isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
