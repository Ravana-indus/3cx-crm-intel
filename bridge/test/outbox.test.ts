import { afterEach, describe, expect, it } from 'vitest';
import { buildCallEvent } from '../src/webhooks/events.js';
import { OutboxDispatcher, type FetchLike } from '../src/webhooks/outbox.js';
import { callInput, testContext } from './helpers.js';

type Ctx = ReturnType<typeof testContext>;

describe('OutboxDispatcher', () => {
  let ctx: Ctx | undefined;

  afterEach(() => {
    ctx?.db.close();
    ctx = undefined;
  });

  it('delivers an event and stores the lead_id returned by the portal', async () => {
    ctx = testContext({ portalWebhookUrl: 'http://portal.test/hook' });
    const call = ctx.calls.upsert(callInput()).row;
    ctx.outbox.enqueue('call.completed', buildCallEvent('call.completed', call));

    let seenSignature: string | undefined;
    const fetchImpl: FetchLike = async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenSignature = headers['x-bridge-signature'];
      const body = JSON.parse(String(init?.body)) as {
        call: { id: string };
      };
      expect(body.call.id).toBe(call.id);
      return new Response(JSON.stringify({ lead_id: 'LEAD-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const dispatcher = new OutboxDispatcher(
      ctx.config,
      ctx.outbox,
      ctx.calls,
      ctx.log,
      fetchImpl,
    );

    const result = await dispatcher.dispatchOnce(new Date());
    expect(result.delivered).toBe(1);
    expect(seenSignature?.startsWith('sha256=')).toBe(true);
    expect(ctx.calls.getById(call.id)?.lead_id).toBe('LEAD-1');
    expect(ctx.outbox.pendingCount()).toBe(0);
  });

  it('retries with backoff and dead-letters after four retries', async () => {
    ctx = testContext({ portalWebhookUrl: 'http://portal.test/hook' });
    const call = ctx.calls.upsert(callInput()).row;
    ctx.outbox.enqueue('call.completed', buildCallEvent('call.completed', call));

    const failing: FetchLike = async () => {
      throw new Error('network down');
    };
    const dispatcher = new OutboxDispatcher(
      ctx.config,
      ctx.outbox,
      ctx.calls,
      ctx.log,
      failing,
    );

    let now = new Date();
    const first = await dispatcher.dispatchOnce(now);
    expect(first.retried).toBe(1);

    let row = ctx.db
      .prepare('SELECT * FROM outbox')
      .get() as { attempts: number; next_attempt_at: string; delivered_at: string | null };
    expect(row.attempts).toBe(1);
    expect(row.delivered_at).toBeNull();
    expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(now.getTime());

    for (let index = 0; index < 4; index += 1) {
      now = new Date(now.getTime() + 3 * 3_600_000);
      await dispatcher.dispatchOnce(now);
    }

    row = ctx.db.prepare('SELECT * FROM outbox').get() as typeof row;
    expect(row.attempts).toBe(5);
    expect(row.delivered_at).toBeNull();
  });

  it('does nothing when no webhook URL is configured', async () => {
    ctx = testContext();
    ctx.outbox.enqueue('call.completed', { event: 'call.completed' });

    const dispatcher = new OutboxDispatcher(
      ctx.config,
      ctx.outbox,
      ctx.calls,
      ctx.log,
      async () => new Response('{}'),
    );

    const result = await dispatcher.dispatchOnce(new Date());
    expect(result.skipped).toBe(true);
    expect(ctx.outbox.pendingCount()).toBe(1);
  });
});
