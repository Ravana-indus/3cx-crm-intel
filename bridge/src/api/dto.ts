import type { CallRow } from '../repo/calls.js';
import type {
  DecisionFactRow,
  DecisionRow,
} from '../repo/decisions.js';
import type { SummaryRow } from '../repo/summaries.js';
import type { TranscriptRow } from '../repo/transcripts.js';
import { toColombo } from '../util/time.js';

export interface CallDtoOptions {
  recordingUrl?: string | null;
  recordingUrlExpiresAt?: string | null;
  recordingExpiresAt?: string | null;
  transcript?: unknown;
  summary?: unknown;
  decision?: unknown;
  facts?: unknown;
  agentUserId?: string | null;
  hasRecording?: boolean;
  hasTranscript?: boolean;
  hasSummary?: boolean;
  hasDecision?: boolean;
}

/**
 * Layer A facts are deterministic and nullable. A null means the PBX did not
 * expose the value; it is never inferred from prose or model output.
 */
export function factsDto(
  row: CallRow,
  options: CallDtoOptions = {},
) {
  const durationSeconds =
    row.started_at && row.ended_at
      ? Math.max(
          0,
          Math.round(
            (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000,
          ),
        )
      : null;

  return {
    call_id: row.id,
    tcx_call_id: row.tcx_call_id,
    direction: row.direction,
    from_number: row.from_e164 ?? row.from_raw ?? null,
    to_number: row.to_e164 ?? row.to_raw ?? null,
    started_at: toColombo(row.started_at),
    answered_at: toColombo(row.answered_at),
    ended_at: toColombo(row.ended_at),
    duration_seconds: durationSeconds,
    disposition: row.disposition ?? null,
    hangup_party: row.hangup_party ?? null,
    queue_wait_seconds: row.queue_wait_sec ?? null,
    ring_seconds: row.ring_sec ?? null,
    talk_seconds: row.talk_sec ?? null,
    agent_extension: row.agent_ext ?? row.ext ?? null,
    agent_user_id: options.agentUserId ?? row.agent_user_id ?? null,
    recording_url: options.recordingUrl ?? null,
    recording_url_expires_at:
      options.recordingUrlExpiresAt ?? null,
    recording_expires_at: options.recordingExpiresAt ?? null,
    transfer_to: row.transfer_to ?? null,
    transferred_at: toColombo(row.transferred_at),
    is_missed:
      row.missed_call === null || row.missed_call === undefined
        ? null
        : Boolean(row.missed_call),
    raw_status: row.raw_status ?? null,
    source: 'layer_a' as const,
  };
}

export function callDto(row: CallRow, options: CallDtoOptions = {}) {
  return {
    id: row.id,
    tcx_call_id: row.tcx_call_id,
    direction: row.direction,
    from_raw: row.from_raw,
    from_e164: row.from_e164,
    to_raw: row.to_raw,
    to_e164: row.to_e164,
    ext: row.ext,
    agent: row.agent_ext,
    queue: row.queue,
    outcome: row.outcome,
    started_at: toColombo(row.started_at),
    answered_at: toColombo(row.answered_at),
    ended_at: toColombo(row.ended_at),
    ring_sec: row.ring_sec,
    talk_sec: row.talk_sec,
    lead_id: row.lead_id,
    recording_url: options.recordingUrl ?? null,
    recording_expires_at: options.recordingExpiresAt ?? null,
    recording_url_expires_at: options.recordingUrlExpiresAt ?? null,
    has_recording: options.hasRecording ?? Boolean(options.recordingUrl),
    has_transcript: options.hasTranscript ?? Boolean(options.transcript),
    has_summary: options.hasSummary ?? Boolean(options.summary),
    has_decision: options.hasDecision ?? Boolean(options.decision),
    facts: options.facts ?? factsDto(row, options),
    transcript: options.transcript ?? null,
    summary: options.summary ?? null,
    decision: options.decision ?? null,
  };
}

function segmentDto(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const segment = value as Record<string, unknown>;
  const start =
    typeof segment.start_ms === 'number'
      ? segment.start_ms
      : typeof segment.start === 'number'
        ? Math.round(segment.start * 1000)
        : null;
  const end =
    typeof segment.end_ms === 'number'
      ? segment.end_ms
      : typeof segment.end === 'number'
        ? Math.round(segment.end * 1000)
        : null;

  return {
    ...segment,
    start_ms: start,
    end_ms: end,
    language:
      typeof segment.language === 'string' ? segment.language : null,
    confidence:
      typeof segment.confidence === 'number' ? segment.confidence : null,
  };
}

export function transcriptDto(row: TranscriptRow | undefined) {
  if (!row) return null;

  let segments: unknown = [];
  try {
    const parsed = row.segments_json ? JSON.parse(row.segments_json) : [];
    segments = Array.isArray(parsed) ? parsed.map(segmentDto) : [];
  } catch {
    segments = [];
  }

  return {
    engine: row.engine,
    model: row.model,
    language: row.language,
    text: row.text,
    segments,
    created_at: toColombo(row.created_at),
  };
}

export function summaryDto(row: SummaryRow | undefined) {
  if (!row) return null;

  let extracted: unknown = null;
  try {
    extracted = row.extracted_json ? JSON.parse(row.extracted_json) : null;
  } catch {
    extracted = null;
  }

  return {
    model: row.model,
    summary: row.summary,
    extracted,
    created_at: toColombo(row.created_at),
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function decisionDto(
  row: DecisionRow | undefined,
  facts: DecisionFactRow[] = [],
) {
  if (!row) return null;

  return {
    id: row.id,
    call_id: row.call_id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    model_version: row.model_version,
    prompt_version: row.prompt_version,
    transcript_hash: row.transcript_hash,
    outcome: row.outcome,
    outcome_confidence: row.outcome_confidence,
    verdict: row.verdict,
    verdict_reason: row.verdict_reason,
    next_action: row.next_action,
    next_action_confidence: row.next_action_confidence,
    decision: parseJson(row.decision_json),
    validation: parseJson(row.validation_json),
    facts: facts.map((fact) => ({
      field: fact.field,
      value: parseJson(fact.value_json),
      confidence: fact.confidence,
      evidence: fact.evidence,
      evidence_start_ms: fact.evidence_start_ms,
      evidence_end_ms: fact.evidence_end_ms,
      evidence_speaker: fact.evidence_speaker,
      confirmed_by: fact.confirmed_by,
    })),
    reviewed_by: row.reviewed_by,
    reviewed_at: toColombo(row.reviewed_at),
    review_note: row.review_note,
    created_at: toColombo(row.created_at),
    updated_at: toColombo(row.updated_at),
  };
}
