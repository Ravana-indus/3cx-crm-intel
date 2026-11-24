import type { CallRow } from '../repo/calls.js';
import type { TranscriptRow } from '../repo/transcripts.js';
import type { SummaryResult } from '../summariser/types.js';
import { toColombo } from '../util/time.js';

export interface CallEventCall {
  id: string;
  direction: string;
  from: string | null;
  to: string | null;
  ext: string | null;
  agent: string | null;
  queue: string | null;
  outcome: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  ring_sec: number | null;
  talk_sec: number | null;
  lead_id: string | null;
}

export interface CallEventPayload {
  event: string;
  call: CallEventCall;
}

export function buildCallEvent(event: string, call: CallRow): CallEventPayload {
  return {
    event,
    call: {
      id: call.id,
      direction: call.direction,
      from: call.from_e164 ?? call.from_raw,
      to: call.to_e164 ?? call.to_raw,
      ext: call.ext,
      agent: call.agent_ext,
      queue: call.queue,
      outcome: call.outcome,
      started_at: toColombo(call.started_at),
      answered_at: toColombo(call.answered_at),
      ended_at: toColombo(call.ended_at),
      ring_sec: call.ring_sec,
      talk_sec: call.talk_sec,
      lead_id: call.lead_id,
    },
  };
}

export interface ConnectorDegradedPayload {
  event: 'connector.degraded';
  connector: '3cx';
  error: string | null;
}

export function buildConnectorDegraded(error: string | null): ConnectorDegradedPayload {
  return { event: 'connector.degraded', connector: '3cx', error };
}

/**
 * call.transcribed is emitted only after the transcript *and* summary are
 * ready, matching the portal contract in 3cx.md.
 */
export function buildCallTranscribedEvent(
  call: CallRow,
  transcript: TranscriptRow,
  result: SummaryResult,
) {
  return {
    event: 'call.transcribed',
    call: buildCallEvent('call.transcribed', call).call,
    transcript: {
      language: transcript.language,
      model: transcript.model,
      text: transcript.text,
    },
    summary: result.summary,
    extracted: result.extracted,
  };
}
