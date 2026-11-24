import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { DecisionsRepo } from '../repo/decisions.js';
import type { CallsRepo } from '../repo/calls.js';
import type { JobRow, JobsRepo } from '../repo/jobs.js';
import type { OutboxRepo } from '../repo/outbox.js';
import type { TranscriptsRepo } from '../repo/transcripts.js';
import type { Logger } from '../util/logger.js';
import { LayaProviderError } from './laya.js';
import {
  DECISION_MODEL_VERSION,
  type DecisionPayload,
} from './schema.js';
import type {
  DecisionInput,
  DecisionModel,
  LayerAFacts,
} from './types.js';
import {
  DecisionValidationError,
  buildTranscriptSegments,
  validateDecision,
} from './validate.js';

export interface DecisionRunnerDeps {
  config: Config;
  jobs: JobsRepo;
  calls: CallsRepo;
  transcripts: TranscriptsRepo;
  decisions: DecisionsRepo;
  outbox: OutboxRepo;
  model: DecisionModel;
  log: Logger;
}

export interface DecisionRunStats {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  invalid: number;
}

function emptyStats(): DecisionRunStats {
  return { claimed: 0, completed: 0, retried: 0, failed: 0, invalid: 0 };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidDecision(callId: string): DecisionPayload {
  return {
    call_id: callId,
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
  };
}

export class DecisionRunner {
  constructor(private readonly deps: DecisionRunnerDeps) {}

  async runOnce(now = new Date()): Promise<DecisionRunStats> {
    const stats = emptyStats();
    let job: JobRow | null;

    while ((job = this.deps.jobs.claimNext('decision', now)) !== null) {
      stats.claimed += 1;
      await this.process(job, now, stats);
    }

    return stats;
  }

  private buildInput(
    call: NonNullable<ReturnType<CallsRepo['getById']>>,
    transcript: NonNullable<ReturnType<TranscriptsRepo['getByCallId']>>,
  ): DecisionInput {
    const facts: LayerAFacts = {
      callId: call.id,
      tcxCallId: call.tcx_call_id,
      direction: call.direction,
      fromNumber: call.from_e164 ?? call.from_raw ?? null,
      toNumber: call.to_e164 ?? call.to_raw ?? null,
      startedAt: call.started_at,
      answeredAt: call.answered_at,
      endedAt: call.ended_at,
      disposition: call.disposition,
      hangupParty: call.hangup_party,
      queueWaitSeconds: call.queue_wait_sec,
      ringSeconds: call.ring_sec,
      talkSeconds: call.talk_sec,
      agentExtension: call.agent_ext ?? call.ext,
      agentUserId: call.agent_user_id,
      isMissed:
        call.missed_call === null || call.missed_call === undefined
          ? null
          : Boolean(call.missed_call),
      queue: call.queue,
    };

    return {
      call,
      transcript,
      segments: buildTranscriptSegments(transcript),
      facts,
      maxTranscriptChars: this.deps.config.decisionMaxTranscriptChars,
    };
  }

  private async process(
    job: JobRow,
    now: Date,
    stats: DecisionRunStats,
  ): Promise<void> {
    const {
      calls,
      transcripts,
      decisions,
      jobs,
      outbox,
      model,
      log,
    } = this.deps;

    if (!job.ref_id) {
      jobs.markFailed(job.id, 'decision job has no call reference');
      stats.failed += 1;
      return;
    }

    const call = calls.getById(job.ref_id);
    const transcript = transcripts.getByCallId(job.ref_id);

    if (!call || !transcript || !transcript.text?.trim()) {
      this.scheduleRetry(job, 'transcript or call not ready', now, stats);
      return;
    }

    const input = this.buildInput(call, transcript);
    const transcriptHash = hash(
      JSON.stringify({
        text: transcript.text,
        language: transcript.language,
        segments: transcript.segments_json,
      }),
    );
    const inputHash = hash(
      JSON.stringify({
        transcriptHash,
        facts: input.facts,
        model: model.model,
      }),
    );

    let feedback: string | undefined;
    let lastError = 'Laya decision failed';

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response;
      try {
        response = await model.decide(input, feedback);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof LayaProviderError) {
          this.scheduleRetry(job, message, now, stats);
          return;
        }
        this.scheduleRetry(job, message, now, stats);
        return;
      }

      try {
        const validated = validateDecision(response.raw, input);
        validated.truncated = validated.truncated || response.truncated;
        if (validated.truncated) {
          validated.validation.transcript_truncated = true;
          validated.validation.rejected.push({
            field: 'transcript',
            reason: 'truncated',
          });
        }

        decisions.supersedeForCall(call.id, now);
        const stored = decisions.insert({
          callId: call.id,
          provider: model.name,
          model: model.model,
          modelVersion: DECISION_MODEL_VERSION,
          promptVersion: DECISION_MODEL_VERSION,
          transcriptHash,
          inputHash,
          decision: validated.decision,
          validation: validated.validation,
          facts: validated.facts,
        });

        jobs.markDone(job.id);
        outbox.enqueue(
          'decision.staged',
          {
            event: 'decision.staged',
            decision_id: stored.id,
            call_id: call.id,
            status: stored.status,
            model_version: DECISION_MODEL_VERSION,
            transcript_hash: transcriptHash,
          },
          now,
        );

        stats.completed += 1;
        log.info(
          {
            jobId: job.id,
            callId: call.id,
            decisionId: stored.id,
            model: model.model,
            rejected: validated.validation.rejected.length,
            override: validated.validation.pbx_override ?? null,
          },
          'call decision staged',
        );
        return;
      } catch (error) {
        if (error instanceof DecisionValidationError) {
          lastError = error.message;
          feedback = [
            error.message,
            ...(Array.isArray(error.details)
              ? (error.details as Array<{ path?: unknown; message?: string }>)
                  .map(
                    (issue) =>
                      `${(issue.path as unknown[])?.join('.') ?? ''}: ${
                        issue.message ?? ''
                      }`,
                  )
              : []),
          ].join('\n');
          log.warn(
            { jobId: job.id, attempt: attempt + 1, error: lastError },
            'Laya decision rejected by schema/evidence',
          );
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.scheduleRetry(job, message, now, stats);
        return;
      }
    }

    // Two invalid outputs: stage an explicit invalid row for review rather than
    // discarding the call. No fields are exposed as usable.
    const invalid = invalidDecision(call.id);
    decisions.supersedeForCall(call.id, now);
    const stored = decisions.insert({
      callId: call.id,
      status: 'invalid',
      provider: model.name,
      model: model.model,
      modelVersion: DECISION_MODEL_VERSION,
      promptVersion: DECISION_MODEL_VERSION,
      transcriptHash,
      inputHash,
      decision: invalid,
      validation: {
        rejected: [],
        error: lastError.slice(0, 2000),
      },
      facts: [],
    });

    jobs.markDone(job.id);
    outbox.enqueue(
      'decision.staged',
      {
        event: 'decision.staged',
        decision_id: stored.id,
        call_id: call.id,
        status: 'invalid',
        model_version: DECISION_MODEL_VERSION,
        transcript_hash: transcriptHash,
      },
      now,
    );
    stats.invalid += 1;
    log.error(
      { jobId: job.id, callId: call.id, decisionId: stored.id, error: lastError },
      'call decision staged as invalid after two failed attempts',
    );
  }

  private scheduleRetry(
    job: JobRow,
    message: string,
    now: Date,
    stats: DecisionRunStats,
  ): void {
    if (job.attempts >= 3) {
      this.deps.jobs.markFailed(job.id, message);
      stats.failed += 1;
      this.deps.log.error(
        { jobId: job.id, attempts: job.attempts, error: message },
        'decision job failed permanently',
      );
      return;
    }

    const nextRunAt = new Date(now.getTime() + 60_000 * job.attempts);
    this.deps.jobs.retry(job.id, message, nextRunAt);
    stats.retried += 1;
  }
}
