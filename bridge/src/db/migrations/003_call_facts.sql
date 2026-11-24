-- Layer A: deterministic PBX facts. All columns are nullable because 3CX does
-- not expose every field on every build/licence. A null is honest; a guessed
-- value would corrupt the CRM. Raw status is retained for audit/backfill.

ALTER TABLE calls ADD COLUMN disposition TEXT;
ALTER TABLE calls ADD COLUMN hangup_party TEXT;
ALTER TABLE calls ADD COLUMN queue_wait_sec INTEGER;
ALTER TABLE calls ADD COLUMN agent_user_id TEXT;
ALTER TABLE calls ADD COLUMN missed_call INTEGER;
ALTER TABLE calls ADD COLUMN raw_status TEXT;
ALTER TABLE calls ADD COLUMN raw_json TEXT;
ALTER TABLE calls ADD COLUMN transfer_to TEXT;
ALTER TABLE calls ADD COLUMN transferred_at TEXT;

ALTER TABLE recordings ADD COLUMN expires_at TEXT;
ALTER TABLE agents ADD COLUMN user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_id
  ON agents(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS call_segments (
  call_id        TEXT NOT NULL,
  tcx_segment_id TEXT NOT NULL,
  started_at     TEXT,
  ended_at       TEXT,
  ext            TEXT,
  action_dn      TEXT,
  status         TEXT,
  raw_json       TEXT,
  PRIMARY KEY (call_id, tcx_segment_id)
);

CREATE INDEX IF NOT EXISTS idx_call_segments_call
  ON call_segments(call_id, started_at);
