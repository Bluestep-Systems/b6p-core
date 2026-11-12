/**
 * Discriminant carried by every {@link BsjsGitError}, so callers can branch without `instanceof`.
 *
 * The first group mirrors what the platform's git proxy answers; the rest are this package's own.
 * @lastreviewed null
 */
export type BsjsGitErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "PUSH_NOT_ENABLED"
  | "CODE_LOCKED"
  | "REPO_NOT_FOUND"
  | "UNSUPPORTED_REQUEST"
  | "SERVER_ERROR"
  | "TRANSPORT"
  | "PUSH_REJECTED"
  | "NOT_FAST_FORWARD"
  | "IDENTITY_REQUIRED"
  | "UNPUSHED_CHANGES"
  | "PUBLISH_REFUSED"
  | "PUBLISH_FAILED"
  | "GIT_MODE_FAILED"
  | "UNKNOWN_SCRIPT_TYPE"
  | "LEGACY_HISTORY"
  | "BAD_SAVE_STATE";

/**
 * Base class of every error this package throws deliberately.
 * @lastreviewed null
 */
export class BsjsGitError extends Error {
  constructor(
    readonly code: BsjsGitErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The proxy answered 401: no credentials, or a token it did not accept.
 * @lastreviewed null
 */
export class GitAuthError extends BsjsGitError {
  constructor(message = "The platform did not accept the token (HTTP 401)") {
    super("AUTH_REQUIRED", message);
  }
}

/**
 * The proxy answered 403. `reason` is the server's own sentence (it is empty for the row-gated lanes, which say nothing).
 * @lastreviewed null
 */
export class GitPermissionError extends BsjsGitError {
  constructor(
    readonly reason: string,
    code: "PERMISSION_DENIED" | "PUSH_NOT_ENABLED" | "CODE_LOCKED" = "PERMISSION_DENIED"
  ) {
    super(code, reason ? `Refused by the platform: ${reason}` : "Refused by the platform (HTTP 403)");
  }
}

/**
 * A push was refused because the script publishes over WebDAV, so its repo is a read-only mirror. Enabling git
 * publishing on the script is the platform's side of the fix, not this client's.
 * @lastreviewed null
 */
export class GitPushNotEnabledError extends GitPermissionError {
  constructor(reason: string) {
    super(reason, "PUSH_NOT_ENABLED");
  }
}

/**
 * A push was refused because the script's code is locked (carries a fixed id or is frozen).
 * @lastreviewed null
 */
export class GitCodeLockedError extends GitPermissionError {
  constructor(reason: string) {
    super(reason, "CODE_LOCKED");
  }
}

/**
 * The proxy answered 404: the script has no repo yet, the caller cannot see it, or git integration is off. The
 * platform deliberately does not say which.
 * @lastreviewed null
 */
export class GitRepoNotFoundError extends BsjsGitError {
  constructor() {
    super("REPO_NOT_FOUND", "The script's git repo was not found (HTTP 404): it has no repo yet, or is not visible");
  }
}

/**
 * The proxy answered 415: the request body's content type is one the platform has already consumed.
 * @lastreviewed null
 */
export class GitUnsupportedRequestError extends BsjsGitError {
  constructor() {
    super("UNSUPPORTED_REQUEST", "The platform refused the git request's content type (HTTP 415)");
  }
}

/**
 * The proxy answered 5xx (502 is the forge being unreachable or misconfigured).
 * @lastreviewed null
 */
export class GitServerError extends BsjsGitError {
  constructor(readonly status: number) {
    super("SERVER_ERROR", `The platform's git service failed (HTTP ${status})`);
  }
}

/**
 * The request never produced an HTTP answer (network down, aborted).
 * @lastreviewed null
 */
export class GitTransportError extends BsjsGitError {
  constructor(cause: unknown) {
    super("TRANSPORT", `Could not reach the platform: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/**
 * The forge accepted the connection but refused the ref update, in git's own vocabulary. `protectedBranch` is true when
 * the ref is the published branch, which a proxied push can never move.
 * @lastreviewed null
 */
export class GitPushRejectedError extends BsjsGitError {
  constructor(
    readonly ref: string,
    readonly reason: string,
    readonly protectedBranch: boolean
  ) {
    super(
      "PUSH_REJECTED",
      protectedBranch
        ? `Push to ${ref} refused: the published branch can only be moved by a publish (${reason})`
        : `Push to ${ref} refused: ${reason}`
    );
  }
}

/**
 * The push would not be a fast-forward: fetch and integrate the remote draft first.
 * @lastreviewed null
 */
export class GitNotFastForwardError extends BsjsGitError {
  constructor(readonly ref: string) {
    super("NOT_FAST_FORWARD", `Push to ${ref} is not a fast-forward; fetch and integrate the remote branch first`);
  }
}

/**
 * Commits need a caller-supplied author; this package never invents one.
 * @lastreviewed null
 */
export class GitIdentityError extends BsjsGitError {
  constructor(message: string) {
    super("IDENTITY_REQUIRED", message);
  }
}

/**
 * A publish was attempted while the local draft has commits the platform's draft does not.
 * @lastreviewed null
 */
export class GitUnpushedChangesError extends BsjsGitError {
  constructor(
    readonly localSha: string,
    readonly remoteSha: string | undefined
  ) {
    super("UNPUSHED_CHANGES", "The local draft is not what the platform holds; push it before publishing");
  }
}

/**
 * The platform refused the publish (`PUBLISH_REFUSED`): nothing was written. `reason` is the server's
 * `extensions.reason` (for example `ENTRYPOINT_MISSING`) and `details` its `extensions.publish`.
 * @lastreviewed null
 */
export class PublishRefusedError extends BsjsGitError {
  constructor(
    readonly reason: string | undefined,
    readonly details: unknown,
    message: string
  ) {
    super("PUBLISH_REFUSED", `Publish refused${reason ? ` (${reason})` : ""}: ${message}`);
  }
}

/**
 * Any other publish failure (transport status, a GraphQL error that is not a refusal, an answer without a sha).
 * @lastreviewed null
 */
export class PublishFailedError extends BsjsGitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("PUBLISH_FAILED", `Publish failed: ${message}`, options);
  }
}

/**
 * The script's class id has no known publish mutation.
 * @lastreviewed null
 */
export class UnknownScriptTypeError extends BsjsGitError {
  constructor(classid: string) {
    super("UNKNOWN_SCRIPT_TYPE", `No script type is known for classid ${classid}`);
  }
}

/**
 * The legacy history endpoint answered with something other than the contract.
 * @lastreviewed null
 */
export class LegacyHistoryError extends BsjsGitError {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super("LEGACY_HISTORY", message);
  }
}

/**
 * A stored saveState was not a version 0 or version 1 tree.
 * @lastreviewed null
 */
export class BadSaveStateError extends BsjsGitError {
  constructor(message: string) {
    super("BAD_SAVE_STATE", message);
  }
}

/**
 * Switching the script to git publishing failed, or left it without a clone URL.
 * @lastreviewed null
 */
export class GitModeError extends BsjsGitError {
  constructor(message: string, cause?: unknown) {
    super("GIT_MODE_FAILED", `Could not switch the script to git publishing: ${message}`, { cause });
  }
}

/**
 * The reason the platform gives (`PUBLISH_REFUSED`) when the draft it holds is no longer the commit the caller verified
 * and asked to publish (`expectedDraftSha`).
 * @lastreviewed null
 */
export const DRAFT_MOVED_REASON = "draft moved";

/**
 * The publish was refused because the platform's draft moved after this client verified it (someone pushed in between):
 * nothing was published, and the draft to publish must be fetched and checked again.
 * @lastreviewed null
 */
export class PublishDraftMovedError extends PublishRefusedError {
  constructor(details: unknown, message: string) {
    super(DRAFT_MOVED_REASON, details, message);
  }
}
