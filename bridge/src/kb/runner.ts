import type { Config } from '../config.js';
import type { JobRow, JobsRepo } from '../repo/jobs.js';
import type { Logger } from '../util/logger.js';
import type { KbSyncResult, KbSyncer } from './sync.js';

export interface KbRunStats {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

export function enqueueKbSync(jobs: JobsRepo): void {
  jobs.createIfAbsent({ type: 'kb_sync', refId: null });
}

export class KbSyncRunner {
  constructor(
    private readonly config: Config,
    private readonly jobs: JobsRepo,
    private readonly syncer: KbSyncer,
    private readonly log: Logger,
  ) {}

  async runOnce(now = new Date()): Promise<KbRunStats> {
    const stats: KbRunStats = {
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
    };

    let job: JobRow | null;
    while ((job = this.jobs.claimNext('kb_sync', now)) !== null) {
      stats.claimed += 1;
      try {
        const result: KbSyncResult = await this.syncer.sync(now);
        this.jobs.markDone(job.id);
        stats.completed += 1;
        this.log.debug(result, 'kb_sync job completed');
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
          stats.retried += 1;
        }
        this.log.warn({ jobId: job.id, error: message }, 'kb_sync job failed');
      }
    }

    return stats;
  }
}
