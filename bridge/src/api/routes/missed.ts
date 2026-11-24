import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';
import { callDto } from '../dto.js';
import { parseDateOr, toColombo } from '../../util/time.js';

export function registerMissedRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get(
    '/v1/missed',
    {
      schema: {
        tags: ['calls'],
        summary: 'Missed and abandoned calls with callback status',
        querystring: {
          type: 'object',
          properties: {
            since: { type: 'string' },
            unreturned: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as { since?: string; unreturned?: string };
      const now = new Date();
      const since = parseDateOr(
        query.since,
        new Date(now.getTime() - 7 * 86_400_000),
      );
      const unreturned = query.unreturned === 'true' || query.unreturned === '1';

      const rows = deps.calls.listMissed(since, unreturned);
      const returned = deps.db.prepare(
        `SELECT 1 AS hit FROM calls
         WHERE direction = 'outbound' AND to_e164 = ? AND started_at > ?
         LIMIT 1`,
      );

      return {
        since: toColombo(since),
        items: rows.map((row) => {
          const callbackStatus = !row.from_e164
            ? 'unknown'
            : returned.get(row.from_e164, row.started_at)
              ? 'returned'
              : 'unreturned';

          return {
            ...callDto(row),
            callback_status: callbackStatus,
          };
        }),
      };
    },
  );
}
