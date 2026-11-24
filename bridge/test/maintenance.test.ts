import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupRunner } from '../src/maintenance/backup.js';
import { CompressRunner } from '../src/maintenance/compress.js';
import { Alerter, Heartbeat, type FetchLike } from '../src/maintenance/ops.js';
import { restoreBackup } from '../src/maintenance/restore.js';
import { RetentionRunner } from '../src/maintenance/retention.js';
import { makeSilentWav } from '../src/threecx/mock.js';
import { callInput, testContext } from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), '3cx-ops-'));
  tempDirs.push(dir);
  return dir;
}

describe('backup and restore', () => {
  it('backs up once per day and restores with a passing integrity check', async () => {
    const root = workDir();
    const backupDir = join(root, 'backups');
    const recordingsDir = join(root, 'recordings');
    mkdirSync(recordingsDir, { recursive: true });
    const audioPath = join(recordingsDir, 'a.wav');
    writeFileSync(audioPath, makeSilentWav(1, 1));

    const ctx = testContext({
      backupDir,
      recordingsDir,
      backupHour: 0,
      backupRetentionDays: 30,
    });

    try {
      ctx.calls.upsert(callInput({ tcxCallId: 'b1' }));
      ctx.recordings.insertIfAbsent({
        tcxRecId: 'r1',
        callId: null,
        filePath: audioPath,
        sha256: 'x',
        bytes: 10,
        durationSec: 1,
        channels: 1,
      });

      const backup = new BackupRunner(
        ctx.config,
        ctx.db,
        ctx.settings,
        ctx.log,
      );
      const now = new Date('2026-11-23T04:00:00.000Z');

      const result = await backup.maybeRun(now);
      expect(result).toBeTruthy();
      expect(existsSync(join(result?.dir as string, 'bridge.db'))).toBe(true);
      expect(existsSync(join(result?.dir as string, 'manifest.json'))).toBe(true);
      expect(result?.manifest.calls).toBe(1);
      expect(result?.manifest.recordingsCount).toBe(1);
      expect(await backup.maybeRun(now)).toBeNull();

      const restored = await restoreBackup(
        result?.dir as string,
        join(root, 'restored'),
      );
      expect(restored.integrity).toBe('ok');
      expect(restored.calls).toBe(1);
      expect(restored.recordings).toBe(1);
      expect(existsSync(join(root, 'restored', 'recordings', 'a.wav'))).toBe(true);
    } finally {
      ctx.db.close();
    }
  });
});

describe('retention', () => {
  it('removes recordings older than the audio retention window', async () => {
    const dir = workDir();
    const audioPath = join(dir, 'old.wav');
    writeFileSync(audioPath, makeSilentWav(1, 1));

    const ctx = testContext({ recordingsDir: dir, retentionAudioDays: 30 });

    try {
      const row = ctx.recordings.insertIfAbsent({
        tcxRecId: 'old-rec',
        callId: null,
        filePath: audioPath,
        sha256: 'x',
        bytes: 10,
        durationSec: 1,
        channels: 1,
      }).row;
      ctx.db
        .prepare('UPDATE recordings SET downloaded_at = ? WHERE id = ?')
        .run('2020-01-01T00:00:00.000Z', row.id);

      const retention = new RetentionRunner(
        ctx.config,
        ctx.recordings,
        ctx.settings,
        ctx.log,
      );
      const now = new Date('2026-11-23T00:00:00.000Z');

      expect((await retention.maybeRun(now))?.deleted).toBe(1);
      expect(ctx.recordings.getById(row.id)).toBeUndefined();
      expect(existsSync(audioPath)).toBe(false);
      expect(await retention.maybeRun(now)).toBeNull();
    } finally {
      ctx.db.close();
    }
  });
});

describe('audio compression', () => {
  it('skips a recording that is already Opus', async () => {
    const dir = workDir();
    const opusPath = join(dir, 'already.opus');
    writeFileSync(opusPath, 'fake opus');

    const ctx = testContext({ recordingsDir: dir, compressAudio: true });

    try {
      const row = ctx.recordings.insertIfAbsent({
        tcxRecId: 'rec-opus',
        callId: null,
        filePath: opusPath,
        sha256: 'x',
        bytes: 9,
        durationSec: 1,
        channels: 1,
      }).row;
      ctx.jobs.createIfAbsent({ type: 'compress', refId: row.id });

      const runner = new CompressRunner(
        ctx.config,
        ctx.jobs,
        ctx.recordings,
        ctx.log,
      );
      const stats = await runner.runOnce(new Date(Date.now() + 1_000));

      expect(stats.skipped).toBe(1);
      expect(stats.compressed).toBe(0);
      expect(existsSync(opusPath)).toBe(true);
      expect(ctx.recordings.getById(row.id)?.file_path).toBe(opusPath);
    } finally {
      ctx.db.close();
    }
  });

  it('converts a recording to Opus and updates the row', async () => {
    const dir = workDir();
    const audioPath = join(dir, 'rec.wav');
    writeFileSync(audioPath, makeSilentWav(1, 1));

    const ctx = testContext({ recordingsDir: dir, compressAudio: true });

    try {
      const row = ctx.recordings.insertIfAbsent({
        tcxRecId: 'rec-compress',
        callId: null,
        filePath: audioPath,
        sha256: 'x',
        bytes: 10,
        durationSec: 1,
        channels: 1,
      }).row;
      ctx.jobs.createIfAbsent({ type: 'compress', refId: row.id });

      const runner = new CompressRunner(
        ctx.config,
        ctx.jobs,
        ctx.recordings,
        ctx.log,
      );
      const stats = await runner.runOnce(new Date(Date.now() + 1_000));

      expect(stats.compressed).toBe(1);
      const updated = ctx.recordings.getById(row.id);
      expect(updated?.file_path.endsWith('.opus')).toBe(true);
      expect(existsSync(updated?.file_path as string)).toBe(true);
      expect(existsSync(audioPath)).toBe(false);
    } finally {
      ctx.db.close();
    }
  });
});

describe('heartbeat and alerts', () => {
  it('records a heartbeat and alerts when the monitor rejects it', async () => {
    const ctx = testContext({
      heartbeatUrl: 'http://monitor.test/ping',
      alertWebhookUrl: 'http://alert.test/hook',
    });

    try {
      const heartbeats: string[] = [];
      const alerts: string[] = [];

      const alert = new Alerter(ctx.config, ctx.log, async (input) => {
        alerts.push(String(input));
        return new Response('{}', { status: 200 });
      });

      const okFetch: FetchLike = async (input) => {
        heartbeats.push(String(input));
        return new Response('{}', { status: 200 });
      };

      const heartbeat = new Heartbeat(
        ctx.config,
        ctx.settings,
        ctx.log,
        () => ({ status: 'ok', connector: 'ok' }),
        alert,
        okFetch,
      );

      const at = new Date('2026-11-23T00:00:00.000Z');
      expect(await heartbeat.sendOnce(at)).toBe(true);
      expect(ctx.settings.get('last_heartbeat')).toBe(at.toISOString());
      expect(heartbeats[0]).toContain('monitor.test');

      const failingFetch: FetchLike = async () =>
        new Response('down', { status: 503 });
      const failing = new Heartbeat(
        ctx.config,
        ctx.settings,
        ctx.log,
        () => ({ status: 'ok' }),
        alert,
        failingFetch,
      );

      expect(await failing.sendOnce(at)).toBe(false);
      expect(alerts[0]).toContain('alert.test');
    } finally {
      ctx.db.close();
    }
  });
});
