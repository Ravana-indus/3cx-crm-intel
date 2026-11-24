import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MockSummariser } from '../src/summariser/mock.js';
import { SummariserRunner } from '../src/summariser/runner.js';
import { callInput, testContext } from './helpers.js';

const WORKER = { authorization: 'Bearer test-worker' };

describe('internal worker protocol', () => {
  it('moves a job through transcript -> summary -> call.transcribed', async () => {
    const ctx = testContext();

    const call = ctx.calls.upsert(callInput({ tcxCallId: 'int-call' })).row;
    const recording = ctx.recordings.insertIfAbsent({
      tcxRecId: 'rec-int',
      callId: call.id,
      filePath: '/tmp/none.wav',
      sha256: 'x',
      bytes: 1,
      durationSec: 1,
      channels: 1,
    }).row;
    ctx.jobs.createIfAbsent({ type: 'transcribe', refId: recording.id });
    ctx.db
      .prepare(
        'INSERT INTO kb_docs (id, title, body_md, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        'kb1',
        'Germany Opportunity Card',
        'Eligibility and fees',
        new Date().toISOString(),
      );

    const app = await buildApp(ctx);
    try {
      const claim = await app.inject({
        method: 'POST',
        url: '/internal/jobs/claim',
        headers: WORKER,
        payload: { type: 'transcribe' },
        remoteAddress: '127.0.0.1',
      });
      expect(claim.statusCode).toBe(200);

      const claimBody = claim.json() as {
        job: { id: string; audio_url: string; hints: string | null };
      };
      expect(claimBody.job).toBeTruthy();
      expect(claimBody.job.audio_url).toBe(`/internal/audio/${claimBody.job.id}`);
      expect(claimBody.job.hints).toContain('Germany Opportunity Card');

      const result = await app.inject({
        method: 'POST',
        url: `/internal/jobs/${claimBody.job.id}/result`,
        headers: WORKER,
        remoteAddress: '127.0.0.1',
        payload: {
          status: 'ok',
          engine: 'mock',
          model: 'mock-v1',
          language: 'ta',
          text: 'I need a work visa for Germany',
          segments: [{ start: 0, end: 2, text: 'I need a work visa for Germany' }],
        },
      });
      expect(result.statusCode).toBe(200);

      const transcript = ctx.transcripts.getByCallId(call.id);
      expect(transcript?.text).toContain('work visa');
      expect(ctx.transcripts.parseSegments(transcript as never)).toHaveLength(1);

      const beforeSummary = ctx.db
        .prepare("SELECT COUNT(*) AS count FROM outbox WHERE event = 'call.transcribed'")
        .get() as { count: number };
      expect(beforeSummary.count).toBe(0);

      const runner = new SummariserRunner({
        config: ctx.config,
        db: ctx.db,
        jobs: ctx.jobs,
        calls: ctx.calls,
        transcripts: ctx.transcripts,
        summaries: ctx.summaries,
        outbox: ctx.outbox,
        summariser: new MockSummariser(),
        log: ctx.log,
      });
      const stats = await runner.runOnce(new Date());
      expect(stats.completed).toBe(1);

      expect(ctx.summaries.getByCallId(call.id)?.summary).toBeTruthy();
      const afterSummary = ctx.db
        .prepare("SELECT COUNT(*) AS count FROM outbox WHERE event = 'call.transcribed'")
        .get() as { count: number };
      expect(afterSummary.count).toBe(1);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });

  it('marks a skipped transcription done without touching the transcript', async () => {
    const ctx = testContext();
    const call = ctx.calls.upsert(callInput({ tcxCallId: 'skip-call' })).row;
    const recording = ctx.recordings.insertIfAbsent({
      tcxRecId: 'rec-skip',
      callId: call.id,
      filePath: '/tmp/none.wav',
      sha256: 'x',
      bytes: 1,
      durationSec: 1,
      channels: 1,
    }).row;
    ctx.jobs.createIfAbsent({ type: 'transcribe', refId: recording.id });

    const app = await buildApp(ctx);
    try {
      const claim = await app.inject({
        method: 'POST',
        url: '/internal/jobs/claim',
        headers: WORKER,
        payload: { type: 'transcribe' },
        remoteAddress: '127.0.0.1',
      });
      const jobId = (claim.json() as { job: { id: string } }).job.id;

      const result = await app.inject({
        method: 'POST',
        url: `/internal/jobs/${jobId}/result`,
        headers: WORKER,
        remoteAddress: '127.0.0.1',
        payload: {
          status: 'skipped',
          engine: 'fluidvoice',
          model: 'Whisper Large Turbo',
          language: 'si',
          reason: 'language_not_allowed',
        },
      });
      expect(result.statusCode).toBe(200);
      expect(ctx.transcripts.getByCallId(call.id)).toBeUndefined();
      expect(ctx.jobs.getById(jobId)?.status).toBe('done');

      const summariseJobs = ctx.db
        .prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'summarise'")
        .get() as { count: number };
      expect(summariseJobs.count).toBe(0);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });

  it('rejects internal endpoints from a non-loopback address', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/jobs/claim',
        headers: WORKER,
        payload: {},
        remoteAddress: '203.0.113.9',
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
