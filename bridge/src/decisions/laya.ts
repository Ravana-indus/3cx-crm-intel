import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { DECISION_MODEL_VERSION } from './schema.js';
import type {
  DecisionInput,
  DecisionModel,
  DecisionModelResponse,
  TranscriptSegment,
} from './types.js';

export type DecisionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type Question =
  | { type: 'noul'; instructions: string; criteria?: Record<string, string> }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

interface LayaAnswer {
  type?: string;
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  answer_confidence?: number;
  probabilities?: Record<string, number>;
}

interface LayaResponse {
  answers?: Record<string, LayaAnswer>;
  routing?: { model?: string };
  detail?: string;
  error?: string;
}

export class LayaProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayaProviderError';
  }
}

const DIMENSIONS = [
  'financial_readiness',
  'language_readiness',
  'timeline_urgency',
  'intent_seriousness',
] as const;

type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_RUBRICS: Record<Dimension, string[]> = {
  financial_readiness: [
    'No funding information, or the customer cannot afford the move.',
    'Funds are clearly short and no credible sponsor is named.',
    'Some funding or a family sponsor exists, but the amount is uncertain.',
    'Stated funds or a credible sponsor cover most of the likely cost.',
    'Proof of funds, a strong sponsor, or funds comfortably cover the move.',
  ],
  language_readiness: [
    'No language ability and no test taken or booked.',
    'Beginner level, such as A1 or A2, or a test merely planned.',
    'Intermediate level or a test taken below the usual target.',
    'Good level, such as B2, or a test at or near the target.',
    'Strong evidence: C1/C2, a test above the target, or study in the language.',
  ],
  timeline_urgency: [
    'No timeline stated and nothing signals when they intend to move.',
    'Indefinite, or blocked with no date attached.',
    'Targeting an intake more than a year away.',
    'Targeting an intake within six to twelve months.',
    'Targeting the next intake or already inside a deadline window.',
  ],
  intent_seriousness: [
    'Explicitly not interested, or asked not to be contacted.',
    'Vague curiosity only, with no destination, programme or timeline of their own.',
    'General interest with some specifics, but still hedged or waiting on someone else.',
    'Clear intent with concrete specifics and some preparation started.',
    'Committed and acting: tests, documents, funds, or pressing for the next step.',
  ],
};

const DIMENSION_INSTRUCTIONS: Record<Dimension, string> = {
  financial_readiness:
    'How ready is the customer to fund the move, judged only from what was said on this call?',
  language_readiness:
    'How ready is the customer on the language requirement, judged only from what was said on this call?',
  timeline_urgency:
    'How soon does the customer intend to move, judged only from what was said on this call?',
  intent_seriousness:
    'How serious is the customer about actually migrating, judged from their own words on this call?',
};

const DIMENSION_ASKED: Record<Dimension, string> = {
  financial_readiness: 'Did the agent ask the customer about funding, costs or who will pay?',
  language_readiness:
    'Did the agent ask the customer about English or German language ability or tests?',
  timeline_urgency:
    'Did the agent ask the customer when they want to move or which intake they want?',
  intent_seriousness:
    'Did the agent ask the customer about their plans, intent or reasons for moving?',
};

const DIMENSION_KEYWORDS: Record<Dimension, string[]> = {
  financial_readiness: [
    'fund',
    'money',
    'pay',
    'payment',
    'deposit',
    'bank',
    'loan',
    'sponsor',
    'afford',
    'salary',
    'lakh',
    'million',
    'rupee',
  ],
  language_readiness: [
    'english',
    'ielts',
    'pte',
    'toefl',
    'duolingo',
    'language',
    'language test',
    'english test',
    'speak german',
    'learn german',
    'german language',
    'test score',
    'a1',
    'a2',
    'b1',
    'b2',
    'c1',
    'c2',
  ],
  timeline_urgency: [
    'month',
    'year',
    'intake',
    'soon',
    'next',
    'october',
    'january',
    'summer',
    'winter',
    'deadline',
    '2026',
    '2027',
    'later',
  ],
  intent_seriousness: [
    'want',
    'plan',
    'apply',
    'study',
    'move',
    'interested',
    'decide',
    'ready',
    'intend',
    'commit',
    'prepare',
  ],
};

const FACT_KEYWORDS: Record<string, string[]> = {
  funding_source: [
    'fund',
    'sponsor',
    'loan',
    'bank',
    'self',
    'family',
    'pay',
    'money',
  ],
  language_test: [
    'ielts',
    'pte',
    'toefl',
    'duolingo',
    'language test',
    'english test',
    'test score',
  ],
  language_level: [
    'a1',
    'a2',
    'b1',
    'b2',
    'c1',
    'c2',
    'beginner',
    'intermediate',
    'native',
  ],
  has_passport: ['passport', 'travel document'],
};

const OBJECTION_KEYWORDS: Record<string, string[]> = {
  cost: ['cost', 'expensive', 'money', 'afford', 'pay', 'fee', 'price'],
  timing: ['time', 'later', 'wait', 'month', 'year', 'intake', 'soon'],
  family: ['family', 'parent', 'mother', 'father', 'wife', 'husband', 'spouse'],
  documents: ['document', 'passport', 'transcript', 'certificate', 'paper'],
  trust: ['trust', 'scam', 'guarantee', 'refund', 'believe', 'risk'],
  route: ['route', 'visa', 'course', 'university', 'country', 'eligibility'],
};

function clampScore(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(4, Math.round(value)));
}

function answerConfidence(answer: LayaAnswer | undefined): number {
  if (!answer) return 0;
  if (typeof answer.answer_confidence === 'number') return answer.answer_confidence;
  if (typeof answer.confidence === 'number') return answer.confidence;
  const probabilities = Object.values(answer.probabilities ?? {});
  return probabilities.length ? Math.max(...probabilities) : 0;
}

function topChoice(answer: LayaAnswer | undefined): string | null {
  if (!answer) return null;
  if (typeof answer.choice === 'string') return answer.choice;
  const entries = Object.entries(answer.probabilities ?? {});
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function buildState(input: DecisionInput): {
  state: string;
  truncated: boolean;
} {
  const facts = input.facts;
  const header = [
    'Call facts (authoritative):',
    `direction: ${facts.direction}`,
    `disposition: ${facts.disposition ?? 'unknown'}`,
    `missed: ${facts.isMissed === null ? 'unknown' : facts.isMissed}`,
    `ring_seconds: ${facts.ringSeconds ?? 'unknown'}`,
    `talk_seconds: ${facts.talkSeconds ?? 'unknown'}`,
    `queue: ${facts.queue ?? 'unknown'}`,
    `agent_extension: ${facts.agentExtension ?? 'unknown'}`,
    '',
    'Transcript segments:',
  ].join('\n');

  const max = Math.min(input.maxTranscriptChars, 50_000);
  let state = header;
  let truncated = false;

  for (let index = 0; index < input.segments.length; index += 1) {
    const segment = input.segments[index];
    const metadata = [
      segment.speaker ?? 'unknown speaker',
      segment.language ?? 'unknown language',
      segment.confidence === null
        ? null
        : `confidence ${segment.confidence.toFixed(2)}`,
    ]
      .filter(Boolean)
      .join(' | ');
    const line = `[s${index}] ${metadata}: ${segment.text}`;
    if (state.length + line.length + 1 > max) {
      truncated = true;
      break;
    }
    state += `\n${line}`;
  }

  return { state, truncated };
}

function buildDecisionQuestions(): Record<string, Question> {
  const questions: Record<string, Question> = {
    outcome: {
      type: 'choice',
      instructions:
        'What was the outcome of this call, based only on the conversation? A real two-way conversation is connected. A request to be called later is callback_requested. An explicit refusal is not_interested. The wrong person answering is wrong_number.',
      criteria: {
        connected: 'A real two-way conversation with the customer took place.',
        callback_requested: 'The customer asked to be contacted or called later.',
        not_interested: 'The customer said they are not interested or do not want to proceed.',
        wrong_number: 'The wrong person answered, or the number does not belong to the customer.',
      },
    },
    verdict: {
      type: 'choice',
      instructions:
        'What is the commercial verdict for this call? Judge only from what was said.',
      criteria: {
        hot: 'Ready and motivated; a next step is clearly justified now.',
        warm: 'Interested and plausible, but needs work or a further conversation.',
        cold: 'Little current interest or readiness; long-term nurture only.',
        not_interested: 'Explicitly not interested or the wrong fit.',
      },
    },
    next_action: {
      type: 'choice',
      instructions:
        'What should the consultant do next with this customer, given this call?',
      criteria: {
        call_now: 'Call now because the customer is warm and waiting.',
        book_consultation: 'Book a formal consultation.',
        request_documents: 'Request the missing documents or evidence.',
        send_information: 'Send programme, fee or requirement information.',
        nurture_long_term: 'Keep the customer warm and revisit later.',
      },
    },
    funding_source: {
      type: 'choice',
      instructions: 'Who is expected to fund the move, according to the customer?',
      criteria: {
        self_funded: 'The customer will fund it themselves.',
        family_sponsored: 'A family member or friend is sponsoring them.',
        loan: 'A bank or other loan is funding it.',
        employer_sponsored: 'An employer is sponsoring them.',
        other: 'Another funding source is described.',
        not_discussed: 'Funding was not discussed.',
      },
    },
    language_test: {
      type: 'choice',
      instructions: 'Which language test has the customer taken or booked?',
      criteria: {
        ielts: 'IELTS.',
        pte: 'PTE.',
        toefl: 'TOEFL.',
        duolingo: 'Duolingo English Test.',
        none: 'No language test has been taken or booked.',
        other: 'Another language test.',
        not_discussed: 'Language testing was not discussed.',
      },
    },
    language_level: {
      type: 'choice',
      instructions: 'What language level, if any, did the customer state?',
      criteria: {
        a1: 'A1.',
        a2: 'A2.',
        b1: 'B1.',
        b2: 'B2.',
        c1: 'C1.',
        c2: 'C2.',
        native: 'Native or equivalent.',
        not_discussed: 'Language level was not discussed.',
      },
    },
    asked_passport: {
      type: 'noul',
      instructions: 'Did the agent ask whether the customer has a passport?',
    },
    has_passport: {
      type: 'noul',
      instructions: 'Does the customer say they have a passport?',
    },
    callback_requested: {
      type: 'noul',
      instructions: 'Did the customer ask for a callback or a later conversation?',
    },
    competitor_mentioned: {
      type: 'noul',
      instructions: 'Did the customer mention another agency or competitor?',
    },
  };

  for (const dimension of DIMENSIONS) {
    questions[`asked_${dimension}`] = {
      type: 'noul',
      instructions: DIMENSION_ASKED[dimension],
    };
    questions[dimension] = {
      type: 'score',
      instructions: DIMENSION_INSTRUCTIONS[dimension],
      criteria: DIMENSION_RUBRICS[dimension],
    };
  }

  for (const type of Object.keys(OBJECTION_KEYWORDS)) {
    questions[`objection_${type}`] = {
      type: 'noul',
      instructions: `Did the customer raise a ${type} objection: ${OBJECTION_KEYWORDS[type].join(', ')}?`,
      criteria: {
        true: 'The customer raised this concern.',
        false: 'The customer did not raise this concern.',
      },
    };
  }

  return questions;
}

interface EvidenceCandidate {
  label: string;
  segment: TranscriptSegment;
}

function chooseCandidates(
  segments: TranscriptSegment[],
  keywords: string[],
  limit = 24,
): EvidenceCandidate[] {
  const indexed = segments.map((segment, index) => ({
    segment,
    index,
    text: segment.text.toLowerCase(),
  }));

  const scored = indexed.map((entry) => ({
    ...entry,
    score: keywords.reduce(
      (total, keyword) =>
        total + (entry.text.includes(keyword.toLowerCase()) ? 1 : 0),
      0,
    ),
  }));

  const selected =
    scored.length <= limit
      ? scored
      : scored
          .slice()
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, limit)
          .sort((a, b) => a.index - b.index);

  return selected
    .filter((entry) => entry.score > 0 || scored.length <= limit)
    .map((entry) => ({
      label: `s${entry.index}`,
      segment: entry.segment,
    }));
}

function evidenceQuestion(
  instructions: string,
  candidates: EvidenceCandidate[],
): Question {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[candidate.label] = candidate.segment.text.slice(0, 280);
  }
  criteria.none = 'No transcript line supports this.';
  return { type: 'choice', instructions, criteria };
}

function confirmedBy(segment: TranscriptSegment): string {
  const speaker = (segment.speaker ?? '').toLowerCase();
  if (
    speaker.includes('caller') ||
    speaker.includes('customer') ||
    speaker.includes('client') ||
    /speaker\s*2/.test(speaker)
  ) {
    return 'customer';
  }
  if (
    speaker.includes('agent') ||
    speaker.includes('consultant') ||
    /speaker\s*1/.test(speaker)
  ) {
    return 'agent';
  }
  return 'customer';
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

export class LayaDecisionModel implements DecisionModel {
  readonly name = 'laya';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;

  constructor(
    config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: DecisionFetch = fetch,
  ) {
    this.model = config.layaModel;
    this.baseUrl = config.layaBaseUrl
      .replace(/\/$/, '')
      .replace(/\/v1$/, '');
    this.apiKey = config.layaApiKey;
    this.timeoutMs = config.layaTimeoutMs;
  }

  async decide(input: DecisionInput): Promise<DecisionModelResponse> {
    const state = buildState(input);
    const decisionQuestions = buildDecisionQuestions();
    const first = await this.predict(
      state.state,
      decisionQuestions,
      input.transcript.language,
    );
    const answers = first.answers ?? {};

    const choice = (id: string): string | null => topChoice(answers[id]);
    const noul = (id: string): number => {
      const value = answers[id]?.noul;
      return typeof value === 'number' ? value : 0;
    };
    const score = (id: string): number | null => {
      const value = answers[id]?.score;
      return typeof value === 'number' ? value : null;
    };

    const dimensions: Record<
      string,
      { value: number | null; evidence: string | null; asked: boolean }
    > = {};
    const pendingDimensions: Array<{
      dimension: Dimension;
      value: number;
      questionId: string;
      candidates: EvidenceCandidate[];
    }> = [];

    for (const dimension of DIMENSIONS) {
      const asked = noul(`asked_${dimension}`) >= 0.5;
      const value = asked ? clampScore(score(dimension)) : null;
      dimensions[dimension] = {
        value,
        evidence: null,
        asked,
      };

      if (asked && value !== null) {
        const candidates = chooseCandidates(
          input.segments,
          DIMENSION_KEYWORDS[dimension],
        );
        if (candidates.length > 0) {
          pendingDimensions.push({
            dimension,
            value,
            questionId: `evidence_${dimension}`,
            candidates,
          });
        }
      }
    }

    const pendingFacts: Array<{
      field: string;
      value: unknown;
      confidence: number;
      questionId: string;
      candidates: EvidenceCandidate[];
    }> = [];

    const addFact = (
      field: string,
      value: unknown,
      confidence: number,
      keywords: string[],
    ) => {
      const candidates = chooseCandidates(input.segments, keywords);
      if (!candidates.length) return;
      pendingFacts.push({
        field,
        value,
        confidence,
        questionId: `evidence_fact_${field}`,
        candidates,
      });
    };

    const funding = choice('funding_source');
    if (funding && funding !== 'not_discussed') {
      addFact(
        'funding_source',
        funding,
        answerConfidence(answers.funding_source),
        FACT_KEYWORDS.funding_source,
      );
    }

    const languageTest = choice('language_test');
    if (languageTest && languageTest !== 'not_discussed') {
      addFact(
        'language_test',
        languageTest,
        answerConfidence(answers.language_test),
        FACT_KEYWORDS.language_test,
      );
    }

    const languageLevel = choice('language_level');
    if (languageLevel && languageLevel !== 'not_discussed') {
      addFact(
        'language_level',
        languageLevel,
        answerConfidence(answers.language_level),
        FACT_KEYWORDS.language_level,
      );
    }

    if (noul('asked_passport') >= 0.5) {
      addFact(
        'has_passport',
        noul('has_passport') >= 0.5,
        Math.max(noul('has_passport'), 1 - noul('has_passport')),
        FACT_KEYWORDS.has_passport,
      );
    }

    const objections: Array<{
      type: string;
      questionId: string;
      candidates: EvidenceCandidate[];
    }> = [];
    for (const type of Object.keys(OBJECTION_KEYWORDS)) {
      if (noul(`objection_${type}`) >= 0.5) {
        const candidates = chooseCandidates(
          input.segments,
          OBJECTION_KEYWORDS[type],
        );
        if (candidates.length > 0) {
          objections.push({
            type,
            questionId: `evidence_objection_${type}`,
            candidates,
          });
        }
      }
    }

    const callbackRequested = noul('callback_requested') >= 0.5;
    const callbackCandidates = callbackRequested
      ? chooseCandidates(input.segments, [
          'call',
          'tomorrow',
          'today',
          'later',
          'monday',
          'time',
          'back',
        ])
      : [];
    const callbackQuestionId = 'evidence_callback';

    const evidenceQuestions: Record<string, Question> = {};
    const evidenceMap = new Map<
      string,
      { candidates: EvidenceCandidate[] }
    >();

    for (const pending of pendingDimensions) {
      evidenceQuestions[pending.questionId] = evidenceQuestion(
        `Which transcript line is the verbatim evidence that the agent asked about ${pending.dimension.replace(/_/g, ' ')} and the answer was level ${pending.value}?`,
        pending.candidates,
      );
      evidenceMap.set(pending.questionId, {
        candidates: pending.candidates,
      });
    }

    for (const pending of pendingFacts) {
      evidenceQuestions[pending.questionId] = evidenceQuestion(
        `Which transcript line is the verbatim evidence that the ${pending.field.replace(/_/g, ' ')} is ${JSON.stringify(pending.value)}?`,
        pending.candidates,
      );
      evidenceMap.set(pending.questionId, {
        candidates: pending.candidates,
      });
    }

    for (const objection of objections) {
      evidenceQuestions[objection.questionId] = evidenceQuestion(
        `Which transcript line is the customer's verbatim ${objection.type} objection?`,
        objection.candidates,
      );
      evidenceMap.set(objection.questionId, {
        candidates: objection.candidates,
      });
    }

    if (callbackRequested && callbackCandidates.length > 0) {
      evidenceQuestions[callbackQuestionId] = evidenceQuestion(
        'Which transcript line is the customer\'s verbatim request to be called later?',
        callbackCandidates,
      );
      evidenceMap.set(callbackQuestionId, {
        candidates: callbackCandidates,
      });
    }

    let evidenceAnswers: Record<string, LayaAnswer> = {};
    if (Object.keys(evidenceQuestions).length > 0) {
      const second = await this.predict(
        state.state,
        evidenceQuestions,
        input.transcript.language,
      );
      evidenceAnswers = second.answers ?? {};
    }

    const evidenceFor = (
      questionId: string,
      keywords: string[],
    ): TranscriptSegment | null => {
      const label = topChoice(evidenceAnswers[questionId]);
      if (!label || label === 'none') return null;
      const segment =
        evidenceMap
          .get(questionId)
          ?.candidates.find((candidate) => candidate.label === label)?.segment ??
        null;
      if (!segment) return null;
      if (!matchesKeywords(segment.text, keywords)) return null;
      return segment;
    };

    for (const pending of pendingDimensions) {
      const segment = evidenceFor(
        pending.questionId,
        DIMENSION_KEYWORDS[pending.dimension],
      );
      dimensions[pending.dimension] = segment
        ? {
            value: pending.value,
            evidence: segment.text,
            asked: true,
          }
        : {
            value: null,
            evidence: null,
            asked: true,
          };
    }

    // A scored dimension without a selected verbatim span is not evidence-backed.
    // Leave the field rejected rather than emitting a score with no quote.
    for (const dimension of DIMENSIONS) {
      const signal = dimensions[dimension];
      if (signal.asked && signal.value !== null && !signal.evidence) {
        signal.value = null;
        signal.evidence = null;
      }
    }

    const facts: Array<{
      field: string;
      value: unknown;
      confidence: number;
      evidence: string;
      confirmed_by: string;
    }> = [];
    for (const pending of pendingFacts) {
      const segment = evidenceFor(
        pending.questionId,
        FACT_KEYWORDS[pending.field] ?? [],
      );
      if (!segment) continue;
      facts.push({
        field: pending.field,
        value: pending.value,
        confidence: pending.confidence,
        evidence: segment.text,
        confirmed_by: confirmedBy(segment),
      });
    }

    const keptObjections: Array<{
      type: string;
      quote: string;
      resolved: boolean;
    }> = [];
    for (const objection of objections) {
      const segment = evidenceFor(
        objection.questionId,
        OBJECTION_KEYWORDS[objection.type] ?? [],
      );
      if (!segment) continue;
      keptObjections.push({
        type: objection.type,
        quote: segment.text,
        resolved: false,
      });
    }

    const callbackSegment =
      callbackRequested && callbackCandidates.length > 0
        ? evidenceFor(callbackQuestionId, [
            'call',
            'tomorrow',
            'today',
            'later',
            'monday',
            'time',
            'back',
          ])
        : null;

    const firstEvidence =
      pendingDimensions
        .map(
          (pending) =>
            evidenceFor(
              pending.questionId,
              DIMENSION_KEYWORDS[pending.dimension],
            )?.text,
        )
        .find(Boolean) ??
      facts[0]?.evidence ??
      null;

    const verdict = choice('verdict');
    const verdictReason = verdict
      ? firstEvidence
        ? `Laya: ${verdict}. "${firstEvidence.replace(/\s+/g, ' ').slice(0, 90)}"`
        : `Laya verdict: ${verdict}.`
      : null;

    const raw = {
      call_id: input.call.id,
      model_version: DECISION_MODEL_VERSION,
      outcome: choice('outcome'),
      outcome_confidence: answerConfidence(answers.outcome),
      verdict,
      verdict_reason: verdictReason
        ? verdictReason.slice(0, 140)
        : null,
      dimension_signals: dimensions,
      facts,
      objections: keptObjections,
      competitors: [],
      next_action: choice('next_action'),
      next_action_confidence: answerConfidence(answers.next_action),
      callback: {
        requested: Boolean(callbackRequested && callbackSegment),
        at: null,
        spoken_as: callbackSegment?.text ?? null,
      },
    };

    this.log.info(
      {
        callId: input.call.id,
        questions: Object.keys(decisionQuestions).length,
        evidenceQuestions: Object.keys(evidenceQuestions).length,
        truncated: state.truncated,
      },
      'Laya decision complete',
    );

    return { raw, truncated: state.truncated };
  }

  private async predict(
    state: string,
    questions: Record<string, Question>,
    language: string | null,
  ): Promise<LayaResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      state,
      questions,
      model: this.model,
    };
    if (language === 'en' || language === 'ta' || language === 'si') {
      body.lang = language;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/predict`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LayaProviderError(
        `Laya HTTP ${response.status}: ${detail.slice(0, 400)}`,
      );
    }

    const parsed = (await response.json()) as LayaResponse;
    const error = parsed.error ?? parsed.detail;
    if (error) throw new LayaProviderError(`Laya error: ${error}`);
    if (!parsed.answers || typeof parsed.answers !== 'object') {
      throw new LayaProviderError('Laya returned no answers object');
    }
    return parsed;
  }
}
