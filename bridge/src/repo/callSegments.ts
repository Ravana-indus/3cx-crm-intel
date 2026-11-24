import type { Db } from '../db/index.js';
import type { TcxCallSegment } from '../threecx/types.js';

export interface CallSegmentRow {
  call_id: string;
  tcx_segment_id: string;
  started_at: string | null;
  ended_at: string | null;
  ext: string | null;
  action_dn: string | null;
  status: string | null;
  raw_json: string | null;
}

export class CallSegmentsRepo {
  constructor(private readonly db: Db) {}

  upsertMany(callId: string, segments: TcxCallSegment[]): number {
    if (segments.length === 0) return 0;

    const statement = this.db.prepare(
      `INSERT INTO call_segments (
        call_id, tcx_segment_id, started_at, ended_at, ext, action_dn,
        status, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(call_id, tcx_segment_id) DO UPDATE SET
        started_at = COALESCE(excluded.started_at, started_at),
        ended_at = COALESCE(excluded.ended_at, ended_at),
        ext = COALESCE(excluded.ext, ext),
        action_dn = COALESCE(excluded.action_dn, action_dn),
        status = COALESCE(excluded.status, status),
        raw_json = COALESCE(excluded.raw_json, raw_json)`,
    );

    const write = this.db.transaction((rows: TcxCallSegment[]) => {
      for (const segment of rows) {
        statement.run(
          callId,
          segment.segmentId,
          segment.startedAt,
          segment.endedAt,
          segment.ext,
          segment.actionDn,
          segment.status,
          segment.raw === undefined ? null : JSON.stringify(segment.raw),
        );
      }
      return rows.length;
    });

    return write(segments);
  }

  listByCallId(callId: string): CallSegmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM call_segments
         WHERE call_id = ?
         ORDER BY started_at ASC, tcx_segment_id ASC`,
      )
      .all(callId) as CallSegmentRow[];
  }
}
