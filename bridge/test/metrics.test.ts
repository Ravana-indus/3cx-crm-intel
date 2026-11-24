import { describe, expect, it } from 'vitest';
import { parseColomboRange } from '../src/util/time.js';
import { callInput, testContext } from './helpers.js';

type Ctx = ReturnType<typeof testContext>;

function seed(ctx: Ctx, overrides: Record<string, unknown>) {
  return ctx.calls.upsert(callInput(overrides));
}

function byKey<T extends { group_key: string }>(rows: T[], key: string): T {
  const row = rows.find((entry) => entry.group_key === key);
  if (!row) throw new Error(`No metric row for ${key}`);
  return row;
}

describe('MetricsRepo', () => {
  it('computes per-agent metrics for a Colombo day', () => {
    const ctx = testContext();

    try {
      ctx.agents.upsert({ ext: '102', name: 'Agent A', team: 'sales' });
      ctx.agents.upsert({ ext: '199', name: 'AI Receptionist', team: 'ai' });

      seed(ctx, {
        tcxCallId: 'a',
        startedAt: '2026-11-20T04:30:00.000Z',
        answeredAt: '2026-11-20T04:30:09.000Z',
        endedAt: '2026-11-20T04:35:12.000Z',
        ringSec: 9,
        talkSec: 303,
        ext: '102',
        agentExt: '102',
        outcome: 'answered',
      });

      seed(ctx, {
        tcxCallId: 'b',
        startedAt: '2026-11-20T05:00:00.000Z',
        answeredAt: '2026-11-20T05:00:05.000Z',
        endedAt: '2026-11-20T05:00:13.000Z',
        ringSec: 5,
        talkSec: 8,
        ext: '102',
        agentExt: '102',
        outcome: 'answered',
      });

      seed(ctx, {
        tcxCallId: 'c',
        startedAt: '2026-11-20T06:00:00.000Z',
        answeredAt: null,
        talkSec: null,
        endedAt: '2026-11-20T06:00:25.000Z',
        ringSec: 25,
        ext: '102',
        agentExt: null,
        outcome: 'missed',
        fromRaw: '0770001111',
        fromE164: '+94770001111',
      });

      seed(ctx, {
        tcxCallId: 'd',
        direction: 'outbound',
        outcome: 'outbound',
        startedAt: '2026-11-20T07:00:00.000Z',
        answeredAt: '2026-11-20T07:00:05.000Z',
        endedAt: '2026-11-20T07:02:05.000Z',
        ringSec: 5,
        talkSec: 120,
        fromRaw: '102',
        fromE164: null,
        toRaw: '0770001111',
        toE164: '+94770001111',
        ext: '102',
        agentExt: '102',
      });

      const ai = seed(ctx, {
        tcxCallId: 'e',
        startedAt: '2026-11-20T08:00:00.000Z',
        answeredAt: '2026-11-20T08:00:02.000Z',
        endedAt: '2026-11-20T08:01:37.000Z',
        ringSec: 2,
        talkSec: 95,
        ext: '199',
        agentExt: '199',
        outcome: 'ai_handled',
      });
      ctx.calls.setLeadId(ai.row.id, 'LEAD-1');

      const range = parseColomboRange('2026-11-20', '2026-11-20');
      const rows = ctx.metrics.byGroup('agent', 'day', range);

      const agent = byKey(rows, '102');
      expect(agent.offered).toBe(3);
      expect(agent.answered).toBe(2);
      expect(agent.missed).toBe(1);
      expect(agent.abandoned).toBe(0);
      expect(agent.answer_rate).toBe(0.6667);
      expect(agent.avg_speed_of_answer_sec).toBe(7);
      expect(agent.talk_sec_total).toBe(311);
      expect(agent.talk_sec_avg).toBe(155.5);
      expect(agent.drops).toBe(1);
      expect(agent.outbound_calls).toBe(1);
      expect(agent.outbound_talk_sec).toBe(120);
      expect(agent.callback_returned).toBe(1);
      expect(agent.callback_unreturned).toBe(0);
      expect(agent.avg_callback_minutes).toBe(60);

      const aiRow = byKey(rows, '199');
      expect(aiRow.offered).toBe(1);
      expect(aiRow.ai_handled).toBe(1);
      expect(aiRow.ai_handled_with_lead).toBe(1);
      expect(aiRow.talk_sec_total).toBe(95);
      expect(aiRow.answer_rate).toBe(0);
    } finally {
      ctx.db.close();
    }
  });

  it('groups by team and buckets on Colombo local days and weeks', () => {
    const ctx = testContext();

    try {
      ctx.agents.upsert({ ext: '102', name: 'Agent A', team: 'sales' });

      seed(ctx, {
        tcxCallId: 'day-one',
        startedAt: '2026-11-20T04:30:00.000Z',
        ext: '102',
        agentExt: '102',
      });

      // 20:00Z on the 20th is 01:30 on the 21st in Colombo.
      seed(ctx, {
        tcxCallId: 'next-local-day',
        startedAt: '2026-11-20T20:00:00.000Z',
        ext: '102',
        agentExt: '102',
      });

      const range = parseColomboRange('2026-11-20', '2026-11-21');
      const teamRows = ctx.metrics.byGroup('team', 'day', range);
      const sales = byKey(teamRows, 'sales');

      expect(sales.team).toBe('sales');
      expect(sales.ext).toBeNull();

      const dayRows = ctx.metrics
        .byGroup('agent', 'day', range)
        .filter((row) => row.group_key === '102');
      expect(dayRows.map((row) => row.period).sort()).toEqual([
        '2026-11-20',
        '2026-11-21',
      ]);
      expect(dayRows.reduce((sum, row) => sum + row.offered, 0)).toBe(2);
      const localNextDay = dayRows.find((row) => row.period === '2026-11-21');
      expect(localNextDay?.offered).toBe(1);

      const weekRange = parseColomboRange('2026-11-16', '2026-11-22');
      const weekRows = ctx.metrics.byGroup('team', 'week', weekRange);
      expect(weekRows.length).toBe(1);
      expect(weekRows[0].period).toBe('2026-11-16');
      expect(weekRows[0].offered).toBe(2);
    } finally {
      ctx.db.close();
    }
  });

  it('measures callbacks and treats slow or missing callbacks as unreturned', () => {
    const ctx = testContext();

    try {
      const missed = (id: string, from: string, at: string) =>
        seed(ctx, {
          tcxCallId: id,
          startedAt: at,
          answeredAt: null,
          talkSec: null,
          endedAt: at,
          ringSec: 20,
          ext: '102',
          agentExt: null,
          outcome: 'missed',
          fromRaw: from,
          fromE164: from,
        });

      const outbound = (id: string, to: string, at: string) =>
        seed(ctx, {
          tcxCallId: id,
          direction: 'outbound',
          outcome: 'outbound',
          startedAt: at,
          answeredAt: at,
          endedAt: at,
          talkSec: 30,
          fromRaw: '102',
          fromE164: null,
          toRaw: to,
          toE164: to,
          ext: '102',
          agentExt: '102',
        });

      missed('m1', '+94770003333', '2026-11-20T06:00:00.000Z');
      outbound('o1', '+94770003333', '2026-11-20T06:05:00.000Z');

      missed('m2', '+94770004444', '2026-11-20T07:00:00.000Z');
      outbound('o2', '+94770004444', '2026-11-21T08:00:00.000Z');

      missed('m3', '+94770005555', '2026-11-20T08:00:00.000Z');

      const range = parseColomboRange('2026-11-20', '2026-11-21');
      const row = byKey(
        ctx.metrics.byGroup('agent', 'day', range).filter(
          (entry) => entry.period === '2026-11-20',
        ),
        '102',
      );

      expect(row.callback_returned).toBe(1);
      expect(row.callback_unreturned).toBe(2);
      expect(row.avg_callback_minutes).toBe(5);
    } finally {
      ctx.db.close();
    }
  });

  it('computes active minutes from presence events, split by local day', () => {
    const ctx = testContext();

    try {
      ctx.agents.upsert({ ext: '102', name: 'Agent A', team: 'sales' });
      ctx.agents.upsert({ ext: '103', name: 'Agent B', team: 'sales' });

      seed(ctx, {
        tcxCallId: 'p1',
        startedAt: '2026-11-20T04:30:00.000Z',
        ext: '102',
        agentExt: '102',
      });

      ctx.presence.insert('102', 'Available', '2026-11-20T03:30:00.000Z');
      ctx.presence.insert('102', 'Away', '2026-11-20T04:30:00.000Z');
      ctx.presence.insert('102', 'Available', '2026-11-20T05:30:00.000Z');
      ctx.presence.insert('102', 'Away', '2026-11-20T06:00:00.000Z');

      ctx.presence.insert('103', 'Available', '2026-11-20T03:30:00.000Z');
      ctx.presence.insert('103', 'Away', '2026-11-20T04:30:00.000Z');

      const range = parseColomboRange('2026-11-20', '2026-11-20');

      const agentRow = byKey(ctx.metrics.byGroup('agent', 'day', range), '102');
      expect(agentRow.active_minutes).toBe(90);

      const teamRow = byKey(ctx.metrics.byGroup('team', 'day', range), 'sales');
      expect(teamRow.active_minutes).toBe(150);
    } finally {
      ctx.db.close();
    }
  });

  it('reports active_minutes as null when presence is unavailable', () => {
    const ctx = testContext();

    try {
      ctx.agents.upsert({ ext: '102', name: 'Agent A', team: 'sales' });
      seed(ctx, {
        tcxCallId: 'n1',
        startedAt: '2026-11-20T04:30:00.000Z',
        ext: '102',
        agentExt: '102',
      });

      const range = parseColomboRange('2026-11-20', '2026-11-20');
      const row = byKey(ctx.metrics.byGroup('agent', 'day', range), '102');
      expect(row.active_minutes).toBeNull();
    } finally {
      ctx.db.close();
    }
  });
});
