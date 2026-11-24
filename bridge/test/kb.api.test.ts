import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testContext } from './helpers.js';

const AUTH = { authorization: 'Bearer test-portal' };

describe('knowledge base and AI API', () => {
  it('manages KB, AI mode and AI conversations', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/kb/docs',
        headers: AUTH,
        payload: {
          title: 'Fees',
          body_md: 'Fees are reviewed yearly.',
          tags: 'fees, germany',
          review_by: '2026-01-01',
        },
      });
      expect(created.statusCode).toBe(201);
      const doc = created.json() as { id: string; title: string };
      expect(doc.title).toBe('Fees');

      const sync = await app.inject({
        method: 'POST',
        url: '/v1/kb/sync',
        headers: AUTH,
      });
      expect(sync.statusCode).toBe(200);
      expect((sync.json() as { result: { created: number } }).result.created).toBe(
        1,
      );
      expect(ctx.elevenlabs.remoteDocs()).toHaveLength(1);

      const list = await app.inject({
        method: 'GET',
        url: '/v1/kb/docs',
        headers: AUTH,
      });
      expect((list.json() as { items: unknown[] }).items).toHaveLength(1);

      const updated = await app.inject({
        method: 'PUT',
        url: `/v1/kb/docs/${doc.id}`,
        headers: AUTH,
        payload: { body_md: 'Fees are reviewed every quarter.' },
      });
      expect(updated.statusCode).toBe(200);

      const health = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: AUTH,
      });
      const healthBody = health.json() as {
        stale_kb_docs: unknown[];
        maintenance: { ai_mode: string };
      };
      expect(healthBody.stale_kb_docs).toHaveLength(1);
      expect(healthBody.maintenance.ai_mode).toBe('overflow');

      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/kb/docs/${doc.id}`,
        headers: AUTH,
      });
      expect(removed.statusCode).toBe(200);
      expect(ctx.elevenlabs.remoteDocs()).toHaveLength(0);

      const settings = await app.inject({
        method: 'GET',
        url: '/v1/ai/settings',
        headers: AUTH,
      });
      expect((settings.json() as { mode: string }).mode).toBe('overflow');

      const put = await app.inject({
        method: 'PUT',
        url: '/v1/ai/settings',
        headers: AUTH,
        payload: { mode: 'off' },
      });
      expect((put.json() as { mode: string }).mode).toBe('off');
      expect(ctx.softphone.statuses).toContain('dnd');

      ctx.aiConversations.upsert({
        elConversationId: 'conv-1',
        callId: null,
        callerE164: '+94771234567',
        transcript: [{ speaker: 'caller', text: 'hello' }],
        analysis: { summary: 'Caller asked about Germany' },
        collected: { destination: 'Germany' },
        leadId: 'LEAD-1',
      });

      const conversations = await app.inject({
        method: 'GET',
        url: '/v1/ai/conversations',
        headers: AUTH,
      });
      const conversationsBody = conversations.json() as {
        items: Array<{ collected: { destination: string } }>;
      };
      expect(conversationsBody.items).toHaveLength(1);
      expect(conversationsBody.items[0].collected.destination).toBe('Germany');

      const one = await app.inject({
        method: 'GET',
        url: '/v1/ai/conversations/conv-1',
        headers: AUTH,
      });
      expect((one.json() as { id: string }).id).toBe('conv-1');
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
