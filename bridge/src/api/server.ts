import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from './deps.js';
import { portalAuth, workerAuth } from './auth.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerCallsRoutes } from './routes/calls.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerExportRoutes } from './routes/export.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerKbRoutes } from './routes/kb.js';
import { registerMissedRoutes } from './routes/missed.js';
import { registerOpenApiRoute } from './routes/openapi.js';
import { registerTeamRoutes } from './routes/team.js';
import { registerUiRoutes } from './routes/ui.js';

export async function registerApi(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  registerUiRoutes(app);

  await app.register(swagger, {
    openapi: {
      info: {
        title: '3CX Bridge',
        description:
          'Call log, recordings, transcripts and AI conversations for the migration portal.',
        version: '0.1.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'calls', description: 'Call log and recordings' },
        { name: 'decisions', description: 'Staged Laya decisions and review' },
        { name: 'team', description: 'Agent, team and presence metrics' },
        { name: 'ai', description: 'AI mode and conversations' },
        { name: 'kb', description: 'Knowledge base' },
        { name: 'health', description: 'Process and connector state' },
        { name: 'internal', description: 'Localhost worker endpoints' },
      ],
    },
  });

  await app.register(async (v1) => {
    v1.addHook('preHandler', portalAuth(deps.config));
    registerCallsRoutes(v1, deps);
    registerDecisionRoutes(v1, deps);
    registerExportRoutes(v1, deps);
    registerMissedRoutes(v1, deps);
    registerTeamRoutes(v1, deps);
    registerAiRoutes(v1, deps);
    registerKbRoutes(v1, deps);
    registerHealthRoutes(v1, deps);
    registerOpenApiRoute(v1, () => app.swagger());
  });

  await app.register(async (internal) => {
    internal.addHook('preHandler', workerAuth(deps.config));
    registerInternalRoutes(internal, deps);
  });
}
