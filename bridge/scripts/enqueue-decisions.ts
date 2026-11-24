/**
 * Queue Laya decisions for calls that already have transcripts.
 *
 *   DB_PATH=./data/live.db npx tsx scripts/enqueue-decisions.ts
 *   DB_PATH=./data/live.db npx tsx scripts/enqueue-decisions.ts --call-id call_...
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { JobsRepo } from '../src/repo/jobs.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  migrate(db);
  const jobs = new JobsRepo(db);
  const callId = arg('call-id');
  const limit = Number(arg('limit') ?? 0) || 0;

  const rows = callId
    ? (db
        .prepare(
          `SELECT call_id FROM transcripts
           WHERE call_id = ? AND text IS NOT NULL AND text <> ''`,
        )
        .all(callId) as Array<{ call_id: string }>)
    : (db
        .prepare(
          `SELECT t.call_id FROM transcripts t
           WHERE t.text IS NOT NULL AND t.text <> ''
           ORDER BY t.created_at DESC
           ${limit > 0 ? 'LIMIT ?' : ''}`,
        )
        .all(...(limit > 0 ? [limit] : [])) as Array<{ call_id: string }>);

  let created = 0;
  for (const row of rows) {
    const job = jobs.createIfAbsent({
      type: 'decision',
      refId: row.call_id,
      nextRunAt: new Date(),
    });
    if (job) created += 1;
  }

  console.log(
    JSON.stringify(
      { transcripts: rows.length, queued: created },
      null,
      2,
    ),
  );
  db.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
