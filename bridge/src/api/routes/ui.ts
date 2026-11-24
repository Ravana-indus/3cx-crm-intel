import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'app.js': 'application/javascript; charset=utf-8',
};

let resolvedDir: string | null = null;

function uiDir(): string {
  if (resolvedDir) return resolvedDir;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'ui'),
    join(process.cwd(), 'src', 'ui'),
  ];

  for (const candidate of candidates) {
    try {
      readFileSync(join(candidate, 'index.html'));
      resolvedDir = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }

  throw new Error('UI assets not found (looked for src/ui/index.html)');
}

function asset(name: string): string {
  return readFileSync(join(uiDir(), name), 'utf8');
}

function sendAsset(reply: FastifyReply, name: string): FastifyReply {
  return reply
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-store')
    .type(CONTENT_TYPES[name] ?? 'application/octet-stream')
    .send(asset(name));
}

/**
 * Static dashboard assets. They contain no data and no secrets; the browser
 * supplies PORTAL_TOKEN and all data comes from the authenticated /v1 API.
 */
export function registerUiRoutes(app: FastifyInstance): void {
  app.get('/', async (_request, reply) => reply.redirect('/ui'));
  app.get('/ui', async (_request, reply) => sendAsset(reply, 'index.html'));
  app.get('/ui/', async (_request, reply) => sendAsset(reply, 'index.html'));
  app.get('/ui/app.css', async (_request, reply) =>
    sendAsset(reply, 'app.css'),
  );
  app.get('/ui/app.js', async (_request, reply) => sendAsset(reply, 'app.js'));
}
