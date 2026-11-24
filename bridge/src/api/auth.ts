import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

function constantEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  return scheme.toLowerCase() === 'bearer' ? token : null;
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

/**
 * /v1 is portal-only. A short-lived signed recording link is the one exception:
 * the recording route validates its own signature.
 */
export function portalAuth(config: Config) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = request.url.split('?')[0] ?? '';
    const isRecordingRoute = /^\/v1\/calls\/[^/]+\/recording$/.test(path);
    const query = request.query as { sig?: string } | undefined;

    if (isRecordingRoute && query?.sig) return;

    const token = bearerToken(request);
    if (!token || !constantEqual(token, config.portalToken)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

export function workerAuth(config: Config) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isLoopback(request.socket.remoteAddress ?? undefined)) {
      reply.code(403).send({ error: 'internal_endpoint_localhost_only' });
      return;
    }

    const token = bearerToken(request);
    if (!token || !constantEqual(token, config.workerToken)) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
