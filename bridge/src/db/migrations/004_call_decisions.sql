-- Layer B staging. Decisions are never written onto leads by this service;
-- the CRM pulls approved rows. Every fact keeps its verbatim evidence and a
-- transcript location.

CREATE TABLE IF NOT EXISTS call_decisions (
  id                    TEXT PRIMARY KEY,
  call_id               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'staged',
  provider              TEXT,
  model                 TEXT,
  model_version         TEXT,
  prompt_version        TEXT,
  transcript_hash       TEXT NOT NULL,
  input_hash            TEXT,
  outcome               TEXT,
  outcome_confidence    REAL,
  verdict               TEXT,
  verdict_reason        TEXT,
  next_action           TEXT,
  next_action_confidence REAL,
  decision_json         TEXT NOT NULL,
  validation_json       TEXT,
  reviewed_by           TEXT,
  reviewed_at           TEXT,
  review_note           TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_decisions_identity
  ON call_decisions(call_id, transcript_hash, model_version);

CREATE INDEX IF NOT EXISTS idx_call_decisions_status
  ON call_decisions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS decision_facts (
  id                  TEXT PRIMARY KEY,
  decision_id         TEXT NOT NULL,
  call_id             TEXT NOT NULL,
  field               TEXT NOT NULL,
  value_json          TEXT NOT NULL,
  confidence          REAL,
  evidence            TEXT NOT NULL,
  evidence_start_ms   INTEGER,
  evidence_end_ms     INTEGER,
  evidence_speaker    TEXT,
  confirmed_by        TEXT,
  created_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_facts_unique
  ON decision_facts(decision_id, field);

CREATE INDEX IF NOT EXISTS idx_decision_facts_call
  ON decision_facts(call_id);
