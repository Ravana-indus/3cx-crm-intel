import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';
import { colomboDayKey, toColombo } from '../../util/time.js';

export function registerHealthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get(
    '/v1/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Connector, pollers, job queue and outbox state',
      },
    },
    async () => {
      const jobs = deps.jobs.counts();
      const failed = deps.jobs.recentFailed(10).map((job) => ({
        id: job.id,
        type: job.type,
        ref_id: job.ref_id,
        attempts: job.attempts,
        error: job.error,
        updated_at: toColombo(job.updated_at),
      }));
      const stale = deps.kb.stale(colomboDayKey(new Date())).map((doc) => ({
        id: doc.id,
        title: doc.title,
        owner: doc.owner,
        review_by: doc.review_by,
      }));

      return {
        status: deps.connector.state() === 'degraded' ? 'degraded' : 'ok',
        connector: {
          mode: deps.connector.mode,
          state: deps.connector.state(),
          last_error: deps.connector.lastError(),
        },
        polls: {
          calls: toColombo(deps.checkpoints.get('calllog')),
          recordings: toColombo(deps.checkpoints.get('recordings')),
          presence: toColombo(deps.checkpoints.get('presence')),
        },
        jobs,
        summariser: {
          provider: deps.config.summariser,
          model:
            deps.config.summariser === 'ollama'
              ? deps.config.ollamaModel
              : 'mock-v1',
        },
        decisions: {
          enabled: deps.config.decisionEnabled,
          provider: deps.config.decisionModel,
          model:
            deps.config.decisionModel === 'laya'
              ? deps.config.layaModel
              : 'laya-mock-v1',
          counts: deps.decisions.counts(),
        },
        failed_jobs: failed,
        outbox_pending: deps.outbox.pendingCount(),
        stale_kb_docs: stale,
        maintenance: {
          last_backup_date: deps.settings.get('last_backup_date'),
          last_backup_path: deps.settings.get('last_backup_path'),
          last_heartbeat: toColombo(deps.settings.get('last_heartbeat')),
          ai_mode: deps.settings.get('ai_mode') ?? deps.config.aiMode,
        },
        now: toColombo(new Date()),
      };
    },
  );
}
