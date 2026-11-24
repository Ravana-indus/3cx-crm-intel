import type { SummaryInput } from './types.js';

const MAX_TRANSCRIPT_CHARS = 12_000;

export function systemPrompt(): string {
  return [
    'You summarise recorded phone calls for a Sri Lankan migration consultancy.',
    'Return exactly one JSON object, no prose and no code fences, with this shape:',
    '{',
    '  "summary": "3 sentences maximum",',
    '  "extracted": {',
    '    "caller_intent": "short phrase",',
    '    "destination": "country or null",',
    '    "service": "visa/service type or null",',
    '    "documents_mentioned": ["..."],',
    '    "next_action": "short phrase or null",',
    '    "follow_up_at": "YYYY-MM-DD or null",',
    '    "sentiment": "positive" | "neutral" | "negative"',
    '  }',
    '}',
    'Never invent a fee, processing time or eligibility rule that is not in the transcript.',
    'If the caller did not mention something, use null (or an empty array).',
  ].join('\n');
}

export function userPrompt(input: SummaryInput): string {
  const metadata = [
    `direction: ${input.call.direction}`,
    `language: ${input.language ?? 'unknown'}`,
    `extension: ${input.call.ext ?? 'unknown'}`,
    `queue: ${input.call.queue ?? 'none'}`,
  ].join(', ');

  const hints =
    input.hints.length > 0
      ? `\nDomain terms (spell these correctly): ${input.hints.slice(0, 40).join(', ')}`
      : '';

  const transcript =
    input.transcript.length > MAX_TRANSCRIPT_CHARS
      ? `${input.transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[truncated]`
      : input.transcript;

  return `Call metadata: ${metadata}${hints}\n\nTranscript:\n${transcript}\n\nReturn the JSON object now.`;
}

export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}
