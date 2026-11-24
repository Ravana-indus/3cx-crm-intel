/**
 * Fetch the newest N 3CX calls, ensure their recordings exist, and queue a
 * fresh transcription job for each. Intended for targeted re-transcription.
 *
 *   TCX_MODE=live TCX_URL=https://saas.3cx.asia/ TCX_ACCESS_TOKEN=... \
 *     npx tsx scripts/retranscribe-last.ts --limit 5 --days 30
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { CallsRepo } from '../src/repo/calls.js';
import { JobsRepo } from '../src/repo/jobs.js';
import { RecordingsRepo } from '../src/repo/recordings.js';
import { LiveThreeCX } from '../src/threecx/live/xapi.js';
import { deriveOutcome } from '../src/threecx/normalise.js';
import { createLogger } from '../src/util/logger.js';
import { normalisePhone } from '../src/util/phone.js';

const execFileAsync = promisify(execFile);

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitise(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function probe(filePath: string): Promise<{
  durationSec: number | null;
  channels: number | null;
}> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; channels?: number }>;
    };
    const duration = parsed.format?.duration
      ? Number(parsed.format.duration)
      : null;
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
    return {
      durationSec: duration !== null && Number.isFinite(duration) ? duration : null,
      channels: audio?.channels ?? null,
    };
  } catch {
    return { durationSec: null, channels: null };
  }
}

async function main(): Promise<void> {
  const limit = arg('limit', 5);
  const days = arg('days', 30);
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  if (config.tcxMode !== 'live') {
    throw new Error('run with TCX_MODE=live and TCX_ACCESS_TOKEN');
  }

  const db = openDb(config.dbPath);
  migrate(db);

  const callsRepo = new CallsRepo(db);
  const recordingsRepo = new RecordingsRepo(db);
  const jobsRepo = new JobsRepo(db);
  const connector = new LiveThreeCX(config, log);

  const since = new Date(Date.now() - days * 86_400_000);

  try {
    const calls = (await connector.listCalls(since))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);

    log.info({ limit, days, found: calls.length }, 'selecting newest calls');

    const selected: string[] = [];
    for (const call of calls) {
      let fromE164 = call.fromE164;
      let toE164 = call.toE164;
      if (call.direction === 'inbound') {
        fromE164 = normalisePhone(call.fromRaw).e164 ?? fromE164;
      } else if (call.direction === 'outbound') {
        toE164 = normalisePhone(call.toRaw).e164 ?? toE164;
      }

      const upserted = callsRepo.upsert({
        tcxCallId: call.tcxCallId,
        segmentIds: call.segmentIds,
        direction: call.direction,
        fromRaw: call.fromRaw,
        fromE164,
        toRaw: call.toRaw,
        toE164,
        ext: call.ext,
        agentExt: call.agentExt,
        queue: call.queue,
        outcome: deriveOutcome(call, config.tcxAiExt),
        startedAt: call.startedAt,
        answeredAt: call.answeredAt,
        endedAt: call.endedAt,
        ringSec: call.ringSec,
        talkSec: call.talkSec,
      });
      selected.push(call.tcxCallId);
      log.info(
        {
          callId: upserted.row.id,
          tcxCallId: call.tcxCallId,
          startedAt: call.startedAt,
          direction: call.direction,
          ext: call.ext,
          outcome: upserted.row.outcome,
        },
        'call upserted',
      );
    }

    const selectedSet = new Set(selected);
    const recordings = (await connector.listRecordings(since)).filter(
      (recording) =>
        recording.callTcxId && selectedSet.has(recording.callTcxId),
    );

    log.info({ recordings: recordings.length }, 'recordings for selected calls');

    let downloaded = 0;
    let reused = 0;
    let jobs = 0;

    for (const recording of recordings) {
      const call = recording.callTcxId
        ? callsRepo.getByTcxId(recording.callTcxId)
        : undefined;

      let row = recordingsRepo.getByTcxId(recording.tcxRecId);

      if (row && existsSync(row.file_path)) {
        reused += 1;
        if (call && row.call_id !== call.id) {
          recordingsRepo.linkToCall(row.id, call.id);
        }
      } else {
        const date = new Date(recording.startedAt);
        const dir = join(
          config.recordingsDir,
          String(date.getUTCFullYear()),
          String(date.getUTCMonth() + 1).padStart(2, '0'),
        );
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.${sanitise(recording.tcxRecId)}.part`);
        const finalPath = join(dir, `${sanitise(recording.tcxRecId)}.wav`);

        const hash = createHash('sha256');
        let bytes = 0;
        const source = await connector.downloadRecording(recording.tcxRecId);
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buffer);
            bytes += buffer.length;
            callback(null, buffer);
          },
        });

        try {
          await pipeline(source, meter, createWriteStream(tmp));
        } catch (error) {
          await unlink(tmp).catch(() => undefined);
          throw error;
        }

        const probed = await probe(tmp);
        await rename(tmp, finalPath);

        const inserted = recordingsRepo.insertIfAbsent({
          tcxRecId: recording.tcxRecId,
          callId: call?.id ?? null,
          filePath: finalPath,
          sha256: hash.digest('hex'),
          bytes,
          durationSec: probed.durationSec ?? recording.durationSec,
          channels: probed.channels ?? recording.channels,
        });
        row = inserted.row;
        downloaded += 1;
      }

      const job = jobsRepo.createIfAbsent({
        type: 'transcribe',
        refId: row.id,
      });
      if (job) jobs += 1;
    }

    log.info(
      { selected: calls.length, recordings: recordings.length, downloaded, reused, jobs },
      're-transcription queued',
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
