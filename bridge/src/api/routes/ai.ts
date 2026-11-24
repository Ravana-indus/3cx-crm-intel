import type { FastifyInstance } from 'fastify';
import type { AiConversationRow } from '../../repo/aiConversations.js';
import { parseColomboRange, toColombo } from '../../util/time.js';
import type { ApiDeps } from '../deps.js';

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function conversationDto(row: AiConversationRow) {
  return {
    id: row.el_conversation_id,
    call_id: row.call_id,
    caller: row.caller_e164,
    lead_id: row.lead_id,
    transcript: parseJson(row.transcript_json),
    analysis: parseJson(row.analysis_json),
    collected: parseJson(row.collected_json),
    created_at: toColombo(row.created_at),
  };
}

export function registerAiRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): void {
  app.get(
    '/v1/ai/settings',
    {
      schema: {
        tags: ['ai'],
        summary: 'Read AI answering mode and schedule',
      },
    },
    async () => deps.aiSettings.get(),
  );

  app.put(
    '/v1/ai/settings',
    {
      schema: {
        tags: ['ai'],
        summary: 'Change AI mode (off/overflow/always) and schedule',
        body: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['off', 'overflow', 'always'] },
            schedule: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      const body = (request.body ?? {}) as {
        mode?: 'off' | 'overflow' | 'always';
        schedule?: string | null;
      };
      return deps.aiSettings.set(body);
    },
  );

  app.get(
    '/v1/ai/conversations',
    {
      schema: {
        tags: ['ai'],
        summary: 'AI conversations in a date range',
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as { from?: string; to?: string };
      const range = parseColomboRange(query.from, query.to);
      return {
        from: toColombo(range.from),
        to: toColombo(range.to),
        items: deps.aiConversations
          .list(range.from, range.to)
          .map(conversationDto),
      };
    },
  );

  app.get(
    '/v1/ai/conversations/:id',
    {
      schema: {
        tags: ['ai'],
        summary: 'One AI conversation (ElevenLabs id or call id)',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const row =
        deps.aiConversations.getByElId(id) ??
        deps.aiConversations.getByCallId(id);
      if (!row) return reply.code(404).send({ error: 'conversation_not_found' });
      return conversationDto(row);
    },
  );
}
