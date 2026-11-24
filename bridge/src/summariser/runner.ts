import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { CallsRepo } from '../repo/calls.js';
import type { JobRow, JobsRepo } from '../repo/jobs.js';
import type { OutboxRepo } from '../repo/outbox.js';
import type { SummariesRepo } from '../repo/summaries.js';
import type { TranscriptsRepo } from '../repo/transcripts.js';
import type { Logger } from '../util/logger.js';
import { buildCallTranscribedEvent } from '../webhooks/events.js';
import type { Summariser } from './types.js';

export interface SummariserRunnerDeps {
  config: Config;
  db: Db;
  jobs: JobsRepo;
  calls: CallsRepo;
  transcripts: TranscriptsRepo;
  summaries: SummariesRepo;
  outbox: OutboxRepo;
  summariser: Summariser;
  log: Logger;
}

export interface SummariserRunStats {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

function emptyStats(): SummariserRunStats {
  return { claimed: 0, completed: 0, retried: 0, failed: 0 };
}

/**
 * Runs inside the bridge: it claims summarise jobs, asks the configured LLM for
 * schema-validated JSON, stores it, and only then emits call.transcribed.
 */
export class SummariserRunner {
  constructor(private readonly deps: SummariserRunnerDeps) {}

  /** Highest-value helper for tests and the scheduler. */
  async runOnce(now = new Date()): Promise<SummariserRunStats> {
    const stats = emptyStats();
    let job: JobRow | null;

    while ((job = this.deps.jobs.claimNext('summarise', now)) !== null) {
      stats.claimed += 1;
      await this.process(job, now, stats);
    }

    return stats;
  }

  private domainTerms(): string[] {
    const rows = this.deps.db
      .prepare(
        'SELECT title, tags FROM kb_docs ORDER BY updated_at DESC LIMIT 25',
      )
      .all() as Array<{ title: string | null; tags: string | null }>;

    const terms = new Set<string>();
    for (const row of rows) {
      if (row.title) terms.add(row.title);
      if (row.tags) {
        for (const tag of row.tags.split(',')) {
          const trimmed = tag.trim();
          if (trimmed) terms.add(trimmed);
        }
      }
    }
    return [...terms];
  }

  private async process(
    job: JobRow,
    now: Date,
    stats: SummariserRunStats,
  ): Promise<void> {
    const { calls, transcripts, summaries, outbox, jobs, summariser, log } =
      this.deps;

    if (!job.ref_id) {
      jobs.markFailed(job.id, 'summarise job has no call reference');
      stats.failed += 1;
      return;
    }

    const call = calls.getById(job.ref_id);
    const transcript = transcripts.getByCallId(job.ref_id);

    if (!call || !transcript || !transcript.text) {
      this.scheduleRetry(job, 'transcript or call not ready', now, stats);
      return;
    }

    const input = {
      transcript: transcript.text,
      language: transcript.language,
      call,
      hints: this.domainTerms(),
    };

    let lastError = 'unknown summariser error';

    // One validation-level retry before falling back to the job-level backoff.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await summariser.summarise(input);

        summaries.upsert({
          callId: call.id,
          model: summariser.model,
          summary: result.summary,
          extracted: result.extracted,
        });
        jobs.markDone(job.id);
        outbox.enqueue(
          'call.transcribed',
          buildCallTranscribedEvent(call, transcript, result),
          now,
        );

        stats.completed += 1;
        log.info(
          { jobId: job.id, callId: call.id, model: summariser.model },
          'call summarised',
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log.warn(
          { jobId: job.id, attempt: attempt + 1, error: lastError },
          'summary attempt failed',
        );
      }
    }

    this.scheduleRetry(job, lastError, now, stats);
  }

  private scheduleRetry(
    job: JobRow,
    message: string,
    now: Date,
    stats: SummariserRunStats,
  ): void {
    if (job.attempts >= 3) {
      this.deps.jobs.markFailed(job.id, message);
      stats.failed += 1;
      this.deps.log.error(
        { jobId: job.id, attempts: job.attempts, error: message },
        'summarise job failed permanently',
      );
      return;
    }

    const nextRunAt = new Date(now.getTime() + 60_000 * job.attempts);
    this.deps.jobs.retry(job.id, message, nextRunAt);
    stats.retried += 1;
  }
}
