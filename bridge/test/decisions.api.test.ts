import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DecisionPayload } from '../src/decisions/schema.js';
import { callInput, testContext } from './helpers.js';

const AUTH = { authorization: 'Bearer test-portal' };

function fixtureDecision(callId: string): DecisionPayload {
  return {
    call_id: callId,
    model_version: 'call-decision-v1',
    outcome: 'connected',
    outcome_confidence: 0.8,
    verdict: 'warm',
    verdict_reason: 'Ready to proceed.',
    dimension_signals: {
      financial_readiness: {
        value: 3,
        evidence: 'I can pay',
        asked: true,
      },
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
  };
}

describe('decision API', () => {
  it('exposes facts, segments and staged decisions, then reviews without a lead write', async () => {
    const ctx = testContext({ decisionEnabled: true });
    const call = ctx.calls.upsert(
      callInput({
        tcxCallId: 'api-dec-1',
        disposition: 'answered',
        isMissed: false,
        talkSec: 120,
        ringSec: 4,
      }),
    );
    ctx.transcripts.upsert({
      callId: call.row.id,
      engine: 'mock',
      model: 'mock',
      language: 'en',
      text: 'I can pay the deposit.',
      segments: [
        {
          start: 1,
          end: 4,
          speaker: 'Speaker 1',
          language: 'en',
          confidence: 0.9,
          text: 'I can pay the deposit.',
        },
      ],
    });
    const decision = ctx.decisions.insert({
      callId: call.row.id,
      provider: 'mock',
      model: 'mock',
      modelVersion: 'call-decision-v1',
      promptVersion: 'call-decision-v1',
      transcriptHash: 'hash',
      inputHash: 'input',
      decision: fixtureDecision(call.row.id),
      validation: { rejected: [] },
      facts: [],
    });

    const app = await buildApp(ctx);
    try {
      const callResponse = await app.inject({
        method: 'GET',
        url: `/v1/calls/${call.row.id}`,
        headers: AUTH,
      });
      expect(callResponse.statusCode).toBe(200);
      const body = callResponse.json() as {
        facts: { disposition: string; is_missed: boolean; call_id: string };
        transcript: {
          segments: Array<{
            start_ms: number;
            speaker: string;
            language: string;
            confidence: number;
          }>;
        };
        decision: { id: string; status: string; outcome: string };
        has_decision: boolean;
      };
      expect(body.facts.call_id).toBe(call.row.id);
      expect(body.facts.disposition).toBe('answered');
      expect(body.facts.is_missed).toBe(false);
      expect(body.transcript.segments[0]).toMatchObject({
        start_ms: 1000,
        speaker: 'Speaker 1',
        language: 'en',
        confidence: 0.9,
      });
      expect(body.decision).toMatchObject({
        id: decision.id,
        status: 'staged',
        outcome: 'connected',
      });
      expect(body.has_decision).toBe(true);

      const list = await app.inject({
        method: 'GET',
        url: '/v1/decisions?status=staged',
        headers: AUTH,
      });
      expect(list.statusCode).toBe(200);
      expect(
        (list.json() as { items: Array<{ id: string }> }).items[0].id,
      ).toBe(decision.id);

      const review = await app.inject({
        method: 'POST',
        url: `/v1/decisions/${decision.id}/review`,
        headers: AUTH,
        payload: { status: 'approved', reviewed_by: 'Patu' },
      });
      expect(review.statusCode).toBe(200);
      expect((review.json() as { status: string }).status).toBe('approved');
      expect(ctx.calls.getById(call.row.id)?.lead_id).toBeNull();

      const exported = await app.inject({
        method: 'GET',
        url: '/v1/export/calls',
        headers: AUTH,
      });
      expect(exported.statusCode).toBe(200);
      const exportedBody = exported.json() as {
        items: Array<{
          call_id: string;
          facts: { disposition: string };
          transcript: { segments: unknown[] };
          decision: { id: string; status: string };
        }>;
      };
      expect(exportedBody.items[0].call_id).toBe(call.row.id);
      expect(exportedBody.items[0].facts.disposition).toBe('answered');
      expect(exportedBody.items[0].decision).toMatchObject({
        id: decision.id,
        status: 'approved',
      });
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
