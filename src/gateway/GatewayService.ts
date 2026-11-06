import { GatewayClient } from "./GatewayClient";
import { GatewayGit } from "./GatewayGit";
import type { GatewayGitOptions } from "./GatewayGit";
import type { GatewayContext } from "./GatewayContext";
import { GatewayTokenService } from "./GatewayTokenService";

/**
 * The gateway subsystem: web-global's gateway (`gateway.bluestep.net`), reached for knowledge bases
 * and marketplace repos. It sits beside `core.script` as `core.gateway`.
 *
 * It holds the HTTP {@link client}, the {@link git} layer and the caller's own token management
 * ({@link tokens}); the knowledge-base and marketplace operations are added beside them as their
 * own members. Each is built over that one client, so every gateway request shares its
 * one-at-a-time queue.
 * @lastreviewed null
 */
export class GatewayService {
  /**
   * The authenticated, sequential HTTP client for the gateway.
   * @lastreviewed null
   */
  readonly client: GatewayClient;

  /**
   * Pure-JS git over the gateway's smart HTTP endpoints (clone, fast-forward pull, status, push).
   * @lastreviewed null
   */
  readonly git: GatewayGit;

  /**
   * Self-service management of the caller's own tokens: list, create, revoke, rotate.
   * @lastreviewed null
   */
  readonly tokens: GatewayTokenService;

  constructor(ctx: GatewayContext, options: { git?: GatewayGitOptions } = {}) {
    this.client = new GatewayClient(ctx);
    this.git = new GatewayGit(ctx, this.client, options.git);
    this.tokens = new GatewayTokenService(this.client, ctx);
  }
}
