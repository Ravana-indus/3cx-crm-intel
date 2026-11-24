import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testContext } from './helpers.js';

describe('dashboard UI', () => {
  it('serves the static dashboard without API auth', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);

    try {
      const page = await app.inject({ method: 'GET', url: '/ui' });
      expect(page.statusCode).toBe(200);
      expect(String(page.headers['content-type'])).toContain('text/html');
      expect(page.body).toContain('3CX Bridge');
      expect(page.body).toContain('Decisions');
      expect(page.body).toContain('/ui/app.js');

      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(302);
      expect(root.headers.location).toBe('/ui');

      const css = await app.inject({ method: 'GET', url: '/ui/app.css' });
      expect(css.statusCode).toBe(200);
      expect(String(css.headers['content-type'])).toContain('text/css');

      const js = await app.inject({ method: 'GET', url: '/ui/app.js' });
      expect(js.statusCode).toBe(200);
      expect(js.body).toContain('/v1/calls');
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
