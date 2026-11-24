import {
  chromium,
  type BrowserContext,
  type Page,
  type Response,
} from 'playwright';
import type { Config } from '../../config.js';
import type { Logger } from '../../util/logger.js';

/**
 * Selectors are centralised here because they are the most likely thing to
 * break after a 3CX web-client update. Fill them from the Phase 0 HAR.
 */
const LOGIN_SELECTORS = {
  username:
    '#loginInput, input[name="username"], input[name="extension"], input[name="email"], input[type="text"]',
  password: '#passwordInput, input[type="password"], input[name="password"]',
  submit:
    '#submitBtn, button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")',
};

const STORAGE_HINTS = ['token', 'accesstoken', 'access_token', 'jwt', 'bearer'];

function findTokenInObject(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTokenInObject(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      typeof entry === 'string' &&
      entry.length >= 20 &&
      (lower.includes('token') || lower === 'jwt' || lower.includes('access'))
    ) {
      return entry;
    }
    const nested = findTokenInObject(entry, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export interface SessionCredentials {
  user?: string;
  password?: string;
  profileDir?: string;
}

export class ThreeCXSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private token: string | null = null;
  private failures = 0;
  private degraded = false;
  private failureMessage: string | null = null;
  private loginInFlight: Promise<string> | null = null;
  private readonly username: string | null;
  private readonly password: string | null;
  private readonly profileDir: string;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    credentials: SessionCredentials = {},
  ) {
    this.username = credentials.user ?? config.tcxServiceUser;
    this.password = credentials.password ?? config.tcxServicePassword;
    this.profileDir = credentials.profileDir ?? config.chromiumProfileDir;
  }

  async getPage(): Promise<Page> {
    return this.contextAndPage();
  }

  getContext(): BrowserContext | null {
    return this.context;
  }

  state(): 'ok' | 'degraded' {
    return this.degraded ? 'degraded' : 'ok';
  }

  lastError(): string | null {
    return this.failureMessage;
  }

  currentToken(): string | null {
    return this.token;
  }

  /** Bootstrap/test path: use a captured bearer token instead of logging in. */
  setToken(token: string): void {
    this.token = token;
    this.recordSuccess();
  }

  async ensureAuth(): Promise<string> {
    if (this.token) return this.token;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login()
      .finally(() => {
        this.loginInFlight = null;
      });

    return this.loginInFlight;
  }

  async invalidate(): Promise<void> {
    this.token = null;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.degraded = false;
    this.failureMessage = null;
  }

  recordFailure(error: unknown): void {
    this.failures += 1;
    this.failureMessage = error instanceof Error ? error.message : String(error);
    if (this.failures >= 3) {
      this.degraded = true;
      this.log.error(
        { failures: this.failures, error: this.failureMessage },
        '3CX connector degraded after repeated failures',
      );
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
    }
  }

  private async contextAndPage(): Promise<Page> {
    if (!this.context) {
      this.context = await chromium.launchPersistentContext(
        this.profileDir,
        {
          headless: true,
          acceptDownloads: true,
          args: [
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      );
    }

    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
    }

    return this.page;
  }

  private async login(): Promise<string> {
    const base = this.config.tcxUrl;
    const user = this.username;
    const password = this.password;
    if (!base) {
      throw new Error('TCX_URL is not configured');
    }

    const page = await this.contextAndPage();

    try {
      const refreshed = await this.tryRefreshToken();
      if (refreshed) {
        this.token = refreshed;
        this.recordSuccess();
        return refreshed;
      }

      if (!user || !password) {
        throw new Error(
          '3CX credentials are required when the refresh cookie is invalid',
        );
      }

      await page.goto(`${base.replace(/\/$/, '')}/webclient/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      const stored = await this.readStoredToken(page);
      if (stored) {
        this.log.info('reused 3CX token from persistent Chromium profile');
        this.token = stored;
        this.recordSuccess();
        return stored;
      }

      const captured = this.captureTokenFromTraffic(page);
      await this.fillLoginForm(page, user, password);

      const token = await Promise.race([captured, this.pollStoredToken(page, 20_000)]);
      if (!token) {
        throw new Error(
          '3CX login did not yield a bearer token; check LOGIN_SELECTORS and the HAR',
        );
      }

      this.token = token;
      this.recordSuccess();
      this.log.info('3CX service session authenticated');
      return token;
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }

  /**
   * The 3CX webclient keeps a HttpOnly RefreshTokenCookie. Replaying the
   * client's refresh_token grant through the persistent context avoids a full
   * login after the short-lived access token expires.
   */
  private async tryRefreshToken(): Promise<string | null> {
    const base = this.config.tcxUrl?.replace(/\/$/, '');
    if (!base || !this.context) return null;

    try {
      const response = await this.context.request.post(
        `${base}/connect/token`,
        {
          form: {
            client_id: 'Webclient',
            grant_type: 'refresh_token',
          },
          headers: {
            origin: base,
            referer: `${base}/webclient/`,
          },
          timeout: 30_000,
        },
      );

      if (!response.ok()) {
        this.log.debug(
          { status: response.status() },
          '3CX cookie refresh was rejected',
        );
        return null;
      }

      const body = (await response.json()) as { access_token?: string };
      if (!body.access_token) return null;

      this.log.info('refreshed 3CX token from the persistent profile');
      return body.access_token;
    } catch (error) {
      this.log.debug(
        { error: error instanceof Error ? error.message : String(error) },
        '3CX cookie refresh failed',
      );
      return null;
    }
  }

  private async fillLoginForm(
    page: Page,
    user: string,
    password: string,
  ): Promise<void> {
    const username = page.locator(LOGIN_SELECTORS.username).first();
    if ((await username.count()) === 0) {
      this.log.warn('no 3CX login form detected; waiting for an existing session');
      return;
    }

    await username.fill(user);

    const passwordField = page.locator(LOGIN_SELECTORS.password).first();
    if ((await passwordField.count()) > 0) {
      await passwordField.fill(password);
    }

    const submit = page.locator(LOGIN_SELECTORS.submit).first();
    if ((await submit.count()) > 0) {
      await submit.click().catch(() => page.keyboard.press('Enter'));
    } else {
      await page.keyboard.press('Enter');
    }
  }

  private captureTokenFromTraffic(page: Page): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (token: string | null) => {
        if (settled) return;
        settled = true;
        page.off('response', handler);
        resolve(token);
      };

      const handler = (response: Response) => {
        const authorization = response.request().headers()['authorization'];
        if (authorization?.toLowerCase().startsWith('bearer ')) {
          finish(authorization.slice(7).trim());
          return;
        }

        const contentType = response.headers()['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          response
            .json()
            .then((body) => {
              const token = findTokenInObject(body);
              if (token) finish(token);
            })
            .catch(() => undefined);
        }
      };

      page.on('response', handler);
      setTimeout(() => finish(null), 25_000);
    });
  }

  private async pollStoredToken(page: Page, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const token = await this.readStoredToken(page);
      if (token) return token;
      await page.waitForTimeout(500);
    }
    return null;
  }

  private async readStoredToken(page: Page): Promise<string | null> {
    try {
      const values = await page.evaluate((hints: string[]) => {
        const found: string[] = [];
        const scan = (storage: Storage) => {
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (!key) continue;
            const value = storage.getItem(key) ?? '';
            if (value.length < 20) continue;
            const lowerKey = key.toLowerCase();
            if (hints.some((hint) => lowerKey.includes(hint))) {
              found.push(value);
              continue;
            }
            if (value.trim().startsWith('{')) {
              try {
                const parsed = JSON.parse(value) as Record<string, unknown>;
                for (const [innerKey, innerValue] of Object.entries(parsed)) {
                  if (
                    typeof innerValue === 'string' &&
                    innerValue.length >= 20 &&
                    hints.some((hint) => innerKey.toLowerCase().includes(hint))
                  ) {
                    found.push(innerValue);
                  }
                }
              } catch {
                // not JSON, ignore
              }
            }
          }
        };

        scan(localStorage);
        scan(sessionStorage);
        return found;
      }, STORAGE_HINTS);

      if (values.length === 0) return null;
      const candidate = values[0];
      return candidate.replace(/^"|"$/g, '');
    } catch {
      return null;
    }
  }
}
