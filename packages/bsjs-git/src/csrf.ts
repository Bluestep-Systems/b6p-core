import type { FetchLike } from "./http";

const CSRF_PATH = "csrf-token";
const CSRF_HEADER = "B6P-CSRF-TOKEN";

/**
 * `fetch` for the platform's CSRF-protected endpoints (`/gql`), the way `b6p-core`'s `SessionManager.csrfFetch` does
 * it: the bearer token opens a session on the first request, whose token is read from `/csrf-token` and sent as
 * `B6P-CSRF-TOKEN`; a token the response refreshes is adopted, and a refused request (403) is retried once with a
 * fresh token.
 *
 * The CSRF token is bound to the session cookie. Node has no cookie jar, so `Set-Cookie` values are kept here and sent
 * back; a browser keeps its own jar (it hides `Set-Cookie` from scripts and ignores a `Cookie` header), so this class
 * also asks for `credentials: "include"`.
 * @lastreviewed null
 */
export class CsrfFetch {
  readonly #fetch: FetchLike;
  readonly #origin: string;
  readonly #bearer: string;
  readonly #cookies = new Map<string, string>();
  #csrf: string | undefined;

  constructor(fetchImpl: FetchLike, origin: string, bearerToken: string) {
    this.#fetch = fetchImpl;
    this.#origin = origin;
    this.#bearer = bearerToken;
  }

  /** POSTs JSON to a path under the origin with the CSRF header, retrying once if the platform refuses the token. */
  async postJson(path: string, body: string): Promise<Response> {
    let response = await this.#send(path, body, this.#csrf ?? (await this.#token()));
    if (response.status === 403) {
      response = await this.#send(path, body, await this.#token());
    }
    return response;
  }

  async #token(): Promise<string> {
    const response = await this.#request(`${this.#origin}${CSRF_PATH}`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`the platform's CSRF token request answered HTTP ${response.status}`);
    }
    this.#csrf = (await response.text()).trim();
    return this.#csrf;
  }

  async #send(path: string, body: string, token: string): Promise<Response> {
    const response = await this.#request(`${this.#origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [CSRF_HEADER]: token },
      body,
    });
    const refreshed = response.headers.get(CSRF_HEADER);
    if (refreshed) {
      this.#csrf = refreshed;
    }
    return response;
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${this.#bearer}`,
    };
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
