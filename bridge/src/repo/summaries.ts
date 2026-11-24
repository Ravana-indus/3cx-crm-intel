import type { Db } from '../db/index.js';

export interface SummaryRow {
  call_id: string;
  model: string | null;
  summary: string | null;
  extracted_json: string | null;
  created_at: string;
}

export interface UpsertSummaryInput {
  callId: string;
  model: string | null;
  summary: string;
  extracted: unknown;
}

export class SummariesRepo {
  constructor(private readonly db: Db) {}

  getByCallId(callId: string): SummaryRow | undefined {
    return this.db
      .prepare('SELECT * FROM summaries WHERE call_id = ?')
      .get(callId) as SummaryRow | undefined;
  }

  upsert(input: UpsertSummaryInput): SummaryRow {
    this.db
      .prepare(
        `INSERT INTO summaries (call_id, model, summary, extracted_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(call_id) DO UPDATE SET
           model = excluded.model,
           summary = excluded.summary,
           extracted_json = excluded.extracted_json,
           created_at = excluded.created_at`,
      )
      .run(
        input.callId,
        input.model,
        input.summary,
        JSON.stringify(input.extracted),
        new Date().toISOString(),
      );

    return this.getByCallId(input.callId) as SummaryRow;
  }
}
