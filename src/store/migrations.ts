/** Append-only. Each entry runs once, in order, tracked by `PRAGMA user_version`. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id         INTEGER PRIMARY KEY,
    cwd        TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id               TEXT PRIMARY KEY,
    project_id       INTEGER REFERENCES projects(id),
    cwd              TEXT,
    git_branch       TEXT,
    name             TEXT,          -- Claude Code's session display name
    title            TEXT,          -- AI-generated title
    last_prompt      TEXT,
    first_ts         TEXT,
    last_ts          TEXT,
    msg_count        INTEGER NOT NULL DEFAULT 0,
    user_prompt_count INTEGER NOT NULL DEFAULT 0,
    cc_version       TEXT,
    cost_usd         REAL,
    source_path      TEXT,
    transcript_gone  INTEGER NOT NULL DEFAULT 0   -- Claude Code deleted the JSONL; we keep the history
  );
  CREATE INDEX sessions_last_ts ON sessions(last_ts);

  -- Keyed per session: forked/resumed sessions can copy message uuids into a new transcript.
  CREATE TABLE messages (
    uuid         TEXT NOT NULL,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_uuid  TEXT,
    ts           TEXT NOT NULL,
    role         TEXT NOT NULL,
    kind         TEXT NOT NULL,   -- prompt|meta|text|tool_use|tool_result|thinking|other
    tool_name    TEXT,
    text         TEXT NOT NULL DEFAULT '',
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, uuid)
  );
  CREATE INDEX messages_session_ts ON messages(session_id, ts);

  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages
    WHEN new.kind IN ('prompt', 'text') AND new.text <> '' BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages
    WHEN old.kind IN ('prompt', 'text') AND old.text <> '' BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;

  -- Incremental ingest bookkeeping, one row per transcript file.
  CREATE TABLE ingest_files (
    path        TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mtime_ms    INTEGER NOT NULL,
    offset      INTEGER NOT NULL,
    opted_out   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  -- Make Claude Code's away summaries searchable.
  DROP TRIGGER messages_ai;
  DROP TRIGGER messages_ad;
  CREATE TRIGGER messages_ai AFTER INSERT ON messages
    WHEN new.kind IN ('prompt', 'text', 'away_summary') AND new.text <> '' BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages
    WHEN old.kind IN ('prompt', 'text', 'away_summary') AND old.text <> '' BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;

  -- Re-read transcripts from the start to pick up away_summary records skipped before.
  -- Message inserts are idempotent, so this only adds what was missing.
  DELETE FROM ingest_files;

  -- One rolling summary per session, extended as the session grows.
  CREATE TABLE session_digests (
    session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    covers_until   TEXT NOT NULL,   -- timestamp of the last message the summary accounts for
    source         TEXT NOT NULL,   -- away_summary (written by Claude Code) | llm (written by us)
    model          TEXT,
    prompt_version INTEGER NOT NULL,
    digest_json    TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE recaps (
    day            TEXT PRIMARY KEY,  -- local date the recap is for, YYYY-MM-DD
    window_start   TEXT NOT NULL,
    window_end     TEXT NOT NULL,
    session_ids    TEXT NOT NULL,     -- JSON array
    model          TEXT NOT NULL,
    prompt_version INTEGER NOT NULL,
    recap_json     TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );

  -- Every model call the companion makes, so its usage is visible.
  CREATE TABLE llm_calls (
    id          INTEGER PRIMARY KEY,
    ts          TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    model       TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    cost_usd    REAL,
    duration_ms INTEGER,
    error       TEXT
  );
  `,
  `
  -- Living notes per session: the important points and specifics, kept current as the session goes.
  CREATE TABLE session_notes (
    session_id   TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    covers_until TEXT NOT NULL,   -- timestamp of the last message the notes account for
    path         TEXT NOT NULL,   -- the .md file
    model        TEXT,
    updated_at   TEXT NOT NULL
  );

  -- A chat opened from another one ("let's discuss this in a separate chat", or a hand-off).
  CREATE TABLE session_links (
    child_id   TEXT PRIMARY KEY,
    parent_id  TEXT NOT NULL,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL,     -- branch | handoff
    created_at TEXT NOT NULL
  );
  CREATE INDEX session_links_parent ON session_links(parent_id);

  -- Files you pinned as essential to a session: kept through compaction and handed to new chats.
  CREATE TABLE session_pins (
    session_id TEXT NOT NULL,
    path       TEXT NOT NULL,
    pinned_at  TEXT NOT NULL,
    PRIMARY KEY (session_id, path)
  );
  `,
  `
  -- Chats you hid from the sidebar. Their transcripts are left alone.
  CREATE TABLE hidden_sessions (
    session_id TEXT PRIMARY KEY,
    hidden_at  TEXT NOT NULL
  );

  -- Chats you deleted, so a transcript copy left behind is never ingested again.
  CREATE TABLE deleted_sessions (
    session_id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL
  );
  `,
  `
  -- MCP servers from Claude Code's list that Companion reads from, and how the last check went.
  -- The servers themselves (and their credentials) stay in Claude Code's config.
  CREATE TABLE connector_servers (
    name       TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1,
    status     TEXT,              -- connected | error
    detail     TEXT,              -- who it's signed in as, or the error
    checked_at TEXT
  );

  -- What a connector returned for a recap, shown next to it on Today.
  CREATE TABLE recap_sources (
    day        TEXT NOT NULL,
    kind       TEXT NOT NULL,     -- github
    data_json  TEXT,
    error      TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (day, kind)
  );
  `,
];
