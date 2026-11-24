-- Full schema from 3cx.md. Phase 1 uses calls, recordings, jobs, outbox,
-- checkpoints, presence_events; the rest are created up front so later
-- phases do not need to migrate core tables again.

CREATE TABLE IF NOT EXISTS calls (
  id                TEXT PRIMARY KEY,
  tcx_call_id       TEXT NOT NULL UNIQUE,
  tcx_segment_ids   TEXT NOT NULL DEFAULT '[]',
  direction         TEXT NOT NULL,
  from_raw          TEXT,
  from_e164         TEXT,
  to_raw            TEXT,
  to_e164           TEXT,
  ext               TEXT,
  agent_ext         TEXT,
  queue             TEXT,
  outcome           TEXT,
  started_at        TEXT NOT NULL,
  answered_at       TEXT,
  ended_at          TEXT,
  ring_sec          INTEGER,
  talk_sec          INTEGER,
  lead_id           TEXT,
  ai_conversation_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_outcome ON calls(outcome);
CREATE INDEX IF NOT EXISTS idx_calls_lead_id ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_from_e164 ON calls(from_e164);

CREATE TABLE IF NOT EXISTS recordings (
  id             TEXT PRIMARY KEY,
  call_id        TEXT,
  tcx_rec_id     TEXT NOT NULL UNIQUE,
  file_path      TEXT NOT NULL,
  sha256         TEXT,
  bytes          INTEGER,
  duration_sec   REAL,
  channels       INTEGER,
  downloaded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recordings_call_id ON recordings(call_id);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  ref_id        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_at    TEXT,
  error         TEXT,
  next_run_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_ref ON jobs(type, ref_id);

CREATE TABLE IF NOT EXISTS transcripts (
  call_id       TEXT PRIMARY KEY,
  engine        TEXT,
  model         TEXT,
  language      TEXT,
  text          TEXT,
  segments_json TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  call_id        TEXT PRIMARY KEY,
  model          TEXT,
  summary        TEXT,
  extracted_json TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  ext    TEXT PRIMARY KEY,
  name   TEXT,
  email  TEXT,
  team   TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS presence_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ext    TEXT NOT NULL,
  status TEXT NOT NULL,
  at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_presence_ext_at ON presence_events(ext, at DESC);

CREATE TABLE IF NOT EXISTS ai_conversations (
  el_conversation_id TEXT PRIMARY KEY,
  call_id            TEXT,
  caller_e164        TEXT,
  transcript_json    TEXT,
  analysis_json      TEXT,
  collected_json     TEXT,
  lead_id            TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_docs (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  tags         TEXT,
  owner        TEXT,
  review_by    TEXT,
  content_hash TEXT,
  el_doc_id    TEXT,
  updated_at   TEXT NOT NULL,
  synced_at    TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  event           TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  delivered_at    TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(delivered_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS checkpoints (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
