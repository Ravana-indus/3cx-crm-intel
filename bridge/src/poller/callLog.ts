import type { Config } from '../config.js';
import type { CallsRepo } from '../repo/calls.js';
import type { CallSegmentsRepo } from '../repo/callSegments.js';
import type { CheckpointsRepo } from '../repo/checkpoints.js';
import type { OutboxRepo } from '../repo/outbox.js';
import { deriveOutcome } from '../threecx/normalise.js';
import type { ThreeCXConnector } from '../threecx/types.js';
import type { Logger } from '../util/logger.js';
import { normalisePhone } from '../util/phone.js';
import { buildCallEvent } from '../webhooks/events.js';

export interface CallLogPollerDeps {
  config: Config;
  connector: ThreeCXConnector;
  calls: CallsRepo;
  callSegments?: CallSegmentsRepo;
  checkpoints: CheckpointsRepo;
  outbox: OutboxRepo;
  log: Logger;
}

export interface CallLogPollResult {
  fetched: number;
  created: number;
  updated: number;
  webhooks: number;
  since: string;
}

function phoneFields(
  direction: string,
  fromRaw: string,
  fromE164: string | null,
  toRaw: string,
  toE164: string | null,
): { fromE164: string | null; toE164: string | null } {
  if (direction === 'internal') {
    return { fromE164: null, toE164: null };
  }

  if (direction === 'outbound') {
    const parsed = normalisePhone(toRaw);
    return { fromE164, toE164: parsed.e164 ?? toE164 };
  }

  const parsed = normalisePhone(fromRaw);
  return { fromE164: parsed.e164 ?? fromE164, toE164 };
}

export class CallLogPoller {
  constructor(private readonly deps: CallLogPollerDeps) {}

  async poll(now = new Date()): Promise<CallLogPollResult> {
    const { config, connector, calls, checkpoints, outbox, log } = this.deps;

    const checkpoint = checkpoints.getDate('calllog');
    const since = checkpoint
      ? new Date(checkpoint.getTime() - config.overlapMs)
      : new Date(now.getTime() - config.initialLookbackMs);

    const remoteCalls = await connector.listCalls(since);
    const result: CallLogPollResult = {
      fetched: remoteCalls.length,
      created: 0,
      updated: 0,
      webhooks: 0,
      since: since.toISOString(),
    };

    for (const remote of remoteCalls) {
      const outcome = deriveOutcome(remote, config.tcxAiExt);
      const phones = phoneFields(
        remote.direction,
        remote.fromRaw,
        remote.fromE164,
        remote.toRaw,
        remote.toE164,
      );

      const upserted = calls.upsert({
        tcxCallId: remote.tcxCallId,
        segmentIds: remote.segmentIds,
        direction: remote.direction,
        fromRaw: remote.fromRaw,
        fromE164: phones.fromE164,
        toRaw: remote.toRaw,
        toE164: phones.toE164,
        ext: remote.ext,
        agentExt: remote.agentExt,
        queue: remote.queue,
        outcome,
        startedAt: remote.startedAt,
        answeredAt: remote.answeredAt,
        endedAt: remote.endedAt,
        ringSec: remote.ringSec,
        talkSec: remote.talkSec,
        disposition: remote.disposition ?? null,
        hangupParty: remote.hangupParty ?? null,
        queueWaitSec: remote.queueWaitSec ?? null,
        agentUserId: remote.agentUserId ?? null,
        isMissed: remote.isMissed ?? null,
        rawStatus: remote.rawStatus ?? remote.status ?? null,
        rawJson: remote.raw === undefined ? null : JSON.stringify(remote.raw),
        transferTo: remote.transferTo ?? null,
        transferredAt: remote.transferredAt ?? null,
      });

      this.deps.callSegments?.upsertMany(
        upserted.row.id,
        remote.segments ?? [],
      );

      if (upserted.created) result.created += 1;
      else result.updated += 1;

      const isMissed = outcome === 'missed' || outcome === 'abandoned';
      const isFinal = isMissed || Boolean(upserted.row.ended_at);
      const shouldNotify =
        outcome !== 'internal' &&
        isFinal &&
        (upserted.created || upserted.becameFinal || upserted.outcomeChanged);

      if (shouldNotify) {
        const event = isMissed ? 'call.missed' : 'call.completed';
        outbox.enqueue(event, buildCallEvent(event, upserted.row), now);
        result.webhooks += 1;
      }
    }

    checkpoints.advanceIfLater('calllog', now.toISOString());
    log.info(
      {
        fetched: result.fetched,
        created: result.created,
        updated: result.updated,
        webhooks: result.webhooks,
      },
      'call log polled',
    );

    return result;
  }
}
