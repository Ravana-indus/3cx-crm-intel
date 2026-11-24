import type { FastifyInstance } from 'fastify';

export function registerOpenApiRoute(
  app: FastifyInstance,
  getSpec: () => unknown,
): void {
  app.get('/v1/openapi.json', async () => getSpec());
}
