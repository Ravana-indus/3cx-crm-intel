import type { Db } from '../db/index.js';

export class CheckpointsRepo {
  constructor(private readonly db: Db) {}

  get(name: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM checkpoints WHERE name = ?')
      .get(name) as { value: string } | undefined;
    return row?.value ?? null;
  }

  getDate(name: string): Date | null {
    const value = this.get(name);
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  set(name: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (name, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value, new Date().toISOString());
  }

  advanceIfLater(name: string, value: string): void {
    const current = this.get(name);
    if (!current || Date.parse(value) > Date.parse(current)) {
      this.set(name, value);
    }
  }
}
