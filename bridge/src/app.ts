import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiDeps } from './api/deps.js';
import { registerApi } from './api/server.js';

export async function buildApp(deps: ApiDeps): Promise<FastifyInstance> {
  // pino's Logger carries more methods than Fastify's base logger type, which
  // makes Fastify's inferred instance generic narrower than the public type.
  const app = Fastify({
    loggerInstance: deps.log,
    trustProxy: true,
    bodyLimit: 1_048_576,
  }) as unknown as FastifyInstance;

  await registerApi(app, deps);
  return app;
}
