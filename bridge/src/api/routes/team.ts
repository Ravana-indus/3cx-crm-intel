import type { FastifyInstance } from 'fastify';
import type { MetricsGroup, MetricsInterval } from '../../repo/metrics.js';
import { parseColomboRange, toColombo } from '../../util/time.js';
import type { ApiDeps } from '../deps.js';

const RANGE_PROPS = {
  from: { type: 'string' },
  to: { type: 'string' },
};

export function registerTeamRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): void {
  app.get(
    '/v1/team/metrics',
    {
      schema: {
        tags: ['team'],
        summary: 'Per-agent or per-team metrics for a date range',
        querystring: {
          type: 'object',
          properties: {
            ...RANGE_PROPS,
            group: { type: 'string', enum: ['agent', 'team'], default: 'agent' },
            interval: { type: 'string', enum: ['day', 'week'], default: 'day' },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as {
        from?: string;
        to?: string;
        group?: string;
        interval?: string;
      };

      const group: MetricsGroup = query.group === 'team' ? 'team' : 'agent';
      const interval: MetricsInterval = query.interval === 'week' ? 'week' : 'day';
      const range = parseColomboRange(query.from, query.to);

      return {
        from: toColombo(range.from),
        to: toColombo(range.to),
        group_by: group,
        interval,
        rows: deps.metrics.byGroup(group, interval, range),
      };
    },
  );

  app.get(
    '/v1/team/agents',
    {
      schema: {
        tags: ['team'],
        summary: 'Agent roster (extension, name, team)',
      },
    },
    async () => ({ items: deps.agents.list() }),
  );

  app.put(
    '/v1/team/agents/:ext',
    {
      schema: {
        tags: ['team'],
        summary: 'Create or update an agent roster entry',
        params: {
          type: 'object',
          required: ['ext'],
          properties: { ext: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            team: { type: ['string', 'null'] },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const { ext } = request.params as { ext: string };
      const body = (request.body ?? {}) as {
        name?: string | null;
        email?: string | null;
        team?: string | null;
        active?: boolean;
      };

      return deps.agents.upsert({
        ext,
        name: body.name,
        email: body.email,
        team: body.team,
        active: body.active,
      });
    },
  );

  app.get(
    '/v1/team/agents/:ext/metrics',
    {
      schema: {
        tags: ['team'],
        summary: 'One agent: totals plus day/week buckets',
        params: {
          type: 'object',
          required: ['ext'],
          properties: { ext: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            ...RANGE_PROPS,
            interval: {
              type: 'string',
              enum: ['day', 'week', 'total'],
              default: 'day',
            },
          },
        },
      },
    },
    async (request) => {
      const { ext } = request.params as { ext: string };
      const query = request.query as {
        from?: string;
        to?: string;
        interval?: string;
      };

      const interval: MetricsInterval =
        query.interval === 'week'
          ? 'week'
          : query.interval === 'total'
            ? 'total'
            : 'day';

      const range = parseColomboRange(query.from, query.to);

      return {
        ext,
        agent: deps.agents.get(ext) ?? null,
        from: toColombo(range.from),
        to: toColombo(range.to),
        interval,
        totals: deps.metrics.forAgentTotals(ext, range),
        buckets:
          interval === 'total'
            ? []
            : deps.metrics.byGroup('agent', interval, range, ext),
      };
    },
  );

  app.get(
    '/v1/team/presence',
    {
      schema: {
        tags: ['team'],
        summary: 'Latest observed presence per extension',
      },
    },
    async () => ({
      now: toColombo(new Date()),
      items: deps.metrics.presence(),
    }),
  );
}
