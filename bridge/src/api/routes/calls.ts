import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';
import { bearerToken } from '../auth.js';
import type { CallRow } from '../../repo/calls.js';
import {
  callDto,
  decisionDto,
  factsDto,
  summaryDto,
  transcriptDto,
} from '../dto.js';
import { recordingUrl, verifyRecording } from '../recordingLink.js';
import { parseDateOr } from '../../util/time.js';

interface CallListQuery {
  from?: string;
  to?: string;
  ext?: string;
  outcome?: string;
  lead_id?: string;
  cursor?: string;
  limit?: number;
}

function findCall(deps: ApiDeps, id: string): CallRow | undefined {
  return deps.calls.getById(id) ?? deps.calls.getByTcxId(id);
}

export function registerCallsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { config, recordings } = deps;

  const linkFor = (call: CallRow): string | null => {
    const recording = recordings.getByCallId(call.id);
    if (!recording) return null;
    return recordingUrl(
      config.publicBaseUrl,
      call.id,
      config.portalWebhookSecret,
      config.recordingLinkTtlSec,
    );
  };

  const urlExpiry = (): string =>
    new Date(
      Date.now() + config.recordingLinkTtlSec * 1000,
    ).toISOString();

  const agentUserId = (row: CallRow): string | null =>
    deps.agents.get(row.agent_ext ?? row.ext ?? '')?.user_id ?? null;

  const listItem = (row: CallRow) => {
    const recording = recordings.getByCallId(row.id);
    const transcript = deps.transcripts.getByCallId(row.id);
    const summary = deps.summaries.getByCallId(row.id);
    const decision = deps.decisions.getLatestByCallId(row.id);
    const url = recording ? linkFor(row) : null;
    return callDto(row, {
      recordingUrl: url,
      recordingUrlExpiresAt: url ? urlExpiry() : null,
      recordingExpiresAt: recording?.expires_at ?? null,
      hasRecording: Boolean(recording),
      hasTranscript: Boolean(transcript),
      hasSummary: Boolean(summary),
      hasDecision: Boolean(decision),
      decision: decision
        ? decisionDto(decision, deps.decisions.getFacts(decision.id))
        : null,
      facts: factsDto(row, {
        recordingUrl: url,
        recordingUrlExpiresAt: url ? urlExpiry() : null,
        recordingExpiresAt: recording?.expires_at ?? null,
        agentUserId: agentUserId(row),
      }),
    });
  };

  app.get(
    '/v1/calls',
    {
      schema: {
        tags: ['calls'],
        summary: 'Paged call log, newest first',
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            ext: { type: 'string' },
            outcome: { type: 'string' },
            lead_id: { type: 'string' },
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as CallListQuery;
      const now = new Date();
      const from = parseDateOr(query.from, new Date(now.getTime() - 7 * 86_400_000));
      const to = parseDateOr(query.to, now);

      const page = deps.calls.list(
        {
          from,
          to,
          ext: query.ext,
          outcome: query.outcome,
          leadId: query.lead_id,
        },
        query.limit ?? 50,
        query.cursor,
      );

      return {
        items: page.items.map(listItem),
        next_cursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/calls/:id',
    {
      schema: {
        tags: ['calls'],
        summary: 'One call with transcript, summary and recording link',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const call = findCall(deps, id);
      if (!call) {
        return reply.code(404).send({ error: 'call_not_found' });
      }

      const transcript = transcriptDto(deps.transcripts.getByCallId(call.id));
      const summary = summaryDto(deps.summaries.getByCallId(call.id));
      const recording = recordings.getByCallId(call.id);
      const url = recording ? linkFor(call) : null;
      const decision = deps.decisions.getLatestByCallId(call.id);
      const decisionPayload = decisionDto(
        decision,
        decision ? deps.decisions.getFacts(decision.id) : [],
      );

      return callDto(call, {
        recordingUrl: url,
        recordingUrlExpiresAt: url ? urlExpiry() : null,
        recordingExpiresAt: recording?.expires_at ?? null,
        hasRecording: Boolean(recording),
        hasTranscript: Boolean(transcript),
        hasSummary: Boolean(summary),
        hasDecision: Boolean(decision),
        transcript,
        summary,
        decision: decisionPayload,
        facts: factsDto(call, {
          recordingUrl: url,
          recordingUrlExpiresAt: url ? urlExpiry() : null,
          recordingExpiresAt: recording?.expires_at ?? null,
          agentUserId: agentUserId(call),
        }),
      });
    },
  );

  app.get(
    '/v1/calls/:id/facts',
    {
      schema: {
        tags: ['calls'],
        summary: 'Deterministic Layer A facts for one call',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const call = findCall(deps, id);
      if (!call) return reply.code(404).send({ error: 'call_not_found' });

      const recording = recordings.getByCallId(call.id);
      const url = recording ? linkFor(call) : null;
      return factsDto(call, {
        recordingUrl: url,
        recordingUrlExpiresAt: url ? urlExpiry() : null,
        recordingExpiresAt: recording?.expires_at ?? null,
        agentUserId: agentUserId(call),
      });
    },
  );

  app.get(
    '/v1/calls/:id/decisions',
    {
      schema: {
        tags: ['calls', 'decisions'],
        summary: 'Current staged/approved decision for one call',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const call = findCall(deps, id);
      if (!call) return reply.code(404).send({ error: 'call_not_found' });

      const decision = deps.decisions.getLatestByCallId(call.id);
      return {
        items: decision
          ? [
              decisionDto(
                decision,
                deps.decisions.getFacts(decision.id),
              ),
            ]
          : [],
      };
    },
  );

  app.get(
    '/v1/calls/:id/transcript',
    {
      schema: {
        tags: ['calls'],
        summary: 'Transcript with timestamped segments',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const call = findCall(deps, id);
      if (!call) {
        return reply.code(404).send({ error: 'call_not_found' });
      }

      const transcript = transcriptDto(
        deps.transcripts.getByCallId(call.id),
      );
      if (!transcript) {
        return reply.code(404).send({ error: 'transcript_not_ready' });
      }
      return transcript;
    },
  );

  app.get(
    '/v1/calls/:id/recording',
    {
      schema: {
        tags: ['calls'],
        summary: 'Stream the call recording (Bearer or signed link)',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            exp: { type: 'string' },
            sig: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const call = findCall(deps, id);
      if (!call) {
        return reply.code(404).send({ error: 'call_not_found' });
      }

      const recording = recordings.getByCallId(call.id);
      if (!recording) {
        return reply.code(404).send({ error: 'recording_not_found' });
      }

      const token = bearerToken(request);
      const bearerOk = token !== null && token === config.portalToken;

      if (!bearerOk) {
        const query = request.query as { exp?: string; sig?: string };
        const exp = Number(query.exp);
        if (
          !query.sig ||
          !verifyRecording(
            call.id,
            exp,
            query.sig,
            config.portalWebhookSecret,
          )
        ) {
          return reply.code(403).send({ error: 'invalid_recording_signature' });
        }
      }

      const info = await stat(recording.file_path).catch(() => null);
      if (!info) {
        return reply.code(404).send({ error: 'recording_file_missing' });
      }

      reply
        .header('content-type', 'audio/wav')
        .header('content-length', String(info.size))
        .header('cache-control', 'private, max-age=60');

      return reply.send(createReadStream(recording.file_path));
    },
  );
}
