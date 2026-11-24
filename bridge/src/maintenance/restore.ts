import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface RestoreResult {
  targetDir: string;
  databasePath: string;
  integrity: string;
  calls: number;
  recordings: number;
}

/**
 * Restores a backup directory into a fresh target. Never overwrites the live
 * database: restoring is an explicit, separate operation. `--verify` callers
 * check integrity and row counts before swapping.
 */
export async function restoreBackup(
  backupDir: string,
  targetDir: string,
): Promise<RestoreResult> {
  const sourceDb = join(backupDir, 'bridge.db');
  if (!existsSync(sourceDb)) {
    throw new Error(`backup database not found: ${sourceDb}`);
  }

  await mkdir(targetDir, { recursive: true });
  const databasePath = join(targetDir, 'bridge.db');
  await cp(sourceDb, databasePath);

  const sourceRecordings = join(backupDir, 'recordings');
  if (existsSync(sourceRecordings)) {
    await cp(sourceRecordings, join(targetDir, 'recordings'), {
      recursive: true,
      force: true,
    });
  }

  const db = new Database(databasePath, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check', {
      simple: true,
    }) as unknown as string;
    const calls = (
      db.prepare('SELECT COUNT(*) AS count FROM calls').get() as {
        count: number;
      }
    ).count;
    const recordings = (
      db.prepare('SELECT COUNT(*) AS count FROM recordings').get() as {
        count: number;
      }
    ).count;

    if (integrity !== 'ok') {
      throw new Error(`restored database failed integrity check: ${integrity}`);
    }

    return { targetDir, databasePath, integrity, calls, recordings };
  } finally {
    db.close();
  }
}
