/**
 * Constants for b6p as git's credential helper ({@link GitCredentialService}).
 * @lastreviewed null
 */
export namespace GitCredential {
  /**
   * The username answered with the token. Both git proxies (the platform's and the gateway's) read
   * only the Basic password, but Basic needs a username; this is the one `bsjs-git` sends.
   * @lastreviewed null
   */
  export const USERNAME = "b6p";

  /**
   * The helper command written into git config by default: git runs `<command> get|store|erase`
   * through the shell, so the leading `!` makes it a shell command rather than a
   * `git credential-<name>` program.
   * @lastreviewed null
   */
  export const DEFAULT_HELPER = "!b6p auth git-credential";
}
