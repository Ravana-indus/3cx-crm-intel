import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import type { CallsRepo } from '../repo/calls.js';
import type { CheckpointsRepo } from '../repo/checkpoints.js';
import type { JobsRepo } from '../repo/jobs.js';
import type { RecordingRow, RecordingsRepo } from '../repo/recordings.js';
import type { ThreeCXConnector, TcxRecording } from '../threecx/types.js';
import type { Logger } from '../util/logger.js';

export interface RecordingsPollerDeps {
  config: Config;
  connector: ThreeCXConnector;
  calls: CallsRepo;
  recordings: RecordingsRepo;
  checkpoints: CheckpointsRepo;
  jobs: JobsRepo;
  log: Logger;
}

export interface RecordingsPollResult {
  fetched: number;
  downloaded: number;
  linked: number;
  jobsCreated: number;
  failed: number;
}

interface ProbeResult {
  durationSec: number | null;
  channels: number | null;
}

function sanitise(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function probeAudio(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 15_000 },
      (error, stdout) => {
        if (error) {
          resolve({ durationSec: null, channels: null });
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as {
            format?: { duration?: string };
            streams?: Array<{ codec_type?: string; channels?: number }>;
          };
          const duration = parsed.format?.duration
            ? Number(parsed.format.duration)
            : null;
          const audio = parsed.streams?.find(
            (stream) => stream.codec_type === 'audio',
          );
          resolve({
            durationSec: duration !== null && Number.isFinite(duration) ? duration : null,
            channels: audio?.channels ?? null,
          });
        } catch {
          resolve({ durationSec: null, channels: null });
        }
      },
    );
  });
}

export class RecordingsPoller {
  constructor(private readonly deps: RecordingsPollerDeps) {}

  async poll(now = new Date()): Promise<RecordingsPollResult> {
    const { config, connector, recordings, checkpoints, log } = this.deps;

    const checkpoint = checkpoints.getDate('recordings');
    const since = checkpoint
      ? new Date(checkpoint.getTime() - config.overlapMs)
      : new Date(now.getTime() - config.initialLookbackMs);

    const remote = await connector.listRecordings(since);
    const result: RecordingsPollResult = {
      fetched: remote.length,
      downloaded: 0,
      linked: 0,
      jobsCreated: 0,
      failed: 0,
    };

    for (const entry of remote) {
      const existing = recordings.getByTcxId(entry.tcxRecId);
      if (existing) {
        if (!existing.call_id && this.link(existing.id, entry)) {
          result.linked += 1;
        }
        continue;
      }

      try {
        const stored = await this.store(entry);
        result.downloaded += 1;
        if (stored.linked) result.linked += 1;
        if (stored.jobCreated) result.jobsCreated += 1;
      } catch (error) {
        result.failed += 1;
        log.error(
          {
            recordingId: entry.tcxRecId,
            error: error instanceof Error ? error.message : String(error),
          },
          'failed to store recording',
        );
      }
    }

    checkpoints.advanceIfLater('recordings', now.toISOString());
    log.info(result, 'recordings polled');
    return result;
  }

  private resolveCall(entry: TcxRecording) {
    const { calls } = this.deps;
    return entry.callTcxId
      ? calls.getByTcxId(entry.callTcxId)
      : calls.findByExtAndTime(entry.ext, entry.startedAt, 5);
  }

  private link(recordingId: string, entry: TcxRecording): boolean {
    const call = this.resolveCall(entry);
    if (!call) return false;
    this.deps.recordings.linkToCall(recordingId, call.id);
    return true;
  }

  private async store(
    entry: TcxRecording,
  ): Promise<{ row: RecordingRow; linked: boolean; jobCreated: boolean }> {
    const { config, connector, recordings, jobs, log } = this.deps;

    const tmpDir = join(config.recordingsDir, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `${sanitise(entry.tcxRecId)}-${randomUUID()}.part`);

    const hash = createHash('sha256');
    let bytes = 0;

    const source = await connector.downloadRecording(entry.tcxRecId);
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        bytes += buffer.length;
        callback(null, buffer);
      },
    });

    try {
      await pipeline(source, meter, createWriteStream(tmpPath));
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }

    const probe = await probeAudio(tmpPath);
    const date = new Date(entry.startedAt);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const finalDir = join(config.recordingsDir, year, month);
    await mkdir(finalDir, { recursive: true });
    const finalPath = join(finalDir, `${sanitise(entry.tcxRecId)}.wav`);

    await rename(tmpPath, finalPath);

    const call = this.resolveCall(entry);

    const inserted = recordings.insertIfAbsent({
      tcxRecId: entry.tcxRecId,
      callId: call?.id ?? null,
      filePath: finalPath,
      sha256: hash.digest('hex'),
      bytes,
      durationSec: probe.durationSec ?? entry.durationSec,
      channels: probe.channels ?? entry.channels,
      expiresAt: new Date(
        Date.now() + config.retentionAudioDays * 86_400_000,
      ).toISOString(),
    });

    const job = jobs.createIfAbsent({
      type: 'transcribe',
      refId: inserted.row.id,
    });

    log.debug(
      {
        recordingId: entry.tcxRecId,
        bytes,
        durationSec: probe.durationSec,
        channels: probe.channels,
        callId: call?.id ?? null,
      },
      'recording stored',
    );

    return {
      row: inserted.row,
      linked: Boolean(call),
      jobCreated: job !== null,
    };
  }
}
