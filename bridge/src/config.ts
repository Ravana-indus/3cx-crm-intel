import 'dotenv/config';
import { z } from 'zod';

const boolEnv = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no'])
  .transform((value) => ['1', 'true', 'yes'].includes(value));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  TZ: z.string().default('Asia/Colombo'),

  TCX_MODE: z.enum(['mock', 'live']).default('mock'),
  TCX_URL: z.string().optional(),
  TCX_SERVICE_USER: z.string().optional(),
  TCX_SERVICE_PASSWORD: z.string().optional(),
  TCX_AI_EXT: z.string().optional(),
  TCX_AI_PASSWORD: z.string().optional(),
  // Testing/bootstrap only: skip the browser login with a captured bearer token.
  TCX_ACCESS_TOKEN: z.string().optional(),

  TCX_EP_CALLS: z
    .string()
    .default('/xapi/v1/ReportCallLogData/Pbx.GetCallLogData'),
  TCX_EP_RECORDINGS: z.string().default('/xapi/v1/Recordings'),
  TCX_EP_DOWNLOAD: z
    .string()
    .default('/xapi/v1/Recordings/Pbx.DownloadRecording(recId={id})'),
  TCX_EP_PRESENCE: z.string().default('/xapi/v1/Users'),

  PORTAL_TOKEN: z.string().min(1).default('dev-portal-token'),
  PORTAL_API_URL: z.string().default(''),
  PUBLIC_BASE_URL: z.string().optional(),
  PORTAL_WEBHOOK_URL: z.string().optional(),
  PORTAL_WEBHOOK_SECRET: z.string().min(1).default('dev-webhook-secret'),

  WORKER_TOKEN: z.string().min(1).default('dev-worker-token'),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_MODE: z.enum(['mock', 'live']).default('mock'),
  ELEVENLABS_BASE_URL: z.string().default('https://api.elevenlabs.io'),

  AI_MODE: z.enum(['off', 'overflow', 'always']).default('overflow'),
  AI_VOICE_ENABLED: boolEnv.default('0'),
  AI_WATCHDOG_MS: z.coerce.number().int().positive().default(10_000),
  AI_WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),

  KB_SEED_DIR: z.string().default('../kb'),
  KB_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  PORTAL_API_TOKEN: z.string().optional(),

  HEARTBEAT_URL: z.string().optional(),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  ALERT_WEBHOOK_URL: z.string().optional(),

  BACKUP_DIR: z.string().default('./data/backups'),
  BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  BACKUP_MINUTE: z.coerce.number().int().min(0).max(59).default(0),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  RETENTION_AUDIO_DAYS: z.coerce.number().int().positive().default(365),
  COMPRESS_AUDIO: boolEnv.default('1'),
  COMPRESS_BITRATE: z.string().default('32k'),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  DB_PATH: z.string().default('./data/bridge.db'),
  RECORDINGS_DIR: z.string().default('./data/recordings'),
  CHROMIUM_PROFILE_DIR: z.string().default('./data/chromium'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(8080),

  POLL_CALLS_MS: z.coerce.number().int().positive().default(120_000),
  POLL_RECORDINGS_MS: z.coerce.number().int().positive().default(120_000),
  POLL_PRESENCE_MS: z.coerce.number().int().positive().default(60_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  OVERLAP_MS: z.coerce.number().int().nonnegative().default(600_000),
  INITIAL_LOOKBACK_MS: z.coerce.number().int().positive().default(604_800_000),

  RECORDING_LINK_TTL_SEC: z.coerce.number().int().positive().default(900),
  DROP_THRESHOLD_SEC: z.coerce.number().int().positive().default(10),
  ACTIVE_STATUSES: z.string().default('available,ready,online'),

  SUMMARISER: z.enum(['mock', 'ollama']).default('mock'),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SUMMARISER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  JOB_STALE_MS: z.coerce.number().int().positive().default(1_800_000),

  DECISION_ENABLED: boolEnv.default('0'),
  DECISION_MODEL: z.enum(['mock', 'laya']).default('mock'),
  DECISION_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  DECISION_MAX_TRANSCRIPT_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(48_000),
  LAYA_BASE_URL: z.string().default('http://127.0.0.1:8000'),
  LAYA_MODEL: z.string().default('typed-decisions'),
  LAYA_API_KEY: z.string().optional(),
  LAYA_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

export interface Config {
  nodeEnv: string;
  logLevel: string;
  tz: string;

  tcxMode: 'mock' | 'live';
  tcxUrl: string | null;
  tcxServiceUser: string | null;
  tcxServicePassword: string | null;
  tcxAiExt: string | null;
  tcxAiPassword: string | null;
  tcxAccessToken: string | null;
  epCalls: string;
  epRecordings: string;
  epDownload: string;
  epPresence: string | null;

  portalToken: string;
  portalApiUrl: string;
  publicBaseUrl: string | null;
  portalWebhookUrl: string | null;
  portalWebhookSecret: string;

  workerToken: string;

  elevenLabsApiKey: string | null;
  elevenLabsAgentId: string | null;
  elevenLabsMode: 'mock' | 'live';
  elevenLabsBaseUrl: string;

  aiMode: 'off' | 'overflow' | 'always';
  aiVoiceEnabled: boolean;
  aiWatchdogMs: number;
  aiWatchdogIntervalMs: number;

  kbSeedDir: string;
  kbSyncIntervalMs: number;

  portalApiToken: string | null;

  heartbeatUrl: string | null;
  heartbeatIntervalMs: number;
  alertWebhookUrl: string | null;

  backupDir: string;
  backupHour: number;
  backupMinute: number;
  backupRetentionDays: number;
  retentionAudioDays: number;
  compressAudio: boolean;
  compressBitrate: string;
  maintenanceIntervalMs: number;

  dbPath: string;
  recordingsDir: string;
  chromiumProfileDir: string;
  apiHost: string;
  apiPort: number;

  pollCallsMs: number;
  pollRecordingsMs: number;
  pollPresenceMs: number;
  outboxIntervalMs: number;
  overlapMs: number;
  initialLookbackMs: number;

  recordingLinkTtlSec: number;
  dropThresholdSec: number;
  activeStatuses: string[];

  summariser: 'mock' | 'ollama';
  ollamaUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  summariserIntervalMs: number;
  jobStaleMs: number;

  decisionEnabled: boolean;
  decisionModel: 'mock' | 'laya';
  decisionIntervalMs: number;
  decisionMaxTranscriptChars: number;
  layaBaseUrl: string;
  layaModel: string;
  layaApiKey: string | null;
  layaTimeoutMs: number;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const e = parsed.data;
  const config: Config = {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    tz: e.TZ,

    tcxMode: e.TCX_MODE,
    tcxUrl: nonEmpty(e.TCX_URL),
    tcxServiceUser: nonEmpty(e.TCX_SERVICE_USER),
    tcxServicePassword: nonEmpty(e.TCX_SERVICE_PASSWORD),
    tcxAiExt: nonEmpty(e.TCX_AI_EXT),
    tcxAiPassword: nonEmpty(e.TCX_AI_PASSWORD),
    tcxAccessToken: nonEmpty(e.TCX_ACCESS_TOKEN),
    epCalls: e.TCX_EP_CALLS,
    epRecordings: e.TCX_EP_RECORDINGS,
    epDownload: e.TCX_EP_DOWNLOAD,
    epPresence: nonEmpty(e.TCX_EP_PRESENCE),

    portalToken: e.PORTAL_TOKEN,
    portalApiUrl: e.PORTAL_API_URL,
    publicBaseUrl: nonEmpty(e.PUBLIC_BASE_URL),
    portalWebhookUrl: nonEmpty(e.PORTAL_WEBHOOK_URL),
    portalWebhookSecret: e.PORTAL_WEBHOOK_SECRET,

    workerToken: e.WORKER_TOKEN,

    elevenLabsApiKey: nonEmpty(e.ELEVENLABS_API_KEY),
    elevenLabsAgentId: nonEmpty(e.ELEVENLABS_AGENT_ID),
    elevenLabsMode: e.ELEVENLABS_MODE,
    elevenLabsBaseUrl: e.ELEVENLABS_BASE_URL.replace(/\/$/, ''),

    aiMode: e.AI_MODE,
    aiVoiceEnabled: e.AI_VOICE_ENABLED,
    aiWatchdogMs: e.AI_WATCHDOG_MS,
    aiWatchdogIntervalMs: e.AI_WATCHDOG_INTERVAL_MS,

    kbSeedDir: e.KB_SEED_DIR,
    kbSyncIntervalMs: e.KB_SYNC_INTERVAL_MS,

    portalApiToken: nonEmpty(e.PORTAL_API_TOKEN),

    heartbeatUrl: nonEmpty(e.HEARTBEAT_URL),
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    alertWebhookUrl: nonEmpty(e.ALERT_WEBHOOK_URL),

    backupDir: e.BACKUP_DIR,
    backupHour: e.BACKUP_HOUR,
    backupMinute: e.BACKUP_MINUTE,
    backupRetentionDays: e.BACKUP_RETENTION_DAYS,
    retentionAudioDays: e.RETENTION_AUDIO_DAYS,
    compressAudio: e.COMPRESS_AUDIO,
    compressBitrate: e.COMPRESS_BITRATE,
    maintenanceIntervalMs: e.MAINTENANCE_INTERVAL_MS,

    dbPath: e.DB_PATH,
    recordingsDir: e.RECORDINGS_DIR,
    chromiumProfileDir: e.CHROMIUM_PROFILE_DIR,
    apiHost: e.API_HOST,
    apiPort: e.API_PORT,

    pollCallsMs: e.POLL_CALLS_MS,
    pollRecordingsMs: e.POLL_RECORDINGS_MS,
    pollPresenceMs: e.POLL_PRESENCE_MS,
    outboxIntervalMs: e.OUTBOX_INTERVAL_MS,
    overlapMs: e.OVERLAP_MS,
    initialLookbackMs: e.INITIAL_LOOKBACK_MS,

    recordingLinkTtlSec: e.RECORDING_LINK_TTL_SEC,
    dropThresholdSec: e.DROP_THRESHOLD_SEC,
    activeStatuses: e.ACTIVE_STATUSES.split(',')
      .map((status) => status.trim().toLowerCase())
      .filter(Boolean),

    summariser: e.SUMMARISER,
    ollamaUrl: e.OLLAMA_URL,
    ollamaModel: e.OLLAMA_MODEL,
    ollamaTimeoutMs: e.OLLAMA_TIMEOUT_MS,
    summariserIntervalMs: e.SUMMARISER_INTERVAL_MS,
    jobStaleMs: e.JOB_STALE_MS,

    decisionEnabled: e.DECISION_ENABLED,
    decisionModel: e.DECISION_MODEL,
    decisionIntervalMs: e.DECISION_INTERVAL_MS,
    decisionMaxTranscriptChars: e.DECISION_MAX_TRANSCRIPT_CHARS,
    layaBaseUrl: e.LAYA_BASE_URL.replace(/\/$/, ''),
    layaModel: e.LAYA_MODEL,
    layaApiKey: nonEmpty(e.LAYA_API_KEY),
    layaTimeoutMs: e.LAYA_TIMEOUT_MS,
  };

  if (config.tcxMode === 'live' && !config.tcxAccessToken) {
    const missing: string[] = [];
    if (!config.tcxUrl) missing.push('TCX_URL');
    if (!config.tcxServiceUser) missing.push('TCX_SERVICE_USER');
    if (!config.tcxServicePassword) missing.push('TCX_SERVICE_PASSWORD');
    if (missing.length > 0) {
      throw new Error(
        `TCX_MODE=live requires: ${missing.join(', ')}. Set them in .env.`,
      );
    }
  }

  return config;
}
