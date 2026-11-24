import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';
import {
  decisionDto,
  factsDto,
  transcriptDto,
} from '../dto.js';
import { recordingUrl } from '../recordingLink.js';
import { parseDateOr } from '../../util/time.js';

interface ExportQuery {
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/**
 * CRM pull surface for historical backfill and new facts. The bridge writes
 * nothing to the CRM; the caller joins by call_id / tcx_call_id / phone.
 */
export function registerExportRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): void {
  app.get(
    '/v1/export/calls',
    {
      schema: {
        tags: ['calls', 'decisions'],
        summary: 'Paged facts + transcript + decision export for the CRM',
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as ExportQuery;
      const now = new Date();
      const from = parseDateOr(
        query.from,
        new Date(now.getTime() - 30 * 86_400_000),
      );
      const to = parseDateOr(query.to, now);

      const page = deps.calls.list(
        { from, to },
        query.limit ?? 100,
        query.cursor,
      );
      const ttlExpiry = new Date(
        now.getTime() + deps.config.recordingLinkTtlSec * 1000,
      ).toISOString();

      const items = page.items.map((call) => {
        const recording = deps.recordings.getByCallId(call.id);
        const url = recording
          ? recordingUrl(
              deps.config.publicBaseUrl,
              call.id,
              deps.config.portalWebhookSecret,
              deps.config.recordingLinkTtlSec,
            )
          : null;
        const transcript = transcriptDto(
          deps.transcripts.getByCallId(call.id),
        );
        const decision = deps.decisions.getLatestByCallId(call.id);

        return {
          call_id: call.id,
          tcx_call_id: call.tcx_call_id,
          facts: factsDto(call, {
            recordingUrl: url,
            recordingUrlExpiresAt: url ? ttlExpiry : null,
            recordingExpiresAt: recording?.expires_at ?? null,
            agentUserId:
              deps.agents.get(call.agent_ext ?? call.ext ?? '')?.user_id ??
              null,
          }),
          transcript,
          decision: decisionDto(
            decision,
            decision ? deps.decisions.getFacts(decision.id) : [],
          ),
        };
      });

      return { items, next_cursor: page.nextCursor };
    },
  );
}
