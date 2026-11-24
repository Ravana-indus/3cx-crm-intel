import type { Db } from '../db/index.js';
import {
  colomboDayKey,
  nextColomboMidnightMs,
  weekStartOfDay,
} from '../util/time.js';
import type { AgentsRepo } from './agents.js';

export type MetricsInterval = 'day' | 'week' | 'total';
export type MetricsGroup = 'agent' | 'team';

export interface MetricsRange {
  from: Date;
  to: Date;
}

export interface MetricRow {
  period: string;
  group_key: string;
  ext: string | null;
  agent: string | null;
  team: string | null;
  offered: number;
  answered: number;
  missed: number;
  abandoned: number;
  ai_handled: number;
  ai_handled_with_lead: number;
  answer_rate: number | null;
  avg_speed_of_answer_sec: number | null;
  talk_sec_total: number;
  talk_sec_avg: number | null;
  drops: number;
  outbound_calls: number;
  outbound_talk_sec: number;
  callback_returned: number;
  callback_unreturned: number;
  avg_callback_minutes: number | null;
  active_minutes: number | null;
}

export interface PresenceEntry {
  ext: string;
  status: string;
  at: string;
  name: string | null;
  team: string | null;
  email: string | null;
}

interface SqlMetricRow {
  period: string;
  group_key: string;
  agent_name: string | null;
  team: string | null;
  offered: number | null;
  answered: number | null;
  missed: number | null;
  abandoned: number | null;
  ai_handled: number | null;
  ai_handled_with_lead: number | null;
  talk_sec_total: number | null;
  talk_sec_avg: number | null;
  avg_speed_of_answer_sec: number | null;
  drops: number | null;
  outbound_calls: number | null;
  outbound_talk_sec: number | null;
}

interface CallbackAgg {
  returned: number;
  unreturned: number;
  avg_minutes: number | null;
}

interface ActiveData {
  map: Map<string, number>;
  hasPresence: boolean;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Asia/Colombo has a constant +05:30 offset, so a simple shift works in SQL.
 */
function bucketExpr(interval: MetricsInterval, column = 'started_at'): string {
  if (interval === 'total') return "'total'";
  const local = `datetime(${column}, '+5 hours', '+30 minutes')`;
  if (interval === 'day') return `date(${local})`;
  // Monday of the local week.
  return `date(${local}, '-' || ((CAST(strftime('%w', ${local}) AS INTEGER) + 6) % 7) || ' days')`;
}

function groupExpr(group: MetricsGroup): string {
  return group === 'agent'
    ? "COALESCE(c.agent_key, 'unknown')"
    : "COALESCE(c.team, 'Unassigned')";
}

export class MetricsRepo {
  constructor(
    private readonly db: Db,
    private readonly agents: AgentsRepo,
    private readonly activeStatuses: string[],
  ) {}

  byGroup(
    group: MetricsGroup,
    interval: MetricsInterval,
    range: MetricsRange,
    agentExt?: string,
  ): MetricRow[] {
    const rows = this.metricRows(group, interval, range, agentExt);
    const callbacks = this.callbackMap(group, interval, range, agentExt);
    const active = this.activeMap(group, interval, range);

    return rows.map((row) => this.toMetricRow(row, group, callbacks, active));
  }

  forAgentTotals(ext: string, range: MetricsRange): MetricRow {
    const rows = this.byGroup('agent', 'total', range, ext);
    if (rows.length > 0) return rows[0];

    const agent = this.agents.get(ext);
    const active = this.activeMap('agent', 'total', range);

    return {
      period: 'total',
      group_key: ext,
      ext,
      agent: agent?.name ?? ext,
      team: agent?.team ?? null,
      offered: 0,
      answered: 0,
      missed: 0,
      abandoned: 0,
      ai_handled: 0,
      ai_handled_with_lead: 0,
      answer_rate: null,
      avg_speed_of_answer_sec: null,
      talk_sec_total: 0,
      talk_sec_avg: null,
      drops: 0,
      outbound_calls: 0,
      outbound_talk_sec: 0,
      callback_returned: 0,
      callback_unreturned: 0,
      avg_callback_minutes: null,
      active_minutes: active.hasPresence
        ? round(active.map.get(`total|${ext}`) ?? 0, 1)
        : null,
    };
  }

  presence(): PresenceEntry[] {
    return this.db
      .prepare(
        `SELECT p.ext, p.status, p.at, a.name, a.team, a.email
         FROM presence_events p
         JOIN (
           SELECT ext, MAX(id) AS id FROM presence_events GROUP BY ext
         ) latest ON latest.id = p.id
         LEFT JOIN agents a ON a.ext = p.ext
         ORDER BY p.ext ASC`,
      )
      .all() as PresenceEntry[];
  }

  private metricRows(
    group: MetricsGroup,
    interval: MetricsInterval,
    range: MetricsRange,
    agentExt?: string,
  ): SqlMetricRow[] {
    const bucket = bucketExpr(interval);
    const groupColumn = groupExpr(group);

    const params: Array<string | number> = [
      range.from.toISOString(),
      range.to.toISOString(),
    ];
    let extClause = '';
    if (agentExt) {
      extClause = "AND COALESCE(c.agent_key, 'unknown') = ?";
      params.push(agentExt);
    }

    return this.db
      .prepare(
        `SELECT
           ${bucket} AS period,
           ${groupColumn} AS group_key,
           MAX(c.agent_name) AS agent_name,
           MAX(c.team) AS team,
           SUM(c.is_offered) AS offered,
           SUM(c.is_answered) AS answered,
           SUM(c.is_missed) AS missed,
           SUM(c.is_abandoned) AS abandoned,
           SUM(c.is_ai_handled) AS ai_handled,
           SUM(CASE WHEN c.is_ai_handled = 1 AND c.lead_id IS NOT NULL THEN 1 ELSE 0 END)
             AS ai_handled_with_lead,
           SUM(CASE WHEN c.is_connected = 1 THEN c.talk_sec ELSE 0 END) AS talk_sec_total,
           AVG(CASE WHEN c.is_connected = 1 THEN c.talk_sec END) AS talk_sec_avg,
           AVG(CASE WHEN c.is_answered = 1 THEN c.ring_sec END) AS avg_speed_of_answer_sec,
           SUM(c.is_drop) AS drops,
           SUM(c.is_outbound) AS outbound_calls,
           SUM(CASE WHEN c.is_outbound = 1 THEN c.talk_sec ELSE 0 END) AS outbound_talk_sec
         FROM v_metric_calls c
         WHERE c.started_at >= ? AND c.started_at <= ? ${extClause}
         GROUP BY period, group_key
         ORDER BY period DESC, group_key ASC`,
      )
      .all(...params) as SqlMetricRow[];
  }

  private callbackMap(
    group: MetricsGroup,
    interval: MetricsInterval,
    range: MetricsRange,
    agentExt?: string,
  ): Map<string, CallbackAgg> {
    const bucket = bucketExpr(interval, 'c.started_at');
    const groupColumn = groupExpr(group);

    const params: Array<string | number> = [
      range.from.toISOString(),
      range.to.toISOString(),
    ];
    let extClause = '';
    if (agentExt) {
      extClause = "AND COALESCE(c.agent_key, 'unknown') = ?";
      params.push(agentExt);
    }

    const rows = this.db
      .prepare(
        `SELECT
           period,
           group_key,
           SUM(CASE WHEN diff_sec IS NOT NULL AND diff_sec <= 86400 THEN 1 ELSE 0 END)
             AS returned,
           SUM(CASE WHEN diff_sec IS NULL OR diff_sec > 86400 THEN 1 ELSE 0 END)
             AS unreturned,
           AVG(CASE WHEN diff_sec IS NOT NULL AND diff_sec <= 86400 THEN diff_sec / 60.0 END)
             AS avg_minutes
         FROM (
           SELECT
             ${bucket} AS period,
             ${groupColumn} AS group_key,
             (CAST(strftime('%s', cb.returned_at) AS INTEGER)
               - CAST(strftime('%s', cb.started_at) AS INTEGER)) AS diff_sec
           FROM v_missed_callbacks cb
           JOIN v_metric_calls c ON c.id = cb.call_id
           WHERE c.started_at >= ? AND c.started_at <= ? ${extClause}
         )
         GROUP BY period, group_key`,
      )
      .all(...params) as Array<{
      period: string;
      group_key: string;
      returned: number;
      unreturned: number;
      avg_minutes: number | null;
    }>;

    const map = new Map<string, CallbackAgg>();
    for (const row of rows) {
      map.set(`${row.period}|${row.group_key}`, {
        returned: row.returned ?? 0,
        unreturned: row.unreturned ?? 0,
        avg_minutes: row.avg_minutes,
      });
    }
    return map;
  }

  private toMetricRow(
    row: SqlMetricRow,
    group: MetricsGroup,
    callbacks: Map<string, CallbackAgg>,
    active: ActiveData,
  ): MetricRow {
    const key = `${row.period}|${row.group_key}`;
    const callback = callbacks.get(key);
    const offered = row.offered ?? 0;
    const answered = row.answered ?? 0;

    return {
      period: row.period,
      group_key: row.group_key,
      ext: group === 'agent' ? row.group_key : null,
      agent: row.agent_name ?? (group === 'agent' ? row.group_key : null),
      team: row.team ?? null,
      offered,
      answered,
      missed: row.missed ?? 0,
      abandoned: row.abandoned ?? 0,
      ai_handled: row.ai_handled ?? 0,
      ai_handled_with_lead: row.ai_handled_with_lead ?? 0,
      answer_rate: offered > 0 ? round(answered / offered, 4) : null,
      avg_speed_of_answer_sec:
        row.avg_speed_of_answer_sec === null
          ? null
          : round(Number(row.avg_speed_of_answer_sec), 1),
      talk_sec_total: row.talk_sec_total ?? 0,
      talk_sec_avg:
        row.talk_sec_avg === null ? null : round(Number(row.talk_sec_avg), 1),
      drops: row.drops ?? 0,
      outbound_calls: row.outbound_calls ?? 0,
      outbound_talk_sec: row.outbound_talk_sec ?? 0,
      callback_returned: callback?.returned ?? 0,
      callback_unreturned: callback?.unreturned ?? 0,
      avg_callback_minutes:
        callback?.avg_minutes === null || callback?.avg_minutes === undefined
          ? null
          : round(callback.avg_minutes, 1),
      active_minutes: active.hasPresence
        ? round(active.map.get(key) ?? 0, 1)
        : null,
    };
  }

  private activeMap(
    group: MetricsGroup,
    interval: MetricsInterval,
    range: MetricsRange,
  ): ActiveData {
    const { perExtDay, hasPresence } = this.activeData(range);
    const map = new Map<string, number>();
    if (!hasPresence) return { map, hasPresence: false };

    const teamByExt = new Map<string, string>();
    for (const agent of this.agents.list()) {
      teamByExt.set(agent.ext, agent.team ?? 'Unassigned');
    }

    for (const [ext, days] of perExtDay) {
      const groupKey =
        group === 'team' ? (teamByExt.get(ext) ?? 'Unassigned') : ext;

      for (const [day, minutes] of days) {
        const period =
          interval === 'day'
            ? day
            : interval === 'week'
              ? weekStartOfDay(day)
              : 'total';
        const key = `${period}|${groupKey}`;
        map.set(key, (map.get(key) ?? 0) + minutes);
      }
    }

    return { map, hasPresence: true };
  }

  private activeData(range: MetricsRange): {
    perExtDay: Map<string, Map<string, number>>;
    hasPresence: boolean;
  } {
    const rows = this.db
      .prepare(
        `SELECT ext, status, at FROM presence_events
         WHERE at <= ?
         ORDER BY ext ASC, at ASC, id ASC`,
      )
      .all(range.to.toISOString()) as Array<{
      ext: string;
      status: string;
      at: string;
    }>;

    if (rows.length === 0) {
      return { perExtDay: new Map(), hasPresence: false };
    }

    const byExt = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byExt.get(row.ext);
      if (list) list.push(row);
      else byExt.set(row.ext, [row]);
    }

    const fromMs = range.from.getTime();
    const toMs = range.to.getTime();
    const perExtDay = new Map<string, Map<string, number>>();

    for (const [ext, events] of byExt) {
      const days = new Map<string, number>();
      let status: string | null = null;
      let since = fromMs;

      for (const event of events) {
        const at = Date.parse(event.at);
        if (Number.isNaN(at)) continue;

        if (at <= fromMs) {
          status = event.status;
          since = fromMs;
          continue;
        }
        if (at >= toMs) break;

        this.addActive(days, status, since, at);
        status = event.status;
        since = at;
      }

      this.addActive(days, status, since, toMs);
      perExtDay.set(ext, days);
    }

    return { perExtDay, hasPresence: true };
  }

  private addActive(
    days: Map<string, number>,
    status: string | null,
    startMs: number,
    endMs: number,
  ): void {
    if (!status || endMs <= startMs || !this.isActive(status)) return;

    let cursor = startMs;
    while (cursor < endMs) {
      const day = colomboDayKey(cursor);
      const boundary = nextColomboMidnightMs(cursor);
      const segmentEnd = Math.min(endMs, boundary);
      if (segmentEnd <= cursor) break;

      const minutes = (segmentEnd - cursor) / 60_000;
      days.set(day, (days.get(day) ?? 0) + minutes);
      cursor = segmentEnd;
    }
  }

  private isActive(status: string): boolean {
    const value = status.toLowerCase();
    return this.activeStatuses.some((term) => value.includes(term));
  }
}
