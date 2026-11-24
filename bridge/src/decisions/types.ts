import type { CallRow } from '../repo/calls.js';
import type { TranscriptRow } from '../repo/transcripts.js';
import type { DecisionPayload } from './schema.js';

export interface LayerAFacts {
  callId: string;
  tcxCallId: string;
  direction: string;
  fromNumber: string | null;
  toNumber: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  disposition: string | null;
  hangupParty: string | null;
  queueWaitSeconds: number | null;
  ringSeconds: number | null;
  talkSeconds: number | null;
  agentExtension: string | null;
  agentUserId: string | null;
  isMissed: boolean | null;
  queue: string | null;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
  language: string | null;
  confidence: number | null;
}

export interface DecisionInput {
  call: CallRow;
  transcript: TranscriptRow;
  segments: TranscriptSegment[];
  facts: LayerAFacts;
  maxTranscriptChars: number;
}

export interface DecisionFactRowInput {
  field: string;
  value: unknown;
  confidence: number;
  evidence: string;
  evidenceStartMs: number | null;
  evidenceEndMs: number | null;
  evidenceSpeaker: string | null;
  confirmedBy: string;
}

export interface DecisionValidation {
  rejected: Array<{ field: string; reason: string }>;
  pbx_override?: string;
  transcript_truncated?: boolean;
  competitors_dropped?: string[];
  verdict_reason_truncated?: boolean;
  error?: string;
}

export interface ValidatedDecision {
  decision: DecisionPayload;
  validation: DecisionValidation;
  facts: DecisionFactRowInput[];
  truncated: boolean;
}

export interface DecisionModelResponse {
  raw: unknown;
  truncated: boolean;
}

export interface DecisionModel {
  readonly name: string;
  readonly model: string;
  decide(
    input: DecisionInput,
    feedback?: string,
  ): Promise<DecisionModelResponse>;
}
