import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

export interface RecordingRow {
  id: string;
  call_id: string | null;
  tcx_rec_id: string;
  file_path: string;
  sha256: string | null;
  bytes: number | null;
  duration_sec: number | null;
  channels: number | null;
  downloaded_at: string;
  expires_at: string | null;
}

export interface InsertRecordingInput {
  tcxRecId: string;
  callId: string | null;
  filePath: string;
  sha256: string;
  bytes: number;
  durationSec: number | null;
  channels: number | null;
  expiresAt?: string | null;
}

export class RecordingsRepo {
  constructor(private readonly db: Db) {}

  getByTcxId(tcxRecId: string): RecordingRow | undefined {
    return this.db
      .prepare('SELECT * FROM recordings WHERE tcx_rec_id = ?')
      .get(tcxRecId) as RecordingRow | undefined;
  }

  getById(id: string): RecordingRow | undefined {
    return this.db
      .prepare('SELECT * FROM recordings WHERE id = ?')
      .get(id) as RecordingRow | undefined;
  }

  getByCallId(callId: string): RecordingRow | undefined {
    return this.db
      .prepare('SELECT * FROM recordings WHERE call_id = ? ORDER BY downloaded_at DESC LIMIT 1')
      .get(callId) as RecordingRow | undefined;
  }

  insertIfAbsent(input: InsertRecordingInput): {
    row: RecordingRow;
    created: boolean;
  } {
    const existing = this.getByTcxId(input.tcxRecId);
    if (existing) return { row: existing, created: false };

    const id = `rec_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO recordings (
          id, call_id, tcx_rec_id, file_path, sha256, bytes,
          duration_sec, channels, downloaded_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.callId,
        input.tcxRecId,
        input.filePath,
        input.sha256,
        input.bytes,
        input.durationSec,
        input.channels,
        new Date().toISOString(),
        input.expiresAt ?? null,
      );

    return { row: this.getById(id) as RecordingRow, created: true };
  }

  linkToCall(id: string, callId: string | null): void {
    this.db.prepare('UPDATE recordings SET call_id = ? WHERE id = ?').run(callId, id);
  }

  updateFilePath(id: string, filePath: string): void {
    this.db
      .prepare('UPDATE recordings SET file_path = ? WHERE id = ?')
      .run(filePath, id);
  }

  listOlderThan(cutoffIso: string): RecordingRow[] {
    return this.db
      .prepare('SELECT * FROM recordings WHERE downloaded_at < ?')
      .all(cutoffIso) as RecordingRow[];
  }

  /** New rows carry expires_at; old rows fall back to downloaded_at. */
  listExpired(nowIso: string): RecordingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM recordings
         WHERE COALESCE(expires_at, downloaded_at) < ?`,
      )
      .all(nowIso) as RecordingRow[];
  }

  /** Give pre-migration rows a per-row retention date from their download time. */
  backfillExpiry(retentionDays: number): number {
    const rows = this.db
      .prepare(
        'SELECT id, downloaded_at FROM recordings WHERE expires_at IS NULL',
      )
      .all() as Array<{ id: string; downloaded_at: string }>;
    if (rows.length === 0) return 0;

    const update = this.db.prepare(
      'UPDATE recordings SET expires_at = ? WHERE id = ?',
    );
    const write = this.db.transaction(
      (items: Array<{ id: string; downloaded_at: string }>) => {
        for (const row of items) {
          const downloaded = Date.parse(row.downloaded_at);
          if (!Number.isFinite(downloaded)) continue;
          update.run(
            new Date(downloaded + retentionDays * 86_400_000).toISOString(),
            row.id,
          );
        }
      },
    );
    write(rows);
    return rows.length;
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  }

  unlinked(): RecordingRow[] {
    return this.db
      .prepare('SELECT * FROM recordings WHERE call_id IS NULL ORDER BY downloaded_at ASC')
      .all() as RecordingRow[];
  }
}
