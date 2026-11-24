import type { Db } from '../db/index.js';

export interface PresenceRow {
  id: number;
  ext: string;
  status: string;
  at: string;
}

export class PresenceRepo {
  constructor(private readonly db: Db) {}

  insert(ext: string, status: string, at: string): void {
    this.db
      .prepare('INSERT INTO presence_events (ext, status, at) VALUES (?, ?, ?)')
      .run(ext, status, at);
  }

  lastFor(ext: string): PresenceRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM presence_events WHERE ext = ? ORDER BY at DESC, id DESC LIMIT 1',
      )
      .get(ext) as PresenceRow | undefined;
  }

  latestPerExt(): PresenceRow[] {
    return this.db
      .prepare(
        `SELECT p.* FROM presence_events p
         JOIN (
           SELECT ext, MAX(id) AS id FROM presence_events GROUP BY ext
         ) latest ON latest.id = p.id
         ORDER BY p.ext ASC`,
      )
      .all() as PresenceRow[];
  }
}
