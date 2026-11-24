import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { SettingsRepo } from '../repo/settings.js';
import type { Logger } from '../util/logger.js';
import { colomboDayKey, colomboHourMinute } from '../util/time.js';

export interface BackupManifest {
  createdAt: string;
  database: string;
  recordings: boolean;
  calls: number;
  recordingsCount: number;
  dbBytes: number;
}

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
}

/**
 * Nightly sqlite3 .backup plus the recordings folder. Runs once per Colombo
 * day at/after BACKUP_HOUR; the scheduler calls maybeRun() every minute.
 */
export class BackupRunner {
  constructor(
    private readonly config: Config,
    private readonly db: Db,
    private readonly settings: SettingsRepo,
    private readonly log: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async maybeRun(now = this.clock()): Promise<BackupResult | null> {
    const day = colomboDayKey(now);
    if (this.settings.get('last_backup_date') === day) return null;

    const { hour } = colomboHourMinute(now);
    if (hour < this.config.backupHour) return null;

    return this.run(now, day);
  }

  async run(now: Date, day = colomboDayKey(now)): Promise<BackupResult> {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const dir = join(this.config.backupDir, `backup-${stamp}`);
    await mkdir(dir, { recursive: true });

    await this.db.backup(join(dir, 'bridge.db'));

    let recordingsCopied = false;
    if (existsSync(this.config.recordingsDir)) {
      await cp(this.config.recordingsDir, join(dir, 'recordings'), {
        recursive: true,
        force: true,
      });
      recordingsCopied = true;
    }

    const calls = (
      this.db.prepare('SELECT COUNT(*) AS count FROM calls').get() as {
        count: number;
      }
    ).count;
    const recordingsCount = (
      this.db.prepare('SELECT COUNT(*) AS count FROM recordings').get() as {
        count: number;
      }
    ).count;
    const dbBytes = (await stat(join(dir, 'bridge.db'))).size;

    const manifest: BackupManifest = {
      createdAt: now.toISOString(),
      database: 'bridge.db',
      recordings: recordingsCopied,
      calls,
      recordingsCount,
      dbBytes,
    };

    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );

    this.settings.set('last_backup_date', day);
    this.settings.set('last_backup_path', dir);
    await this.prune(now);

    this.log.info({ dir, ...manifest }, 'backup complete');
    return { dir, manifest };
  }

  private async prune(now: Date): Promise<void> {
    if (!existsSync(this.config.backupDir)) return;
    const cutoff = now.getTime() - this.config.backupRetentionDays * 86_400_000;
    const entries = await readdir(this.config.backupDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('backup-')) continue;
      const full = join(this.config.backupDir, entry.name);
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true });
        this.log.info({ dir: full }, 'pruned old backup');
      }
    }
  }
}
