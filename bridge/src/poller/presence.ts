import type { Config } from '../config.js';
import type { AgentsRepo } from '../repo/agents.js';
import type { CheckpointsRepo } from '../repo/checkpoints.js';
import type { PresenceRepo } from '../repo/presence.js';
import type { ThreeCXConnector } from '../threecx/types.js';
import type { Logger } from '../util/logger.js';

export interface PresencePollerDeps {
  config: Config;
  connector: ThreeCXConnector;
  presence: PresenceRepo;
  agents?: AgentsRepo;
  checkpoints: CheckpointsRepo;
  log: Logger;
}

export interface PresencePollResult {
  skipped: boolean;
  inserted: number;
}

export class PresencePoller {
  constructor(private readonly deps: PresencePollerDeps) {}

  async poll(now = new Date()): Promise<PresencePollResult> {
    const { config, connector, presence, agents, checkpoints, log } = this.deps;

    if (!config.epPresence) {
      return { skipped: true, inserted: 0 };
    }

    const remote = await connector.getPresence();
    let inserted = 0;

    for (const entry of remote) {
      if (entry.userId && agents) {
        agents.upsert({ ext: entry.ext, userId: entry.userId });
      }

      const last = presence.lastFor(entry.ext);
      if (!last || last.status !== entry.status) {
        presence.insert(entry.ext, entry.status, entry.at);
        inserted += 1;
      }
    }

    checkpoints.advanceIfLater('presence', now.toISOString());
    log.info({ fetched: remote.length, inserted }, 'presence polled');
    return { skipped: false, inserted };
  }
}
