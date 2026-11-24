import type { Db } from '../db/index.js';

export interface TranscriptRow {
  call_id: string;
  engine: string | null;
  model: string | null;
  language: string | null;
  text: string | null;
  segments_json: string | null;
  created_at: string;
}

export interface UpsertTranscriptInput {
  callId: string;
  engine: string | null;
  model: string | null;
  language: string | null;
  text: string | null;
  segments: unknown[];
}

export class TranscriptsRepo {
  constructor(private readonly db: Db) {}

  getByCallId(callId: string): TranscriptRow | undefined {
    return this.db
      .prepare('SELECT * FROM transcripts WHERE call_id = ?')
      .get(callId) as TranscriptRow | undefined;
  }

  upsert(input: UpsertTranscriptInput): TranscriptRow {
    this.db
      .prepare(
        `INSERT INTO transcripts (call_id, engine, model, language, text, segments_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET
           engine = excluded.engine,
           model = excluded.model,
           language = excluded.language,
           text = excluded.text,
           segments_json = excluded.segments_json,
           created_at = excluded.created_at`,
      )
      .run(
        input.callId,
        input.engine,
        input.model,
        input.language,
        input.text,
        JSON.stringify(input.segments),
        new Date().toISOString(),
      );

    return this.getByCallId(input.callId) as TranscriptRow;
  }

  parseSegments(row: TranscriptRow): unknown[] {
    if (!row.segments_json) return [];
    try {
      const parsed = JSON.parse(row.segments_json) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
