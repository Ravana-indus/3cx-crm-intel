import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobRow {
  id: string;
  type: string;
  ref_id: string | null;
  status: JobStatus;
  attempts: number;
  claimed_at: string | null;
  error: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export interface CreateJobInput {
  type: string;
  refId: string | null;
  nextRunAt?: Date;
}

export interface JobCounts {
  pending: number;
  running: number;
  failed: number;
  done: number;
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  createIfAbsent(input: CreateJobInput): JobRow | null {
    const existing = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE type = ? AND ref_id IS ? AND status IN ('pending', 'running')
         LIMIT 1`,
      )
      .get(input.type, input.refId) as JobRow | undefined;
    if (existing) return null;

    const now = new Date().toISOString();
    const id = `job_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, ref_id, status, attempts, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.type,
        input.refId,
        (input.nextRunAt ?? new Date()).toISOString(),
        now,
        now,
      );

    return this.getById(id) ?? null;
  }

  getById(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      | JobRow
      | undefined;
  }

  claimNext(type: string, now = new Date()): JobRow | null {
    const claim = this.db.transaction((): JobRow | null => {
      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE type = ? AND status = 'pending' AND next_run_at <= ?
           ORDER BY next_run_at ASC
           LIMIT 1`,
        )
        .get(type, now.toISOString()) as JobRow | undefined;

      if (!row) return null;

      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running', claimed_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(now.toISOString(), now.toISOString(), row.id);

      return this.getById(row.id) ?? null;
    });

    return claim();
  }

  markDone(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
  }

  retry(id: string, error: string, nextRunAt: Date): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', error = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(error.slice(0, 1000), nextRunAt.toISOString(), new Date().toISOString(), id);
  }

  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error.slice(0, 1000), new Date().toISOString(), id);
  }

  counts(): JobCounts {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status')
      .all() as Array<{ status: JobStatus; count: number }>;

    const counts: JobCounts = { pending: 0, running: 0, failed: 0, done: 0 };
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  /**
   * A killed worker leaves a job in 'running' forever. Reset claims older than
   * the threshold so the next claim retries it.
   */
  requeueStale(type: string, olderThan: Date, now = new Date()): number {
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending', claimed_at = NULL, updated_at = ?
         WHERE type = ? AND status = 'running' AND claimed_at < ?`,
      )
      .run(now.toISOString(), type, olderThan.toISOString());
    return result.changes;
  }

  recentFailed(limit = 20): JobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'failed'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as JobRow[];
  }
}
