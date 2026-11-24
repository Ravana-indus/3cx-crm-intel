import { describe, expect, it } from 'vitest';
import { DecisionRunner } from '../src/decisions/runner.js';
import { MockDecisionModel } from '../src/decisions/mock.js';
import { LayaDecisionModel } from '../src/decisions/laya.js';
import { decisionSchema } from '../src/decisions/schema.js';
import {
  DecisionValidationError,
  buildTranscriptSegments,
  validateDecision,
} from '../src/decisions/validate.js';
import type {
  DecisionInput,
  LayerAFacts,
} from '../src/decisions/types.js';
import { testConfig, testContext, callInput } from './helpers.js';

function callWithTranscript(ctx: ReturnType<typeof testContext>) {
  const call = ctx.calls.upsert(
    callInput({
      tcxCallId: 'dec-call-1',
      disposition: 'answered',
      isMissed: false,
      talkSec: 120,
      ringSec: 4,
      endedAt: '2026-11-20T04:35:12.000Z',
    }),
  );

  ctx.transcripts.upsert({
    callId: call.row.id,
    engine: 'mock',
    model: 'mock',
    language: 'en',
    text: 'Yes, I have a passport and I can pay the deposit.',
    segments: [
      {
        start: 1,
        end: 6,
        speaker: 'Speaker 2',
        language: 'en',
        confidence: 0.93,
        text: 'Yes, I have a passport and I can pay the deposit.',
      },
    ],
  });

  return call.row;
}

function baseRaw(overrides: Record<string, unknown> = {}) {
  return {
    call_id: 'call-x',
    model_version: 'call-decision-v1',
    outcome: 'connected',
    outcome_confidence: 0.8,
    verdict: 'warm',
    verdict_reason: 'Ready to apply.',
    dimension_signals: {
      financial_readiness: { value: 3, evidence: 'I can pay', asked: true },
      language_readiness: { value: null, evidence: null, asked: false },
      timeline_urgency: { value: null, evidence: null, asked: false },
      intent_seriousness: { value: null, evidence: null, asked: false },
    },
    facts: [],
    objections: [],
    competitors: [],
    next_action: 'send_information',
    next_action_confidence: 0.7,
    callback: { requested: false, at: null, spoken_as: null },
    ...overrides,
  };
}

function inputFor(
  ctx: ReturnType<typeof testContext>,
  callId: string,
  disposition: string | null,
  isMissed: boolean | null,
  talkSeconds: number | null,
  transcriptText = 'Yes, I can pay.',
): DecisionInput {
  const call = ctx.calls.getById(callId)!;
  const transcript = ctx.transcripts.getByCallId(callId)!;
  const facts: LayerAFacts = {
    callId: call.id,
    tcxCallId: call.tcx_call_id,
    direction: call.direction,
    fromNumber: call.from_e164 ?? call.from_raw,
    toNumber: call.to_e164 ?? call.to_raw,
    startedAt: call.started_at,
    answeredAt: call.answered_at,
    endedAt: call.ended_at,
    disposition,
    hangupParty: call.hangup_party,
    queueWaitSeconds: call.queue_wait_sec,
    ringSeconds: call.ring_sec,
    talkSeconds,
    agentExtension: call.agent_ext,
    agentUserId: call.agent_user_id,
    isMissed,
    queue: call.queue,
  };
  return {
    call,
    transcript: { ...transcript, text: transcriptText },
    segments: buildTranscriptSegments({ ...transcript, text: transcriptText }),
    facts,
    maxTranscriptChars: 48_000,
  };
}

describe('Layer B decision contract', () => {
  it('rejects asked=false with a score', () => {
    const raw = baseRaw({
      dimension_signals: {
        financial_readiness: { value: null, evidence: null, asked: false },
        language_readiness: { value: 2, evidence: 'x', asked: false },
        timeline_urgency: { value: null, evidence: null, asked: false },
        intent_seriousness: { value: null, evidence: null, asked: false },
      },
    });
    expect(decisionSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects evidence that is not in the transcript', () => {
    const ctx = testContext();
    const call = callWithTranscript(ctx);
    const input = inputFor(ctx, call.id, 'answered', false, 120);
    const raw = baseRaw({
      facts: [
        {
          field: 'has_passport',
          value: true,
          confidence: 0.9,
          evidence: 'I have a passport',
          confirmed_by: 'customer',
        },
        {
          field: 'funding_source',
          value: 'self_funded',
          confidence: 0.8,
          evidence: 'my uncle will sponsor me',
          confirmed_by: 'customer',
        },
      ],
    });

    const validated = validateDecision(raw, input);
    expect(validated.facts).toHaveLength(1);
    expect(validated.facts[0].field).toBe('has_passport');
    expect(validated.validation.rejected).toEqual(
      expect.arrayContaining([
        {
          field: 'facts.funding_source',
          reason: 'evidence_not_in_transcript',
        },
      ]),
    );
  });

  it('keeps dimensions asked=true only when a quote exists', () => {
    const ctx = testContext();
    const call = callWithTranscript(ctx);
    const input = inputFor(ctx, call.id, 'answered', false, 120);
    const raw = baseRaw({
      dimension_signals: {
        financial_readiness: {
          value: 3,
          evidence: 'I can pay',
          asked: true,
        },
        language_readiness: {
          value: 2,
          evidence: 'not in this transcript',
          asked: true,
        },
        timeline_urgency: { value: null, evidence: null, asked: false },
        intent_seriousness: { value: null, evidence: null, asked: false },
      },
    });

    const validated = validateDecision(raw, input);
    expect(validated.decision.dimension_signals.financial_readiness.value).toBe(3);
    expect(validated.decision.dimension_signals.language_readiness.value).toBeNull();
    expect(validated.decision.dimension_signals.language_readiness.asked).toBe(true);
    expect(validated.validation.rejected).toEqual(
      expect.arrayContaining([
        {
          field: 'dimension_signals.language_readiness',
          reason: 'evidence_not_in_transcript',
        },
      ]),
    );
  });

  it('forces nulls when the PBX says the call did not connect', () => {
    const ctx = testContext();
    const call = callWithTranscript(ctx);
    const input = inputFor(ctx, call.id, 'no_answer', true, 0);
    const validated = validateDecision(baseRaw(), input);

    expect(validated.decision.outcome).toBeNull();
    expect(validated.decision.verdict).toBeNull();
    expect(validated.decision.verdict_reason).toBeNull();
    expect(validated.decision.next_action).toBeNull();
    expect(validated.decision.facts).toEqual([]);
    expect(validated.validation.pbx_override).toBe('not_connected');
    expect(validated.decision.dimension_signals.financial_readiness.asked).toBe(false);
    expect(validated.decision.dimension_signals.financial_readiness.value).toBeNull();
  });

  it('stages a valid mock decision and does not write a lead', async () => {
    const ctx = testContext({ decisionEnabled: true });
    const call = callWithTranscript(ctx);
    ctx.jobs.createIfAbsent({
      type: 'decision',
      refId: call.id,
      nextRunAt: new Date('2026-11-20T05:00:00Z'),
    });

    const runner = new DecisionRunner({
      config: ctx.config,
      jobs: ctx.jobs,
      calls: ctx.calls,
      transcripts: ctx.transcripts,
      decisions: ctx.decisions,
      outbox: ctx.outbox,
      model: new MockDecisionModel(),
      log: ctx.log,
    });
    const stats = await runner.runOnce(new Date('2026-11-20T05:00:00Z'));

    expect(stats.completed).toBe(1);
    const decision = ctx.decisions.getLatestByCallId(call.id);
    expect(decision?.status).toBe('staged');
    expect(decision?.outcome).toBe('connected');
    expect(decision?.verdict).toBe('warm');
    expect(decision?.decision_json).toContain('financial_readiness');
    expect(ctx.calls.getById(call.id)?.lead_id).toBeNull();
    expect(ctx.outbox.pendingCount()).toBe(1);
  });

  it('stages invalid output after two schema failures', async () => {
    const ctx = testContext({ decisionEnabled: true });
    const call = callWithTranscript(ctx);
    ctx.jobs.createIfAbsent({
      type: 'decision',
      refId: call.id,
      nextRunAt: new Date('2026-11-20T05:00:00Z'),
    });

    const invalidModel = {
      name: 'bad',
      model: 'bad-v1',
      async decide() {
        return { raw: { nope: true }, truncated: false };
      },
    };

    const runner = new DecisionRunner({
      config: ctx.config,
      jobs: ctx.jobs,
      calls: ctx.calls,
      transcripts: ctx.transcripts,
      decisions: ctx.decisions,
      outbox: ctx.outbox,
      model: invalidModel,
      log: ctx.log,
    });
    await runner.runOnce(new Date('2026-11-20T05:00:00Z'));

    const decision = ctx.decisions.getLatestByCallId(call.id);
    expect(decision?.status).toBe('invalid');
    expect(decision?.validation_json).toContain('schema');
    expect(decision?.outcome).toBeNull();
  });

  it('reviews a staged decision without touching the lead', () => {
    const ctx = testContext();
    const call = callWithTranscript(ctx);
    const decision = ctx.decisions.insert({
      callId: call.id,
      provider: 'mock',
      model: 'mock',
      modelVersion: 'call-decision-v1',
      promptVersion: 'call-decision-v1',
      transcriptHash: 'hash',
      inputHash: 'input',
      decision: baseRaw() as never,
      validation: { rejected: [] },
      facts: [],
    });

    const reviewed = ctx.decisions.review(
      decision.id,
      'approved',
      'Patu',
      'looks right',
      new Date('2026-11-20T05:00:00Z'),
    );
    expect(reviewed?.status).toBe('approved');
    expect(reviewed?.reviewed_by).toBe('Patu');
    expect(ctx.calls.getById(call.id)?.lead_id).toBeNull();
  });

  it('throws a typed validation error for non-object output', () => {
    const ctx = testContext();
    const call = callWithTranscript(ctx);
    const input = inputFor(ctx, call.id, 'answered', false, 120);
    expect(() => validateDecision('nope', input)).toThrow(DecisionValidationError);
  });
});

describe('Laya native adapter', () => {
  it('calls /predict for typed decisions and selects verbatim evidence', async () => {
    const config = testConfig({
      decisionModel: 'laya',
      layaBaseUrl: 'http://laya.test',
      layaModel: 'typed-decisions',
    });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        state: string;
        questions: Record<
          string,
          { type: string; criteria?: Record<string, unknown> | unknown[] }
        >;
      };
      calls.push({ url: String(input), body });

      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(body.questions)) {
        if (id.startsWith('evidence_')) {
          const criteria = question.criteria as
            | Record<string, unknown>
            | undefined;
          answers[id] = {
            type: 'choice',
            choice: criteria?.s0 ? 's0' : 'none',
            confidence: 0.9,
            answer_confidence: 0.9,
          };
          continue;
        }

        if (question.type === 'noul') {
          const probability =
            id === 'asked_passport' || id === 'has_passport'
              ? 0.9
              : id === 'callback_requested' || id.startsWith('objection_')
                ? 0.1
                : id.startsWith('asked_')
                  ? 0.9
                  : 0.1;
          answers[id] = {
            type: 'noul',
            noul: probability,
            confidence: probability,
            answer_confidence: probability,
          };
        } else if (question.type === 'score') {
          answers[id] = {
            type: 'score',
            score: 3.1,
            probabilities: { '3': 0.7, '4': 0.3 },
            confidence: 0.7,
            answer_confidence: 0.7,
          };
        } else {
          const value =
            id === 'outcome'
              ? 'connected'
              : id === 'verdict'
                ? 'warm'
                : id === 'next_action'
                  ? 'send_information'
                  : id === 'funding_source'
                    ? 'self_funded'
                    : id === 'language_test'
                      ? 'ielts'
                      : id === 'language_level'
                        ? 'b1'
                        : 'not_discussed';
          answers[id] = {
            type: 'choice',
            choice: value,
            confidence: 0.8,
            answer_confidence: 0.8,
          };
        }
      }

      return new Response(
        JSON.stringify({
          model: 'laya-rl-agent',
          answers,
          routing: { model: 'typed-decisions' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const ctx = testContext();
    const call = callWithTranscript(ctx);
    const input = inputFor(ctx, call.id, 'answered', false, 120);
    const model = new LayaDecisionModel(config, ctx.log, fetchImpl);
    const result = await model.decide(input);

    expect(model.name).toBe('laya');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('http://laya.test/predict');
    expect(calls[0].body.model).toBe('typed-decisions');
    expect(calls[0].body.state).toContain('[s0]');
    expect(calls[1].body.questions).toEqual(
      expect.objectContaining({
        evidence_financial_readiness: expect.any(Object),
      }),
    );

    const raw = result.raw as {
      outcome: string;
      verdict: string;
      dimension_signals: Record<string, { value: number; evidence: string }>;
      facts: Array<{ field: string; evidence: string }>;
      callback: { requested: boolean };
    };
    expect(raw.outcome).toBe('connected');
    expect(raw.verdict).toBe('warm');
    expect(raw.dimension_signals.financial_readiness).toMatchObject({
      value: 3,
      evidence: 'Yes, I have a passport and I can pay the deposit.',
    });
    expect(
      raw.facts.find((fact) => fact.field === 'has_passport')?.evidence,
    ).toContain('passport');
    expect(raw.callback.requested).toBe(false);
    expect(result.truncated).toBe(false);
  });
});
