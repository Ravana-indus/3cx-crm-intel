import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PortalLead {
  lead_id: string | null;
  name?: string | null;
  stage?: string | null;
}

/**
 * The bridge is the only outside caller of the portal API. These calls happen
 * from client tools during the AI conversation, so the agent needs no public
 * endpoint or tunnel.
 */
export class PortalClient {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async lookupLead(e164: string): Promise<PortalLead | null> {
    if (!this.config.portalApiUrl || !e164) return null;

    try {
      const response = await this.fetchImpl(
        `${this.base()}/api/leads/by-phone?e164=${encodeURIComponent(e164)}`,
        { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return null;
      return (await response.json()) as PortalLead;
    } catch (error) {
      this.log.warn(
        { error: String(error), e164 },
        'portal lead lookup failed',
      );
      return null;
    }
  }

  async createEnquiry(payload: Record<string, unknown>): Promise<unknown> {
    if (!this.config.portalApiUrl) {
      throw new Error('PORTAL_API_URL is not configured');
    }

    const response = await this.fetchImpl(`${this.base()}/api/enquiries`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `portal enquiry failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
      );
    }

    return response.json().catch(() => ({}));
  }

  private base(): string {
    return this.config.portalApiUrl.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return this.config.portalApiToken
      ? { authorization: `Bearer ${this.config.portalApiToken}` }
      : {};
  }
}
