import { GatewayClient } from "./GatewayClient";
import { GatewayGit } from "./GatewayGit";
import type { GatewayGitOptions } from "./GatewayGit";
import { GatewayMarketplace } from "./GatewayMarketplace";
import type { GatewayContext } from "./GatewayContext";

/**
 * The gateway subsystem: web-global's gateway (`gateway.bluestep.net`), reached for knowledge bases
 * and marketplace repos. It sits beside `core.script` as `core.gateway`.
 *
 * Today it holds the HTTP {@link client} and the {@link git} layer; the knowledge-base and marketplace
 * operations are added beside them as their own members, each built over that one client so every
 * REST request made through it, and every git operation, shares its one-at-a-time queue.
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
   * Marketplace repos: list and pull a plain working clone (no push).
   * @lastreviewed null
   */
  readonly marketplace: GatewayMarketplace;

  constructor(ctx: GatewayContext, options: { git?: GatewayGitOptions } = {}) {
    this.client = new GatewayClient(ctx);
    this.git = new GatewayGit(ctx, this.client, options.git);
    this.marketplace = new GatewayMarketplace(this.client, this.git);
  }
}
