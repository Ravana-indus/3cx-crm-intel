import type { Config } from '../config.js';
import type { CallsRepo } from '../repo/calls.js';
import type { OutboxRepo, OutboxRow } from '../repo/outbox.js';
import type { Logger } from '../util/logger.js';
import { signBody } from './sign.js';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const BACKOFF_SECONDS = [60, 300, 1800, 7200];

export interface DispatchResult {
  attempted: number;
  delivered: number;
  retried: number;
  dead: number;
  skipped: boolean;
}

function emptyResult(skipped = false): DispatchResult {
  return { attempted: 0, delivered: 0, retried: 0, dead: 0, skipped };
}

export class OutboxDispatcher {
  constructor(
    private readonly config: Config,
    private readonly outbox: OutboxRepo,
    private readonly calls: CallsRepo,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async dispatchOnce(now = new Date()): Promise<DispatchResult> {
    const url = this.config.portalWebhookUrl;
    if (!url) return emptyResult(true);

    const due = this.outbox.claimDue(now);
    if (due.length === 0) return emptyResult();

    const result: DispatchResult = {
      attempted: due.length,
      delivered: 0,
      retried: 0,
      dead: 0,
      skipped: false,
    };

    for (const row of due) {
      await this.deliverOne(row, url, now, result);
    }

    return result;
  }

  private async deliverOne(
    row: OutboxRow,
    url: string,
    now: Date,
    result: DispatchResult,
  ): Promise<void> {
    const body = row.payload_json;

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-signature': signBody(body, this.config.portalWebhookSecret),
          'x-bridge-event': row.event,
          'x-bridge-event-id': row.id,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`portal responded HTTP ${response.status}`);
      }

      await this.captureLeadId(row, body, response);
      this.outbox.markDelivered(row.id);
      result.delivered += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);

      if (attempts > BACKOFF_SECONDS.length) {
        this.outbox.markDead(row.id, attempts, message);
        result.dead += 1;
        this.log.error(
          { eventId: row.id, event: row.event, attempts, error: message },
          'webhook dead-lettered',
        );
        return;
      }

      const delay = BACKOFF_SECONDS[attempts - 1] ?? BACKOFF_SECONDS[0];
      const nextAttemptAt = new Date(now.getTime() + delay * 1000);
      this.outbox.markRetry(row.id, attempts, nextAttemptAt, message);
      result.retried += 1;
      this.log.warn(
        { eventId: row.id, event: row.event, attempts, nextAttemptAt, error: message },
        'webhook delivery failed; scheduled retry',
      );
    }
  }

  private async captureLeadId(
    row: OutboxRow,
    body: string,
    response: Response,
  ): Promise<void> {
    if (!row.event.startsWith('call.')) return;

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return;
    }

    const leadId = (parsed as { lead_id?: unknown } | null)?.lead_id;
    if (typeof leadId !== 'string' || leadId.trim() === '') return;

    try {
      const payload = JSON.parse(body) as { call?: { id?: string } };
      const callId = payload.call?.id;
      if (callId) this.calls.setLeadId(callId, leadId);
    } catch {
      // ignore malformed payloads; delivery already succeeded
    }
  }
}
