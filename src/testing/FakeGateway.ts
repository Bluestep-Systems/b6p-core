import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Gateway } from "../constants/Gateway";
import type {
  GatewayErrorBody,
  GatewayKnowledgeBase,
  GatewayKnowledgeBaseList,
  GatewayMarketplaceRepo,
  GatewayMarketplaceRepoList,
} from "../types";

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
 * `GET /api/v1/registry/repos` (scope `registry:read`), `404 not-found` for anything else.
 * Tokens are granted explicitly with their scopes; a request without one is `401 token-missing`,
 * an unknown one `401 token-invalid`, a missing scope `403 scope-missing` with `scope`.
 * @lastreviewed null
 */
export class FakeGateway {
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

  private inFlight = 0;
  private readonly tokens = new Map<string, Set<string>>();
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
  grantToken(token: string, scopes: readonly string[]): void {
    this.tokens.set(token, new Set(scopes));
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

      const failure = this.failures.shift();
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
      if (!this.authorize(req, res)) {
        return;
      }
      sendJson(res, 404, { error: "not-found", message: "Not found." });
    } finally {
      this.inFlight--;
    }
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
    const scopes = this.tokens.get(token);
    if (!scopes) {
      sendJson(res, 401, { error: "token-invalid", message: "The access token is not valid." });
      return false;
    }
    if (scope && !scopes.has(scope)) {
      sendJson(res, 403, { error: "scope-missing", message: `The token lacks ${scope}.`, scope });
      return false;
    }
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
