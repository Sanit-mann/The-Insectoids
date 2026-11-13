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
  // v2: taskboard (Hive 02-D10)
  `
  CREATE TABLE tasks (
    id                TEXT PRIMARY KEY,
    goal_id           TEXT NOT NULL,
    wave              INTEGER NOT NULL,
    title             TEXT NOT NULL,
    brief             TEXT NOT NULL,
    caste             TEXT NOT NULL,
    priority          TEXT NOT NULL,
    acceptance        TEXT NOT NULL,
    depends_on        TEXT NOT NULL DEFAULT '[]',
    status            TEXT NOT NULL,
    claimed_by        TEXT,
    lease_expires_at  INTEGER,
    attempts          INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL DEFAULT 3,
    escalated         INTEGER NOT NULL DEFAULT 0,
    result            TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX tasks_board ON tasks (status, caste, priority, created_at);
  CREATE INDEX tasks_goal ON tasks (goal_id, wave);

  CREATE TABLE task_events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    from_st    TEXT NOT NULL,
    to_st      TEXT NOT NULL,
    actor      TEXT NOT NULL,
    note       TEXT,
    at         INTEGER NOT NULL
  );
  CREATE INDEX task_events_task ON task_events (task_id, seq);
  `,
  // v3: goals and the approval inbox (Hive 02-D5, D7, D11)
  `
  CREATE TABLE goals (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    text           TEXT NOT NULL,
    shelf          TEXT NOT NULL,
    status         TEXT NOT NULL,
    plan           TEXT,
    current_wave   INTEGER NOT NULL DEFAULT 0,
    budget_tokens  INTEGER,
    spent_tokens   INTEGER NOT NULL DEFAULT 0,
    spent_usd      REAL NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE approvals (
    id           TEXT PRIMARY KEY,
    goal_id      TEXT,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    from_agent   TEXT NOT NULL,
    why          TEXT NOT NULL,
    effect       TEXT NOT NULL,
    destructive  INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL,
    payload      TEXT,
    created_at   INTEGER NOT NULL,
    decided_at   INTEGER,
    decided_by   TEXT
  );
  CREATE INDEX approvals_status ON approvals (status, created_at);
  `,
  // v4: run outcomes, the Treasurer's memory (Hive 02-D9 P1, Connections 04-D7; Phase 2 A5)
  `
  CREATE TABLE run_outcomes (
    run_id          TEXT PRIMARY KEY,
    goal_id         TEXT,
    card_id         TEXT,
    role            TEXT NOT NULL,
    priority        TEXT NOT NULL,
    engine          TEXT NOT NULL,
    tier            TEXT NOT NULL,
    model           TEXT NOT NULL,
    effort          TEXT NOT NULL,
    attempt         INTEGER NOT NULL DEFAULT 0,
    result          TEXT NOT NULL,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    tokens_cache    INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    cost_estimated  INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    at              INTEGER NOT NULL
  );
  CREATE INDEX run_outcomes_engine_at ON run_outcomes (engine, at);
  CREATE INDEX run_outcomes_learn ON run_outcomes (role, engine, tier, effort, result);
  CREATE INDEX run_outcomes_card ON run_outcomes (card_id, attempt);
  `,
  // v5: meaning-search vectors (Memory 01-E11; Phase 2 B1). One per record and model; stale when the
  // record's content hash moves on. int8-quantized unit vectors (1 byte per dimension).
  `
  CREATE TABLE record_vectors (
    record_id     TEXT NOT NULL REFERENCES records(id),
    model         TEXT NOT NULL,
    dim           INTEGER NOT NULL,
    vec           BLOB NOT NULL,
    content_hash  TEXT NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (record_id, model)
  );
  CREATE INDEX record_vectors_model ON record_vectors (model);
  `,
  // v6: use, importance and time (Memory 01-E5, E7, E9; Phase 2 B2).
  // - reads / helped / last_used_at: how agents use a record (ranking and decay).
  // - valid_from / valid_to / superseded_by: time-aware facts; a superseded record leaves default search.
  // - archived_reason: why it left search ("faded: …", "merged into …", "by you").
  // - record_reads: which card attempt read which record, so a pass can credit what helped.
  `
  ALTER TABLE records ADD COLUMN reads INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE records ADD COLUMN helped INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE records ADD COLUMN last_used_at INTEGER;
  ALTER TABLE records ADD COLUMN valid_from INTEGER;
  ALTER TABLE records ADD COLUMN valid_to INTEGER;
  ALTER TABLE records ADD COLUMN superseded_by TEXT;
  ALTER TABLE records ADD COLUMN archived_reason TEXT;
  UPDATE records SET valid_from = created_at;
  CREATE INDEX records_current ON records (shelf, kind, archived, valid_to);

  CREATE TABLE record_reads (
    read_key   TEXT NOT NULL,
    record_id  TEXT NOT NULL REFERENCES records(id),
    credited   INTEGER NOT NULL DEFAULT 0,
    at         INTEGER NOT NULL,
    PRIMARY KEY (read_key, record_id)
  );
  `,
  // v7: lessons (Memory 01-E10; Phase 2 B3). One row per time the hive ran into a lesson, so a lesson
  // seen again (folded by dedupe) counts up instead of being copied.
  `
  CREATE TABLE lesson_hits (
    record_id  TEXT NOT NULL REFERENCES records(id),
    at         INTEGER NOT NULL
  );
  CREATE INDEX lesson_hits_record ON lesson_hits (record_id);
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
