import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { MockSummariser } from './mock.js';
import { OllamaSummariser, type SummariserFetch } from './ollama.js';
import type { Summariser } from './types.js';

export function createSummariser(
  config: Config,
  log: Logger,
  fetchImpl?: SummariserFetch,
): Summariser {
  if (config.summariser === 'ollama') {
    return new OllamaSummariser(config, log, fetchImpl);
  }
  return new MockSummariser();
}
