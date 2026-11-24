import type { Readable } from 'node:stream';

export type CallDirection = 'inbound' | 'outbound' | 'internal';

export type CallOutcome =
  | 'answered'
  | 'missed'
  | 'abandoned'
  | 'ai_handled'
  | 'outbound'
  | 'internal';

export type CallDisposition =
  | 'answered'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'voicemail'
  | 'rejected';

export type HangupParty = 'caller' | 'callee' | 'system';

/**
 * One row of the 3CX segment chain. MainCallHistoryId collapses transfers into
 * one call; the segment rows preserve who handled each leg.
 */
export interface TcxCallSegment {
  segmentId: string;
  startedAt: string | null;
  endedAt: string | null;
  ext: string | null;
  actionDn: string | null;
  status: string | null;
  raw: unknown;
}

/**
 * Provider-neutral call row. Nothing outside src/threecx/ should see raw
 * 3CX payloads; these fields are already normalised names.
 */
export interface TcxCall {
  tcxCallId: string;
  segmentIds: string[];
  direction: CallDirection;
  fromRaw: string;
  fromE164: string | null;
  toRaw: string;
  toE164: string | null;
  ext: string | null;
  agentExt: string | null;
  queue: string | null;
  status: string | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  ringSec: number | null;
  talkSec: number | null;
  disposition?: CallDisposition | null;
  hangupParty?: HangupParty | null;
  queueWaitSec?: number | null;
  agentUserId?: string | null;
  isMissed?: boolean | null;
  rawStatus?: string | null;
  transferTo?: string | null;
  transferredAt?: string | null;
  segments?: TcxCallSegment[];
  raw?: unknown;
}

export interface TcxRecording {
  tcxRecId: string;
  callTcxId: string | null;
  ext: string | null;
  startedAt: string;
  durationSec: number | null;
  channels: number | null;
}

export interface TcxPresence {
  ext: string;
  status: string;
  at: string;
  userId?: string | null;
}

export interface ThreeCXData {
  listCalls(since: Date): Promise<TcxCall[]>;
  listRecordings(since: Date): Promise<TcxRecording[]>;
  downloadRecording(id: string): Promise<Readable>;
  getPresence(): Promise<TcxPresence[]>;
}

export interface ThreeCXConnector extends ThreeCXData {
  readonly mode: 'mock' | 'live';
  ensureAuth(): Promise<void>;
  state(): 'ok' | 'degraded';
  lastError(): string | null;
  close(): Promise<void>;
}
