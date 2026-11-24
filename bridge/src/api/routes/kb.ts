import type { FastifyInstance } from 'fastify';
import { enqueueKbSync } from '../../kb/runner.js';
import type { ApiDeps } from '../deps.js';

export function registerKbRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): void {
  app.get(
    '/v1/kb/docs',
    { schema: { tags: ['kb'], summary: 'List knowledge-base documents' } },
    async () => ({ items: deps.kb.list() }),
  );

  app.post(
    '/v1/kb/docs',
    {
      schema: {
        tags: ['kb'],
        summary: 'Create a knowledge-base document',
        body: {
          type: 'object',
          required: ['title', 'body_md'],
          properties: {
            title: { type: 'string' },
            body_md: { type: 'string' },
            tags: { type: ['string', 'null'] },
            owner: { type: ['string', 'null'] },
            review_by: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        title: string;
        body_md: string;
        tags?: string | null;
        owner?: string | null;
        review_by?: string | null;
      };

      const doc = deps.kb.create({
        title: body.title,
        bodyMd: body.body_md,
        tags: body.tags ?? null,
        owner: body.owner ?? null,
        reviewBy: body.review_by ?? null,
      });
      enqueueKbSync(deps.jobs);
      return reply.code(201).send(doc);
    },
  );

  app.get(
    '/v1/kb/docs/:id',
    {
      schema: {
        tags: ['kb'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const doc = deps.kb.get(id);
      if (!doc) return reply.code(404).send({ error: 'kb_doc_not_found' });
      return doc;
    },
  );

  app.put(
    '/v1/kb/docs/:id',
    {
      schema: {
        tags: ['kb'],
        summary: 'Update a knowledge-base document (triggers resync)',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body_md: { type: 'string' },
            tags: { type: ['string', 'null'] },
            owner: { type: ['string', 'null'] },
            review_by: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        title?: string;
        body_md?: string;
        tags?: string | null;
        owner?: string | null;
        review_by?: string | null;
      };

      const doc = deps.kb.update(id, {
        title: body.title,
        bodyMd: body.body_md,
        tags: body.tags,
        owner: body.owner,
        reviewBy: body.review_by,
      });
      if (!doc) return reply.code(404).send({ error: 'kb_doc_not_found' });

      enqueueKbSync(deps.jobs);
      return doc;
    },
  );

  app.delete(
    '/v1/kb/docs/:id',
    {
      schema: {
        tags: ['kb'],
        summary: 'Delete a knowledge-base document locally and remotely',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const doc = deps.kb.remove(id);
      if (!doc) return reply.code(404).send({ error: 'kb_doc_not_found' });

      let remoteDeleted = false;
      try {
        await deps.kbSyncer.delete(doc);
        remoteDeleted = true;
      } catch (error) {
        deps.log.warn(
          { docId: id, error: String(error) },
          'remote knowledge-base delete failed',
        );
      }

      return { ok: true, remote_deleted: remoteDeleted };
    },
  );

  app.post(
    '/v1/kb/sync',
    {
      schema: {
        tags: ['kb'],
        summary: 'Force a sync to the ElevenLabs knowledge base',
      },
    },
    async () => ({ ok: true, result: await deps.kbSyncer.sync() }),
  );
}
