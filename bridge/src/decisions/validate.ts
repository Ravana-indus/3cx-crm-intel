import type { TranscriptRow } from '../repo/transcripts.js';
import {
  DECISION_MODEL_VERSION,
  decisionSchema,
  type DecisionPayload,
} from './schema.js';
import type {
  DecisionFactRowInput,
  DecisionInput,
  DecisionValidation,
  TranscriptSegment,
  ValidatedDecision,
} from './types.js';

export class DecisionValidationError extends Error {
  readonly details: unknown;
  readonly raw: unknown;

  constructor(message: string, raw: unknown, details?: unknown) {
    super(message);
    this.name = 'DecisionValidationError';
    this.raw = raw;
    this.details = details;
  }
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function buildTranscriptSegments(
  transcript: TranscriptRow,
): TranscriptSegment[] {
  let parsed: unknown = [];
  try {
    parsed = transcript.segments_json
      ? JSON.parse(transcript.segments_json)
      : [];
  } catch {
    parsed = [];
  }

  const segments: TranscriptSegment[] = [];
  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      if (!value || typeof value !== 'object') continue;
      const segment = value as Record<string, unknown>;
      const text = typeof segment.text === 'string' ? segment.text.trim() : '';
      if (!text) continue;

      const startMs =
        numberOrNull(segment.start_ms) ??
        (numberOrNull(segment.start) !== null
          ? Math.round((numberOrNull(segment.start) as number) * 1000)
          : 0);
      const endMs =
        numberOrNull(segment.end_ms) ??
        (numberOrNull(segment.end) !== null
          ? Math.round((numberOrNull(segment.end) as number) * 1000)
          : startMs);

      segments.push({
        startMs,
        endMs,
        speaker:
          typeof segment.speaker === 'string' ? segment.speaker : null,
        text,
        language:
          typeof segment.language === 'string' ? segment.language : null,
        confidence: numberOrNull(segment.confidence),
      });
    }
  }

  if (segments.length === 0 && transcript.text?.trim()) {
    segments.push({
      startMs: 0,
      endMs: 0,
      speaker: null,
      text: transcript.text.trim(),
      language: transcript.language,
      confidence: null,
    });
  }

  return segments.sort((a, b) => a.startMs - b.startMs);
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface SearchIndex {
  full: string;
  spans: Array<{ segment: TranscriptSegment; start: number; end: number }>;
}

function buildSearchIndex(segments: TranscriptSegment[]): SearchIndex {
  let full = '';
  const spans: SearchIndex['spans'] = [];

  for (const segment of segments) {
    const piece = normalise(segment.text);
    if (!piece) continue;
    if (full) full += ' ';
    const start = full.length;
    full += piece;
    spans.push({ segment, start, end: full.length });
  }

  return { full, spans };
}

interface EvidenceLocation {
  startMs: number | null;
  endMs: number | null;
  speaker: string | null;
}

function locateEvidence(
  index: SearchIndex,
  evidence: string,
): EvidenceLocation | null {
  const needle = normalise(evidence);
  if (!needle) return null;

  const position = index.full.indexOf(needle);
  if (position === -1) return null;

  const endPosition = position + needle.length;
  const startSpan = index.spans.find(
    (span) => position >= span.start && position < span.end,
  );
  const endSpan = index.spans.find(
    (span) => endPosition > span.start && endPosition <= span.end,
  );

  if (!startSpan || !endSpan) return null;

  return {
    startMs: startSpan.segment.startMs || null,
    endMs: endSpan.segment.endMs || null,
    speaker:
      startSpan.segment === endSpan.segment
        ? startSpan.segment.speaker
        : null,
  };
}

/**
 * Applies the contract's two hard rules the model cannot be trusted with:
 * evidence must exist verbatim, and PBX facts override connectivity.
 */
export function validateDecision(
  raw: unknown,
  input: DecisionInput,
): ValidatedDecision {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DecisionValidationError(
      'Laya did not return a JSON object',
      raw,
    );
  }

  const prepared = {
    ...(raw as Record<string, unknown>),
    call_id: input.call.id,
    model_version: DECISION_MODEL_VERSION,
  };

  const parsed = decisionSchema.safeParse(prepared);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new DecisionValidationError(
      `Laya JSON failed schema: ${detail}`,
      raw,
      parsed.error.issues,
    );
  }

  const decision = structuredClone(parsed.data) as DecisionPayload;
  const segments = input.segments;
  const index = buildSearchIndex(segments);
  const validation: DecisionValidation = { rejected: [] };
  const factRows: DecisionFactRowInput[] = [];

  for (const key of Object.keys(
    decision.dimension_signals,
  ) as Array<keyof DecisionPayload['dimension_signals']>) {
    const dimension = decision.dimension_signals[key];
    if (!dimension.asked) continue;
    if (dimension.value === null || !dimension.evidence) {
      dimension.value = null;
      dimension.evidence = null;
      validation.rejected.push({
        field: `dimension_signals.${key}`,
        reason: 'missing_evidence',
      });
      continue;
    }

    const location = locateEvidence(index, dimension.evidence);
    if (!location) {
      dimension.value = null;
      dimension.evidence = null;
      validation.rejected.push({
        field: `dimension_signals.${key}`,
        reason: 'evidence_not_in_transcript',
      });
    }
  }

  const seenFields = new Set<string>();
  const keptFacts: DecisionPayload['facts'] = [];
  for (const fact of decision.facts) {
    if (seenFields.has(fact.field)) {
      validation.rejected.push({
        field: `facts.${fact.field}`,
        reason: 'duplicate_field',
      });
      continue;
    }

    const location = locateEvidence(index, fact.evidence);
    if (!location) {
      validation.rejected.push({
        field: `facts.${fact.field}`,
        reason: 'evidence_not_in_transcript',
      });
      continue;
    }

    seenFields.add(fact.field);
    keptFacts.push(fact);
    factRows.push({
      field: fact.field,
      value: fact.value,
      confidence: fact.confidence,
      evidence: fact.evidence,
      evidenceStartMs: location.startMs,
      evidenceEndMs: location.endMs,
      evidenceSpeaker: location.speaker,
      confirmedBy: fact.confirmed_by,
    });
  }
  decision.facts = keptFacts;

  const keptObjections: DecisionPayload['objections'] = [];
  for (const objection of decision.objections) {
    if (!locateEvidence(index, objection.quote)) {
      validation.rejected.push({
        field: `objections.${objection.type}`,
        reason: 'evidence_not_in_transcript',
      });
      continue;
    }
    keptObjections.push(objection);
  }
  decision.objections = keptObjections;

  const keptCompetitors = decision.competitors.filter((competitor) =>
    index.full.includes(normalise(competitor)),
  );
  if (keptCompetitors.length !== decision.competitors.length) {
    validation.competitors_dropped = decision.competitors.filter(
      (competitor) => !keptCompetitors.includes(competitor),
    );
  }
  decision.competitors = keptCompetitors;

  if (decision.outcome === null) {
    decision.outcome_confidence = 0;
  }
  if (decision.next_action === null) {
    decision.next_action_confidence = 0;
  }

  const disposition = input.facts.disposition;
  const talkSeconds = input.facts.talkSeconds ?? 0;
  const notConnected =
    input.facts.isMissed === true ||
    talkSeconds <= 0 ||
    (disposition !== null && disposition !== 'answered');

  if (notConnected) {
    decision.outcome = null;
    decision.outcome_confidence = 0;
    decision.verdict = null;
    decision.verdict_reason = null;
    decision.next_action = null;
    decision.next_action_confidence = 0;
    decision.callback = { requested: false, at: null, spoken_as: null };
    decision.facts = [];
    decision.objections = [];
    decision.competitors = [];
    factRows.length = 0;
    for (const key of Object.keys(
      decision.dimension_signals,
    ) as Array<keyof DecisionPayload['dimension_signals']>) {
      decision.dimension_signals[key] = {
        value: null,
        evidence: null,
        asked: false,
      };
    }
    validation.pbx_override = 'not_connected';
  }

  return {
    decision,
    validation,
    facts: factRows,
    truncated: false,
  };
}
