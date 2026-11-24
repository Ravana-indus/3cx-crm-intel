import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CallLogPoller } from '../src/poller/callLog.js';
import { RecordingsPoller } from '../src/poller/recordings.js';
import { testContext } from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe('CallLogPoller', () => {
  it('ingests the call log idempotently and emits call webhooks', async () => {
    const ctx = testContext({ overlapMs: 30 * 86_400_000 });

    try {
      const poller = new CallLogPoller({
        config: ctx.config,
        connector: ctx.connector,
        calls: ctx.calls,
        checkpoints: ctx.checkpoints,
        outbox: ctx.outbox,
        log: ctx.log,
      });

      const now = new Date('2026-11-23T00:00:00.000Z');
      const first = await poller.poll(now);

      expect(first.fetched).toBe(5);
      expect(first.created).toBe(5);
      expect(first.webhooks).toBe(5);

      expect(ctx.calls.getByTcxId('seg-1001')?.outcome).toBe('answered');
      expect(ctx.calls.getByTcxId('seg-1002')?.outcome).toBe('missed');
      expect(ctx.calls.getByTcxId('seg-1003')?.outcome).toBe('abandoned');
      expect(ctx.calls.getByTcxId('seg-1990')?.outcome).toBe('ai_handled');
      expect(ctx.calls.getByTcxId('seg-1005')?.outcome).toBe('outbound');

      expect(ctx.calls.getByTcxId('seg-1001')?.from_e164).toBe('+94771234567');
      expect(ctx.calls.getByTcxId('seg-1005')?.to_e164).toBe('+94771234567');

      const second = await poller.poll(new Date(now.getTime() + 60_000));
      expect(second.fetched).toBe(5);
      expect(second.created).toBe(0);
      expect(second.webhooks).toBe(0);
      expect(ctx.calls.list({}, 10).items).toHaveLength(5);
      expect(ctx.outbox.pendingCount()).toBe(5);
    } finally {
      ctx.db.close();
    }
  });

  it('advances the checkpoint after a successful poll', async () => {
    const ctx = testContext();

    try {
      const poller = new CallLogPoller({
        config: ctx.config,
        connector: ctx.connector,
        calls: ctx.calls,
        checkpoints: ctx.checkpoints,
        outbox: ctx.outbox,
        log: ctx.log,
      });

      const now = new Date('2026-11-23T00:00:00.000Z');
      await poller.poll(now);
      expect(ctx.checkpoints.getDate('calllog')?.toISOString()).toBe(
        now.toISOString(),
      );
    } finally {
      ctx.db.close();
    }
  });
});

describe('RecordingsPoller', () => {
  it('downloads once, links to calls and queues transcription', async () => {
    const dir = mkdtempSync(join(tmpdir(), '3cx-rec-'));
    tempDirs.push(dir);
    const ctx = testContext({ overlapMs: 30 * 86_400_000, recordingsDir: dir });

    try {
      const now = new Date('2026-11-23T00:00:00.000Z');

      const callPoller = new CallLogPoller({
        config: ctx.config,
        connector: ctx.connector,
        calls: ctx.calls,
        checkpoints: ctx.checkpoints,
        outbox: ctx.outbox,
        log: ctx.log,
      });
      await callPoller.poll(now);

      const poller = new RecordingsPoller({
        config: ctx.config,
        connector: ctx.connector,
        calls: ctx.calls,
        recordings: ctx.recordings,
        checkpoints: ctx.checkpoints,
        jobs: ctx.jobs,
        log: ctx.log,
      });

      const first = await poller.poll(now);
      expect(first.fetched).toBe(2);
      expect(first.downloaded).toBe(2);
      expect(first.linked).toBe(2);
      expect(first.jobsCreated).toBe(2);

      const recording = ctx.recordings.getByTcxId('rec-2001');
      expect(recording?.call_id).toBe(ctx.calls.getByTcxId('seg-1001')?.id);
      expect(recording?.bytes).toBeGreaterThan(44);
      expect(recording?.channels).toBe(2);
      expect(recording !== undefined && existsSync(recording.file_path)).toBe(true);
      expect(ctx.jobs.counts().pending).toBe(2);

      const second = await poller.poll(new Date(now.getTime() + 60_000));
      expect(second.downloaded).toBe(0);
      expect(second.jobsCreated).toBe(0);
      expect(ctx.jobs.counts().pending).toBe(2);
    } finally {
      ctx.db.close();
    }
  });
});
