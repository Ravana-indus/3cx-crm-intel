import type { Db } from '../db/index.js';

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: string, fallback: string | null = null): string | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string | null } | undefined;
    return row ? row.value : fallback;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
