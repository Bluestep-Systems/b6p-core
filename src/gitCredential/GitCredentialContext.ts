import type { GitCredentialHosts } from "../cache/GitCredentialHosts";
import type { PlatformContext } from "../PlatformContext";
import type { GatewayTokenSource } from "../providers";
import type { GitConfigRunner } from "./GitConfigRunner";

/**
 * The dependency bundle of the git-credential subsystem ({@link GitCredentialService}): the shared
 * {@link PlatformContext} plus what only it reads. It never prompts and never drives the token's
 * lifecycle: the token is read through {@link token} and nothing here writes it.
 * @lastreviewed null
 */
export interface GitCredentialContext extends PlatformContext {
  /**
   * The stored `b6pt_` token, read without prompting (the gateway's source).
   * @lastreviewed null
   */
  readonly token: GatewayTokenSource;
  /**
   * The configured gateway origin (core config `settings.gatewayUrl`), unvalidated.
   * @lastreviewed null
   */
  gatewayUrl(): Promise<string>;
  /**
   * The tenant hosts script pulls reached with the stored token.
   * @lastreviewed null
   */
  readonly hosts: GitCredentialHosts;
  /**
   * Runs `git config`, for reading, setting up and taking out the helper in the user's global config.
   * @lastreviewed null
   */
  readonly gitConfig: GitConfigRunner;
}
