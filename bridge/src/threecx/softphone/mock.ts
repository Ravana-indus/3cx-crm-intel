import type { Config } from '../../config.js';
import type { Logger } from '../../util/logger.js';
import type {
  AudioTransport,
  IncomingCall,
  SoftphoneStatus,
  ThreeCXSoftphone,
} from './types.js';

export class MockAudioTransport implements AudioTransport {
  started = false;
  stopped = false;
  flushes = 0;
  readonly sentAgentAudio: Buffer[] = [];
  private callerSink: ((pcm: Buffer) => void) | null = null;

  async start(): Promise<void> {
    this.started = true;
  }

  onCallerAudio(cb: (pcm: Buffer) => void): void {
    this.callerSink = cb;
  }

  sendAgentAudio(pcm: Buffer): void {
    this.sentAgentAudio.push(Buffer.from(pcm));
  }

  flushPlayback(): void {
    this.flushes += 1;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.callerSink = null;
  }

  emitCallerAudio(pcm: Buffer): void {
    this.callerSink?.(pcm);
  }
}

export class MockSoftphone implements ThreeCXSoftphone {
  readonly mode = 'mock' as const;
  readonly statuses: SoftphoneStatus[] = [];
  readonly answered: string[] = [];
  readonly hungUp: string[] = [];
  readonly transports: MockAudioTransport[] = [];

  private incomingHandler: ((call: IncomingCall) => void) | null = null;
  private endedHandler: ((callId: string) => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  async ensureReady(): Promise<void> {
    this.log.debug('mock softphone ready');
  }

  async setStatus(status: SoftphoneStatus): Promise<void> {
    this.statuses.push(status);
  }

  async answer(callId: string): Promise<void> {
    this.answered.push(callId);
  }

  async hangup(callId: string): Promise<void> {
    this.hungUp.push(callId);
  }

  onIncomingCall(cb: (call: IncomingCall) => void): void {
    this.incomingHandler = cb;
  }

  onCallEnded(cb: (callId: string) => void): void {
    this.endedHandler = cb;
  }

  async createTransport(): Promise<AudioTransport> {
    const transport = new MockAudioTransport();
    this.transports.push(transport);
    return transport;
  }

  async close(): Promise<void> {
    this.incomingHandler = null;
    this.endedHandler = null;
  }

  // Test/dev helpers -------------------------------------------------------
  emitIncoming(call: IncomingCall): void {
    this.incomingHandler?.(call);
  }

  emitCallEnded(callId: string): void {
    this.endedHandler?.(callId);
  }

  latestTransport(): MockAudioTransport | undefined {
    return this.transports[this.transports.length - 1];
  }
}
