import type { Db } from '../db/index.js';

export interface AiConversationRow {
  el_conversation_id: string;
  call_id: string | null;
  caller_e164: string | null;
  transcript_json: string | null;
  analysis_json: string | null;
  collected_json: string | null;
  lead_id: string | null;
  created_at: string;
}

export interface UpsertAiConversationInput {
  elConversationId: string;
  callId: string | null;
  callerE164: string | null;
  transcript: unknown;
  analysis: unknown;
  collected: unknown;
  leadId: string | null;
}

export class AiConversationsRepo {
  constructor(private readonly db: Db) {}

  upsert(input: UpsertAiConversationInput): AiConversationRow {
    this.db
      .prepare(
        `INSERT INTO ai_conversations (
          el_conversation_id, call_id, caller_e164, transcript_json,
          analysis_json, collected_json, lead_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(el_conversation_id) DO UPDATE SET
          call_id = COALESCE(excluded.call_id, ai_conversations.call_id),
          caller_e164 = excluded.caller_e164,
          transcript_json = excluded.transcript_json,
          analysis_json = excluded.analysis_json,
          collected_json = excluded.collected_json,
          lead_id = COALESCE(excluded.lead_id, ai_conversations.lead_id)`,
      )
      .run(
        input.elConversationId,
        input.callId,
        input.callerE164,
        JSON.stringify(input.transcript ?? null),
        JSON.stringify(input.analysis ?? null),
        JSON.stringify(input.collected ?? null),
        input.leadId,
        new Date().toISOString(),
      );

    return this.getByElId(input.elConversationId) as AiConversationRow;
  }

  getByElId(id: string): AiConversationRow | undefined {
    return this.db
      .prepare('SELECT * FROM ai_conversations WHERE el_conversation_id = ?')
      .get(id) as AiConversationRow | undefined;
  }

  getByCallId(callId: string): AiConversationRow | undefined {
    return this.db
      .prepare('SELECT * FROM ai_conversations WHERE call_id = ? LIMIT 1')
      .get(callId) as AiConversationRow | undefined;
  }

  list(from: Date, to: Date, limit = 200): AiConversationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ai_conversations
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(from.toISOString(), to.toISOString(), limit) as AiConversationRow[];
  }

  linkCall(elConversationId: string, callId: string): void {
    this.db
      .prepare(
        'UPDATE ai_conversations SET call_id = ? WHERE el_conversation_id = ?',
      )
      .run(callId, elConversationId);
  }
}
