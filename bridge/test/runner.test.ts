import { describe, expect, it } from 'vitest';
import { MockSummariser } from '../src/summariser/mock.js';
import { SummariserRunner } from '../src/summariser/runner.js';
import type { Summariser } from '../src/summariser/types.js';
import { callInput, testContext } from './helpers.js';

type Ctx = ReturnType<typeof testContext>;

function seedTranscript(ctx: Ctx, tcxCallId = 'sum-call') {
  const call = ctx.calls.upsert(callInput({ tcxCallId })).row;
  ctx.transcripts.upsert({
    callId: call.id,
    engine: 'mock',
    model: 'mock-v1',
    language: 'en',
    text: 'Caller wants a work visa for Germany. Thank you.',
    segments: [{ start: 0, end: 2, text: 'Caller wants a work visa for Germany.' }],
  });
  ctx.jobs.createIfAbsent({ type: 'summarise', refId: call.id });
  return call;
}

function runnerFor(ctx: Ctx, summariser: Summariser): SummariserRunner {
  return new SummariserRunner({
    config: ctx.config,
    db: ctx.db,
    jobs: ctx.jobs,
    calls: ctx.calls,
    transcripts: ctx.transcripts,
    summaries: ctx.summaries,
    outbox: ctx.outbox,
    summariser,
    log: ctx.log,
  });
}

describe('SummariserRunner', () => {
  it('stores a summary and emits call.transcribed with extracted fields', async () => {
    const ctx = testContext();

    try {
      const call = seedTranscript(ctx);
      const runner = runnerFor(ctx, new MockSummariser());

      const stats = await runner.runOnce(new Date());
      expect(stats.completed).toBe(1);

      const summary = ctx.summaries.getByCallId(call.id);
      expect(summary?.summary).toBeTruthy();
      const extracted = JSON.parse(summary?.extracted_json ?? '{}') as {
        destination: string;
      };
      expect(extracted.destination).toBe('Germany');

      const job = ctx.db
        .prepare("SELECT status FROM jobs WHERE type = 'summarise'")
        .get() as { status: string };
      expect(job.status).toBe('done');

      const event = ctx.db
        .prepare("SELECT * FROM outbox WHERE event = 'call.transcribed'")
        .get() as { payload_json: string };
      expect(event).toBeTruthy();

      const payload = JSON.parse(event.payload_json) as {
        summary: string;
        extracted: { destination: string };
        transcript: { text: string };
        call: { id: string };
      };
      expect(payload.call.id).toBe(call.id);
      expect(payload.summary).toBe(summary?.summary);
      expect(payload.extracted.destination).toBe('Germany');
      expect(payload.transcript.text).toContain('work visa');
    } finally {
      ctx.db.close();
    }
  });

  it('retries then dead-letters a persistently failing summariser', async () => {
    const ctx = testContext();

    try {
      seedTranscript(ctx);
      const failing: Summariser = {
        name: 'failing',
        model: 'failing-v1',
        async summarise() {
          throw new Error('LLM offline');
        },
      };
      const runner = runnerFor(ctx, failing);

      const start = new Date(Date.now() + 1_000);
      const first = await runner.runOnce(start);
      expect(first.retried).toBe(1);

      let job = ctx.db
        .prepare("SELECT * FROM jobs WHERE type = 'summarise'")
        .get() as { status: string; attempts: number; error: string };
      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(1);
      expect(job.error).toContain('LLM offline');

      await runner.runOnce(new Date(start.getTime() + 10 * 60_000));
      await runner.runOnce(new Date(start.getTime() + 20 * 60_000));

      job = ctx.db
        .prepare("SELECT * FROM jobs WHERE type = 'summarise'")
        .get() as typeof job;
      expect(job.attempts).toBe(3);
      expect(job.status).toBe('failed');

      const events = ctx.db
        .prepare("SELECT COUNT(*) AS count FROM outbox WHERE event = 'call.transcribed'")
        .get() as { count: number };
      expect(events.count).toBe(0);
    } finally {
      ctx.db.close();
    }
  });

  it('requeues a job left running by a killed worker', () => {
    const ctx = testContext();

    try {
      ctx.jobs.createIfAbsent({ type: 'transcribe', refId: 'rec-1' });
      const claimAt = new Date(Date.now() + 1_000);
      const claimed = ctx.jobs.claimNext('transcribe', claimAt);
      expect(claimed?.status).toBe('running');

      const requeued = ctx.jobs.requeueStale(
        'transcribe',
        new Date(claimAt.getTime() + 60_000),
        new Date(claimAt.getTime() + 300_000),
      );
      expect(requeued).toBe(1);

      const row = ctx.db
        .prepare("SELECT * FROM jobs WHERE type = 'transcribe'")
        .get() as { status: string; attempts: number };
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);

      const reclaimed = ctx.jobs.claimNext(
        'transcribe',
        new Date(claimAt.getTime() + 360_000),
      );
      expect(reclaimed?.attempts).toBe(2);
    } finally {
      ctx.db.close();
    }
  });
});
