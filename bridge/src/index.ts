import { mkdir } from 'node:fs/promises';
import { buildApp } from './app.js';
import type { ApiDeps } from './api/deps.js';
import { VoiceBridge } from './ai/bridge.js';
import { AiSettingsService } from './ai/settings.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import {
  createAgentSessionFactory,
  createElevenLabsClient,
} from './elevenlabs/index.js';
import { KbSyncRunner, enqueueKbSync } from './kb/runner.js';
import { seedKnowledgeBase } from './kb/seed.js';
import { KbSyncer } from './kb/sync.js';
import { createDecisionModel } from './decisions/index.js';
import { DecisionRunner } from './decisions/runner.js';
import { BackupRunner } from './maintenance/backup.js';
import { CompressRunner } from './maintenance/compress.js';
import { Alerter, Heartbeat } from './maintenance/ops.js';
import { RetentionRunner } from './maintenance/retention.js';
import { CallLogPoller } from './poller/callLog.js';
import { PresencePoller } from './poller/presence.js';
import { RecordingsPoller } from './poller/recordings.js';
import { Scheduler } from './poller/scheduler.js';
import { PortalClient } from './portal/client.js';
import { AgentsRepo } from './repo/agents.js';
import { AiConversationsRepo } from './repo/aiConversations.js';
import { CallsRepo } from './repo/calls.js';
import { CallSegmentsRepo } from './repo/callSegments.js';
import { CheckpointsRepo } from './repo/checkpoints.js';
import { DecisionsRepo } from './repo/decisions.js';
import { JobsRepo } from './repo/jobs.js';
import { KbRepo } from './repo/kb.js';
import { MetricsRepo } from './repo/metrics.js';
import { OutboxRepo } from './repo/outbox.js';
import { PresenceRepo } from './repo/presence.js';
import { RecordingsRepo } from './repo/recordings.js';
import { SettingsRepo } from './repo/settings.js';
import { SummariesRepo } from './repo/summaries.js';
import { TranscriptsRepo } from './repo/transcripts.js';
import { createSummariser } from './summariser/index.js';
import { SummariserRunner } from './summariser/runner.js';
import { createConnector } from './threecx/index.js';
import { createSoftphone } from './threecx/softphone/index.js';
import { createLogger } from './util/logger.js';
import { buildConnectorDegraded } from './webhooks/events.js';
import { OutboxDispatcher } from './webhooks/outbox.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);

  await mkdir(config.recordingsDir, { recursive: true });
  await mkdir(config.chromiumProfileDir, { recursive: true });

  const db = openDb(config.dbPath);
  const migration = migrate(db);
  log.info(migration, 'database ready');

  const connector = await createConnector(config, log);
  try {
    await connector.ensureAuth();
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'initial 3CX authentication failed; continuing in degraded mode',
    );
  }

  const calls = new CallsRepo(db);
  const callSegments = new CallSegmentsRepo(db);
  const recordings = new RecordingsRepo(db);
  recordings.backfillExpiry(config.retentionAudioDays);
  const checkpoints = new CheckpointsRepo(db);
  const outbox = new OutboxRepo(db);
  const jobs = new JobsRepo(db);
  const presence = new PresenceRepo(db);
  const transcripts = new TranscriptsRepo(db);
  const summaries = new SummariesRepo(db);
  const decisions = new DecisionsRepo(db);
  const agents = new AgentsRepo(db);
  const settings = new SettingsRepo(db);

  // The drop threshold is a metric definition, so keep it in settings for the view.
  settings.set('drop_threshold_sec', String(config.dropThresholdSec));

  const metrics = new MetricsRepo(db, agents, config.activeStatuses);

  const kb = new KbRepo(db);
  const aiConversations = new AiConversationsRepo(db);
  const elevenlabs = createElevenLabsClient(config, log);
  const softphone = createSoftphone(config, log);
  const aiSettings = new AiSettingsService(
    settings,
    softphone,
    config.aiMode,
    log,
  );
  const kbSyncer = new KbSyncer(kb, elevenlabs, log);

  const seededDocs = seedKnowledgeBase(kb, config.kbSeedDir, log);
  if (seededDocs > 0 || kb.list().some((doc) => kb.needsSync(doc))) {
    enqueueKbSync(jobs);
  }

  const deps: ApiDeps = {
    config,
    db,
    log,
    connector,
    agents,
    metrics,
    calls,
    recordings,
    checkpoints,
    outbox,
    jobs,
    presence,
    transcripts,
    summaries,
    decisions,
    kb,
    kbSyncer,
    aiConversations,
    aiSettings,
    settings,
  };

  const app = await buildApp(deps);
  const scheduler = new Scheduler(log);

  const callLogPoller = new CallLogPoller({
    config,
    connector,
    calls,
    callSegments,
    checkpoints,
    outbox,
    log,
  });
  const recordingsPoller = new RecordingsPoller({
    config,
    connector,
    calls,
    recordings,
    checkpoints,
    jobs,
    log,
  });
  const presencePoller = new PresencePoller({
    config,
    connector,
    presence,
    agents,
    checkpoints,
    log,
  });
  const dispatcher = new OutboxDispatcher(config, outbox, calls, log);

  const summariser = createSummariser(config, log);
  const summariserRunner = new SummariserRunner({
    config,
    db,
    jobs,
    calls,
    transcripts,
    summaries,
    outbox,
    summariser,
    log,
  });
  const decisionRunner = new DecisionRunner({
    config,
    jobs,
    calls,
    transcripts,
    decisions,
    outbox,
    model: createDecisionModel(config, log),
    log,
  });

  const kbRunner = new KbSyncRunner(config, jobs, kbSyncer, log);
  const alerter = new Alerter(config, log);
  const portal = new PortalClient(config, log);
  const sessionFactory = createAgentSessionFactory(config, log, elevenlabs);
  const voiceBridge = new VoiceBridge({
    config,
    log,
    softphone,
    sessions: sessionFactory,
    elevenlabs,
    portal,
    calls,
    aiConversations,
    outbox,
    alert: (event, detail) => alerter.send(event, detail),
  });
  if (config.aiVoiceEnabled) voiceBridge.start();

  const backupRunner = new BackupRunner(config, db, settings, log);
  const retentionRunner = new RetentionRunner(config, recordings, settings, log);
  const compressRunner = new CompressRunner(config, jobs, recordings, log);
  const heartbeat = new Heartbeat(
    config,
    settings,
    log,
    () => ({
      status: connector.state() === 'degraded' ? 'degraded' : 'ok',
      connector: {
        mode: connector.mode,
        state: connector.state(),
        last_error: connector.lastError(),
      },
      jobs: jobs.counts(),
      outbox_pending: outbox.pendingCount(),
    }),
    alerter,
  );

  try {
    await aiSettings.applyCurrent();
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'could not apply AI mode at startup',
    );
  }

  let degradedNotified = false;

  scheduler.every('call-log', config.pollCallsMs, async () => {
    await callLogPoller.poll();

    if (connector.state() === 'degraded') {
      if (!degradedNotified) {
        outbox.enqueue(
          'connector.degraded',
          buildConnectorDegraded(connector.lastError()),
        );
        void alerter.send('connector.degraded', {
          error: connector.lastError(),
        });
        degradedNotified = true;
      }
    } else {
      degradedNotified = false;
    }
  });

  scheduler.every('recordings', config.pollRecordingsMs, async () => {
    await recordingsPoller.poll();
  });

  scheduler.every('presence', config.pollPresenceMs, async () => {
    await presencePoller.poll();
  });

  scheduler.every('outbox', config.outboxIntervalMs, async () => {
    await dispatcher.dispatchOnce();
  });

  scheduler.every('summarise', config.summariserIntervalMs, async () => {
    await summariserRunner.runOnce();
  });

  scheduler.every('decision', config.decisionIntervalMs, async () => {
    if (config.decisionEnabled) await decisionRunner.runOnce();
  });

  scheduler.every('stale-jobs', 60_000, async () => {
    const cutoff = new Date(Date.now() - config.jobStaleMs);
    const requeuedTranscribe = jobs.requeueStale('transcribe', cutoff);
    const requeuedSummarise = jobs.requeueStale('summarise', cutoff);
    const requeuedDecision = jobs.requeueStale('decision', cutoff);
    const requeuedCompress = jobs.requeueStale('compress', cutoff);
    const requeuedKb = jobs.requeueStale('kb_sync', cutoff);
    if (
      requeuedTranscribe > 0 ||
      requeuedSummarise > 0 ||
      requeuedDecision > 0 ||
      requeuedCompress > 0 ||
      requeuedKb > 0
    ) {
      log.warn(
        {
          requeuedTranscribe,
          requeuedSummarise,
          requeuedDecision,
          requeuedCompress,
          requeuedKb,
        },
        'requeued stale jobs left by a stopped worker',
      );
    }
  });

  scheduler.every('kb-sync', config.kbSyncIntervalMs, async () => {
    await kbRunner.runOnce();
  });

  scheduler.every('compress', 60_000, async () => {
    await compressRunner.runOnce();
  });

  scheduler.every('backup', config.maintenanceIntervalMs, async () => {
    await backupRunner.maybeRun();
  });

  scheduler.every('retention', config.maintenanceIntervalMs, async () => {
    await retentionRunner.maybeRun();
  });

  scheduler.every('heartbeat', config.heartbeatIntervalMs, async () => {
    await heartbeat.sendOnce();
  });

  if (config.aiVoiceEnabled) {
    scheduler.every('ai-watchdog', config.aiWatchdogIntervalMs, async () => {
      await voiceBridge.tick();
    });
  }

  await app.listen({ host: config.apiHost, port: config.apiPort });
  log.info(
    { host: config.apiHost, port: config.apiPort, mode: config.tcxMode },
    '3cx-bridge listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    await scheduler.stop();
    await voiceBridge.stop().catch(() => undefined);
    await app.close().catch(() => undefined);
    await connector.close().catch(() => undefined);
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
