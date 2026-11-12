import type { DatabaseSync } from 'node:sqlite';

/** Ordered migrations; PRAGMA user_version records how many have run. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE records (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    shelf         TEXT NOT NULL,
    owner         TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    summary       TEXT,
    trust         TEXT NOT NULL,
    source        TEXT,
    confidence    REAL,
    content_hash  TEXT NOT NULL,
    version       INTEGER NOT NULL,
    archived      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX records_shelf_kind ON records (shelf, kind, archived);
  CREATE INDEX records_hash ON records (shelf, content_hash);

  CREATE TABLE record_versions (
    record_id   TEXT NOT NULL REFERENCES records(id),
    version     INTEGER NOT NULL,
    change      TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    summary     TEXT,
    trust       TEXT NOT NULL,
    changed_by  TEXT NOT NULL,
    changed_at  INTEGER NOT NULL,
    PRIMARY KEY (record_id, version)
  );

  CREATE TABLE links (
    from_id     TEXT NOT NULL REFERENCES records(id),
    to_id       TEXT NOT NULL REFERENCES records(id),
    rel         TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, rel)
  );

  CREATE VIRTUAL TABLE records_fts USING fts5(
    title, body, summary,
    content = 'records', content_rowid = 'rowid', tokenize = 'unicode61'
  );
  CREATE TRIGGER records_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts (rowid, title, body, summary) VALUES (new.rowid, new.title, new.body, new.summary);
  END;
  CREATE TRIGGER records_au AFTER UPDATE OF title, body, summary ON records BEGIN
    INSERT INTO records_fts (records_fts, rowid, title, body, summary) VALUES ('delete', old.rowid, old.title, old.body, old.summary);
    INSERT INTO records_fts (rowid, title, body, summary) VALUES (new.rowid, new.title, new.body, new.summary);
  END;
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
