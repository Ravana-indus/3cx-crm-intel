import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { makeSilentWav } from '../src/threecx/mock.js';
import { callInput, testContext } from './helpers.js';

const AUTH = { authorization: 'Bearer test-portal' };

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('REST API', () => {
  it('requires the portal bearer token on /v1', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);

    try {
      const response = await app.inject({ method: 'GET', url: '/v1/calls' });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });

  it('pages the call log newest first', async () => {
    const ctx = testContext();
    ctx.calls.upsert(callInput({ tcxCallId: 'a', startedAt: minutesAgo(30) }));
    ctx.calls.upsert(callInput({ tcxCallId: 'b', startedAt: minutesAgo(20) }));
    ctx.calls.upsert(callInput({ tcxCallId: 'c', startedAt: minutesAgo(10) }));

    const app = await buildApp(ctx);
    try {
      const first = await app.inject({
        method: 'GET',
        url: '/v1/calls?limit=2',
        headers: AUTH,
      });
      expect(first.statusCode).toBe(200);

      const firstBody = first.json() as {
        items: Array<{ tcx_call_id: string }>;
        next_cursor: string | null;
      };
      expect(firstBody.items.map((item) => item.tcx_call_id)).toEqual(['c', 'b']);
      expect(firstBody.next_cursor).toBeTruthy();

      const second = await app.inject({
        method: 'GET',
        url: `/v1/calls?limit=2&cursor=${encodeURIComponent(
          firstBody.next_cursor as string,
        )}`,
        headers: AUTH,
      });
      const secondBody = second.json() as {
        items: Array<{ tcx_call_id: string }>;
      };
      expect(secondBody.items.map((item) => item.tcx_call_id)).toEqual(['a']);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });

  it('serves a recording through a short-lived signed link', async () => {
    const dir = mkdtempSync(join(tmpdir(), '3cx-api-'));
    const filePath = join(dir, 'rec.wav');
    writeFileSync(filePath, makeSilentWav(1, 1));

    const ctx = testContext();
    const call = ctx.calls.upsert(
      callInput({ tcxCallId: 'rec-call', startedAt: minutesAgo(5) }),
    ).row;
    ctx.recordings.insertIfAbsent({
      tcxRecId: 'rec-x',
      callId: call.id,
      filePath,
      sha256: 'abc',
      bytes: 100,
      durationSec: 1,
      channels: 1,
    });

    const app = await buildApp(ctx);
    try {
      const detail = await app.inject({
        method: 'GET',
        url: `/v1/calls/${call.id}`,
        headers: AUTH,
      });
      expect(detail.statusCode).toBe(200);

      const recordingUrl = (detail.json() as { recording_url: string })
        .recording_url;
      expect(recordingUrl).toContain('/recording?');

      const recording = await app.inject({ method: 'GET', url: recordingUrl });
      expect(recording.statusCode).toBe(200);
      expect(String(recording.headers['content-type'])).toContain('audio/wav');

      const tampered = await app.inject({
        method: 'GET',
        url: recordingUrl.replace(/sig=[^&]+/, 'sig=not-a-signature'),
      });
      expect(tampered.statusCode).toBe(403);

      const transcript = await app.inject({
        method: 'GET',
        url: `/v1/calls/${call.id}/transcript`,
        headers: AUTH,
      });
      expect(transcript.statusCode).toBe(404);

      ctx.transcripts.upsert({
        callId: call.id,
        engine: 'mock',
        model: 'mock-v1',
        language: 'ta',
        text: 'hello',
        segments: [],
      });
      const list = await app.inject({
        method: 'GET',
        url: '/v1/calls',
        headers: AUTH,
      });
      const item = (
        list.json() as { items: Array<{ id: string; has_transcript: boolean }> }
      ).items.find((entry) => entry.id === call.id);
      expect(item?.has_transcript).toBe(true);
    } finally {
      await app.close();
      ctx.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports health and publishes OpenAPI', async () => {
    const ctx = testContext();
    const app = await buildApp(ctx);

    try {
      const health = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: AUTH,
      });
      expect(health.statusCode).toBe(200);
      const healthBody = health.json() as {
        status: string;
        jobs: { pending: number };
      };
      expect(healthBody.status).toBe('ok');
      expect(healthBody.jobs.pending).toBe(0);

      const spec = await app.inject({
        method: 'GET',
        url: '/v1/openapi.json',
        headers: AUTH,
      });
      expect(spec.statusCode).toBe(200);
      const specBody = spec.json() as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      expect(specBody.openapi.startsWith('3.')).toBe(true);
      expect(specBody.paths['/v1/calls']).toBeTruthy();
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
