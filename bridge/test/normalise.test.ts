import { describe, expect, it } from 'vitest';
import {
  deriveOutcome,
  normaliseCallLogData,
  normaliseTcxCall,
  normaliseTcxRecording,
  normaliseUsersPresence,
  parseDurationSeconds,
} from '../src/threecx/normalise.js';
import type { TcxCall } from '../src/threecx/types.js';

function baseCall(overrides: Partial<TcxCall> = {}): TcxCall {
  return {
    tcxCallId: 'call-1',
    segmentIds: ['call-1'],
    direction: 'inbound',
    fromRaw: '0771234567',
    fromE164: null,
    toRaw: '100',
    toE164: null,
    ext: '102',
    agentExt: '102',
    queue: 'sales',
    status: 'answered',
    startedAt: '2026-11-20T04:30:00.000Z',
    answeredAt: '2026-11-20T04:30:09.000Z',
    endedAt: '2026-11-20T04:35:12.000Z',
    ringSec: 9,
    talkSec: 303,
    ...overrides,
  };
}

describe('deriveOutcome', () => {
  it('marks outbound calls', () => {
    expect(deriveOutcome(baseCall({ direction: 'outbound' }), '199')).toBe(
      'outbound',
    );
  });

  it('marks abandoned calls from status', () => {
    expect(
      deriveOutcome(
        baseCall({ status: 'Abandoned', answeredAt: null, talkSec: null }),
        '199',
      ),
    ).toBe('abandoned');
  });

  it('marks the AI extension as ai_handled even when it talked', () => {
    expect(
      deriveOutcome(baseCall({ ext: '199', agentExt: '199' }), '199'),
    ).toBe('ai_handled');
  });

  it('marks answered when there is an answer or talk time', () => {
    expect(deriveOutcome(baseCall(), '199')).toBe('answered');
  });

  it('marks missed when nobody answered', () => {
    expect(
      deriveOutcome(
        baseCall({ answeredAt: null, talkSec: null, status: 'missed' }),
        '199',
      ),
    ).toBe('missed');
  });
});

describe('normaliseTcxCall', () => {
  it('accepts aliased V20 field names', () => {
    const call = normaliseTcxCall({
      Id: 'seg-9',
      Direction: 'Inbound',
      CallerNumber: '0771234567',
      Destination: '100',
      Extension: '102',
      AgentExtension: '102',
      QueueName: 'sales',
      Status: 'Answered',
      StartTime: '2026-11-20T04:30:00.000Z',
      AnswerTime: '2026-11-20T04:30:09.000Z',
      EndTime: '2026-11-20T04:35:12.000Z',
    });

    expect(call?.tcxCallId).toBe('seg-9');
    expect(call?.direction).toBe('inbound');
    expect(call?.fromRaw).toBe('0771234567');
    expect(call?.talkSec).toBe(303);
    expect(call?.ringSec).toBe(9);
  });

  it('returns null without an id or start time', () => {
    expect(normaliseTcxCall({})).toBeNull();
    expect(normaliseTcxCall({ Id: 'x' })).toBeNull();
  });
});

describe('normaliseTcxRecording', () => {
  it('maps recording aliases', () => {
    const rec = normaliseTcxRecording({
      RecordingId: 'rec-1',
      CallId: 'seg-1',
      Extension: '102',
      StartTime: '2026-11-20T04:30:00.000Z',
      Duration: 303,
      Channels: 2,
    });

    expect(rec).toEqual({
      tcxRecId: 'rec-1',
      callTcxId: 'seg-1',
      ext: '102',
      startedAt: '2026-11-20T04:30:00.000Z',
      durationSec: 303,
      channels: 2,
    });
  });
});

describe('xapi mapping', () => {
  it('parses Edm.Duration formats', () => {
    expect(parseDurationSeconds('PT9S')).toBe(9);
    expect(parseDurationSeconds('PT2M3S')).toBe(123);
    expect(parseDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(parseDurationSeconds('PT0S')).toBe(0);
    expect(parseDurationSeconds('00:01:30')).toBe(90);
    expect(parseDurationSeconds(12)).toBe(12);
    expect(parseDurationSeconds(null)).toBeNull();
  });

  it('maps a ReportCallLogData row', () => {
    const call = normaliseCallLogData({
      MainCallHistoryId: '123',
      CallHistoryId: 'ch-1',
      CdrId: 'cdr-1',
      SegmentId: 5,
      StartTime: '2026-11-23T10:00:00Z',
      Direction: 'Inbound',
      SourceCallerId: '0771234567',
      SourceDn: '10020',
      DestinationDn: '31000',
      ActionDnDn: '31000',
      Answered: true,
      RingingDuration: 'PT9S',
      TalkingDuration: 'PT2M3S',
      Status: 'Answered',
    });

    expect(call).toBeTruthy();
    expect(call?.tcxCallId).toBe('123');
    expect(call?.segmentIds).toEqual(['ch-1', 'cdr-1', '5']);
    expect(call?.direction).toBe('inbound');
    expect(call?.fromRaw).toBe('0771234567');
    expect(call?.toRaw).toBe('31000');
    expect(call?.ext).toBe('31000');
    expect(call?.agentExt).toBe('31000');
    expect(call?.ringSec).toBe(9);
    expect(call?.talkSec).toBe(123);
    expect(call?.answeredAt).toBe('2026-11-23T10:00:09.000Z');
    expect(call?.endedAt).toBe('2026-11-23T10:02:12.000Z');
    expect(call?.status).toBe('Answered');
    expect(call?.disposition).toBe('answered');
    expect(call?.isMissed).toBe(false);
    expect(call?.segments?.[0].segmentId).toBe('5');
    expect(call?.raw).toBeTruthy();
  });

  it('maps Layer A fields only when the PBX provides them', () => {
    const call = normaliseCallLogData({
      MainCallHistoryId: '456',
      StartTime: '2026-11-23T10:00:00Z',
      Direction: 'Inbound',
      SourceCallerId: '0771234567',
      DestinationDn: '31000',
      Answered: false,
      RingingDuration: 'PT20S',
      Status: 'No Answer',
      HangupParty: 'Caller',
      QueueWaitTime: 'PT2M',
      TransferTo: '31001',
      TransferTime: '2026-11-23T10:00:10Z',
    });

    expect(call?.disposition).toBe('no_answer');
    expect(call?.isMissed).toBe(true);
    expect(call?.hangupParty).toBe('caller');
    expect(call?.queueWaitSec).toBe(120);
    expect(call?.transferTo).toBe('31001');
    expect(call?.transferredAt).toBe('2026-11-23T10:00:10.000Z');
  });

  it('leaves unknown Layer A values null rather than guessing', () => {
    const call = normaliseCallLogData({
      MainCallHistoryId: '789',
      StartTime: '2026-11-23T10:00:00Z',
      Direction: 'Inbound',
      SourceCallerId: '0771234567',
      DestinationDn: '31000',
      Answered: false,
      RingingDuration: 'PT20S',
    });

    expect(call?.disposition).toBe('no_answer');
    expect(call?.hangupParty).toBeNull();
    expect(call?.queueWaitSec).toBeNull();
    expect(call?.transferTo).toBeNull();
    expect(call?.agentUserId).toBeNull();
  });

  it('maps a 3CX user id when present', () => {
    expect(
      normaliseUsersPresence(
        {
          Id: 'user-guid',
          Number: '31000',
          CurrentProfileName: 'Available',
          IsRegistered: true,
        },
        '2026-11-23T10:00:00.000Z',
      ),
    ).toEqual({
      ext: '31000',
      status: 'Available',
      at: '2026-11-23T10:00:00.000Z',
      userId: 'user-guid',
    });
  });

  it('maps Users presence', () => {
    expect(
      normaliseUsersPresence(
        { Number: '31000', CurrentProfileName: 'Available', IsRegistered: true },
        '2026-11-23T10:00:00.000Z',
      ),
    ).toEqual({
      ext: '31000',
      status: 'Available',
      at: '2026-11-23T10:00:00.000Z',
    });
  });
});
