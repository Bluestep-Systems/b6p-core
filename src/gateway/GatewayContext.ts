import type { PlatformContext } from "../PlatformContext";
import type { GatewayTokenSource } from "../providers";

/**
 * Fetch signature the gateway client calls; matches `globalThis.fetch`.
 * @lastreviewed null
 */
export type GatewayFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The dependency bundle of the gateway subsystem ({@link GatewayService}): the shared
 * {@link PlatformContext} plus what only the gateway reads. {@link B6PCore} spreads its one
 * platform bundle into this, the same as it does for `ScriptContext`.
 *
 * It holds no `persistence` and no `auth`: the gateway is a second origin that sends the stored
 * `b6pt_` token on every request, read through {@link gatewayToken}. It must never reach the web
 * session's cookie bootstrap (`SessionManager`) or drive the credential's lifecycle (prompting,
 * storing, clearing).
 * @lastreviewed null
 */
export interface GatewayContext extends PlatformContext {
  /**
   * Where the `b6pt_` token comes from, asked once per request.
   * @lastreviewed null
   */
  readonly gatewayToken: GatewayTokenSource;
  /**
   * The configured gateway origin (unvalidated; the client checks it before every request).
   * @lastreviewed null
   */
  gatewayUrl(): Promise<string>;
  /**
   * The fetch the client sends requests through.
   * @lastreviewed null
   */
  readonly fetchFn: GatewayFetch;
}
