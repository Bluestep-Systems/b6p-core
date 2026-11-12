import { AuthTypes } from "../constants/AuthTypes";
import { Gateway } from "../constants/Gateway";
import { Http } from "../constants/Http";
import { MimeTypes } from "../constants/MimeTypes";
import { Err } from "../Err";
import type { GatewayErrorBody, JsonValue } from "../types";
import type { GatewayContext } from "./GatewayContext";
import { gatewayTokenProblem, redactToken } from "./GatewayToken";

/**
 * Hosts allowed to use plain `http:`; everything else must be `https:`, so the bearer token never
 * crosses a network in the clear. Loopback is allowed for local fakes and port-forwards.
 * @lastreviewed null
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Options for one gateway REST request.
 * @lastreviewed null
 */
export interface GatewayRequestOptions {
  /**
   * Query parameters; `undefined` values are left out.
   * @lastreviewed null
   */
  query?: Readonly<Record<string, string | undefined>>;
  /**
   * JSON request body.
   * @lastreviewed null
   */
  body?: JsonValue;
  /**
   * Extra request headers, e.g. `Idempotency-Key`. A name the client sets itself (`Authorization`,
   * `Accept`, `Content-Type`) or a credential header (`Cookie`, `Proxy-Authorization`) is refused
   * with {@link Err.GatewayConfigError} and nothing is sent, as is a name that is not an HTTP token
   * or a value with control characters. No message quotes a value.
   * @lastreviewed null
   */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Header names (lower case) a caller's {@link GatewayRequestOptions.headers} may not set: the ones
 * the client sets itself, and every header that carries a credential.
 * @lastreviewed null
 */
const RESERVED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "accept", "content-type"]);

/**
 * An HTTP header name (RFC 9110 token).
 * @lastreviewed null
 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * An HTTP header value: visible ASCII, spaces and tabs only.
 * @lastreviewed null
 */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/**
 * Check a caller's extra headers before anything is sent. Messages name the header, never its value.
 * @lastreviewed null
 */
function checkExtraHeaders(headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new Err.GatewayConfigError(
        "A gateway request header name is not a valid HTTP header name; nothing was sent."
      );
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new Err.GatewayConfigError(
        `A gateway request may not carry a caller-set ${name} header (the client owns it); nothing was sent.`
      );
    }
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
      throw new Err.GatewayConfigError(
        `The gateway request header ${name} has a value that is not valid; nothing was sent.`
      );
    }
  }
}

/**
 * The handle a {@link GatewayClient.sequence} unit sends its requests through. Every request it
 * sends presents the one token read by its first {@link token} call.
 * @lastreviewed null
 */
export interface GatewaySequence {
  /**
   * The stored token, read once on first call (a typed {@link Err.GatewayAuthError} when none is
   * usable) and the same value on every later call and request of the unit. A secret: never log
   * it or put it in a message.
   * @lastreviewed null
   */
  token(): Promise<string>;
  /**
   * Send one request as part of the unit. Await each before sending the next: the unit holds the
   * client's queue, so its own requests are not queued behind one another.
   * @lastreviewed null
   */
  request(method: string, path: string, options?: GatewayRequestOptions): Promise<JsonValue | undefined>;
}

/**
 * Tuning for a {@link GatewayClient}.
 * @lastreviewed null
 */
export interface GatewayClientOptions {
  /**
   * Milliseconds before a request is abandoned as {@link Err.GatewayUnavailableError}.
   * Defaults to `Gateway.REQUEST_TIMEOUT_MS`.
   * @lastreviewed null
   */
  timeoutMs?: number;
}

/**
 * Validate a configured gateway URL and reduce it to its origin. Throws
 * {@link Err.GatewayConfigError} for anything the token must not be sent to.
 * @lastreviewed null
 */
export function parseGatewayOrigin(raw: string): string {
  // No message below quotes the value, its host or its path: a token pasted into the wrong setting
  // would otherwise reach every error the client throws.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Err.GatewayConfigError("The configured gateway URL is not a URL.");
  }
  if (url.username || url.password) {
    throw new Err.GatewayConfigError("The configured gateway URL carries credentials, which is not allowed.");
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Err.GatewayConfigError(
      "The configured gateway URL is not a bare origin: it has a path, a query or a fragment."
    );
  }
  if (url.protocol === "https:") {
    return url.origin;
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.origin;
  }
  if (url.protocol === "http:") {
    throw new Err.GatewayConfigError(
      "The configured gateway URL uses plain http on a host that is not loopback; https is required there."
    );
  }
  throw new Err.GatewayConfigError("The configured gateway URL's scheme is neither https nor http.");
}

/**
 * Parse a gateway error body. Best-effort: anything that is not a JSON object yields `{}`.
 * @lastreviewed null
 */
function parseErrorBody(text: string): GatewayErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const body: GatewayErrorBody = {};
  if (typeof record.error === "string") {
    body.error = record.error;
  }
  if (typeof record.message === "string") {
    body.message = record.message;
  }
  if (typeof record.scope === "string") {
    body.scope = record.scope;
  }
  if (typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0) {
    body.limit = record.limit;
  }
  // A reason is a short code; anything else is ignored rather than quoted.
  if (typeof record.reason === "string" && /^[a-z0-9-]{1,64}$/.test(record.reason)) {
    body.reason = record.reason;
  }
  if (
    typeof record.presentingExpiresAt === "string" &&
    record.presentingExpiresAt.length <= 40 &&
    !Number.isNaN(Date.parse(record.presentingExpiresAt))
  ) {
    body.presentingExpiresAt = record.presentingExpiresAt;
  }
  return body;
}

/**
 * Map a gateway error response to its typed error. Exported so the git layer, which sees the
 * status (and a best-effort body) through its own HTTP client, maps failures exactly as REST does.
 *
 * @param status the HTTP status (non-2xx)
 * @param bodyText the raw response body, `""` when there is none
 * @param what what was being attempted, e.g. `GET /api/v1/knowledge-bases`; must not contain the token
 * @param token the token that was sent, redacted from anything the server said
 * @lastreviewed null
 */
export function gatewayErrorFor(status: number, bodyText: string, what: string, token?: string): Err.GatewayError {
  const body = parseErrorBody(bodyText);
  const code = body.error ?? null;
  const said = body.message ? `: ${redactToken(body.message, token)}` : "";
  const tag = code ? `${status} ${code}` : `${status}`;
  const msg = (happened: string): string => `${what}: ${happened} (${tag})${said}`;

  switch (status) {
    case 401: {
      const reason = code === "token-missing" ? "token-missing" : "token-invalid";
      const happened =
        reason === "token-missing"
          ? "the gateway received no access token"
          : "the gateway did not accept the access token";
      return new Err.GatewayAuthError(msg(happened), reason, status);
    }
    case 403:
      if (code === "scope-missing") {
        const scope = body.scope ?? null;
        const lacks = scope ? `the access token lacks the ${scope} scope` : "the access token lacks a required scope";
        return new Err.GatewayScopeError(msg(lacks), scope);
      }
      if (code === "scope-escalation") {
        return new Err.GatewayScopeEscalationError(
          msg("a new token's scopes may not exceed those of the token making the request")
        );
      }
      return new Err.GatewayNotPermittedError(
        msg("this user is not permitted to do this"),
        code,
        body.reason ?? null,
        body.presentingExpiresAt ?? null,
        body.scope !== undefined && /^[a-z0-9:_-]{1,64}$/.test(body.scope) ? body.scope : null
      );
    case 400:
      return new Err.GatewayInvalidRequestError(msg("the gateway rejected the request as malformed"), code);
    case 404:
      return new Err.GatewayNotFoundError(msg("not found, or not visible to this user"), code);
    case 409:
      if (code === "alias-taken") {
        return new Err.GatewayAliasTakenError(msg("another of this user's tokens already has that alias"));
      }
      if (code === "token-limit") {
        const limit = body.limit ?? null;
        const full = limit
          ? `this user already has the maximum of ${limit} live tokens`
          : "this user already has the maximum number of live tokens";
        return new Err.GatewayTokenLimitError(msg(full), limit);
      }
      if (code === "live-branch-unprotected") {
        return new Err.GatewayLiveBranchUnprotectedError(
          msg(
            "the gateway refused the push because the knowledge base's live branch is not protected on the forge; nothing was pushed"
          )
        );
      }
      // Only the git routes' conflicts (a push that does not build on the head; a bodyless 409 from
      // the git proxy) are about a branch head. Any other 409 code is some other conflict.
      if (code === null || code === "non-fast-forward") {
        return new Err.GatewayConflictError(msg("the update does not build on the current branch head"), code);
      }
      return new Err.GatewayConflictError(msg("the request conflicts with the current state"), code);
    case 413:
      return new Err.GatewayTooLargeError(msg("the request is larger than the gateway accepts"), code);
    case 503:
      if (code === "registry-unavailable") {
        return new Err.GatewayUnavailableError(
          msg("web-global, which holds the registry, could not answer"),
          status,
          code
        );
      }
      return new Err.GatewayUnavailableError(msg("the gateway or the forge behind it is unavailable"), status, code);
    case 502:
    case 504:
      return new Err.GatewayUnavailableError(msg("the gateway or the forge behind it is unavailable"), status, code);
    default:
      return new Err.GatewayUnexpectedResponseError(
        msg("the gateway answered with an unexpected status"),
        status,
        code
      );
  }
}

/**
 * HTTP client for web-global's gateway.
 *
 * Every request carries `Authorization: Bearer <b6pt_ token>`, asked of the injected
 * {@link GatewayContext.gatewayToken} each time. There is no session, no login and no cookie: this
 * is deliberately not {@link SessionManager}, which bootstraps the web origin's cookie session.
 *
 * REST requests made through this client ({@link request} / {@link getJson}) run **one at a time**,
 * in call order, so a burst from a caller cannot fan out into parallel token reads or parallel
 * connections (the same discipline `SessionManager` keeps). {@link sequence} puts a longer task, such
 * as one of the git layer's operations, in the same queue. {@link authHeadersFor} is not queued: a
 * request a caller sends itself with that header is outside it unless wrapped in `sequence`.
 *
 * Redirects are never followed; a 3xx is an {@link Err.GatewayUnexpectedResponseError} with code
 * `redirect-refused`. A request path that resolves off the gateway's origin is refused unsent.
 *
 * The token never appears in a thrown message or a log line: the client never formats it, and
 * anything the server says is passed through {@link redactToken} first.
 * @lastreviewed null
 */
export class GatewayClient {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(
    private readonly ctx: GatewayContext,
    options: GatewayClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? Gateway.REQUEST_TIMEOUT_MS;
  }

  /**
   * The validated gateway origin (e.g. `https://gateway.bluestep.net`), with no trailing slash.
   * @lastreviewed null
   */
  async origin(): Promise<string> {
    return parseGatewayOrigin(await this.ctx.gatewayUrl());
  }

  /**
   * The `Authorization` header for a request to `url`, for a caller that sends requests itself
   * (the git layer hands this to its HTTP client). Throws {@link Err.GatewayConfigError} when
   * `url` is not on the gateway's origin, so a server-supplied URL cannot redirect the token, and
   * {@link Err.GatewayAuthError} when no usable token is available.
   * @lastreviewed null
   */
  async authHeadersFor(url: string): Promise<Record<string, string>> {
    const origin = await this.origin();
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Err.GatewayConfigError("A URL handed to the gateway client is not a URL.");
    }
    if (target.origin !== origin) {
      throw new Err.GatewayConfigError(
        "A URL handed to the gateway client is not on the gateway's origin; no token is sent to it."
      );
    }
    const token = await this.requireToken();
    return { [Http.Headers.AUTHORIZATION]: `${AuthTypes.BEARER_PREFIX}${token}` };
  }

  /**
   * `GET` a JSON resource.
   * @lastreviewed null
   */
  async getJson(path: string, query?: GatewayRequestOptions["query"]): Promise<JsonValue | undefined> {
    return this.request(Http.Methods.GET, path, { query });
  }

  /**
   * Send one REST request and return its parsed JSON body (`undefined` for an empty body). Queued
   * behind any request already in flight on this client.
   *
   * @param method HTTP method
   * @param path absolute path on the gateway, e.g. `/api/v1/knowledge-bases`
   * @throws {Err.GatewayError} a subclass naming what went wrong
   * @lastreviewed null
   */
  request(method: string, path: string, options: GatewayRequestOptions = {}): Promise<JsonValue | undefined> {
    return this.sequence((seq) => seq.request(method, path, options));
  }

  /**
   * Run `unit` as ONE entry in this client's one-at-a-time queue, behind any request or unit
   * already in flight. Nothing else on this client runs until `unit` settles. The git layer wraps
   * a whole operation (several HTTP requests) in this so git traffic and REST calls never overlap
   * (it ignores `seq`); token rotation runs list + rotate + store in it, so nothing queued can
   * present the just-revoked token.
   *
   * `seq.token()` reads the stored token once, on first use, and every later call and every
   * `seq.request` of the unit presents that same value.
   *
   * Inside `unit`, send REST requests through `seq` only. Calling {@link request} or `sequence` on
   * this client from inside it waits behind the unit itself and never runs.
   * @lastreviewed null
   */
  sequence<T>(unit: (seq: GatewaySequence) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      let read: Promise<string> | undefined;
      let open = true;
      const token = (): Promise<string> => (read ??= this.requireToken());
      const seq: GatewaySequence = {
        token,
        request: async (method, path, options = {}) => {
          if (!open) {
            throw new Err.GatewayConfigError("A gateway request was sent through a sequence that has ended.");
          }
          return this.send(method, path, options, token);
        },
      };
      try {
        return await unit(seq);
      } finally {
        open = false;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async requireToken(): Promise<string> {
    const token = await this.ctx.gatewayToken.token();
    if (token === undefined || token.length === 0) {
      throw new Err.GatewayAuthError("No gateway access token is available.", "token-missing", null);
    }
    const problem = gatewayTokenProblem(token);
    if (problem) {
      throw new Err.GatewayAuthError(`The gateway access token is not usable: ${problem}.`, "token-malformed", null);
    }
    return token;
  }

  private async send(
    method: string,
    path: string,
    options: GatewayRequestOptions,
    readToken: () => Promise<string>
  ): Promise<JsonValue | undefined> {
    const origin = await this.origin();
    // Neither message quotes the path: it may carry caller or server input.
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Err.GatewayConfigError("A gateway request path is not an absolute path.");
    }
    const url = new URL(path, origin);
    // URL parsing reads `\` as `/` and drops tabs and newlines, so a path like `/\host/x` resolves to
    // another host. Checked on the built URL, before any header exists, as in authHeadersFor.
    if (url.origin !== origin) {
      throw new Err.GatewayConfigError("A gateway request path resolves off the gateway's origin; no request is sent.");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    const what = `${method} ${url.pathname}${url.search}`;
    if (options.headers) {
      checkExtraHeaders(options.headers);
    }
    const token = await readToken();

    // The caller's headers go first, so the client's own (already refused above) could never be overridden.
    const headers: Record<string, string> = {
      ...options.headers,
      [Http.Headers.AUTHORIZATION]: `${AuthTypes.BEARER_PREFIX}${token}`,
      [Http.Headers.ACCEPT]: MimeTypes.APPLICATION_JSON,
    };
    // "manual", not "error": the redirect then arrives as a 3xx this client can name, rather than
    // a TypeError indistinguishable from the network being down. It is never followed either way.
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (options.body !== undefined) {
      headers[Http.Headers.CONTENT_TYPE] = MimeTypes.APPLICATION_JSON;
      init.body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    init.signal = controller.signal;

    let response: Response;
    let text: string;
    try {
      response = await this.ctx.fetchFn(url, init);
      text = await response.text();
    } catch (error) {
      const why = controller.signal.aborted
        ? `no answer within ${this.timeoutMs} ms`
        : `the request failed (${redactToken(error instanceof Error ? error.message : String(error), token)})`;
      throw new Err.GatewayUnavailableError(`${what}: the gateway could not be reached: ${why}.`, null, null);
    } finally {
      clearTimeout(timer);
    }

    this.ctx.logger.debug(`gateway ${what} -> ${response.status}`);
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      // Location is not quoted: it is server-supplied and names a place the token was not sent.
      throw new Err.GatewayUnexpectedResponseError(
        `${what}: the gateway answered with a redirect (${response.status}), which was not followed.`,
        response.status,
        "redirect-refused"
      );
    }
    if (!response.ok) {
      throw gatewayErrorFor(response.status, text, what, token);
    }
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new Err.GatewayUnexpectedResponseError(
        `${what}: the gateway answered ${response.status} with a body that is not JSON.`,
        response.status,
        null
      );
    }
  }
}
