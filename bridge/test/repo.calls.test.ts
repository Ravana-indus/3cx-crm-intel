import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callInput, testContext } from './helpers.js';

type Ctx = ReturnType<typeof testContext>;

describe('CallsRepo', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = testContext();
  });

  afterEach(() => {
    ctx.db.close();
  });

  it('upserts by 3CX call id and merges segment ids', () => {
    const first = ctx.calls.upsert(callInput());
    expect(first.created).toBe(true);
    expect(first.becameFinal).toBe(true);

    const second = ctx.calls.upsert(
      callInput({ segmentIds: ['tcx-2'], fromRaw: '0779999999' }),
    );
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(JSON.parse(second.row.tcx_segment_ids)).toEqual(['tcx-1', 'tcx-2']);
    expect(ctx.calls.list({}, 10).items).toHaveLength(1);
  });

  it('flags when a call first becomes final', () => {
    const open = ctx.calls.upsert(
      callInput({ endedAt: null, answeredAt: null, talkSec: null }),
    );
    expect(open.becameFinal).toBe(false);

    const final = ctx.calls.upsert(callInput());
    expect(final.becameFinal).toBe(true);
  });

  it('paginates newest first with a cursor', () => {
    ctx.calls.upsert(callInput({ tcxCallId: 'a', startedAt: '2026-11-20T01:00:00.000Z' }));
    ctx.calls.upsert(callInput({ tcxCallId: 'b', startedAt: '2026-11-20T02:00:00.000Z' }));
    ctx.calls.upsert(callInput({ tcxCallId: 'c', startedAt: '2026-11-20T03:00:00.000Z' }));

    const page1 = ctx.calls.list({}, 2);
    expect(page1.items.map((row) => row.tcx_call_id)).toEqual(['c', 'b']);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = ctx.calls.list({}, 2, page1.nextCursor);
    expect(page2.items.map((row) => row.tcx_call_id)).toEqual(['a']);
    expect(page2.nextCursor).toBeNull();
  });

  it('filters missed calls and resolves unreturned callbacks', () => {
    const missed = ctx.calls.upsert(
      callInput({
        tcxCallId: 'miss-1',
        outcome: 'missed',
        answeredAt: null,
        talkSec: null,
        ext: '103',
        agentExt: null,
        fromRaw: '0770001111',
        fromE164: '+94770001111',
      }),
    );
    expect(missed.row.outcome).toBe('missed');

    const since = new Date('2026-11-01T00:00:00.000Z');
    expect(ctx.calls.listMissed(since, true)).toHaveLength(1);

    ctx.calls.upsert(
      callInput({
        tcxCallId: 'out-1',
        direction: 'outbound',
        outcome: 'outbound',
        fromRaw: '102',
        fromE164: null,
        toRaw: '0770001111',
        toE164: '+94770001111',
        startedAt: '2026-11-20T05:00:00.000Z',
      }),
    );

    expect(ctx.calls.listMissed(since, true)).toHaveLength(0);
    expect(ctx.calls.listMissed(since, false)).toHaveLength(1);
  });

  it('finds a call by extension and start time for recording linking', () => {
    const created = ctx.calls.upsert(callInput());
    const found = ctx.calls.findByExtAndTime(
      '102',
      '2026-11-20T04:30:03.000Z',
      5,
    );
    expect(found?.id).toBe(created.row.id);
    expect(ctx.calls.findByExtAndTime('999', created.row.started_at, 5)).toBeUndefined();
  });

  it('stores lead ids returned by the portal', () => {
    const created = ctx.calls.upsert(callInput());
    ctx.calls.setLeadId(created.row.id, 'LEAD-1');
    expect(ctx.calls.getById(created.row.id)?.lead_id).toBe('LEAD-1');
  });
});
