import type {
  CallDirection,
  CallDisposition,
  CallOutcome,
  HangupParty,
  TcxCall,
  TcxCallSegment,
  TcxPresence,
  TcxRecording,
} from './types.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 3CX payload shapes drift between builds and between the call-log report
 * and the recordings list. These mappers accept several aliases rather than
 * assuming one exact field name.
 */
export function pick(source: unknown, keys: string[]): unknown {
  const record = asRecord(source);
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function asString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function asNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function asIsoDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapDirection(value: unknown): CallDirection {
  const text = (asString(value) ?? '').toLowerCase();
  if (text.includes('out')) return 'outbound';
  if (text.includes('internal') || text.includes('extension')) return 'internal';
  return 'inbound';
}

export function normaliseTcxCall(raw: unknown): TcxCall | null {
  const id = asString(
    pick(raw, [
      'Id',
      'id',
      'CallId',
      'call_id',
      'UniqueId',
      'unique_id',
      'CdrId',
      'cdr_id',
      'SegmentId',
      'segment_id',
    ]),
  );
  if (!id) return null;

  const startedAt = asIsoDate(
    pick(raw, ['StartTime', 'started_at', 'Start', 'CallStartTime', 'callStartTime', 'Time']),
  );
  if (!startedAt) return null;

  const answeredAt = asIsoDate(
    pick(raw, ['AnswerTime', 'answered_at', 'Answered', 'CallAnswerTime', 'callAnswerTime']),
  );
  const endedAt = asIsoDate(
    pick(raw, ['EndTime', 'ended_at', 'End', 'CallEndTime', 'callEndTime']),
  );

  const explicitTalk = asNumber(
    pick(raw, ['TalkTime', 'talk_sec', 'TalkDuration', 'TalkingTime', 'TalkSeconds']),
  );
  const explicitRing = asNumber(
    pick(raw, ['RingTime', 'ring_sec', 'RingDuration', 'RingingTime', 'RingSeconds']),
  );

  const talkSec =
    explicitTalk ??
    (answeredAt && endedAt
      ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(answeredAt)) / 1000))
      : null);

  const ringSec =
    explicitRing ??
    (answeredAt
      ? Math.max(0, Math.round((Date.parse(answeredAt) - Date.parse(startedAt)) / 1000))
      : null);

  const derivedEndedAt =
    endedAt ??
    (answeredAt && talkSec !== null
      ? new Date(Date.parse(answeredAt) + talkSec * 1000).toISOString()
      : null);

  const segmentValue = pick(raw, ['SegmentIds', 'segment_ids', 'Segments']);
  const segmentIds = Array.isArray(segmentValue)
    ? segmentValue.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [id];
  const status =
    asString(pick(raw, ['Status', 'status', 'CallStatus', 'callStatus', 'ActivityType'])) ??
    null;
  const answered = answeredAt !== null || (talkSec !== null && talkSec > 0);
  const direction = mapDirection(
    pick(raw, ['Direction', 'direction', 'CallDirection', 'CallType']),
  );
  const disposition = deriveDisposition(status, answered, talkSec, direction);
  const transfer = deriveTransfer(raw);

  return {
    tcxCallId: id,
    segmentIds,
    direction,
    fromRaw: asString(pick(raw, ['CallerNumber', 'caller', 'from', 'From', 'SrcNumber', 'Source'])) ?? '',
    fromE164: asString(pick(raw, ['CallerE164', 'from_e164'])),
    toRaw: asString(pick(raw, ['Destination', 'to', 'To', 'DstNumber', 'DialedNumber'])) ?? '',
    toE164: asString(pick(raw, ['DestinationE164', 'to_e164'])),
    ext: asString(pick(raw, ['Extension', 'extension', 'Ext', 'AgentExtension', 'RingingExtension'])),
    agentExt: asString(pick(raw, ['AgentExtension', 'agent_ext', 'AnsweredBy', 'answered_by'])),
    queue: asString(pick(raw, ['Queue', 'queue', 'QueueName', 'Group', 'GroupName'])),
    status,
    startedAt,
    answeredAt,
    endedAt: derivedEndedAt,
    ringSec,
    talkSec,
    disposition,
    hangupParty: deriveHangupParty(raw),
    queueWaitSec: deriveQueueWait(raw),
    agentUserId: deriveAgentUserId(raw),
    isMissed: deriveIsMissed(direction, disposition),
    rawStatus: status,
    transferTo: transfer.transferTo,
    transferredAt: transfer.transferredAt,
    segments: [segmentFromCallLog(raw, id)],
    raw,
  };
}

export function normaliseTcxRecording(raw: unknown): TcxRecording | null {
  const id = asString(
    pick(raw, [
      'Id',
      'id',
      'RecordingId',
      'recording_id',
      'RecId',
      'recId',
      'UniqueId',
      'Filename',
      'filename',
    ]),
  );
  if (!id) return null;

  const startedAt =
    asIsoDate(
      pick(raw, ['StartTime', 'started_at', 'Start', 'RecordingStartTime', 'Date', 'CreatedAt']),
    ) ?? new Date().toISOString();

  return {
    tcxRecId: id,
    callTcxId: asString(
      pick(raw, ['CallId', 'call_id', 'CdrId', 'cdr_id', 'CallUniqueId', 'call_unique_id']),
    ),
    ext: asString(pick(raw, ['Extension', 'extension', 'Ext', 'AgentExtension'])),
    startedAt,
    durationSec: asNumber(pick(raw, ['Duration', 'duration', 'duration_sec', 'DurationSec'])),
    channels: asNumber(pick(raw, ['Channels', 'channels', 'ChannelCount'])),
  };
}

export function normaliseTcxPresence(raw: unknown): TcxPresence | null {
  const ext = asString(pick(raw, ['Extension', 'extension', 'Ext', 'Number']));
  if (!ext) return null;
  return {
    ext,
    status: asString(pick(raw, ['Status', 'status', 'Presence', 'CurrentStatus'])) ?? 'unknown',
    at: asIsoDate(pick(raw, ['At', 'at', 'Time', 'UpdatedAt'])) ?? new Date().toISOString(),
  };
}

/** xapi: /Users returns Number + CurrentProfileName + IsRegistered. */
export function normaliseUsersPresence(
  raw: unknown,
  at = new Date().toISOString(),
): TcxPresence | null {
  const ext = asString(pick(raw, ['Number', 'Extension', 'Ext']));
  if (!ext) return null;

  const profile = asString(
    pick(raw, ['CurrentProfileName', 'Status', 'Presence']),
  );
  const registered = pick(raw, ['IsRegistered']);
  const status =
    profile ??
    (registered === false ? 'Unavailable' : 'Available');

  return {
    ext,
    status,
    at,
    ...(asString(pick(raw, ['Id', 'UserId', 'UserID']))
      ? { userId: asString(pick(raw, ['Id', 'UserId', 'UserID'])) }
      : {}),
  };
}

/** Edm.Duration arrives as PT9S, 00:00:09, or a number. */
export function parseDurationSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  const text = String(value).trim();
  const iso = text.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)$/i,
  );
  if (iso) {
    const days = Number(iso[1] ?? 0);
    const hours = Number(iso[2] ?? 0);
    const minutes = Number(iso[3] ?? 0);
    const seconds = Number(iso[4] ?? 0);
    return Math.round(days * 86400 + hours * 3600 + minutes * 60 + seconds);
  }

  const hms = text.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (hms) {
    return Math.round(
      Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]),
    );
  }

  const seconds = Number(text);
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

/**
 * PBX disposition. A raw status wins; otherwise Answered/talk time is the
 * PBX's own signal. Unknown stays null rather than being guessed.
 */
export function deriveDisposition(
  status: string | null,
  answered: boolean,
  talkSec: number | null,
  direction: CallDirection,
): CallDisposition | null {
  const text = (status ?? '').toLowerCase();

  if (text.includes('voicemail') || text.includes('voice mail')) return 'voicemail';
  if (text.includes('busy')) return 'busy';
  if (text.includes('reject') || text.includes('declin')) return 'rejected';
  if (
    text.includes('no answer') ||
    text.includes('noanswer') ||
    text.includes('not answered') ||
    text.includes('unanswered') ||
    text.includes('missed') ||
    text.includes('timeout') ||
    text.includes('abandon')
  ) {
    return 'no_answer';
  }
  if (text.includes('fail') || text.includes('error') || text.includes('unavailable')) {
    return 'failed';
  }
  if (text.includes('answered') || text.includes('connected') || text.includes('success')) {
    return 'answered';
  }

  if (answered || (talkSec !== null && talkSec > 0)) return 'answered';
  if (direction === 'internal') return null;
  return 'no_answer';
}

/** Only use a real hangup field. Never infer the party from direction/talk. */
export function deriveHangupParty(raw: unknown): HangupParty | null {
  const value = asString(
    pick(raw, [
      'HangupParty',
      'HangupBy',
      'HangupSide',
      'DisconnectParty',
      'DisconnectedBy',
      'ReleaseParty',
      'HangupCause',
      'DisconnectCause',
    ]),
  );
  if (!value) return null;
  const text = value.toLowerCase();
  if (text.includes('caller') || text.includes('source')) return 'caller';
  if (
    text.includes('callee') ||
    text.includes('destination') ||
    text.includes('agent') ||
    text.includes('extension')
  ) {
    return 'callee';
  }
  if (text.includes('system') || text.includes('pbx') || text.includes('platform')) {
    return 'system';
  }
  return null;
}

export function deriveQueueWait(raw: unknown): number | null {
  return parseDurationSeconds(
    pick(raw, [
      'QueueWaitTime',
      'QueueWaitDuration',
      'QueueWaitSeconds',
      'WaitingDuration',
      'WaitDuration',
      'WaitTime',
    ]),
  );
}

export function deriveAgentUserId(raw: unknown): string | null {
  return asString(
    pick(raw, [
      'ActionDnUserId',
      'AgentUserId',
      'AgentUserID',
      'ActionDnId',
      'AnsweredByUserId',
    ]),
  );
}

export function deriveIsMissed(
  direction: CallDirection,
  disposition: CallDisposition | null,
): boolean | null {
  if (direction !== 'inbound') return false;
  if (disposition === null) return null;
  return disposition !== 'answered';
}

export function deriveTransfer(raw: unknown): {
  transferTo: string | null;
  transferredAt: string | null;
} {
  return {
    transferTo: asString(
      pick(raw, [
        'TransferTo',
        'TransferredTo',
        'TransferDestination',
        'TransferDestinationDn',
        'RedirectTo',
        'ForwardedTo',
      ]),
    ),
    transferredAt: asIsoDate(
      pick(raw, [
        'TransferTime',
        'TransferredAt',
        'TransferDate',
        'RedirectTime',
      ]),
    ),
  };
}

export function segmentFromCallLog(
  raw: unknown,
  fallbackId: string,
): TcxCallSegment {
  const segmentId =
    asString(pick(raw, ['SegmentId', 'CallHistoryId', 'CdrId'])) ?? fallbackId;
  return {
    segmentId,
    startedAt: asIsoDate(pick(raw, ['StartTime', 'started_at'])),
    endedAt: asIsoDate(pick(raw, ['EndTime', 'ended_at'])),
    ext: asString(pick(raw, ['ActionDnDn', 'SourceDn', 'DestinationDn'])),
    actionDn: asString(pick(raw, ['ActionDnDn', 'ActionDnCallerId'])),
    status: asString(pick(raw, ['Status', 'Reason'])),
    raw,
  };
}

/** A later leg handled by a different DN is a transfer. */
export function deriveTransferFromSegments(
  segments: TcxCallSegment[],
): { transferTo: string | null; transferredAt: string | null } {
  const ordered = [...segments]
    .filter((segment) => segment.startedAt)
    .sort(
      (a, b) =>
        Date.parse(a.startedAt as string) - Date.parse(b.startedAt as string),
    );
  if (ordered.length < 2) return { transferTo: null, transferredAt: null };

  const first = ordered[0];
  const base = first.actionDn ?? first.ext;
  for (const segment of ordered.slice(1)) {
    const handler = segment.actionDn ?? segment.ext;
    if (handler && handler !== base) {
      return {
        transferTo: handler,
        transferredAt: segment.startedAt,
      };
    }
  }
  return { transferTo: null, transferredAt: null };
}

/**
 * xapi ReportCallLogData rows. The function is bound to
 * /xapi/v1/ReportCallLogData/Pbx.GetCallLogData(...) and returns
 * Pbx.CallLogData entities.
 */
export function normaliseCallLogData(raw: unknown): TcxCall | null {
  const id = asString(
    pick(raw, ['MainCallHistoryId', 'CallHistoryId', 'CdrId', 'CallId']),
  );
  if (!id) return null;

  const startedAt = asIsoDate(pick(raw, ['StartTime', 'started_at']));
  if (!startedAt) return null;

  const directionText = (
    asString(pick(raw, ['Direction', 'CallType'])) ?? ''
  ).toLowerCase();
  const direction: CallDirection = directionText.includes('out')
    ? 'outbound'
    : directionText.includes('internal')
      ? 'internal'
      : 'inbound';

  const ringSec = parseDurationSeconds(
    pick(raw, ['RingingDuration', 'ring_sec']),
  );
  const talkSec = parseDurationSeconds(
    pick(raw, ['TalkingDuration', 'talk_sec']),
  );
  const answeredValue = pick(raw, ['Answered']);
  const answered =
    answeredValue === true ||
    String(answeredValue).toLowerCase() === 'true' ||
    (talkSec !== null && talkSec > 0);

  const answeredAt = answered
    ? new Date(
        Date.parse(startedAt) + (ringSec ?? 0) * 1000,
      ).toISOString()
    : null;
  const endedAt = answeredAt
    ? new Date(
        Date.parse(answeredAt) + (talkSec ?? 0) * 1000,
      ).toISOString()
    : ringSec !== null
      ? new Date(Date.parse(startedAt) + ringSec * 1000).toISOString()
      : null;

  const sourceCaller = asString(
    pick(raw, ['SourceCallerId', 'CallerId', 'FromCallerNumber']),
  );
  const sourceDn = asString(pick(raw, ['SourceDn', 'FromDn']));
  const destinationCaller = asString(
    pick(raw, ['DestinationCallerId', 'ToCallerNumber']),
  );
  const destinationDn = asString(pick(raw, ['DestinationDn', 'ToDn']));
  const actionDn = asString(
    pick(raw, ['ActionDnDn', 'ActionDnCallerId', 'actionDnDn']),
  );

  const ext =
    direction === 'internal'
      ? sourceDn
      : actionDn ??
        (direction === 'outbound' ? sourceDn : destinationDn) ??
        null;
  const fromRaw =
    direction === 'internal'
      ? sourceDn ?? sourceCaller ?? ''
      : direction === 'outbound'
        ? sourceDn ?? sourceCaller ?? ''
        : sourceCaller ?? sourceDn ?? '';
  const toRaw =
    direction === 'internal'
      ? destinationDn ?? destinationCaller ?? ''
      : direction === 'outbound'
        ? destinationCaller ?? destinationDn ?? ''
        : destinationDn ?? destinationCaller ?? '';
  const queue =
    direction === 'inbound' &&
    destinationDn !== null &&
    destinationDn !== ext
      ? destinationDn
      : null;

  const segmentIds = [
    asString(pick(raw, ['CallHistoryId'])),
    asString(pick(raw, ['CdrId'])),
    asString(pick(raw, ['SegmentId'])),
  ].filter((entry): entry is string => Boolean(entry));

  const status =
    asString(pick(raw, ['Status', 'Reason', 'CallType'])) ?? null;
  const disposition = deriveDisposition(status, answered, talkSec, direction);
  const transfer = deriveTransfer(raw);

  return {
    tcxCallId: id,
    segmentIds: segmentIds.length > 0 ? segmentIds : [id],
    direction,
    fromRaw,
    fromE164: null,
    toRaw,
    toE164: null,
    ext,
    agentExt: direction === 'internal' ? sourceDn : actionDn,
    queue,
    status,
    startedAt,
    answeredAt,
    endedAt,
    ringSec,
    talkSec,
    disposition,
    hangupParty: deriveHangupParty(raw),
    queueWaitSec: deriveQueueWait(raw),
    agentUserId: deriveAgentUserId(raw),
    isMissed: deriveIsMissed(direction, disposition),
    rawStatus: status,
    transferTo: transfer.transferTo,
    transferredAt: transfer.transferredAt,
    segments: [segmentFromCallLog(raw, id)],
    raw,
  };
}

/**
 * One outcome per call, derived from the call log. Order matters: an AI
 * extension answering is reported as ai_handled even though it also has a
 * talk time.
 */
export function deriveOutcome(call: TcxCall, aiExt: string | null): CallOutcome {
  if (call.direction === 'outbound') return 'outbound';
  if (call.direction === 'internal') return 'internal';

  const status = (call.status ?? '').toLowerCase();
  if (status.includes('abandon')) return 'abandoned';

  if (aiExt && (call.agentExt === aiExt || call.ext === aiExt)) {
    return 'ai_handled';
  }

  if (call.answeredAt || (call.talkSec !== null && call.talkSec > 0)) {
    return 'answered';
  }

  return 'missed';
}
