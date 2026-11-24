import { Readable } from 'node:stream';
import type { Config } from '../../config.js';
import type { Logger } from '../../util/logger.js';
import {
  asIsoDate,
  asString,
  deriveTransferFromSegments,
  normaliseCallLogData,
  normaliseTcxPresence,
  normaliseTcxRecording,
  normaliseUsersPresence,
  parseDurationSeconds,
  pick,
} from '../normalise.js';
import type {
  ThreeCXConnector,
  TcxCall,
  TcxPresence,
  TcxRecording,
} from '../types.js';
import { ThreeCXSession } from './session.js';

function extractArray(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value;
  if (depth > 3 || value === null || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    'value',
    'Value',
    'data',
    'Data',
    'items',
    'Items',
    'results',
    'Results',
    'records',
    'Records',
  ];

  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }

  for (const entry of Object.values(record)) {
    const found = extractArray(entry, depth + 1);
    if (found.length > 0) return found;
  }

  return [];
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function recIdFrom(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  if (/^\d+$/.test(text) && text !== '0') return text;
  const match = text.match(/recId=([^)&]+)/i);
  return match ? match[1] : null;
}

/**
 * A CallLogData row can reference the recording directly. Falls back to the
 * recording id in RecordingUrl when the explicit id columns are zero.
 */
function recordingFromCallLog(raw: unknown): TcxRecording | null {
  const recId =
    recIdFrom(pick(raw, ['SrcRecId'])) ??
    recIdFrom(pick(raw, ['DstRecId'])) ??
    recIdFrom(pick(raw, ['RecordingUrl']));
  if (!recId) return null;

  const startedAt = asIsoDate(pick(raw, ['StartTime']));
  if (!startedAt) return null;

  const ringSec = parseDurationSeconds(pick(raw, ['RingingDuration']));
  const talkSec = parseDurationSeconds(pick(raw, ['TalkingDuration']));
  const callTcxId = asString(
    pick(raw, ['MainCallHistoryId', 'CallHistoryId', 'CdrId']),
  );

  return {
    tcxRecId: recId,
    callTcxId,
    ext: asString(pick(raw, ['ActionDnDn', 'SourceDn', 'DestinationDn'])),
    startedAt,
    durationSec:
      talkSec !== null || ringSec !== null
        ? (talkSec ?? 0) + (ringSec ?? 0)
        : null,
    channels: null,
  };
}

/**
 * Live connector for the 3CX v20 webclient/xapi. Call log is read through the
 * bound OData function; recordings through the Recordings entity set or the
 * recording ids embedded in the call log.
 */
export class LiveThreeCX implements ThreeCXConnector {
  readonly mode = 'live' as const;
  private readonly session: ThreeCXSession;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.session = new ThreeCXSession(config, log);
    if (config.tcxAccessToken) {
      this.session.setToken(config.tcxAccessToken);
      this.log.warn(
        'using TCX_ACCESS_TOKEN bootstrap token; no browser login will be performed',
      );
    }
  }

  async ensureAuth(): Promise<void> {
    await this.session.ensureAuth();
  }

  state(): 'ok' | 'degraded' {
    return this.session.state();
  }

  lastError(): string | null {
    return this.session.lastError();
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async listCalls(since: Date): Promise<TcxCall[]> {
    const rows = await this.fetchCallLogRows(since);
    const grouped = new Map<string, TcxCall>();

    for (const row of rows) {
      const call = normaliseCallLogData(row);
      if (!call) continue;

      const existing = grouped.get(call.tcxCallId);
      if (!existing) {
        grouped.set(call.tcxCallId, {
          ...call,
          segments: call.segments ?? [],
          raw: [row],
        });
        continue;
      }

      const segments = [...(existing.segments ?? []), ...(call.segments ?? [])];
      const bySegment = new Map<string, typeof segments[number]>();
      for (const segment of segments) bySegment.set(segment.segmentId, segment);

      existing.segments = [...bySegment.values()];
      existing.segmentIds = Array.from(
        new Set([...existing.segmentIds, ...call.segmentIds]),
      );
      existing.raw = Array.isArray(existing.raw)
        ? [...existing.raw, row]
        : [existing.raw, row];
      existing.transferTo = existing.transferTo ?? call.transferTo ?? null;
      existing.transferredAt =
        existing.transferredAt ?? call.transferredAt ?? null;
      existing.status = existing.status ?? call.status ?? null;
      existing.rawStatus = existing.rawStatus ?? call.rawStatus ?? null;
    }

    const calls = [...grouped.values()];
    for (const call of calls) {
      const derived = deriveTransferFromSegments(call.segments ?? []);
      call.transferTo = call.transferTo ?? derived.transferTo;
      call.transferredAt = call.transferredAt ?? derived.transferredAt;
    }

    return calls;
  }

  async listRecordings(since: Date): Promise<TcxRecording[]> {
    const collected = new Map<string, TcxRecording>();

    try {
      const endpoint = this.endpoint(this.config.epRecordings);
      endpoint.searchParams.set('$top', '1000');
      const response = await this.request(this.toPath(endpoint), [403, 404]);
      if (response.ok) {
        const body = await response.json();
        for (const row of extractArray(body)) {
          const recording = normaliseTcxRecording(row);
          if (recording) collected.set(recording.tcxRecId, recording);
        }
      } else {
        this.log.warn(
          { status: response.status },
          'Recordings entity set unavailable; deriving recordings from call log',
        );
      }
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'could not list Recordings; falling back to call log',
      );
    }

    try {
      const rows = await this.fetchCallLogRows(since);
      for (const row of rows) {
        const recording = recordingFromCallLog(row);
        if (recording) collected.set(recording.tcxRecId, recording);
      }
    } catch (error) {
      this.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'could not derive recordings from call log',
      );
    }

    return [...collected.values()];
  }

  async downloadRecording(id: string): Promise<Readable> {
    let path: string;
    if (id.startsWith('/') || /^https?:\/\//i.test(id)) {
      path = id;
    } else {
      const template = this.config.epDownload;
      path = template.includes('{id}')
        ? template.replace('{id}', encodeURIComponent(id))
        : `${template.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
    }

    const response = await this.request(path);
    const buffer = Buffer.from(await response.arrayBuffer());
    return Readable.from([buffer]);
  }

  async getPresence(): Promise<TcxPresence[]> {
    if (!this.config.epPresence) return [];

    const response = await this.request(this.config.epPresence, [403, 404]);
    if (!response.ok) {
      this.log.warn(
        { status: response.status },
        'presence endpoint unavailable',
      );
      return [];
    }

    const body = await response.json();
    const at = new Date().toISOString();
    return extractArray(body)
      .map(
        (row) =>
          normaliseUsersPresence(row, at) ?? normaliseTcxPresence(row),
      )
      .filter((presence): presence is TcxPresence => presence !== null);
  }

  private async fetchCallLogRows(since: Date): Promise<unknown[]> {
    const now = new Date();
    const parameters = [
      `periodFrom=${since.toISOString()}`,
      `periodTo=${now.toISOString()}`,
      'sourceType=0',
      "sourceFilter=''",
      'destinationType=0',
      "destinationFilter=''",
      'callsType=0',
      'callTimeFilterType=0',
      "callTimeFilterFrom='0:00:0'",
      "callTimeFilterTo='0:00:0'",
      'hidePcalls=true',
    ];

    const base = this.config.epCalls.replace(/\($/, '');
    let next: string | null = `${base}(${parameters.join(',')})?$skip=0&$top=1000`;
    const rows: unknown[] = [];

    for (let page = 0; page < 20 && next; page += 1) {
      const response = await this.request(next);
      const body = (await response.json()) as Record<string, unknown>;
      rows.push(...extractArray(body));

      const nextLink = body['@odata.nextLink'];
      next = typeof nextLink === 'string' ? nextLink : null;
    }

    this.log.debug({ rows: rows.length, since: since.toISOString() }, 'call log fetched');
    return rows;
  }

  private endpoint(path: string): URL {
    const base = this.config.tcxUrl;
    if (!base) throw new Error('TCX_URL is not configured');
    const normalisedBase = base.endsWith('/') ? base : `${base}/`;
    return new URL(path, normalisedBase);
  }

  private toPath(url: URL): string {
    return `${url.pathname}${url.search}`;
  }

  private async request(
    path: string,
    tolerateStatuses: number[] = [],
  ): Promise<Response> {
    await this.session.ensureAuth();

    const execute = async (): Promise<Response> => {
      const token = this.session.currentToken();
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;

      const target = /^https?:\/\//i.test(path)
        ? path
        : this.endpoint(path).toString();

      return fetch(target, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });
    };

    let response = await execute();

    if (response.status === 401) {
      this.log.warn({ path }, '3CX token rejected; re-authenticating once');
      await this.session.invalidate();
      await this.session.ensureAuth();
      response = await execute();
    }

    if (!response.ok) {
      if (tolerateStatuses.includes(response.status)) {
        return response;
      }

      const detail = await response.text().catch(() => '');
      const error = new Error(
        `3CX ${response.status} ${path}: ${detail.slice(0, 300)}`,
      ) as Error & { status: number };
      error.status = response.status;
      this.session.recordFailure(error);
      throw error;
    }

    this.session.recordSuccess();
    return response;
  }
}
