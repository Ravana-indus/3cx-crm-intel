import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { LayaDecisionModel, type DecisionFetch } from './laya.js';
import { MockDecisionModel } from './mock.js';
import type { DecisionModel } from './types.js';

export function createDecisionModel(
  config: Config,
  log: Logger,
  fetchImpl?: DecisionFetch,
): DecisionModel {
  if (config.decisionModel === 'laya') {
    return new LayaDecisionModel(config, log, fetchImpl);
  }
  return new MockDecisionModel();
}
