import { GatewayClient } from "./GatewayClient";
import type { GatewayContext } from "./GatewayContext";
import { GatewayTokenService } from "./GatewayTokenService";

/**
 * The gateway subsystem: web-global's gateway (`gateway.bluestep.net`), reached for knowledge bases
 * and marketplace repos. It sits beside `core.script` as `core.gateway`.
 *
 * It holds the HTTP {@link client} and the caller's own token management ({@link tokens}); the
 * knowledge-base and marketplace operations are added beside them as their own members. Each is
 * built over that one client, so every gateway request shares its one-at-a-time queue.
 * @lastreviewed null
 */
export class GatewayService {
  /**
   * The authenticated, sequential HTTP client for the gateway.
   * @lastreviewed null
   */
  readonly client: GatewayClient;

  /**
   * Self-service management of the caller's own tokens: list, create, revoke, rotate.
   * @lastreviewed null
   */
  readonly tokens: GatewayTokenService;

  constructor(ctx: GatewayContext) {
    this.client = new GatewayClient(ctx);
    this.tokens = new GatewayTokenService(this.client, ctx);
  }
}
