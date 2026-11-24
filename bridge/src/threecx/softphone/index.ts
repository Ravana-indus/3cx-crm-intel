import type { Config } from '../../config.js';
import type { Logger } from '../../util/logger.js';
import { ThreeCXSession } from '../live/session.js';
import { LiveSoftphone } from './live.js';
import { MockSoftphone } from './mock.js';
import type { ThreeCXSoftphone } from './types.js';

export function createSoftphone(
  config: Config,
  log: Logger,
): ThreeCXSoftphone {
  if (config.tcxMode === 'mock') {
    return new MockSoftphone(config, log);
  }

  const session = new ThreeCXSession(config, log, {
    user: config.tcxAiExt ?? undefined,
    password: config.tcxAiPassword ?? undefined,
    profileDir: `${config.chromiumProfileDir}-ai`,
  });

  return new LiveSoftphone(config, log, session);
}

export { MockSoftphone, LiveSoftphone };
export type {
  AudioTransport,
  IncomingCall,
  SoftphoneStatus,
  ThreeCXSoftphone,
} from './types.js';
