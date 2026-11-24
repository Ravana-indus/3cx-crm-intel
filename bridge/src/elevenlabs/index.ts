import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { LiveElevenLabs } from './live.js';
import { MockElevenLabs } from './mock.js';
import { MockAgentSessionFactory } from './mockSession.js';
import { LiveAgentSessionFactory } from './session.js';
import type { AgentSessionFactory, ElevenLabsClient } from './types.js';

export function createElevenLabsClient(
  config: Config,
  log: Logger,
): ElevenLabsClient {
  if (config.elevenLabsMode === 'live') {
    return new LiveElevenLabs(config, log);
  }
  return new MockElevenLabs();
}

export function createAgentSessionFactory(
  config: Config,
  log: Logger,
  client: ElevenLabsClient,
): AgentSessionFactory {
  if (config.elevenLabsMode === 'live') {
    return new LiveAgentSessionFactory(client, log);
  }
  return new MockAgentSessionFactory();
}

export { MockElevenLabs, MockAgentSessionFactory };
export type { ElevenLabsClient, AgentSessionFactory };
