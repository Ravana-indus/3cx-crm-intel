import { DECISION_MODEL_VERSION } from './schema.js';
import type {
  DecisionInput,
  DecisionModel,
  DecisionModelResponse,
} from './types.js';

/**
 * Deterministic fixture model. It is intentionally conservative: evidence is
 * copied from the transcript and no facts are invented. It exists so the
 * staging/review pipeline can be tested without Laya running.
 */
export class MockDecisionModel implements DecisionModel {
  readonly name = 'mock';
  readonly model = 'laya-mock-v1';

  async decide(input: DecisionInput): Promise<DecisionModelResponse> {
    const evidence = input.segments.find((segment) => segment.text.trim())?.text;
    const notConnected =
      input.facts.isMissed === true ||
      (input.facts.talkSeconds ?? 0) <= 0 ||
      (input.facts.disposition !== null &&
        input.facts.disposition !== 'answered');

    if (notConnected || !evidence) {
      return {
        raw: {
          call_id: input.call.id,
          model_version: DECISION_MODEL_VERSION,
          outcome: null,
          outcome_confidence: 0,
          verdict: null,
          verdict_reason: null,
          dimension_signals: {
            financial_readiness: { value: null, evidence: null, asked: false },
            language_readiness: { value: null, evidence: null, asked: false },
            timeline_urgency: { value: null, evidence: null, asked: false },
            intent_seriousness: { value: null, evidence: null, asked: false },
          },
          facts: [],
          objections: [],
          competitors: [],
          next_action: null,
          next_action_confidence: 0,
          callback: { requested: false, at: null, spoken_as: null },
        },
        truncated: false,
      };
    }

    return {
      raw: {
        call_id: input.call.id,
        model_version: DECISION_MODEL_VERSION,
        outcome: 'connected',
        outcome_confidence: 0.8,
        verdict: 'warm',
        verdict_reason: 'Mock Laya decision for local pipeline verification.',
        dimension_signals: {
          financial_readiness: { value: 3, evidence, asked: true },
          language_readiness: { value: 3, evidence, asked: true },
          timeline_urgency: { value: 3, evidence, asked: true },
          intent_seriousness: { value: 3, evidence, asked: true },
        },
        facts: [],
        objections: [],
        competitors: [],
        next_action: 'send_information',
        next_action_confidence: 0.7,
        callback: { requested: false, at: null, spoken_as: null },
      },
      truncated: false,
    };
  }
}
