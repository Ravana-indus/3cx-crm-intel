import { execFile } from 'node:child_process';
import { stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { JobRow, JobsRepo } from '../repo/jobs.js';
import type { RecordingsRepo } from '../repo/recordings.js';
import type { Logger } from '../util/logger.js';

const execFileAsync = promisify(execFile);

export interface CompressRunStats {
  claimed: number;
  compressed: number;
  skipped: number;
  failed: number;
}

/**
 * After a transcript lands, convert the WAV to Opus (32 kbps by default) and
 * point the recording row at the smaller file.
 */
export class CompressRunner {
  constructor(
    private readonly config: Config,
    private readonly jobs: JobsRepo,
    private readonly recordings: RecordingsRepo,
    private readonly log: Logger,
    private readonly ffmpeg = process.env.FFMPEG ?? 'ffmpeg',
  ) {}

  async runOnce(now = new Date()): Promise<CompressRunStats> {
    const stats: CompressRunStats = {
      claimed: 0,
      compressed: 0,
      skipped: 0,
      failed: 0,
    };

    let job: JobRow | null;
    while ((job = this.jobs.claimNext('compress', now)) !== null) {
      stats.claimed += 1;

      const recording = job.ref_id
        ? this.recordings.getById(job.ref_id)
        : undefined;

      if (!recording) {
        this.jobs.markFailed(job.id, 'recording not found');
        stats.failed += 1;
        continue;
      }

      if (recording.file_path.toLowerCase().endsWith('.opus')) {
        this.jobs.markDone(job.id);
        stats.skipped += 1;
        continue;
      }

      if (!this.config.compressAudio) {
        this.jobs.markDone(job.id);
        stats.skipped += 1;
        continue;
      }

      try {
        const target = recording.file_path.replace(/\.[^.]+$/, '') + '.opus';
        await execFileAsync(this.ffmpeg, [
          '-y',
          '-loglevel',
          'error',
          '-i',
          recording.file_path,
          '-c:a',
          'libopus',
          '-b:a',
          this.config.compressBitrate,
          target,
        ]);

        const info = await stat(target);
        if (info.size <= 0) throw new Error('compressed file is empty');

        this.recordings.updateFilePath(recording.id, target);
        if (target !== recording.file_path) {
          await unlink(recording.file_path).catch(() => undefined);
        }

        this.jobs.markDone(job.id);
        stats.compressed += 1;
        this.log.info(
          {
            recordingId: recording.id,
            originalBytes: recording.bytes,
            compressedBytes: info.size,
          },
          'recording compressed to opus',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.attempts >= 3) {
          this.jobs.markFailed(job.id, message);
          stats.failed += 1;
        } else {
          this.jobs.retry(
            job.id,
            message,
            new Date(now.getTime() + 60_000 * job.attempts),
          );
        }
        this.log.warn({ jobId: job.id, error: message }, 'compression failed');
      }
    }

    return stats;
  }
}
