import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';
import { decisionDto } from '../dto.js';
import type { DecisionStatus } from '../../repo/decisions.js';
import { parseDateOr } from '../../util/time.js';

interface DecisionListQuery {
  status?: DecisionStatus;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

interface ReviewBody {
  status?: 'approved' | 'rejected';
  reviewed_by?: string;
  note?: string;
}

const STATUSES: DecisionStatus[] = [
  'staged',
  'approved',
  'rejected',
  'superseded',
  'invalid',
];

export function registerDecisionRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): void {
  app.get(
    '/v1/decisions',
    {
      schema: {
        tags: ['decisions'],
        summary: 'Paged staged/approved call decisions',
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: STATUSES },
            from: { type: 'string' },
            to: { type: 'string' },
            cursor: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as DecisionListQuery;
      const now = new Date();
      const from = parseDateOr(
        query.from,
        new Date(now.getTime() - 30 * 86_400_000),
      );
      const to = parseDateOr(query.to, now);

      const page = deps.decisions.list(
        {
          status: query.status,
          from,
          to,
        },
        query.limit ?? 50,
        query.cursor,
      );

      return {
        items: page.items.map((row) =>
          decisionDto(row, deps.decisions.getFacts(row.id)),
        ),
        next_cursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/v1/decisions/:id',
    {
      schema: {
        tags: ['decisions'],
        summary: 'One staged decision with facts and provenance',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row = deps.decisions.getById(id);
      if (!row) return reply.code(404).send({ error: 'decision_not_found' });
      return decisionDto(row, deps.decisions.getFacts(row.id));
    },
  );

  app.post(
    '/v1/decisions/:id/review',
    {
      schema: {
        tags: ['decisions'],
        summary: 'Approve or reject a staged decision (no lead write)',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['status', 'reviewed_by'],
          properties: {
            status: { type: 'string', enum: ['approved', 'rejected'] },
            reviewed_by: { type: 'string', minLength: 1 },
            note: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as ReviewBody;
      if (!body.status || !body.reviewed_by?.trim()) {
        return reply
          .code(400)
          .send({ error: 'status and reviewed_by are required' });
      }

      const now = new Date();
      const row = deps.decisions.review(
        id,
        body.status,
        body.reviewed_by.trim(),
        body.note ?? null,
        now,
      );
      if (!row) {
        return reply
          .code(409)
          .send({ error: 'decision_not_reviewable' });
      }

      const event =
        body.status === 'approved' ? 'decision.approved' : 'decision.rejected';
      deps.outbox.enqueue(
        event,
        {
          event,
          decision_id: row.id,
          call_id: row.call_id,
          status: row.status,
          reviewed_by: row.reviewed_by,
        },
        now,
      );

      deps.log.info(
        { decisionId: row.id, callId: row.call_id, status: row.status },
        'decision reviewed',
      );

      return decisionDto(row, deps.decisions.getFacts(row.id));
    },
  );
}
