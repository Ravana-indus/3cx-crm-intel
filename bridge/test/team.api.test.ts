import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { callInput, testContext } from './helpers.js';

const AUTH = { authorization: 'Bearer test-portal' };

describe('team API', () => {
  it('serves metrics, roster, presence and agent totals', async () => {
    const ctx = testContext();

    ctx.agents.upsert({ ext: '102', name: 'Agent A', team: 'sales' });
    ctx.calls.upsert(
      callInput({
        tcxCallId: 't1',
        startedAt: '2026-11-20T04:30:00.000Z',
        ext: '102',
        agentExt: '102',
        outcome: 'answered',
      }),
    );
    ctx.presence.insert('102', 'Available', '2026-11-20T03:30:00.000Z');
    ctx.presence.insert('102', 'Away', '2026-11-20T04:30:00.000Z');

    const app = await buildApp(ctx);
    try {
      const metrics = await app.inject({
        method: 'GET',
        url: '/v1/team/metrics?from=2026-11-20&to=2026-11-20&group=agent&interval=day',
        headers: AUTH,
      });
      expect(metrics.statusCode).toBe(200);
      const metricsBody = metrics.json() as {
        group_by: string;
        rows: Array<{
          group_key: string;
          offered: number;
          active_minutes: number | null;
        }>;
      };
      expect(metricsBody.group_by).toBe('agent');
      expect(metricsBody.rows).toHaveLength(1);
      expect(metricsBody.rows[0].group_key).toBe('102');
      expect(metricsBody.rows[0].offered).toBe(1);
      expect(metricsBody.rows[0].active_minutes).toBe(60);

      const team = await app.inject({
        method: 'GET',
        url: '/v1/team/metrics?from=2026-11-20&to=2026-11-20&group=team',
        headers: AUTH,
      });
      const teamBody = team.json() as { rows: Array<{ group_key: string }> };
      expect(teamBody.rows[0].group_key).toBe('sales');

      const roster = await app.inject({
        method: 'GET',
        url: '/v1/team/agents',
        headers: AUTH,
      });
      expect((roster.json() as { items: unknown[] }).items).toHaveLength(1);

      const put = await app.inject({
        method: 'PUT',
        url: '/v1/team/agents/103',
        headers: AUTH,
        payload: { name: 'Agent B', team: 'support' },
      });
      expect(put.statusCode).toBe(200);
      expect((put.json() as { team: string }).team).toBe('support');

      const totals = await app.inject({
        method: 'GET',
        url: '/v1/team/agents/102/metrics?from=2026-11-20&to=2026-11-20&interval=total',
        headers: AUTH,
      });
      const totalsBody = totals.json() as {
        totals: { offered: number; active_minutes: number | null };
        buckets: unknown[];
        agent: { name: string };
      };
      expect(totalsBody.totals.offered).toBe(1);
      expect(totalsBody.totals.active_minutes).toBe(60);
      expect(totalsBody.buckets).toEqual([]);
      expect(totalsBody.agent.name).toBe('Agent A');

      const buckets = await app.inject({
        method: 'GET',
        url: '/v1/team/agents/102/metrics?from=2026-11-20&to=2026-11-20&interval=day',
        headers: AUTH,
      });
      const bucketsBody = buckets.json() as {
        buckets: Array<{ active_minutes: number | null }>;
      };
      expect(bucketsBody.buckets[0].active_minutes).toBe(60);

      const presence = await app.inject({
        method: 'GET',
        url: '/v1/team/presence',
        headers: AUTH,
      });
      expect(
        (presence.json() as { items: Array<{ status: string }> }).items[0].status,
      ).toBe('Away');

      const unauthenticated = await app.inject({
        method: 'GET',
        url: '/v1/team/metrics',
      });
      expect(unauthenticated.statusCode).toBe(401);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
