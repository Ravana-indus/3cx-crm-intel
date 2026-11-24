import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { DecisionPayload } from '../decisions/schema.js';
import type {
  DecisionFactRowInput,
  DecisionValidation,
} from '../decisions/types.js';

export type DecisionStatus =
  | 'staged'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'invalid';

export interface DecisionRow {
  id: string;
  call_id: string;
  status: DecisionStatus;
  provider: string | null;
  model: string | null;
  model_version: string | null;
  prompt_version: string | null;
  transcript_hash: string;
  input_hash: string | null;
  outcome: string | null;
  outcome_confidence: number | null;
  verdict: string | null;
  verdict_reason: string | null;
  next_action: string | null;
  next_action_confidence: number | null;
  decision_json: string;
  validation_json: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionFactRow {
  id: string;
  decision_id: string;
  call_id: string;
  field: string;
  value_json: string;
  confidence: number | null;
  evidence: string;
  evidence_start_ms: number | null;
  evidence_end_ms: number | null;
  evidence_speaker: string | null;
  confirmed_by: string | null;
  created_at: string;
}

export interface InsertDecisionInput {
  callId: string;
  status?: 'staged' | 'invalid';
  provider: string;
  model: string;
  modelVersion: string;
  promptVersion: string;
  transcriptHash: string;
  inputHash: string;
  decision: DecisionPayload;
  validation: DecisionValidation;
  facts: DecisionFactRowInput[];
}

export interface DecisionFilters {
  status?: DecisionStatus;
  from?: Date;
  to?: Date;
}

export interface DecisionPage {
  items: DecisionRow[];
  nextCursor: string | null;
}

function encodeCursor(row: DecisionRow): string {
  return Buffer.from(`${row.created_at}|${row.id}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(
  cursor: string,
): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator === -1) return null;
    return {
      createdAt: decoded.slice(0, separator),
      id: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export class DecisionsRepo {
  constructor(private readonly db: Db) {}

  insert(input: InsertDecisionInput): DecisionRow {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT * FROM call_decisions
         WHERE call_id = ? AND transcript_hash = ? AND model_version = ?`,
      )
      .get(
        input.callId,
        input.transcriptHash,
        input.modelVersion,
      ) as DecisionRow | undefined;

    const id = existing?.id ?? `dec_${randomUUID()}`;
    const status = input.status ?? 'staged';

    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO call_decisions (
            id, call_id, status, provider, model, model_version, prompt_version,
            transcript_hash, input_hash, outcome, outcome_confidence, verdict,
            verdict_reason, next_action, next_action_confidence, decision_json,
            validation_json, reviewed_by, reviewed_at, review_note, created_at,
            updated_at
          ) VALUES (
            @id, @callId, @status, @provider, @model, @modelVersion,
            @promptVersion, @transcriptHash, @inputHash, @outcome,
            @outcomeConfidence, @verdict, @verdictReason, @nextAction,
            @nextActionConfidence, @decisionJson, @validationJson, NULL, NULL,
            NULL, @now, @now
          )
          ON CONFLICT(call_id, transcript_hash, model_version) DO UPDATE SET
            status = excluded.status,
            provider = excluded.provider,
            model = excluded.model,
            prompt_version = excluded.prompt_version,
            input_hash = excluded.input_hash,
            outcome = excluded.outcome,
            outcome_confidence = excluded.outcome_confidence,
            verdict = excluded.verdict,
            verdict_reason = excluded.verdict_reason,
            next_action = excluded.next_action,
            next_action_confidence = excluded.next_action_confidence,
            decision_json = excluded.decision_json,
            validation_json = excluded.validation_json,
            reviewed_by = NULL,
            reviewed_at = NULL,
            review_note = NULL,
            updated_at = excluded.updated_at`,
        )
        .run({
          id,
          callId: input.callId,
          status,
          provider: input.provider,
          model: input.model,
          modelVersion: input.modelVersion,
          promptVersion: input.promptVersion,
          transcriptHash: input.transcriptHash,
          inputHash: input.inputHash,
          outcome: input.decision.outcome,
          outcomeConfidence: input.decision.outcome_confidence,
          verdict: input.decision.verdict,
          verdictReason: input.decision.verdict_reason,
          nextAction: input.decision.next_action,
          nextActionConfidence: input.decision.next_action_confidence,
          decisionJson: JSON.stringify(input.decision),
          validationJson: JSON.stringify(input.validation),
          now,
        });

      this.db
        .prepare('DELETE FROM decision_facts WHERE decision_id = ?')
        .run(id);

      const factStatement = this.db.prepare(
        `INSERT INTO decision_facts (
          id, decision_id, call_id, field, value_json, confidence, evidence,
          evidence_start_ms, evidence_end_ms, evidence_speaker, confirmed_by,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const fact of input.facts) {
        factStatement.run(
          `fact_${randomUUID()}`,
          id,
          input.callId,
          fact.field,
          JSON.stringify(fact.value ?? null),
          fact.confidence,
          fact.evidence,
          fact.evidenceStartMs,
          fact.evidenceEndMs,
          fact.evidenceSpeaker,
          fact.confirmedBy,
          now,
        );
      }
    });

    write();
    return this.getById(id) as DecisionRow;
  }

  getById(id: string): DecisionRow | undefined {
    return this.db
      .prepare('SELECT * FROM call_decisions WHERE id = ?')
      .get(id) as DecisionRow | undefined;
  }

  getLatestByCallId(callId: string): DecisionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM call_decisions
         WHERE call_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(callId) as DecisionRow | undefined;
  }

  getFacts(decisionId: string): DecisionFactRow[] {
    return this.db
      .prepare(
        `SELECT * FROM decision_facts
         WHERE decision_id = ?
         ORDER BY field ASC`,
      )
      .all(decisionId) as DecisionFactRow[];
  }

  supersedeForCall(callId: string, now = new Date()): number {
    const result = this.db
      .prepare(
        `UPDATE call_decisions
         SET status = 'superseded', updated_at = ?
         WHERE call_id = ? AND status IN ('staged', 'invalid')`,
      )
      .run(now.toISOString(), callId);
    return result.changes;
  }

  review(
    id: string,
    status: 'approved' | 'rejected',
    reviewedBy: string,
    note: string | null,
    now = new Date(),
  ): DecisionRow | undefined {
    const result = this.db
      .prepare(
        `UPDATE call_decisions
         SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?,
             updated_at = ?
         WHERE id = ? AND status IN ('staged', 'invalid')`,
      )
      .run(
        status,
        reviewedBy,
        now.toISOString(),
        note,
        now.toISOString(),
        id,
      );

    if (result.changes === 0) return undefined;
    return this.getById(id);
  }

  list(
    filters: DecisionFilters = {},
    limit = 50,
    cursor?: string | null,
  ): DecisionPage {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filters.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters.from) {
      clauses.push('created_at >= ?');
      params.push(filters.from.toISOString());
    }
    if (filters.to) {
      clauses.push('created_at <= ?');
      params.push(filters.to.toISOString());
    }
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(decoded.createdAt, decoded.createdAt, decoded.id);
      }
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM call_decisions ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit + 1) as DecisionRow[];

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  counts(): Record<DecisionStatus, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM call_decisions
         GROUP BY status`,
      )
      .all() as Array<{ status: DecisionStatus; count: number }>;

    const result: Record<DecisionStatus, number> = {
      staged: 0,
      approved: 0,
      rejected: 0,
      superseded: 0,
      invalid: 0,
    };
    for (const row of rows) result[row.status] = row.count;
    return result;
  }
}
