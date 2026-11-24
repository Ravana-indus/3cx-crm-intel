import type { Config } from '../config.js';
import type { SettingsRepo } from '../repo/settings.js';
import type { Logger } from '../util/logger.js';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class Alerter {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(event: string, detail: unknown): Promise<void> {
    const url = this.config.alertWebhookUrl;
    if (!url) return;

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event,
          detail,
          service: '3cx-bridge',
          at: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.log.warn({ event, status: response.status }, 'alert webhook rejected');
      }
    } catch (error) {
      this.log.warn({ event, error: String(error) }, 'alert webhook failed');
    }
  }
}

export interface HeartbeatPayload {
  status: 'ok' | 'degraded';
  [key: string]: unknown;
}

export class Heartbeat {
  constructor(
    private readonly config: Config,
    private readonly settings: SettingsRepo,
    private readonly log: Logger,
    private readonly status: () => HeartbeatPayload,
    private readonly alert: Alerter,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async sendOnce(now = new Date()): Promise<boolean> {
    const url = this.config.heartbeatUrl;
    if (!url) return false;

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...this.status(), at: now.toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      this.settings.set('last_heartbeat', now.toISOString());
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn({ error: message }, 'heartbeat failed');
      await this.alert.send('heartbeat.failed', { error: message });
      return false;
    }
  }
}
