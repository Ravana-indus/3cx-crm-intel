import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';

function migrationsDir(): string {
  const adjacent = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  if (existsSync(adjacent)) return adjacent;

  const fromCwd = join(process.cwd(), 'src', 'db', 'migrations');
  if (existsSync(fromCwd)) return fromCwd;

  throw new Error(`Cannot find migrations directory (tried ${adjacent} and ${fromCwd})`);
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export function migrate(db: Db): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  const alreadyApplied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((row) => (row as { name: string }).name),
  );

  const record = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }

    const sql = readFileSync(join(dir, file), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    });
    run();
    applied.push(file);
  }

  return { applied, skipped };
}
