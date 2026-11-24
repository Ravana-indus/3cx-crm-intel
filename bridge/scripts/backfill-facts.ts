/**
 * Re-poll a 3CX call-log window into the bridge without downloading audio.
 * The CRM then pulls /v1/export/calls. This is how the 201/447 historical
 * rows can be joined where 3CX still has the calls.
 *
 *   TCX_MODE=live TCX_URL=... TCX_ACCESS_TOKEN=... \
 *     DB_PATH=./data/live.db \
 *     npx tsx scripts/backfill-facts.ts --from 2026-01-01 --to 2026-11-30
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { CallsRepo } from '../src/repo/calls.js';
import { CallSegmentsRepo } from '../src/repo/callSegments.js';
import { deriveOutcome } from '../src/threecx/normalise.js';
import { LiveThreeCX } from '../src/threecx/live/xapi.js';
import { createLogger } from '../src/util/logger.js';
import { normalisePhone } from '../src/util/phone.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function phoneFields(
  direction: string,
  fromRaw: string,
  fromE164: string | null,
  toRaw: string,
  toE164: string | null,
): { fromE164: string | null; toE164: string | null } {
  if (direction === 'internal') return { fromE164: null, toE164: null };
  if (direction === 'outbound') {
    return {
      fromE164,
      toE164: normalisePhone(toRaw).e164 ?? toE164,
    };
  }
  return {
    fromE164: normalisePhone(fromRaw).e164 ?? fromE164,
    toE164,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.tcxMode !== 'live') {
    throw new Error('run with TCX_MODE=live and TCX_ACCESS_TOKEN');
  }

  const from = new Date(arg('from') ?? Date.now() - 30 * 86_400_000);
  const to = new Date(arg('to') ?? Date.now());
  const limit = Number(arg('limit') ?? 0) || 0;

  const log = createLogger(config.logLevel);
  const db = openDb(config.dbPath);
  migrate(db);
  const calls = new CallsRepo(db);
  const callSegments = new CallSegmentsRepo(db);
  const connector = new LiveThreeCX(config, log);

  try {
    const remote = (await connector.listCalls(from))
      .filter((call) => {
        const started = Date.parse(call.startedAt);
        return started >= from.getTime() && started <= to.getTime();
      })
      .sort(
        (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
      )
      .slice(0, limit > 0 ? limit : undefined);

    let created = 0;
    let updated = 0;
    const nulls: Record<string, number> = {};

    for (const call of remote) {
      const phones = phoneFields(
        call.direction,
        call.fromRaw,
        call.fromE164,
        call.toRaw,
        call.toE164,
      );
      const upserted = calls.upsert({
        tcxCallId: call.tcxCallId,
        segmentIds: call.segmentIds,
        direction: call.direction,
        fromRaw: call.fromRaw,
        fromE164: phones.fromE164,
        toRaw: call.toRaw,
        toE164: phones.toE164,
        ext: call.ext,
        agentExt: call.agentExt,
        queue: call.queue,
        outcome: deriveOutcome(call, config.tcxAiExt),
        startedAt: call.startedAt,
        answeredAt: call.answeredAt,
        endedAt: call.endedAt,
        ringSec: call.ringSec,
        talkSec: call.talkSec,
        disposition: call.disposition ?? null,
        hangupParty: call.hangupParty ?? null,
        queueWaitSec: call.queueWaitSec ?? null,
        agentUserId: call.agentUserId ?? null,
        isMissed: call.isMissed ?? null,
        rawStatus: call.rawStatus ?? call.status ?? null,
        rawJson: call.raw === undefined ? null : JSON.stringify(call.raw),
        transferTo: call.transferTo ?? null,
        transferredAt: call.transferredAt ?? null,
      });
      callSegments.upsertMany(upserted.row.id, call.segments ?? []);

      if (upserted.created) created += 1;
      else updated += 1;

      for (const [field, value] of Object.entries({
        disposition: call.disposition,
        hangupParty: call.hangupParty,
        queueWaitSec: call.queueWaitSec,
        agentUserId: call.agentUserId,
        isMissed: call.isMissed,
        transferTo: call.transferTo,
      })) {
        if (value === null || value === undefined) {
          nulls[field] = (nulls[field] ?? 0) + 1;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          from: from.toISOString(),
          to: to.toISOString(),
          fetched: remote.length,
          created,
          updated,
          nulls,
        },
        null,
        2,
      ),
    );
  } finally {
    await connector.close();
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
