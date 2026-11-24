import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { LiveThreeCX } from './live/xapi.js';
import { MockThreeCX } from './mock.js';
import type { ThreeCXConnector } from './types.js';

export async function createConnector(
  config: Config,
  log: Logger,
): Promise<ThreeCXConnector> {
  if (config.tcxMode === 'live') {
    return new LiveThreeCX(config, log);
  }
  return new MockThreeCX(config, log);
}
