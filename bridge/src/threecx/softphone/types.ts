export interface IncomingCall {
  callId: string;
  fromRaw: string;
  fromE164?: string | null;
  startedAt?: string;
}

export type SoftphoneStatus = 'available' | 'dnd';

export interface AudioTransport {
  start(): Promise<void>;
  onCallerAudio(cb: (pcm: Buffer) => void): void;
  sendAgentAudio(pcm: Buffer): void;
  flushPlayback(): void;
  stop(): Promise<void>;
}

export interface ThreeCXSoftphone {
  readonly mode: 'mock' | 'live';
  ensureReady(): Promise<void>;
  setStatus(status: SoftphoneStatus): Promise<void>;
  answer(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  onIncomingCall(cb: (call: IncomingCall) => void): void;
  onCallEnded(cb: (callId: string) => void): void;
  createTransport(): Promise<AudioTransport>;
  close(): Promise<void>;
}
