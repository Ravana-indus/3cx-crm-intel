import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig, type Config } from '../src/config.js';
import { AiSettingsService } from '../src/ai/settings.js';
import { MockElevenLabs } from '../src/elevenlabs/mock.js';
import { KbSyncer } from '../src/kb/sync.js';
import type { UpsertCallInput } from '../src/repo/calls.js';
import { MockSoftphone } from '../src/threecx/softphone/mock.js';
import { MockThreeCX } from '../src/threecx/mock.js';
import { AgentsRepo } from '../src/repo/agents.js';
import { AiConversationsRepo } from '../src/repo/aiConversations.js';
import { CallsRepo } from '../src/repo/calls.js';
import { CallSegmentsRepo } from '../src/repo/callSegments.js';
import { CheckpointsRepo } from '../src/repo/checkpoints.js';
import { DecisionsRepo } from '../src/repo/decisions.js';
import { JobsRepo } from '../src/repo/jobs.js';
import { KbRepo } from '../src/repo/kb.js';
import { MetricsRepo } from '../src/repo/metrics.js';
import { OutboxRepo } from '../src/repo/outbox.js';
import { PresenceRepo } from '../src/repo/presence.js';
import { RecordingsRepo } from '../src/repo/recordings.js';
import { SettingsRepo } from '../src/repo/settings.js';
import { SummariesRepo } from '../src/repo/summaries.js';
import { TranscriptsRepo } from '../src/repo/transcripts.js';
import { createLogger } from '../src/util/logger.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TZ: 'Asia/Colombo',
    TCX_MODE: 'mock',
    TCX_AI_EXT: '199',
    PORTAL_TOKEN: 'test-portal',
    PORTAL_WEBHOOK_SECRET: 'test-secret',
    PORTAL_WEBHOOK_URL: '',
    WORKER_TOKEN: 'test-worker',
    DB_PATH: ':memory:',
    API_PORT: '8080',
    INITIAL_LOOKBACK_MS: String(7 * 86_400_000),
  });

  return { ...base, ...overrides };
}

export function testDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

export function testContext(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides);
  const db = testDb();
  const log = createLogger('silent');
  const connector = new MockThreeCX(config, log);

  const settings = new SettingsRepo(db);
  settings.set(
    'drop_threshold_sec',
    String(config.dropThresholdSec),
  );

  const agents = new AgentsRepo(db);
  const kb = new KbRepo(db);
  const elevenlabs = new MockElevenLabs();
  const softphone = new MockSoftphone(config, log);

  return {
    config,
    db,
    log,
    connector,
    agents,
    metrics: new MetricsRepo(db, agents, config.activeStatuses),
    calls: new CallsRepo(db),
    callSegments: new CallSegmentsRepo(db),
    recordings: new RecordingsRepo(db),
    checkpoints: new CheckpointsRepo(db),
    decisions: new DecisionsRepo(db),
    outbox: new OutboxRepo(db),
    jobs: new JobsRepo(db),
    presence: new PresenceRepo(db),
    transcripts: new TranscriptsRepo(db),
    summaries: new SummariesRepo(db),
    settings,
    kb,
    kbSyncer: new KbSyncer(kb, elevenlabs, log),
    aiConversations: new AiConversationsRepo(db),
    aiSettings: new AiSettingsService(settings, softphone, config.aiMode, log),
    elevenlabs,
    softphone,
  };
}

export function callInput(
  overrides: Partial<UpsertCallInput> = {},
): UpsertCallInput {
  const base: UpsertCallInput = {
    tcxCallId: 'tcx-1',
    segmentIds: ['tcx-1'],
    direction: 'inbound',
    fromRaw: '0771234567',
    fromE164: '+94771234567',
    toRaw: '100',
    toE164: null,
    ext: '102',
    agentExt: '102',
    queue: 'sales',
    outcome: 'answered',
    startedAt: '2026-11-20T04:30:00.000Z',
    answeredAt: '2026-11-20T04:30:09.000Z',
    endedAt: '2026-11-20T04:35:12.000Z',
    ringSec: 9,
    talkSec: 303,
  };

  return { ...base, ...overrides };
}
