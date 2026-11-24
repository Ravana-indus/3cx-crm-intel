import { stripCodeFences } from '../summariser/prompt.js';
import type { DecisionInput } from './types.js';

export { stripCodeFences };

const MAX_VERDICT_REASON = 140;

export function decisionSystemPrompt(): string {
  return [
    'You are the Laya decision model for a Sri Lankan migration consultancy.',
    'Return exactly one JSON object, no prose and no code fences.',
    'Use only the supplied call facts and transcript segments.',
    'Evidence must be a contiguous verbatim span from the transcript. If you cannot quote it, do not output the field.',
    'Tri-state scoring is mandatory: if a question was not asked, asked=false, value=null, evidence=null. Never score an unasked question 0.',
    'The PBX facts decide whether the call connected. Never mark a failed, busy, no-answer, voicemail or missed call as connected.',
    'Do not invent fees, eligibility, documents, names, dates or competitors.',
    `verdict_reason is one sentence of at most ${MAX_VERDICT_REASON} characters; it is not a quote and must not contain a new fact.`,
    'All enums are closed. Use null where the evidence does not support a value.',
  ].join('\n');
}

export function decisionUserPrompt(
  input: DecisionInput,
  feedback?: string,
): { text: string; truncated: boolean } {
  const facts = JSON.stringify(input.facts, null, 2);

  const lines: string[] = [];
  let length = 0;
  let truncated = false;

  for (const segment of input.segments) {
    const meta = [
      `${segment.startMs}-${segment.endMs}ms`,
      segment.speaker ?? 'unknown speaker',
      segment.language ?? 'unknown language',
      segment.confidence === null
        ? null
        : `confidence ${segment.confidence.toFixed(2)}`,
    ]
      .filter(Boolean)
      .join(' | ');
    const line = `[${meta}] ${segment.text}`;

    if (length + line.length + 1 > input.maxTranscriptChars) {
      truncated = true;
      break;
    }

    lines.push(line);
    length += line.length + 1;
  }

  const transcript = lines.join('\n');
  const schema = {
    call_id: 'string',
    model_version: 'call-decision-v1',
    outcome:
      'connected | callback_requested | not_interested | wrong_number | null',
    outcome_confidence: '0..1',
    verdict: 'hot | warm | cold | not_interested | null',
    verdict_reason: `string <= ${MAX_VERDICT_REASON} chars | null`,
    dimension_signals: {
      financial_readiness: {
        value: '0..4 | null',
        evidence: 'verbatim transcript span | null',
        asked: 'boolean',
      },
      language_readiness: {
        value: '0..4 | null',
        evidence: 'verbatim transcript span | null',
        asked: 'boolean',
      },
      timeline_urgency: {
        value: '0..4 | null',
        evidence: 'verbatim transcript span | null',
        asked: 'boolean',
      },
      intent_seriousness: {
        value: '0..4 | null',
        evidence: 'verbatim transcript span | null',
        asked: 'boolean',
      },
    },
    facts: [
      {
        field: 'funding_source | language_test | language_score | language_level | language_test_date | has_passport | visa_refusal_details | intake',
        value: 'typed value; never null',
        confidence: '0..1',
        evidence: 'verbatim transcript span',
        confirmed_by: 'customer | agent | document',
      },
    ],
    objections: [
      {
        type: 'cost | timing | family | documents | trust | route',
        quote: 'verbatim transcript span',
        resolved: 'boolean',
      },
    ],
    competitors: ['company name quoted in the transcript'],
    next_action:
      'call_now | book_consultation | request_documents | send_information | nurture_long_term | null',
    next_action_confidence: '0..1',
    callback: {
      requested: 'boolean',
      at: 'ISO timestamp | null',
      spoken_as: 'verbatim phrase | null',
    },
  };

  const factRules = [
    'funding_source: self_funded | family_sponsored | loan | employer_sponsored | other',
    'language_test: ielts | pte | toefl | duolingo | none | other',
    'language_score: string or number',
    'language_level: a1 | a2 | b1 | b2 | c1 | c2 | native',
    'language_test_date: YYYY-MM-DD',
    'has_passport: boolean',
    'visa_refusal_details: string',
    'intake: string or object',
  ];

  const feedbackBlock = feedback
    ? `\nPrevious attempt was rejected by the validator. Fix only what is listed:\n${feedback}\n`
    : '';

  return {
    text: [
      'Layer A facts (authoritative; do not recompute):',
      facts,
      '',
      'Transcript segments (speaker | language | ms):',
      transcript || '[no transcript segments]',
      truncated ? '\n[transcript truncated]' : '',
      '',
      'Return this JSON shape:',
      JSON.stringify(schema),
      '',
      'Fact value rules:',
      ...factRules.map((rule) => `- ${rule}`),
      '',
      'Rules:',
      '- Every dimension and fact evidence must exist verbatim in the transcript.',
      '- If the customer was not asked, asked=false and value=null. Do not treat unknown as 0.',
      '- If PBX disposition is not answered, or talk_seconds is 0, return outcome=null and verdict=null.',
      '- Do not attribute the agent\'s statements to the customer.',
      '- Do not use a quote from one speaker as evidence for a fact confirmed by the other unless the text says so.',
      '- Return the JSON object now.',
      feedbackBlock,
    ]
      .filter((part) => part !== '')
      .join('\n'),
    truncated,
  };
}
