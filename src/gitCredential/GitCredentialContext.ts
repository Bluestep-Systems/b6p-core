import type { GitCredentialHosts } from "../cache/GitCredentialHosts";
import type { GitCredentialResets } from "../cache/GitCredentialResets";
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
   * The resets b6p wrote into the user's git config, so it removes only its own.
   * @lastreviewed null
   */
  readonly resets: GitCredentialResets;
  /**
   * Runs git (`git config`, `git var`, `git --version`) and edits config files under git's lock, for
   * reading the config in effect, and setting up and taking out the helper in the user's global config.
   * @lastreviewed null
   */
  readonly gitConfig: GitConfigRunner;
}
