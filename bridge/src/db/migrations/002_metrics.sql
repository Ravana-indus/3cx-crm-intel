-- Phase 3 metrics. Definitions live in views so an aggregate can change
-- without a backfill. Drop first so a re-run of this migration is safe.

DROP VIEW IF EXISTS v_missed_callbacks;
DROP VIEW IF EXISTS v_metric_calls;

CREATE VIEW v_metric_calls AS
SELECT
  c.*,
  COALESCE(c.agent_ext, c.ext) AS agent_key,
  a.name AS agent_name,
  COALESCE(a.team, 'Unassigned') AS team,
  CASE
    WHEN c.direction = 'inbound'
      AND c.outcome IN ('answered', 'missed', 'abandoned', 'ai_handled')
    THEN 1 ELSE 0
  END AS is_offered,
  CASE WHEN c.outcome = 'answered' THEN 1 ELSE 0 END AS is_answered,
  CASE WHEN c.outcome IN ('answered', 'ai_handled') THEN 1 ELSE 0 END AS is_connected,
  CASE WHEN c.outcome = 'missed' THEN 1 ELSE 0 END AS is_missed,
  CASE WHEN c.outcome = 'abandoned' THEN 1 ELSE 0 END AS is_abandoned,
  CASE WHEN c.outcome = 'ai_handled' THEN 1 ELSE 0 END AS is_ai_handled,
  CASE WHEN c.direction = 'outbound' THEN 1 ELSE 0 END AS is_outbound,
  CASE
    WHEN c.outcome = 'answered'
      AND c.talk_sec IS NOT NULL
      AND c.talk_sec <= COALESCE(
        (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'drop_threshold_sec'),
        10
      )
    THEN 1 ELSE 0
  END AS is_drop
FROM calls c
LEFT JOIN agents a ON a.ext = COALESCE(c.agent_ext, c.ext);

CREATE VIEW v_missed_callbacks AS
SELECT
  m.id AS call_id,
  m.started_at,
  m.from_e164,
  (
    SELECT MIN(o.started_at)
    FROM calls o
    WHERE o.direction = 'outbound'
      AND o.to_e164 = m.from_e164
      AND o.started_at > m.started_at
  ) AS returned_at
FROM calls m
WHERE m.direction = 'inbound'
  AND m.outcome IN ('missed', 'abandoned');
