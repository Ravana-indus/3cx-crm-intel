import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';

interface ClaimBody {
  type?: string;
}

interface ResultBody {
  status: 'ok' | 'error' | 'skipped';
  engine?: string;
  model?: string;
  language?: string | null;
  text?: string;
  segments?: unknown;
  error?: string;
  reason?: string;
}

/**
 * Domain terms from the knowledge base give the transcriber a spelling prompt
 * (country names, visa types, brand names).
 */
function loadTranscriptionHints(db: ApiDeps['db']): string | null {
  const rows = db
    .prepare('SELECT title, tags FROM kb_docs ORDER BY updated_at DESC LIMIT 40')
    .all() as Array<{ title: string | null; tags: string | null }>;

  const terms = new Set<string>();
  for (const row of rows) {
    if (row.title) terms.add(row.title);
    if (row.tags) {
      for (const tag of row.tags.split(',')) {
        const trimmed = tag.trim();
        if (trimmed) terms.add(trimmed);
      }
    }
  }

  return terms.size > 0 ? [...terms].join(', ') : null;
}

export function registerInternalRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): void {
  app.post(
    '/internal/jobs/claim',
    {
      schema: {
        tags: ['internal'],
        summary: 'Claim the next job for the local worker',
        body: {
          type: 'object',
          properties: { type: { type: 'string', default: 'transcribe' } },
        },
      },
    },
    async (request) => {
      const body = (request.body ?? {}) as ClaimBody;
      const job = deps.jobs.claimNext(body.type ?? 'transcribe');

      if (!job) return { job: null };

      return {
        job: {
          id: job.id,
          type: job.type,
          ref_id: job.ref_id,
          attempts: job.attempts,
          audio_url: `/internal/audio/${job.id}`,
          hints: loadTranscriptionHints(deps.db),
        },
      };
    },
  );

  app.post(
    '/internal/jobs/:id/result',
    {
      schema: {
        tags: ['internal'],
        summary: 'Report a job result back to the bridge',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['ok', 'error', 'skipped'] },
            engine: { type: 'string' },
            model: { type: 'string' },
            language: { type: ['string', 'null'] },
            text: { type: 'string' },
            segments: {},
            error: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as ResultBody;
      const job = deps.jobs.getById(id);
      if (!job) {
        return reply.code(404).send({ error: 'job_not_found' });
      }

      if (body.status === 'skipped') {
        deps.jobs.markDone(id);
        deps.log.info(
          {
            jobId: id,
            language: body.language ?? null,
            reason: body.reason ?? 'language_not_allowed',
          },
          'transcription skipped; existing transcript preserved',
        );
        return { ok: true, skipped: true };
      }

      if (body.status === 'error') {
        const message = body.error ?? 'worker reported an error';
        if (job.attempts >= 3) {
          deps.jobs.markFailed(id, message);
          return { ok: true, retried: false };
        }

        const nextRunAt = new Date(
          Date.now() + 30_000 * Math.max(1, job.attempts),
        );
        deps.jobs.retry(id, message, nextRunAt);
        return { ok: true, retried: true, next_run_at: nextRunAt.toISOString() };
      }

      const recording = job.ref_id
        ? deps.recordings.getById(job.ref_id)
        : undefined;
      const callId = recording?.call_id ?? null;

      if (!callId) {
        deps.jobs.markFailed(id, 'no linked call for transcript');
        return reply.code(409).send({ error: 'no_linked_call' });
      }

      deps.transcripts.upsert({
        callId,
        engine: body.engine ?? null,
        model: body.model ?? null,
        language: body.language ?? null,
        text: body.text ?? null,
        segments: Array.isArray(body.segments) ? body.segments : [],
      });

      deps.jobs.markDone(id);
      deps.jobs.createIfAbsent({ type: 'summarise', refId: callId });
      if (deps.config.decisionEnabled) {
        deps.jobs.createIfAbsent({ type: 'decision', refId: callId });
      }
      if (recording && !recording.file_path.toLowerCase().endsWith('.opus')) {
        deps.jobs.createIfAbsent({ type: 'compress', refId: recording.id });
      }

      // call.transcribed is emitted by the summariser once summary + extracted
      // fields are ready, not here.
      return { ok: true, retried: false };
    },
  );

  app.get(
    '/internal/audio/:job',
    {
      schema: {
        tags: ['internal'],
        summary: 'Stream the recording attached to a claimed job',
        params: {
          type: 'object',
          required: ['job'],
          properties: { job: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { job: jobId } = request.params as { job: string };
      const job = deps.jobs.getById(jobId);
      if (!job) return reply.code(404).send({ error: 'job_not_found' });

      const recording = job.ref_id
        ? deps.recordings.getById(job.ref_id)
        : undefined;
      if (!recording) {
        return reply.code(404).send({ error: 'recording_not_found' });
      }

      const info = await stat(recording.file_path).catch(() => null);
      if (!info) {
        return reply.code(404).send({ error: 'recording_file_missing' });
      }

      reply
        .header('content-type', 'audio/wav')
        .header('content-length', String(info.size));

      return reply.send(createReadStream(recording.file_path));
    },
  );
}
