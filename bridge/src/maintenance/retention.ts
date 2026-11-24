import { unlink } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { RecordingsRepo } from '../repo/recordings.js';
import type { SettingsRepo } from '../repo/settings.js';
import type { Logger } from '../util/logger.js';
import { colomboDayKey } from '../util/time.js';

export interface RetentionResult {
  deleted: number;
}

/**
 * Audio retention. Runs once per Colombo day. Transcripts are left in place:
 * the portal owns lead retention policy.
 */
export class RetentionRunner {
  constructor(
    private readonly config: Config,
    private readonly recordings: RecordingsRepo,
    private readonly settings: SettingsRepo,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async maybeRun(now = this.clock()): Promise<RetentionResult | null> {
    const day = colomboDayKey(now);
    if (this.settings.get('last_retention_date') === day) return null;

    const cutoff = new Date(
      now.getTime() - this.config.retentionAudioDays * 86_400_000,
    ).toISOString();

    const rows = this.recordings.listExpired(cutoff);
    for (const row of rows) {
      await unlink(row.file_path).catch(() => undefined);
      this.recordings.deleteById(row.id);
    }

    this.settings.set('last_retention_date', day);
    if (rows.length > 0) {
      this.log.info(
        { deleted: rows.length, cutoff },
        'retention removed old recordings',
      );
    }
    return { deleted: rows.length };
  }
}
