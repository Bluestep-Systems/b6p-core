import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Gateway } from "../constants/Gateway";
import type {
  GatewayErrorBody,
  GatewayKnowledgeBase,
  GatewayKnowledgeBaseList,
  GatewayMarketplaceRepo,
  GatewayMarketplaceRepoList,
  GatewayMintedTokenBody,
  GatewayTokenList,
} from "../types";

/**
 * The gateway's default lifetime for a minted token with no `expiresAt`.
 * @lastreviewed null
 */
const DEFAULT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * Live (unexpired) tokens one user may hold; a mint past it is `409 token-limit`.
 * @lastreviewed null
 */
const LIVE_TOKEN_LIMIT = 50;

/**
 * Whether `expiresAt` has passed.
 * @lastreviewed null
 */
function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

/**
 * Metadata for a token granted with {@link FakeGateway.grantToken}. Everything is optional.
 * @lastreviewed null
 */
export interface FakeGatewayTokenOptions {
  /**
   * Defaults to `tok_<n>`.
   * @lastreviewed null
   */
  id?: string;
  /**
   * Defaults to `token-<n>`.
   * @lastreviewed null
   */
  alias?: string;
  /**
   * The global user who owns it; the token routes only show a user their own. Defaults to `"user"`.
   * @lastreviewed null
   */
  owner?: string;
  /**
   * ISO 8601; defaults to now. `null` is a token minted before the gateway recorded creation times.
   * @lastreviewed null
   */
  createdAt?: string | null;
  /**
   * ISO 8601 or `null` (never expires); defaults to 90 days after `createdAt`.
   * @lastreviewed null
   */
  expiresAt?: string | null;
}

/**
 * A token the {@link FakeGateway} accepts, secret included, as {@link FakeGateway.issuedTokens}
 * reports it for assertions.
 * @lastreviewed null
 */
export interface FakeGatewayToken {
  secret: string;
  id: string;
  alias: string;
  owner: string;
  scopes: string[];
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/**
 * One request the {@link FakeGateway} received, as recorded for assertions.
 * @lastreviewed null
 */
export interface FakeGatewayRequest {
  method: string;
  /**
   * Path without the query string.
   * @lastreviewed null
   */
  path: string;
  query: Record<string, string>;
  /**
   * The raw `Authorization` header, if any.
   * @lastreviewed null
   */
  authorization: string | undefined;
  /**
   * The request body (always `""` for a custom {@link FakeGatewayRoute}, whose body is left unread).
   * @lastreviewed null
   */
  body: string;
}

/**
 * A canned failure for the next request, served instead of the normal answer.
 * @lastreviewed null
 */
export interface FakeGatewayFailure {
  status: number;
  /**
   * A contract error body (sent as JSON), a raw string, or nothing.
   * @lastreviewed null
   */
  body?: GatewayErrorBody | string;
  /**
   * Serve this failure to the next request with this HTTP method rather than the very next
   * request, leaving requests of other methods alone. Lets a spec fail a `POST` that a `GET`
   * (the token list) precedes.
   * @lastreviewed null
   */
  method?: string;
}

/**
 * An extra route, checked before the built-in REST routes. The git layer's specs mount the smart
 * HTTP endpoints here. The token is checked first (Bearer, or Basic with the token as password, as
 * the contract allows on git routes) and, when `scope` is given, that scope too; the handler only
 * sees authorised requests. Its body stream is left unread for the handler.
 * @lastreviewed null
 */
export interface FakeGatewayRoute {
  method: string;
  /**
   * Matched against the start of the request path.
   * @lastreviewed null
   */
  prefix: string;
  scope?: string;
  handler(req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void>;
}

/**
 * An in-process gateway on `127.0.0.1` (an ephemeral port) answering the b6p gateway contract's
 * REST shapes and error codes, for specs in this package and its consumers. It is a real HTTP
 * server rather than an injected fetch so that the same instance can also serve git smart HTTP
 * (via {@link route}) to a git client that brings its own HTTP stack.
 *
 * Built in: `GET /api/v1/knowledge-bases` (scope `kb:read`, `?scope=` and `?tenant=` filters),
 * `GET /api/v1/registry/repos` (scope `registry:read`), the self-service token routes
 * (`GET`/`POST /api/v1/tokens`, `DELETE /api/v1/tokens/{id}`, `POST /api/v1/tokens/{id}/rotate`,
 * scope `tokens:self`, with `scope-escalation` and `alias-taken`), and `404 not-found` for anything else.
 * Tokens are granted explicitly with their scopes; a request without one is `401 token-missing`,
 * an unknown or expired one `401 token-invalid`, a missing scope `403 scope-missing` with `scope`.
 * @lastreviewed null
 */
export class FakeGateway {
  /**
   * When `true`, a mint or rotate of a token with any scope but `mcp` is refused `403 not-permitted`
   * with reason `restricted-mints-disabled` (the gateway's rollout switch).
   * @lastreviewed null
   */
  restrictedMintsDisabled = false;

  /**
   * Every request received, in arrival order.
   * @lastreviewed null
   */
  readonly requests: FakeGatewayRequest[] = [];
  /**
   * Knowledge bases the list route returns (to every token with `kb:read`).
   * @lastreviewed null
   */
  knowledgeBases: GatewayKnowledgeBase[] = [];
  /**
   * Marketplace repos the registry route returns.
   * @lastreviewed null
   */
  repos: GatewayMarketplaceRepo[] = [];
  /**
   * Milliseconds each built-in route waits before answering (to observe concurrency).
   * @lastreviewed null
   */
  delayMs = 0;
  /**
   * The most requests that were ever being handled at once.
   * @lastreviewed null
   */
  maxInFlight = 0;

  /**
   * Every secret this fake has ever accepted, granted or minted, revoked ones included, in issue
   * order. For leak checks: a spec can assert none of them reached a log line or an error.
   * @lastreviewed null
   */
  readonly issuedSecrets: string[] = [];

  private inFlight = 0;
  private readonly tokens = new Map<string, FakeGatewayToken>();
  private tokenSerial = 0;
  private readonly failures: FakeGatewayFailure[] = [];
  private readonly routes: FakeGatewayRoute[] = [];

  private constructor(
    private readonly server: http.Server,
    /**
     * The gateway origin, e.g. `http://127.0.0.1:41234`, to use as `gatewayUrl`.
     * @lastreviewed null
     */
    readonly url: string
  ) {}

  /**
   * Start a fake gateway on `127.0.0.1` and an ephemeral port.
   * @lastreviewed null
   */
  static async start(): Promise<FakeGateway> {
    let fake: FakeGateway | undefined;
    const server = http.createServer((req, res) => {
      if (!fake) {
        res.writeHead(503).end();
        return;
      }
      fake.handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    fake = new FakeGateway(server, `http://127.0.0.1:${port}`);
    return fake;
  }

  /**
   * Accept `token` with these scopes (replacing any earlier grant).
   * @lastreviewed null
   */
  grantToken(token: string, scopes: readonly string[], options: FakeGatewayTokenOptions = {}): void {
    const n = ++this.tokenSerial;
    const createdAt = options.createdAt === undefined ? new Date().toISOString() : options.createdAt;
    const expiresAt =
      options.expiresAt === undefined
        ? new Date(Date.parse(createdAt ?? new Date().toISOString()) + DEFAULT_TOKEN_LIFETIME_MS).toISOString()
        : options.expiresAt;
    this.issuedSecrets.push(token);
    this.tokens.set(token, {
      secret: token,
      id: options.id ?? `tok_${n}`,
      alias: options.alias ?? `token-${n}`,
      owner: options.owner ?? "user",
      scopes: [...new Set(scopes)],
      createdAt,
      expiresAt,
      lastUsedAt: null,
    });
  }

  /**
   * Every token this fake currently accepts, secrets included (granted or minted through the
   * token routes).
   * @lastreviewed null
   */
  issuedTokens(): FakeGatewayToken[] {
    return [...this.tokens.values()].map((t) => ({ ...t, scopes: [...t.scopes] }));
  }

  /**
   * Stop accepting `token`; it then answers `401 token-invalid`.
   * @lastreviewed null
   */
  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  /**
   * Serve `failure` for the next request, before any auth check. Queued failures are served in order.
   * @lastreviewed null
   */
  failNext(failure: FakeGatewayFailure): void {
    this.failures.push(failure);
  }

  /**
   * Mount an extra route; see {@link FakeGatewayRoute}.
   * @lastreviewed null
   */
  route(route: FakeGatewayRoute): void {
    this.routes.push(route);
  }

  /**
   * The git URL the real gateway would give `org`/`repo`, on this fake's origin.
   * @lastreviewed null
   */
  gitUrl(org: string, repo: string): string {
    return `${this.url}${Gateway.Paths.GIT}/${org}/${repo}.git`;
  }

  /**
   * Stop the server and drop its open connections.
   * @lastreviewed null
   */
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const url = new URL(req.url ?? "/", this.url);
      const method = req.method ?? "GET";
      const custom = this.routes.find((r) => r.method === method && url.pathname.startsWith(r.prefix));
      const body = custom ? "" : await readBody(req);
      this.requests.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: req.headers.authorization,
        body,
      });

      const at = this.failures.findIndex((f) => f.method === undefined || f.method === req.method);
      const failure = at < 0 ? undefined : this.failures.splice(at, 1)[0];
      if (failure) {
        sendFailure(res, failure);
        return;
      }

      if (custom) {
        if (this.authorize(req, res, custom.scope)) {
          await custom.handler(req, res);
        }
        return;
      }

      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }

      if (method === "GET" && url.pathname === Gateway.Paths.KNOWLEDGE_BASES) {
        if (!this.authorize(req, res, Gateway.Scopes.KB_READ)) {
          return;
        }
        const scope = url.searchParams.get("scope");
        const tenant = url.searchParams.get("tenant");
        const list: GatewayKnowledgeBaseList = {
          knowledgeBases: this.knowledgeBases.filter(
            (kb) => (!scope || kb.scope === scope) && (!tenant || kb.tenant === tenant)
          ),
        };
        sendJson(res, 200, list);
        return;
      }
      if (method === "GET" && url.pathname === Gateway.Paths.REGISTRY_REPOS) {
        if (!this.authorize(req, res, Gateway.Scopes.REGISTRY_READ)) {
          return;
        }
        const list: GatewayMarketplaceRepoList = { repos: this.repos };
        sendJson(res, 200, list);
        return;
      }
      if (url.pathname === Gateway.Paths.TOKENS || url.pathname.startsWith(`${Gateway.Paths.TOKENS}/`)) {
        if (this.authorize(req, res, Gateway.Scopes.TOKENS_SELF)) {
          this.handleTokens(method, url.pathname, body, req, res);
        }
        return;
      }
      if (!this.authorize(req, res)) {
        return;
      }
      sendJson(res, 404, { error: "not-found", message: "Not found." });
    } finally {
      this.inFlight--;
    }
  }

  /**
   * The contract's §Tokens routes, for a request already authorised with `tokens:self`.
   * @lastreviewed null
   */
  private handleTokens(
    method: string,
    path: string,
    body: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const caller = this.tokens.get(tokenFrom(req.headers.authorization) ?? "");
    if (!caller) {
      sendJson(res, 401, { error: "token-invalid", message: "The access token is not valid." });
      return;
    }
    const own = [...this.tokens.values()].filter((t) => t.owner === caller.owner);
    const notFound = (): void => sendJson(res, 404, { error: "not-found", message: "Not found." });

    if (path === Gateway.Paths.TOKENS) {
      if (method === "GET") {
        const list: GatewayTokenList = {
          tokens: own.map((t) => ({
            id: t.id,
            alias: t.alias,
            scopes: [...t.scopes],
            createdAt: t.createdAt,
            expiresAt: t.expiresAt,
            lastUsedAt: t.lastUsedAt,
            current: t === caller,
          })),
        };
        sendJson(res, 200, list);
        return;
      }
      if (method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
        const request = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
        const { alias, scopes } = request;
        if (
          typeof alias !== "string" ||
          alias.length === 0 ||
          !Array.isArray(scopes) ||
          !scopes.every((s): s is string => typeof s === "string")
        ) {
          sendJson(res, 400, { error: "invalid-request", message: "alias and scopes are required." });
          return;
        }
        if (scopes.some((s) => !caller.scopes.includes(s))) {
          sendJson(res, 403, {
            error: "scope-escalation",
            message: "The new token's scopes exceed the presenting token's.",
          });
          return;
        }
        if (own.some((t) => t.alias === alias)) {
          sendJson(res, 409, { error: "alias-taken", message: `The alias ${alias} is taken.` });
          return;
        }
        const createdAt = new Date().toISOString();
        let expiresAt: string | null;
        if (!("expiresAt" in request) || request.expiresAt === undefined) {
          // No expiry asked for: the sooner of 90 days and the presenting token's expiry.
          const full = Date.now() + DEFAULT_TOKEN_LIFETIME_MS;
          expiresAt = new Date(
            caller.expiresAt === null ? full : Math.min(full, Date.parse(caller.expiresAt))
          ).toISOString();
        } else if (request.expiresAt === null) {
          expiresAt = null;
        } else if (typeof request.expiresAt === "string") {
          expiresAt = request.expiresAt;
        } else {
          sendJson(res, 400, { error: "invalid-request", message: "expiresAt is not a date." });
          return;
        }
        if (caller.expiresAt !== null && (expiresAt === null || Date.parse(expiresAt) > Date.parse(caller.expiresAt))) {
          sendJson(res, 403, {
            error: "not-permitted",
            reason: "expiry-exceeds-presenting",
            presentingExpiresAt: caller.expiresAt,
            message: "A new token may not outlive the token that makes the request.",
          });
          return;
        }
        if (this.restrictedMintsDisabled && scopes.some((s) => s !== "mcp")) {
          sendJson(res, 403, {
            error: "not-permitted",
            reason: "restricted-mints-disabled",
            message: "Minting tokens beyond mcp is not enabled yet.",
          });
          return;
        }
        if (own.filter((t) => !isExpired(t.expiresAt)).length >= LIVE_TOKEN_LIMIT) {
          sendJson(res, 409, {
            error: "token-limit",
            message: `A user may hold at most ${LIVE_TOKEN_LIMIT} live tokens.`,
            limit: LIVE_TOKEN_LIMIT,
          });
          return;
        }
        sendJson(res, 201, this.mint(caller.owner, alias, scopes, createdAt, expiresAt));
        return;
      }
      notFound();
      return;
    }

    const rest = path.slice(Gateway.Paths.TOKENS.length + 1).split("/");
    const target = own.find((t) => t.id === decodeURIComponent(rest[0]));
    if (!target) {
      notFound();
      return;
    }
    if (rest.length === 1 && method === "DELETE") {
      this.tokens.delete(target.secret);
      res.writeHead(204).end();
      return;
    }
    if (rest.length === 2 && rest[1] === "rotate" && method === "POST") {
      if (this.restrictedMintsDisabled && target.scopes.some((s) => s !== "mcp")) {
        sendJson(res, 403, {
          error: "not-permitted",
          reason: "restricted-mints-disabled",
          message: "Minting tokens beyond mcp is not enabled yet.",
        });
        return;
      }
      const createdAt = new Date().toISOString();
      const expiresAt =
        target.expiresAt === null
          ? null
          : new Date(
              Date.now() +
                (target.createdAt === null
                  ? DEFAULT_TOKEN_LIFETIME_MS
                  : Date.parse(target.expiresAt) - Date.parse(target.createdAt))
            ).toISOString();
      this.tokens.delete(target.secret);
      sendJson(res, 201, this.mint(target.owner, target.alias, target.scopes, createdAt, expiresAt));
      return;
    }
    notFound();
  }

  private mint(
    owner: string,
    alias: string,
    scopes: readonly string[],
    createdAt: string | null,
    expiresAt: string | null
  ): GatewayMintedTokenBody {
    const n = ++this.tokenSerial;
    const secret = `${Gateway.TOKEN_PREFIX}fake_${n}_${randomBytes(12).toString("hex")}`;
    const record: FakeGatewayToken = {
      secret,
      id: `tok_${n}`,
      alias,
      owner,
      scopes: [...new Set(scopes)],
      createdAt,
      expiresAt,
      lastUsedAt: null,
    };
    this.issuedSecrets.push(secret);
    this.tokens.set(secret, record);
    return { id: record.id, token: secret, alias, scopes: [...record.scopes], expiresAt };
  }

  /**
   * Check the token (and scope); answer the contract's error and return `false` when it fails.
   * @lastreviewed null
   */
  private authorize(req: http.IncomingMessage, res: http.ServerResponse, scope?: string): boolean {
    const token = tokenFrom(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: "token-missing", message: "No access token was sent." });
      return false;
    }
    const granted = this.tokens.get(token);
    if (!granted || (granted.expiresAt !== null && Date.parse(granted.expiresAt) <= Date.now())) {
      sendJson(res, 401, { error: "token-invalid", message: "The access token is not valid." });
      return false;
    }
    if (scope && !granted.scopes.includes(scope)) {
      sendJson(res, 403, { error: "scope-missing", message: `The token lacks ${scope}.`, scope });
      return false;
    }
    granted.lastUsedAt = new Date().toISOString();
    return true;
  }
}

function tokenFrom(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  if (header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length) || undefined;
  }
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon >= 0 ? decoded.slice(colon + 1) || undefined : undefined;
  }
  return undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendFailure(res: http.ServerResponse, failure: FakeGatewayFailure): void {
  if (failure.body === undefined) {
    res.writeHead(failure.status).end();
  } else if (typeof failure.body === "string") {
    res.writeHead(failure.status, { "Content-Type": "text/plain" }).end(failure.body);
  } else {
    sendJson(res, failure.status, failure.body);
  }
}
