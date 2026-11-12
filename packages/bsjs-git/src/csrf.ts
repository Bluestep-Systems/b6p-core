import type { FetchLike } from "./http";

const CSRF_PATH = "csrf-token";
const CSRF_HEADER = "B6P-CSRF-TOKEN";

/**
 * How a client proves who it is.
 *
 * - `token`: a `b6pt_` bearer token, sent as `Bearer` (REST, `/gql`) or as the Basic password (git proxy).
 * - `session`: the signed-in browser session. No `Authorization` header is sent; the browser's cookie jar carries the
 *   session (`credentials: "include"`), and every request carries the `B6P-CSRF-TOKEN` the session's `/csrf-token` gave.
 * @lastreviewed null
 */
export type ScriptAuth = { readonly kind: "token"; readonly token: string } | { readonly kind: "session" };

/**
 * `fetch` for the platform's CSRF-protected endpoints, the way `b6p-core`'s `SessionManager.csrfFetch` does it: the
 * token is read from `/csrf-token`, sent as `B6P-CSRF-TOKEN`, a token the response refreshes is adopted, and a refused
 * request (403) is retried once with a fresh token when the token sent was a stale cached one or the response carried
 * a refreshed one.
 *
 * With a bearer token, the bearer opens the session on the first request. The CSRF token is bound to the session
 * cookie. Node has no cookie jar, so `Set-Cookie` values are kept here and sent back; a browser keeps its own (it hides
 * `Set-Cookie` from scripts and ignores a `Cookie` header), so every request also asks for `credentials: "include"`.
 * @lastreviewed null
 */
export class CsrfFetch {
  readonly #fetch: FetchLike;
  readonly #origin: string;
  readonly #auth: ScriptAuth;
  readonly #cookies = new Map<string, string>();
  #csrf: string | undefined;

  constructor(fetchImpl: FetchLike, origin: string, auth: ScriptAuth) {
    this.#fetch = fetchImpl;
    this.#origin = origin;
    this.#auth = auth;
  }

  /** POSTs JSON to a path under the origin with the CSRF header. */
  async postJson(path: string, body: string): Promise<Response> {
    return this.request(`${this.#origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }

  /**
   * Sends a request with the CSRF header (and, for a bearer, the bearer). The body must be replayable (a string or
   * bytes), since a refused token is retried once.
   */
  async request(url: string, init: RequestInit): Promise<Response> {
    const cached = this.#csrf;
    let response = await this.#send(url, init, cached ?? (await this.#token()));
    if (response.status === 403 && (cached !== undefined || response.headers.has(CSRF_HEADER))) {
      response = await this.#send(url, init, await this.#token());
    }
    return response;
  }

  async #token(): Promise<string> {
    const response = await this.#raw(`${this.#origin}${CSRF_PATH}`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`the platform's CSRF token request answered HTTP ${response.status}`);
    }
    this.#csrf = (await response.text()).trim();
    return this.#csrf;
  }

  async #send(url: string, init: RequestInit, token: string): Promise<Response> {
    const response = await this.#raw(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), [CSRF_HEADER]: token },
    });
    const refreshed = response.headers.get(CSRF_HEADER);
    if (refreshed) {
      this.#csrf = refreshed;
    }
    return response;
  }

  async #raw(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.#auth.kind === "token") {
      headers.Authorization = `Bearer ${this.#auth.token}`;
    }
    if (this.#cookies.size > 0) {
      headers.Cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    const response = await this.#fetch(url, { ...init, headers, credentials: "include" });
    const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of setCookies) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
    return response;
  }
}
