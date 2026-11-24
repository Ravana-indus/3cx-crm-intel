import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import type {
  ThreeCXConnector,
  TcxCall,
  TcxRecording,
  TcxPresence,
} from './types.js';

function loadFixture<T>(file: string): T {
  const candidates = [
    new URL(`./fixtures/${file}`, import.meta.url),
    join(process.cwd(), 'src', 'threecx', 'fixtures', file),
    join(process.cwd(), 'threecx', 'fixtures', file),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as T;
    }
  }

  throw new Error(`Mock fixture not found: ${file}`);
}

const fixtureCalls = loadFixture<TcxCall[]>('calls.json');
const fixtureRecordings = loadFixture<TcxRecording[]>('recordings.json');
const fixturePresence = loadFixture<TcxPresence[]>('presence.json');

/**
 * A 16-bit PCM WAV of silence. Gives the recordings poller and ffprobe a real
 * file to work with without shipping a binary fixture.
 */
export function makeSilentWav(
  seconds: number,
  channels: number,
  sampleRate = 8000,
): Buffer {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function failOnce(errorEnv: string): void {
  if (process.env[errorEnv] === '1') {
    delete process.env[errorEnv];
    const error = new Error('Mock 3CX 401 Unauthorized') as Error & { status: number };
    error.status = 401;
    throw error;
  }
}

export class MockThreeCX implements ThreeCXConnector {
  readonly mode = 'mock' as const;
  private status: 'ok' | 'degraded' = 'ok';
  private lastFailure: string | null = null;

  constructor(private readonly config: Config, private readonly log: Logger) {}

  async ensureAuth(): Promise<void> {
    failOnce('TCX_MOCK_FAIL_401_ONCE');
    this.status = 'ok';
    this.lastFailure = null;
  }

  async listCalls(since: Date): Promise<TcxCall[]> {
    this.failIfRequested('calls');
    failOnce('TCX_MOCK_FAIL_401_ONCE');
    const sinceMs = since.getTime();
    return fixtureCalls
      .filter((call) => Date.parse(call.startedAt) >= sinceMs)
      .map((call) => clone(call));
  }

  async listRecordings(since: Date): Promise<TcxRecording[]> {
    this.failIfRequested('recordings');
    const sinceMs = since.getTime();
    return fixtureRecordings
      .filter((recording) => Date.parse(recording.startedAt) >= sinceMs)
      .map((recording) => clone(recording));
  }

  async downloadRecording(id: string): Promise<Readable> {
    this.failIfRequested('download');
    const recording = fixtureRecordings.find((entry) => entry.tcxRecId === id);
    if (!recording) {
      throw new Error(`Mock recording not found: ${id}`);
    }

    this.log.debug({ recordingId: id }, 'mock recording download');
    return Readable.from([
      makeSilentWav(recording.durationSec ?? 1, recording.channels ?? 1),
    ]);
  }

  async getPresence(): Promise<TcxPresence[]> {
    if (!this.config.epPresence) return [];
    this.failIfRequested('presence');
    return clone(fixturePresence);
  }

  state(): 'ok' | 'degraded' {
    return this.status;
  }

  lastError(): string | null {
    return this.lastFailure;
  }

  async close(): Promise<void> {
    // no-op
  }

  private failIfRequested(area: string): void {
    if (process.env.TCX_MOCK_ERROR === area) {
      this.status = 'degraded';
      this.lastFailure = `Mock failure for ${area}`;
      throw new Error(this.lastFailure);
    }
  }
}
