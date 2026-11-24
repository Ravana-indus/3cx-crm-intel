import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

export interface OutboxRow {
  id: string;
  event: string;
  payload_json: string;
  attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

export class OutboxRepo {
  constructor(private readonly db: Db) {}

  enqueue(event: string, payload: unknown, now = new Date()): OutboxRow {
    const id = `evt_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO outbox (id, event, payload_json, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, event, JSON.stringify(payload), now.toISOString(), now.toISOString());

    return this.getById(id) as OutboxRow;
  }

  getById(id: string): OutboxRow | undefined {
    return this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as
      | OutboxRow
      | undefined;
  }

  claimDue(now = new Date(), limit = 20): OutboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE delivered_at IS NULL
           AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`,
      )
      .all(now.toISOString(), limit) as OutboxRow[];
  }

  markDelivered(id: string): void {
    this.db
      .prepare('UPDATE outbox SET delivered_at = ?, last_error = NULL WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  markRetry(id: string, attempts: number, nextAttemptAt: Date, error: string): void {
    this.db
      .prepare(
        'UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
      )
      .run(attempts, nextAttemptAt.toISOString(), error.slice(0, 1000), id);
  }

  markDead(id: string, attempts: number, error: string): void {
    this.db
      .prepare(
        `UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(attempts, new Date(8.64e15).toISOString(), error.slice(0, 1000), id);
  }

  pendingCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM outbox WHERE delivered_at IS NULL')
      .get() as { count: number };
    return row.count;
  }
}
