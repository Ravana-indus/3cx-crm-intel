import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

export interface KbDocRow {
  id: string;
  title: string;
  body_md: string;
  tags: string | null;
  owner: string | null;
  review_by: string | null;
  content_hash: string | null;
  el_doc_id: string | null;
  updated_at: string;
  synced_at: string | null;
}

export interface KbDocInput {
  title: string;
  bodyMd: string;
  tags?: string | null;
  owner?: string | null;
  reviewBy?: string | null;
}

export interface KbDocPatch {
  title?: string;
  bodyMd?: string;
  tags?: string | null;
  owner?: string | null;
  reviewBy?: string | null;
}

export function contentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}

export class KbRepo {
  constructor(private readonly db: Db) {}

  list(): KbDocRow[] {
    return this.db
      .prepare('SELECT * FROM kb_docs ORDER BY updated_at DESC')
      .all() as KbDocRow[];
  }

  get(id: string): KbDocRow | undefined {
    return this.db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(id) as
      | KbDocRow
      | undefined;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM kb_docs').get() as {
      count: number;
    };
    return row.count;
  }

  create(input: KbDocInput): KbDocRow {
    const now = new Date().toISOString();
    const id = `kb_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO kb_docs (
          id, title, body_md, tags, owner, review_by, content_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.bodyMd,
        input.tags ?? null,
        input.owner ?? null,
        input.reviewBy ?? null,
        contentHash(input.title, input.bodyMd),
        now,
      );
    return this.get(id) as KbDocRow;
  }

  update(id: string, patch: KbDocPatch): KbDocRow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;

    const title = patch.title ?? existing.title;
    const body = patch.bodyMd ?? existing.body_md;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE kb_docs SET
          title = ?,
          body_md = ?,
          tags = ?,
          owner = ?,
          review_by = ?,
          content_hash = ?,
          updated_at = ?,
          synced_at = NULL
        WHERE id = ?`,
      )
      .run(
        title,
        body,
        patch.tags !== undefined ? patch.tags : existing.tags,
        patch.owner !== undefined ? patch.owner : existing.owner,
        patch.reviewBy !== undefined ? patch.reviewBy : existing.review_by,
        contentHash(title, body),
        now,
        id,
      );

    return this.get(id);
  }

  remove(id: string): KbDocRow | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    this.db.prepare('DELETE FROM kb_docs WHERE id = ?').run(id);
    return existing;
  }

  markSynced(id: string, elDocId: string, at = new Date()): void {
    this.db
      .prepare('UPDATE kb_docs SET el_doc_id = ?, synced_at = ? WHERE id = ?')
      .run(elDocId, at.toISOString(), id);
  }

  needsSync(doc: KbDocRow): boolean {
    if (!doc.el_doc_id) return true;
    if (!doc.synced_at) return true;
    return Date.parse(doc.updated_at) > Date.parse(doc.synced_at);
  }

  stale(today: string): KbDocRow[] {
    return this.db
      .prepare(
        `SELECT * FROM kb_docs
         WHERE review_by IS NOT NULL AND review_by < ?
         ORDER BY review_by ASC`,
      )
      .all(today) as KbDocRow[];
  }
}
