/**
 * Constants for web-global's gateway (`gateway.bluestep.net`), the origin b6p reaches for
 * knowledge bases and marketplace repos. Paths follow the approved b6p gateway contract: every
 * REST route sits under `/api/v1/<area>`.
 * @lastreviewed null
 */
export namespace Gateway {
  /**
   * The gateway used when the `gatewayUrl` config value is unset.
   * @lastreviewed null
   */
  export const DEFAULT_URL = "https://gateway.bluestep.net";

  /**
   * Every global-user access token the gateway accepts starts with this.
   * @lastreviewed null
   */
  export const TOKEN_PREFIX = "b6pt_";

  /**
   * How long one gateway request may take before it counts as the gateway being unavailable.
   * @lastreviewed null
   */
  export const REQUEST_TIMEOUT_MS = 30_000;

  /**
   * How long a git request may wait for the gateway's first byte (its response headers) before it
   * counts as the gateway being unavailable. Generous because the gateway may be waking the forge.
   * @lastreviewed null
   */
  export const GIT_FIRST_BYTE_TIMEOUT_MS = 30_000;

  /**
   * How long a git response body may go without yielding any bytes before it counts as the gateway
   * being unavailable. An idle timeout rather than a total one, so a large pack on a slow link is
   * never cut off while it is still arriving.
   * @lastreviewed null
   */
  export const GIT_IDLE_TIMEOUT_MS = 60_000;

  /**
   * REST paths, relative to the gateway origin.
   * @lastreviewed null
   */
  export namespace Paths {
    export const KNOWLEDGE_BASES = "/api/v1/knowledge-bases";
    export const REGISTRY_REPOS = "/api/v1/registry/repos";
    export const GIT = "/api/v1/git";
  }

  /**
   * The token scopes the gateway checks. b6p reads with `kb:read` / `registry:read` and pushes a
   * knowledge base with `kb:push`.
   * @lastreviewed null
   */
  export namespace Scopes {
    export const KB_READ = "kb:read";
    export const KB_PUSH = "kb:push";
    export const REGISTRY_READ = "registry:read";
    export const REGISTRY_PUSH = "registry:push";
    export const MCP = "mcp";
  }
}
