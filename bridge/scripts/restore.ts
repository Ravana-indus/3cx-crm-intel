/**
 * Restore a backup into a fresh directory and verify it.
 *
 *   npm run restore -- ./data/backups/backup-<stamp> ./data/restored
 *
 * This never overwrites the live database. Swap it in only after the integrity
 * check and row counts look right.
 */
import { restoreBackup } from '../src/maintenance/restore.js';

async function main(): Promise<void> {
  const backupDir = process.argv[2];
  const targetDir =
    process.argv[3] ?? `./data/restored-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  if (!backupDir) {
    console.error('usage: npm run restore -- <backup-dir> [target-dir]');
    process.exit(1);
  }

  const result = await restoreBackup(backupDir, targetDir);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
