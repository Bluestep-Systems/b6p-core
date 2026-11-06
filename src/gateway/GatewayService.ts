import { GatewayClient } from "./GatewayClient";
import type { GatewayContext } from "./GatewayContext";

/**
 * The gateway subsystem: web-global's gateway (`gateway.bluestep.net`), reached for knowledge bases
 * and marketplace repos. It sits beside `core.script` as `core.gateway`.
 *
 * Today it holds only the HTTP {@link client}; the knowledge-base and marketplace operations are
 * added beside it as their own members, each built over that one client so every gateway request
 * shares its one-at-a-time queue.
 * @lastreviewed null
 */
export class GatewayService {
  /**
   * The authenticated, sequential HTTP client for the gateway.
   * @lastreviewed null
   */
  readonly client: GatewayClient;

  constructor(ctx: GatewayContext) {
    this.client = new GatewayClient(ctx);
  }
}
