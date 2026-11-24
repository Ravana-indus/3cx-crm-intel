import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type {
  CallDirection,
  CallDisposition,
  CallOutcome,
  HangupParty,
} from '../threecx/types.js';

export interface CallRow {
  id: string;
  tcx_call_id: string;
  tcx_segment_ids: string;
  direction: CallDirection;
  from_raw: string | null;
  from_e164: string | null;
  to_raw: string | null;
  to_e164: string | null;
  ext: string | null;
  agent_ext: string | null;
  queue: string | null;
  outcome: CallOutcome | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  ring_sec: number | null;
  talk_sec: number | null;
  lead_id: string | null;
  ai_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  disposition: CallDisposition | null;
  hangup_party: HangupParty | null;
  queue_wait_sec: number | null;
  agent_user_id: string | null;
  missed_call: number | null;
  raw_status: string | null;
  raw_json: string | null;
  transfer_to: string | null;
  transferred_at: string | null;
}

export interface UpsertCallInput {
  tcxCallId: string;
  segmentIds: string[];
  direction: CallDirection;
  fromRaw: string;
  fromE164: string | null;
  toRaw: string;
  toE164: string | null;
  ext: string | null;
  agentExt: string | null;
  queue: string | null;
  outcome: CallOutcome;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  ringSec: number | null;
  talkSec: number | null;
  disposition?: CallDisposition | null;
  hangupParty?: HangupParty | null;
  queueWaitSec?: number | null;
  agentUserId?: string | null;
  isMissed?: boolean | null;
  rawStatus?: string | null;
  rawJson?: string | null;
  transferTo?: string | null;
  transferredAt?: string | null;
}

export interface UpsertCallResult {
  row: CallRow;
  created: boolean;
  becameFinal: boolean;
  outcomeChanged: boolean;
  previousOutcome: CallOutcome | null;
}

export interface CallFilters {
  from?: Date;
  to?: Date;
  ext?: string;
  outcome?: string;
  leadId?: string;
}

export interface CallPage {
  items: CallRow[];
  nextCursor: string | null;
}

function parseSegments(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function encodeCursor(row: CallRow): string {
  return Buffer.from(`${row.started_at}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { startedAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator === -1) return null;
    return {
      startedAt: decoded.slice(0, separator),
      id: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export class CallsRepo {
  constructor(private readonly db: Db) {}

  upsert(input: UpsertCallInput): UpsertCallResult {
    const existing = this.getByTcxId(input.tcxCallId);
    const now = new Date().toISOString();

    if (!existing) {
      const id = `call_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO calls (
            id, tcx_call_id, tcx_segment_ids, direction, from_raw, from_e164,
            to_raw, to_e164, ext, agent_ext, queue, outcome, started_at,
            answered_at, ended_at, ring_sec, talk_sec, disposition,
            hangup_party, queue_wait_sec, agent_user_id, missed_call, raw_status,
            raw_json, transfer_to, transferred_at, created_at, updated_at
          ) VALUES (
            @id, @tcxCallId, @segmentIds, @direction, @fromRaw, @fromE164,
            @toRaw, @toE164, @ext, @agentExt, @queue, @outcome, @startedAt,
            @answeredAt, @endedAt, @ringSec, @talkSec, @disposition,
            @hangupParty, @queueWaitSec, @agentUserId, @isMissed, @rawStatus,
            @rawJson, @transferTo, @transferredAt, @now, @now
          )`,
        )
        .run({
          id,
          tcxCallId: input.tcxCallId,
          segmentIds: JSON.stringify(input.segmentIds),
          direction: input.direction,
          fromRaw: input.fromRaw,
          fromE164: input.fromE164,
          toRaw: input.toRaw,
          toE164: input.toE164,
          ext: input.ext,
          agentExt: input.agentExt,
          queue: input.queue,
          outcome: input.outcome,
          startedAt: input.startedAt,
          answeredAt: input.answeredAt,
          endedAt: input.endedAt,
          ringSec: input.ringSec,
          talkSec: input.talkSec,
          disposition: input.disposition ?? null,
          hangupParty: input.hangupParty ?? null,
          queueWaitSec: input.queueWaitSec ?? null,
          agentUserId: input.agentUserId ?? null,
          isMissed:
            input.isMissed === undefined || input.isMissed === null
              ? null
              : input.isMissed
                ? 1
                : 0,
          rawStatus: input.rawStatus ?? null,
          rawJson: input.rawJson ?? null,
          transferTo: input.transferTo ?? null,
          transferredAt: input.transferredAt ?? null,
          now,
        });

      const row = this.getById(id) as CallRow;
      return {
        row,
        created: true,
        becameFinal: Boolean(input.endedAt),
        outcomeChanged: true,
        previousOutcome: null,
      };
    }

    const mergedSegments = Array.from(
      new Set([...parseSegments(existing.tcx_segment_ids), ...input.segmentIds]),
    );
    const becameFinal = existing.ended_at === null && input.endedAt !== null;
    const outcomeChanged = existing.outcome !== input.outcome;

    this.db
      .prepare(
        `UPDATE calls SET
          tcx_segment_ids = @segmentIds,
          direction = @direction,
          from_raw = @fromRaw,
          from_e164 = COALESCE(@fromE164, from_e164),
          to_raw = @toRaw,
          to_e164 = COALESCE(@toE164, to_e164),
          ext = COALESCE(@ext, ext),
          agent_ext = COALESCE(@agentExt, agent_ext),
          queue = COALESCE(@queue, queue),
          outcome = @outcome,
          started_at = @startedAt,
          answered_at = COALESCE(@answeredAt, answered_at),
          ended_at = COALESCE(@endedAt, ended_at),
          ring_sec = COALESCE(@ringSec, ring_sec),
          talk_sec = COALESCE(@talkSec, talk_sec),
          disposition = COALESCE(@disposition, disposition),
          hangup_party = COALESCE(@hangupParty, hangup_party),
          queue_wait_sec = COALESCE(@queueWaitSec, queue_wait_sec),
          agent_user_id = COALESCE(@agentUserId, agent_user_id),
          missed_call = COALESCE(@isMissed, missed_call),
          raw_status = COALESCE(@rawStatus, raw_status),
          raw_json = COALESCE(@rawJson, raw_json),
          transfer_to = COALESCE(@transferTo, transfer_to),
          transferred_at = COALESCE(@transferredAt, transferred_at),
          updated_at = @now
        WHERE id = @id`,
      )
      .run({
        id: existing.id,
        segmentIds: JSON.stringify(mergedSegments),
        direction: input.direction,
        fromRaw: input.fromRaw,
        fromE164: input.fromE164,
        toRaw: input.toRaw,
        toE164: input.toE164,
        ext: input.ext,
        agentExt: input.agentExt,
        queue: input.queue,
        outcome: input.outcome,
        startedAt: input.startedAt,
        answeredAt: input.answeredAt,
        endedAt: input.endedAt,
        ringSec: input.ringSec,
        talkSec: input.talkSec,
        disposition: input.disposition ?? null,
        hangupParty: input.hangupParty ?? null,
        queueWaitSec: input.queueWaitSec ?? null,
        agentUserId: input.agentUserId ?? null,
        isMissed:
          input.isMissed === undefined || input.isMissed === null
            ? null
            : input.isMissed
              ? 1
              : 0,
        rawStatus: input.rawStatus ?? null,
        rawJson: input.rawJson ?? null,
        transferTo: input.transferTo ?? null,
        transferredAt: input.transferredAt ?? null,
        now,
      });

    return {
      row: this.getById(existing.id) as CallRow,
      created: false,
      becameFinal,
      outcomeChanged,
      previousOutcome: existing.outcome,
    };
  }

  getById(id: string): CallRow | undefined {
    return this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as
      | CallRow
      | undefined;
  }

  getByTcxId(tcxCallId: string): CallRow | undefined {
    return this.db
      .prepare('SELECT * FROM calls WHERE tcx_call_id = ?')
      .get(tcxCallId) as CallRow | undefined;
  }

  setLeadId(id: string, leadId: string | null): void {
    this.db
      .prepare('UPDATE calls SET lead_id = ?, updated_at = ? WHERE id = ?')
      .run(leadId, new Date().toISOString(), id);
  }

  setAiConversationId(id: string, conversationId: string | null): void {
    this.db
      .prepare('UPDATE calls SET ai_conversation_id = ?, updated_at = ? WHERE id = ?')
      .run(conversationId, new Date().toISOString(), id);
  }

  list(filters: CallFilters = {}, limit = 50, cursor?: string | null): CallPage {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filters.from) {
      clauses.push('started_at >= ?');
      params.push(filters.from.toISOString());
    }
    if (filters.to) {
      clauses.push('started_at <= ?');
      params.push(filters.to.toISOString());
    }
    if (filters.ext) {
      clauses.push('(ext = ? OR agent_ext = ?)');
      params.push(filters.ext, filters.ext);
    }
    if (filters.outcome) {
      clauses.push('outcome = ?');
      params.push(filters.outcome);
    }
    if (filters.leadId) {
      clauses.push('lead_id = ?');
      params.push(filters.leadId);
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        clauses.push('(started_at < ? OR (started_at = ? AND id < ?))');
        params.push(decoded.startedAt, decoded.startedAt, decoded.id);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM calls ${where}
         ORDER BY started_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as CallRow[];

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  listMissed(since: Date, unreturned: boolean, limit = 500): CallRow[] {
    const unreturnedClause = unreturned
      ? `AND NOT EXISTS (
           SELECT 1 FROM calls o
           WHERE o.direction = 'outbound'
             AND c.from_e164 IS NOT NULL
             AND o.to_e164 = c.from_e164
             AND o.started_at > c.started_at
         )`
      : '';

    return this.db
      .prepare(
        `SELECT c.* FROM calls c
         WHERE c.outcome IN ('missed', 'abandoned')
           AND c.started_at >= ?
           ${unreturnedClause}
         ORDER BY c.started_at DESC
         LIMIT ?`,
      )
      .all(since.toISOString(), limit) as CallRow[];
  }

  findByExtAndTime(
    ext: string | null,
    startedAt: string,
    windowSec = 5,
  ): CallRow | undefined {
    if (!ext) return undefined;

    const target = Date.parse(startedAt);
    if (Number.isNaN(target)) return undefined;

    const from = new Date(target - windowSec * 1000).toISOString();
    const to = new Date(target + windowSec * 1000).toISOString();

    const rows = this.db
      .prepare(
        `SELECT * FROM calls
         WHERE started_at >= ? AND started_at <= ?
           AND (ext = ? OR agent_ext = ?)`,
      )
      .all(from, to, ext, ext) as CallRow[];

    if (rows.length === 0) return undefined;

    return rows.sort(
      (a, b) =>
        Math.abs(Date.parse(a.started_at) - target) -
        Math.abs(Date.parse(b.started_at) - target),
    )[0];
  }

  countByOutcome(since: Date): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM calls
         WHERE started_at >= ? GROUP BY outcome`,
      )
      .all(since.toISOString()) as Array<{ outcome: string | null; count: number }>;

    const result: Record<string, number> = {};
    for (const row of rows) {
      if (row.outcome) result[row.outcome] = row.count;
    }
    return result;
  }
}
