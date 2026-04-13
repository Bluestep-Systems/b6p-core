import type { SessionData } from '../types';
import { ApiEndpoints, Http } from '../constants';
import { Err } from '../Err';
import { ResponseCodes } from '../network/StatusCodes';
import type { IAuth, ILogger, IPersistence, IPrompt } from '../providers';

const SESSION_PERSISTENCE_KEY = 'sessions';

/**
 * Fetch-compatible function signature used for HTTP requests.
 */
type FetchFn = (url: string | URL, options?: RequestInit) => Promise<Response>;

/**
 * The session manager is responsible for managing individual sessions with BlueStep servers.
 * @lastreviewed null
 */
export class SessionManager {

  private readonly MILLIS_IN_A_MINUTE = 1_000 * 60;
  private readonly MAX_SESSION_DURATION = this.MILLIS_IN_A_MINUTE * 30; // 30 minutes
  private readonly MAX_RETRY_ATTEMPTS = 3;

  /** In-memory session cache, lazily hydrated from persistence. */
  private sessions: Record<string, SessionData> = {};
  private loaded = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Optional callback invoked after login to notify external systems (e.g. OrgCache).
   */
  public onLogin: ((url: URL) => void) | null = null;

  constructor(
    private readonly persistence: IPersistence,
    private readonly logger: ILogger,
    private readonly auth: IAuth,
    private readonly isDebugMode: () => boolean,
    private readonly prompt: IPrompt,
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {
    this.triggerNextCleanup(5_000);
  }

  // ── Session persistence ───────────────────────────────────────────

  private async load(): Promise<void> {
    if (this.loaded) { return; }
    const raw = await this.persistence.getSecret(SESSION_PERSISTENCE_KEY);
    if (raw) {
      this.sessions = JSON.parse(raw) as Record<string, SessionData>;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.persistence.setSecret(SESSION_PERSISTENCE_KEY, JSON.stringify(this.sessions));
  }

  private async getSession(origin: string): Promise<SessionData | undefined> {
    await this.load();
    return this.sessions[origin];
  }

  private async setSession(origin: string, data: SessionData): Promise<void> {
    await this.load();
    this.sessions[origin] = data;
    await this.save();
  }

  private async deleteSession(origin: string): Promise<void> {
    await this.load();
    delete this.sessions[origin];
    await this.save();
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Performs the normal managed fetch, however, wraps it with additional CSRF management,
   * complete with retries.
   */
  public async csrfFetch(url: string | URL, options?: RequestInit, retries = this.MAX_RETRY_ATTEMPTS): Promise<Response> {
    url = new URL(url);
    const origin = url.origin;

    const session = await this.getSession(origin);
    if (!session) {
      await this.login(url);
    }

    const currentSession = await this.getSession(origin);
    if (!currentSession) {
      throw new Err.SessionNotFoundError(origin);
    }

    try {
      const tokenValue = await this.fetch(`${origin}${ApiEndpoints.CSRF_TOKEN}`).then(r => r.text());
      currentSession.lastCsrfToken = tokenValue;
      await this.setSession(origin, currentSession);

      options = options || {};
      options.headers = options.headers || {};

      (options.headers as Record<string, string>)[Http.Headers.B6P_CSRF_TOKEN] =
        currentSession.lastCsrfToken
        || (() => { throw new Err.CsrfTokenNotFoundError(); })();
      const response = await this.fetch(url, options);
      let newToken = response.headers.get(Http.Headers.B6P_CSRF_TOKEN);
      for (const [key, value] of Object.entries(response.headers)) {
        if (key === Http.Headers.B6P_CSRF_TOKEN) {
          newToken = value;
        }
      }
      if (newToken) {
        currentSession.lastCsrfToken = newToken;
        await this.setSession(origin, currentSession);
      }
      return response;
    } catch (e) {
      if (retries <= 0) {
        throw new Err.RetryAttemptsExhaustedError(e instanceof Error ? e.stack || e.message : String(e));
      }
      if (e instanceof Error) {
        if (e.name === 'AbortError') {
          throw new Err.RequestTimeoutError();
        }
        if (e instanceof Err.UnauthorizedError) {
          await this.deleteSession(origin);
          this.prompt.info("Session expired/etc, attempting to re-authenticate...");
          await sleep((this.MAX_RETRY_ATTEMPTS + 1 - retries) * 1_000);
          return await this.csrfFetch(url, options, retries - 1);
        }
        currentSession.lastCsrfToken = null;
        this.prompt.info(`Request didn't work, retrying... (${retries} attempts left)`);
        await this.deleteSession(origin);
        await sleep((this.MAX_RETRY_ATTEMPTS + 1 - retries) * 1_000);
        return await this.csrfFetch(url, options, retries - 1);
      }
      throw e;
    }
  }

  /**
   * Performs a managed fetch, appending and managing session cookies.
   * Does not automatically retry.
   */
  public async fetch(url: string | URL, options?: RequestInit): Promise<Response> {
    url = new URL(url);
    const sessionData = await this.getSession(url.origin);
    if (sessionData?.JSESSIONID && sessionData.lastTouched > (Date.now() - this.MAX_SESSION_DURATION)) {
      this.isDebugMode() && this.logger.info("using existing session for fetch to:" + url.href + "\n " + JSON.stringify(sessionData));
      options = {
        ...options,
        headers: {
          ...options?.headers,
          [Http.Headers.COOKIE]: `${Http.Cookies.JSESSIONID}=${sessionData.JSESSIONID}` + (sessionData.INGRESSCOOKIE ? `; ${Http.Cookies.INGRESSCOOKIE}=${sessionData.INGRESSCOOKIE}` : ''),
        }
      };
      const response = await this.fetchFn(url, options);
      return await this.processResponse(response);
    } else {
      await this.login(url);
      return await this.fetch(url, options);
    }
  }

  /**
   * Clears the session data for a specific origin.
   */
  public async clearSession({ origin }: { origin: string | URL }): Promise<void> {
    await this.deleteSession(new URL(origin).origin);
  }

  /**
   * Clear all sessions.
   */
  public async clearAll(): Promise<void> {
    this.sessions = {};
    await this.save();
  }

  /**
   * Checks if there is a valid session for a specific origin.
   */
  public async hasValidSession({ origin }: { origin: string | URL }): Promise<boolean> {
    const session = await this.getSession(new URL(origin).origin);
    return !!session && (session.lastTouched > (Date.now() - this.MAX_SESSION_DURATION));
  }

  /**
   * Stop cleanup timer. Call when disposing.
   */
  dispose() {
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async login(url: URL) {
    this.logger.info("performing login to:" + url.origin);
    const response = await this.fetchFn(url.origin + ApiEndpoints.LOOKUP_TEST, {
      method: Http.Methods.POST,
      headers: {
        [Http.Headers.AUTHORIZATION]: `${await this.auth.authHeaderValue()}`,
      }
    });
    this.logger.info("login status:" + response.status);
    if (response.status >= ResponseCodes.BAD_REQUEST) {
      throw new Err.HttpResponseError(`HTTP Error: ${response.status} ${response.statusText}`);
    }
    await this.processResponse(response);
    if (this.onLogin) {
      try {
        this.onLogin(url);
      } catch (e) {
        this.logger.warn('onLogin callback failed:', e instanceof Error ? e.message : String(e));
      }
    }
  }

  /**
   * Common code for processing and storing session data from a fetch response.
   */
  private async processResponse(response: Response): Promise<Response> {
    if (response.status === ResponseCodes.FORBIDDEN) {
      throw new Err.UnauthorizedError(`HTTP Error: ${response.status} ${response.statusText}`);
    }
    const cookies = response.headers.get(Http.Headers.SET_COOKIE);
    const responderUrl = new URL(response.url);
    if (cookies) {
      const cookieMap = this.parseCookies(response.headers);
      const existing = await this.getSession(responderUrl.origin);
      const sessionData: SessionData = {
        lastTouched: Date.now(),
        [Http.Cookies.JSESSIONID]: cookieMap.get(Http.Cookies.JSESSIONID)
          || existing?.JSESSIONID
          || (() => { throw new Err.SessionIdMissingError(); })(),
        [Http.Cookies.INGRESSCOOKIE]: cookieMap.get(Http.Cookies.INGRESSCOOKIE)
          || existing?.INGRESSCOOKIE
          || null,
        lastCsrfToken: response.headers.get(Http.Headers.B6P_CSRF_TOKEN)
          || existing?.lastCsrfToken
          || null
      };
      await this.setSession(responderUrl.origin, sessionData);
    } else {
      const existing = await this.getSession(responderUrl.origin);
      if (!existing) {
        throw new Err.SessionDataMissingError();
      }
      existing.lastTouched = Date.now();
      existing.lastCsrfToken = response.headers.get(Http.Headers.B6P_CSRF_TOKEN) || existing.lastCsrfToken;
      await this.setSession(responderUrl.origin, existing);
    }

    return response;
  }

  /**
   * NOTE: this is not a proper cookie parser since we
   * do not care about attributes like `Secure` and `HttpOnly`
   * in this extension (yet).
   */
  private parseCookies(headers: Headers): Map<string, string> {
    const cookieMap = new Map<string, string>();
    const setCookies = headers.getSetCookie();
    for (const cookieString of setCookies) {
      const parts = cookieString.split(";").map(part => part.trim());

      if (parts.length > 0) {
        const cookiePart = parts[0];
        const equalIndex = cookiePart.indexOf("=");

        if (equalIndex > 0) {
          const name = cookiePart.substring(0, equalIndex).trim();
          const value = cookiePart.substring(equalIndex + 1).trim();

          if (name && value) {
            cookieMap.set(name, value);
          }
        }
      }
    }
    return cookieMap;
  }

  private triggerNextCleanup(delay: number = this.MAX_SESSION_DURATION) {
    this.cleanupTimer = setTimeout(async () => {
      const now = Date.now();
      let changed = false;
      for (const [origin, session] of Object.entries(this.sessions)) {
        if (now - session.lastTouched > this.MAX_SESSION_DURATION) {
          delete this.sessions[origin];
          changed = true;
        }
      }
      if (changed) {
        await this.save();
      }
      this.triggerNextCleanup();
    }, delay);
    // Don't keep the process alive just for cleanup (critical for the CLI).
    this.cleanupTimer.unref?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
