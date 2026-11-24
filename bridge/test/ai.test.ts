import { describe, expect, it } from 'vitest';
import { VoiceBridge } from '../src/ai/bridge.js';
import { MockAgentSessionFactory } from '../src/elevenlabs/mockSession.js';
import { PortalClient, type FetchLike } from '../src/portal/client.js';
import type { MockSoftphone } from '../src/threecx/softphone/mock.js';
import { callInput, testContext } from './helpers.js';

const sleep = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function portalFetch(posts: unknown[]): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/api/leads/by-phone')) {
      return new Response(
        JSON.stringify({ lead_id: 'LEAD-1', name: 'Patel', stage: 'documents' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/enquiries')) {
      posts.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ ok: true, lead_id: 'LEAD-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  };
}

describe('AI settings', () => {
  it('maps off to DND and overflow/always to available', async () => {
    const ctx = testContext();

    try {
      expect(ctx.aiSettings.get().mode).toBe('overflow');

      await ctx.aiSettings.set({ mode: 'off' });
      expect(ctx.softphone.statuses).toContain('dnd');

      await ctx.aiSettings.set({
        mode: 'always',
        schedule: 'Mon-Fri 09:00-17:00',
      });
      expect(ctx.softphone.statuses).toContain('available');
      expect(ctx.aiSettings.get().schedule).toBe('Mon-Fri 09:00-17:00');
    } finally {
      ctx.db.close();
    }
  });
});

describe('VoiceBridge', () => {
  it('answers, moves audio, runs client tools and stores the conversation', async () => {
    const ctx = testContext({ portalApiUrl: 'http://portal.test' });
    const posted: unknown[] = [];
    const portal = new PortalClient(ctx.config, ctx.log, portalFetch(posted));
    const sessions = new MockAgentSessionFactory();

    const startedAt = new Date().toISOString();
    const call = ctx.calls.upsert(
      callInput({
        tcxCallId: 'ai-call',
        direction: 'inbound',
        outcome: 'ai_handled',
        ext: '199',
        agentExt: '199',
        startedAt,
        answeredAt: startedAt,
        endedAt: startedAt,
        fromRaw: '0771234567',
        fromE164: '+94771234567',
      }),
    ).row;

    const bridge = new VoiceBridge({
      config: ctx.config,
      log: ctx.log,
      softphone: ctx.softphone,
      sessions,
      elevenlabs: ctx.elevenlabs,
      portal,
      calls: ctx.calls,
      aiConversations: ctx.aiConversations,
      outbox: ctx.outbox,
      alert: async () => undefined,
    });
    bridge.start();

    try {
      await bridge.handleIncoming({ callId: 'c1', fromRaw: '0771234567' });

      const session = sessions.latest();
      expect(session).toBeTruthy();
      expect(ctx.softphone.answered).toContain('c1');
      expect(session?.dynamicVariables.caller_number).toBe('+94771234567');
      expect(session?.dynamicVariables.lead_name).toBe('Patel');

      const transport = (ctx.softphone as MockSoftphone).latestTransport();
      expect(transport?.started).toBe(true);

      transport?.emitCallerAudio(Buffer.from([1, 2]));
      expect(session?.sentAudio).toHaveLength(1);

      session?.emitAgentAudio(Buffer.from([3, 4]));
      expect(transport?.sentAgentAudio).toHaveLength(1);

      session?.emitInterruption();
      expect(transport?.flushes).toBe(1);

      session?.emitToolCall({
        toolCallId: 't1',
        toolName: 'lookup_caller',
        parameters: {},
      });
      await sleep();
      expect(
        (session?.toolResults[0]?.result as { lead_id?: string } | undefined)
          ?.lead_id,
      ).toBe('LEAD-1');

      session?.emitToolCall({
        toolCallId: 't2',
        toolName: 'create_enquiry',
        parameters: { destination: 'Germany' },
      });
      await sleep();
      expect(posted[0]).toMatchObject({
        type: 'enquiry',
        destination: 'Germany',
        caller_number: '+94771234567',
        lead_id: 'LEAD-1',
      });

      session?.emitToolCall({
        toolCallId: 't3',
        toolName: 'end_call',
        parameters: {},
      });
      await sleep();

      expect(ctx.softphone.hungUp).toContain('c1');
      const conversation = ctx.aiConversations.getByElId(
        session?.conversationId as string,
      );
      expect(conversation?.call_id).toBe(call.id);
      expect(conversation?.lead_id).toBe('LEAD-1');

      const events = ctx.db
        .prepare(
          "SELECT COUNT(*) AS count FROM outbox WHERE event = 'ai.conversation.completed'",
        )
        .get() as { count: number };
      expect(events.count).toBe(1);
    } finally {
      await bridge.stop();
      ctx.db.close();
    }
  });

  it('hangs up and flags a call after the watchdog silence window', async () => {
    const ctx = testContext({ portalApiUrl: 'http://portal.test' });
    const sessions = new MockAgentSessionFactory();
    const portal = new PortalClient(ctx.config, ctx.log, portalFetch([]));

    const bridge = new VoiceBridge({
      config: ctx.config,
      log: ctx.log,
      softphone: ctx.softphone,
      sessions,
      elevenlabs: ctx.elevenlabs,
      portal,
      calls: ctx.calls,
      aiConversations: ctx.aiConversations,
      outbox: ctx.outbox,
      alert: async () => undefined,
    });

    try {
      await bridge.handleIncoming({ callId: 'c2', fromRaw: '0771234567' });
      await bridge.tick(Date.now() + ctx.config.aiWatchdogMs + 1);

      expect(ctx.softphone.hungUp).toContain('c2');
      const failed = ctx.db
        .prepare(
          "SELECT COUNT(*) AS count FROM outbox WHERE event = 'ai.call_failed'",
        )
        .get() as { count: number };
      expect(failed.count).toBeGreaterThanOrEqual(1);
    } finally {
      await bridge.stop();
      ctx.db.close();
    }
  });
});
