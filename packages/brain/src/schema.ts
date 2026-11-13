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
  // v8: the code map (Memory 01-E3, D6; Phase 2 B4). Per project shelf: each mapped file with its content
  // hash (refresh only what changed), its symbols, and its calls. Built from the user's project, read-only.
  `
  CREATE TABLE code_files (
    shelf       TEXT NOT NULL,
    path        TEXT NOT NULL,
    language    TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size        INTEGER NOT NULL,
    imports     TEXT NOT NULL,
    parsed_at   INTEGER NOT NULL,
    PRIMARY KEY (shelf, path)
  );
  CREATE TABLE code_symbols (
    shelf       TEXT NOT NULL,
    path        TEXT NOT NULL,
    name        TEXT NOT NULL,
    qualified   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    line        INTEGER NOT NULL,
    end_line    INTEGER NOT NULL,
    signature   TEXT NOT NULL,
    doc         TEXT,
    parent      TEXT
  );
  CREATE INDEX code_symbols_name ON code_symbols (shelf, name COLLATE NOCASE);
  CREATE INDEX code_symbols_path ON code_symbols (shelf, path);
  CREATE TABLE code_edges (
    shelf       TEXT NOT NULL,
    from_path   TEXT NOT NULL,
    from_symbol TEXT NOT NULL,
    callee      TEXT NOT NULL,
    to_path     TEXT,
    line        INTEGER NOT NULL
  );
  CREATE INDEX code_edges_callee ON code_edges (shelf, callee COLLATE NOCASE);
  CREATE INDEX code_edges_from ON code_edges (shelf, from_path, from_symbol);
  CREATE TABLE code_map_state (
    shelf         TEXT PRIMARY KEY,
    last_built_at INTEGER,
    skipped       INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v9: the library catalog (Capabilities 03-D8; Phase 2 C1). One row per agent, skill or tool, synced from
  // the library folder's catalog; usage numbers stay across syncs. Activations log which skills an insect
  // carried on a card attempt, and how that attempt ended.
  `
  CREATE TABLE library_items (
    name          TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    status        TEXT NOT NULL,
    castes        TEXT NOT NULL,
    description   TEXT NOT NULL,
    safety        TEXT NOT NULL,
    file          TEXT,
    sources       TEXT NOT NULL,
    uses          INTEGER NOT NULL DEFAULT 0,
    passed        INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    tokens        INTEGER NOT NULL DEFAULT 0,
    last_used_at  INTEGER,
    synced_at     INTEGER NOT NULL
  );
  CREATE INDEX library_items_status ON library_items (status);
  CREATE VIRTUAL TABLE library_fts USING fts5(
    name, description,
    content = 'library_items', content_rowid = 'rowid', tokenize = 'unicode61'
  );
  CREATE TRIGGER library_ai AFTER INSERT ON library_items BEGIN
    INSERT INTO library_fts (rowid, name, description) VALUES (new.rowid, new.name, new.description);
  END;
  CREATE TRIGGER library_ad AFTER DELETE ON library_items BEGIN
    INSERT INTO library_fts (library_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
  END;
  CREATE TRIGGER library_au AFTER UPDATE OF name, description ON library_items BEGIN
    INSERT INTO library_fts (library_fts, rowid, name, description) VALUES ('delete', old.rowid, old.name, old.description);
    INSERT INTO library_fts (rowid, name, description) VALUES (new.rowid, new.name, new.description);
  END;
  CREATE TABLE library_activations (
    card_id   TEXT NOT NULL,
    attempt   INTEGER NOT NULL,
    item      TEXT NOT NULL,
    at        INTEGER NOT NULL,
    outcome   TEXT NOT NULL DEFAULT 'running',
    PRIMARY KEY (card_id, attempt, item)
  );
  CREATE INDEX library_activations_item ON library_activations (item, at);
  `,
  // v10: the managers' brain side (Hive 02-D8, D9 P3; Phase 2 C2). A card the Watchdog holds is not
  // claimable until the Foreman decides; the Foreman may give a card one more try, once, with a note or a
  // stronger model. Incidents are the Watchdog's log (with a recurrence count per signature); the Foreman's
  // decisions are kept for the Hive monitor.
  `
  ALTER TABLE tasks ADD COLUMN held_reason TEXT;
  ALTER TABLE tasks ADD COLUMN foreman_retries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN foreman_note TEXT;
  ALTER TABLE tasks ADD COLUMN foreman_tier TEXT;
  CREATE TABLE incidents (
    id          TEXT PRIMARY KEY,
    at          INTEGER NOT NULL,
    sensor      TEXT NOT NULL,
    step        TEXT NOT NULL,
    agent       TEXT NOT NULL,
    run_id      TEXT,
    goal_id     TEXT,
    card_id     TEXT,
    evidence    TEXT NOT NULL,
    signature   TEXT NOT NULL,
    recurrence  INTEGER NOT NULL
  );
  CREATE INDEX incidents_at ON incidents (at);
  CREATE INDEX incidents_signature ON incidents (signature);
  CREATE TABLE foreman_decisions (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    goal_id     TEXT NOT NULL,
    card_id     TEXT NOT NULL,
    card_title  TEXT NOT NULL,
    wake        TEXT NOT NULL,
    action      TEXT NOT NULL,
    reason      TEXT NOT NULL
  );
  CREATE INDEX foreman_decisions_card ON foreman_decisions (card_id);
  `,
  // v11: skill proposals and imports (Capabilities 03-D5, D6; Phase 2 C3). Items now have an origin
  // (built-in, learned from repeated work, or imported by the user), the safety scan of learned and imported
  // ones, the approval waiting on them, and when the user approved them. A retired status persists across
  // syncs. Proposals remember each cluster of repeated work, so the same work is proposed once, ever.
  `
  ALTER TABLE library_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'built-in';
  ALTER TABLE library_items ADD COLUMN scan TEXT;
  ALTER TABLE library_items ADD COLUMN approval_id TEXT;
  ALTER TABLE library_items ADD COLUMN approved_at INTEGER;
  ALTER TABLE library_items ADD COLUMN retired_reason TEXT;
  CREATE TABLE library_proposals (
    cluster   TEXT PRIMARY KEY,
    at        INTEGER NOT NULL,
    caste     TEXT NOT NULL,
    cards     TEXT NOT NULL,
    item      TEXT,
    outcome   TEXT NOT NULL
  );
  CREATE INDEX library_proposals_at ON library_proposals (at);
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
