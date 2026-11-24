import { loadConfig } from '../config.js';
import { openDb } from './index.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const result = migrate(db);
db.close();

console.log(
  `migrations: ${result.applied.length} applied, ${result.skipped.length} already present`,
);
if (result.applied.length > 0) {
  console.log(result.applied.map((name) => `  + ${name}`).join('\n'));
}
