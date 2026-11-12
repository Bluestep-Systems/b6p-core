import type { GatewayMintedToken } from "./types";

/**
 * Centralized error namespace containing all custom error types used throughout the application.
 * All error classes extend {@link Error} and have descriptive names that indicate why the error was thrown.
 * @lastreviewed 2025-10-01
 */
export namespace Err {
  // Base Infrastructure Errors

  /**
   * Base error for initialization failures in singleton managers.
   */
  export class InitializationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "InitializationError";
    }
  }

  /**
   * Error thrown when a singleton manager is initialized more than once.
   */
  export class DuplicateInitializationError extends InitializationError {
    constructor(manager: string) {
      super(`Only one ${manager} may be initialized`);
      this.name = "DuplicateInitializationError";
    }
  }

  /**
   * Error thrown when accessing an uninitialized manager.
   */
  export class ManagerNotInitializedError extends InitializationError {
    constructor(manager: string) {
      super(`${manager} not initialized`);
      this.name = "ManagerNotInitializedError";
    }
  }

  /**
   * Error thrown when required VS Code context is missing.
   */
  export class ContextNotSetError extends Error {
    constructor(contextType: string) {
      super(`${contextType} is not set`);
      this.name = "ContextNotSetError";
    }
  }

  /**
   * Error thrown when VS Code context is already set and cannot be overridden.
   */
  export class ContextAlreadySetError extends Error {
    constructor(contextType: string) {
      super(`${contextType} is already set`);
      this.name = "ContextAlreadySetError";
    }
  }

  // File System Errors

  /**
   * Base class for file I/O related errors.
   */
  export class FileSystemError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "FileSystemError";
    }
  }

  /**
   * Error thrown when a file read operation fails.
   */
  export class FileReadError extends FileSystemError {
    constructor(message: string) {
      super(message);
      this.name = "FileReadError";
    }
  }

  /**
   * Error thrown when attempting to access a file that does not exist.
   */
  export class FileNotFoundError extends FileSystemError {
    constructor(filePath: string) {
      super(`File not found: ${filePath}`);
      this.name = "FileNotFoundError";
    }
  }

  /**
   * Error thrown when attempting to access a directory that does not exist.
   */
  export class DirectoryNotFoundError extends FileSystemError {
    constructor(dirPath: string) {
      super(`Directory not found: ${dirPath}`);
      this.name = "DirectoryNotFoundError";
    }
  }

  /**
   * Error thrown when attempting to overwrite an existing file.
   */
  export class FileAlreadyExistsError extends FileSystemError {
    constructor(filePath: string) {
      super(`File already exists: ${filePath}`);
      this.name = "FileAlreadyExistsError";
    }
  }

  /**
   * Error thrown when method is not implemented (placeholder methods).
   */
  export class MethodNotImplementedError extends Error {
    constructor() {
      super("Method not implemented");
      this.name = "MethodNotImplementedError";
    }
  }

  // Authentication Errors

  /**
   * Base class for authentication-related errors.
   */
  export class AuthenticationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AuthenticationError";
    }
  }

  /**
   * Error thrown when credentials are not found for a given flag.
   */
  export class CredentialsNotFoundError extends AuthenticationError {
    constructor(flag: string) {
      super(`No existing credentials found for flag: ${flag}`);
      this.name = "CredentialsNotFoundError";
    }
  }

  // Session Management Errors

  /**
   * Base class for session-related errors.
   */
  export class SessionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "SessionError";
    }
  }

  /**
   * Error thrown when session is not found for an origin.
   */
  export class SessionNotFoundError extends SessionError {
    constructor(origin: string) {
      super(`Session not found for origin: ${origin}`);
      this.name = "SessionNotFoundError";
    }
  }

  /**
   * Error thrown when CSRF token is missing from response.
   */
  export class CsrfTokenNotFoundError extends SessionError {
    constructor() {
      super("CSRF token not found");
      this.name = "CsrfTokenNotFoundError";
    }
  }

  /**
   * Error thrown when request times out.
   */
  export class RequestTimeoutError extends SessionError {
    constructor() {
      super("Request timed out");
      this.name = "RequestTimeoutError";
    }
  }

  /**
   * Error thrown when retry attempts are exhausted.
   */
  export class RetryAttemptsExhaustedError extends SessionError {
    constructor(details: string) {
      super(`Retry attempts exhausted: ${details}`);
      this.name = "RetryAttemptsExhaustedError";
    }
  }

  /**
   * Error thrown for HTTP unauthorized (401/403) responses.
   */
  export class UnauthorizedError extends SessionError {
    constructor(message: string) {
      super(message);
      this.name = "UnauthorizedError";
    }
  }

  /**
   * Error thrown for general HTTP response errors.
   */
  export class HttpResponseError extends SessionError {
    constructor(message: string) {
      super(message);
      this.name = "HttpResponseError";
    }
  }

  /**
   * Error thrown when session data is missing.
   */
  export class SessionDataMissingError extends SessionError {
    constructor() {
      super("No existing session data found, and no cookies in response");
      this.name = "SessionDataMissingError";
    }
  }

  /**
   * Error thrown when required session ID is missing.
   */
  export class SessionIdMissingError extends SessionError {
    constructor() {
      super("Missing JSESSIONID");
      this.name = "SessionIdMissingError";
    }
  }

  // Data Parsing Errors

  /**
   * Base class for data parsing errors.
   */
  export class DataParsingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DataParsingError";
    }
  }

  /**
   * Error thrown when WebDAV response parsing fails.
   */
  export class ScriptKeyParsingError extends DataParsingError {
    constructor(message: string) {
      super(message);
      this.name = "ScriptKeyParsingError";
    }
  }

  /**
   * Error thrown when URL parsing fails.
   */
  export class UrlParsingError extends DataParsingError {
    constructor(
      message: string,
      public readonly input?: string
    ) {
      super(message);
      this.name = "UrlParsingError";
    }
  }

  /**
   * Error thrown when ID format is invalid.
   */
  export class InvalidIdFormatError extends DataParsingError {
    constructor(id: string, expectedFormat: string) {
      super(`Invalid ID format: expected ${expectedFormat} but got: ${id}`);
      this.name = "InvalidIdFormatError";
    }
  }

  /**
   * Error thrown when JSON metadata is malformed.
   */
  export class MalformedJsonError extends DataParsingError {
    constructor(fileName: string) {
      super(`Malformed JSON in ${fileName}`);
      this.name = "MalformedJsonError";
    }
  }

  /**
   * Error thrown when required metadata fields are missing.
   */
  export class MetadataFormatError extends DataParsingError {
    constructor(missingField: string) {
      super(`Invalid metadata.json format: missing ${missingField} field`);
      this.name = "MetadataFormatError";
    }
  }

  /**
   * Error thrown when URI structure doesn't match expected pattern.
   */
  export class InvalidUriStructureError extends DataParsingError {
    constructor(uri: string) {
      super(`The provided URI does not conform to expected structure: \`${uri}\``);
      this.name = "InvalidUriStructureError";
    }
  }

  // Script Operation Errors

  /**
   * Base class for script operation errors.
   */
  export class ScriptOperationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ScriptOperationError";
    }
  }

  /**
   * Error thrown when script is not in a valid state for operations.
   */
  export class ScriptNotCopaceticError extends ScriptOperationError {
    constructor() {
      super("Script is not in a copacetic state");
      this.name = "ScriptNotCopaceticError";
    }
  }

  /**
   * Error thrown when TypeScript compilation fails.
   */
  export class CompilationError extends ScriptOperationError {
    constructor(message: string) {
      super(message);
      this.name = "CompilationError";
    }
  }

  /**
   * Error thrown when no files are found to compile.
   */
  export class NoFilesToCompileError extends ScriptOperationError {
    constructor(tsConfigPath: string) {
      super(`No files to compile for tsconfig at: ${tsConfigPath}`);
      this.name = "NoFilesToCompileError";
    }
  }

  /**
   * Error thrown when attempting invalid operations on metadata files.
   */
  export class MetadataFileOperationError extends ScriptOperationError {
    constructor(operation: string) {
      super(`Cannot ${operation} metadata file`);
      this.name = "MetadataFileOperationError";
    }
  }

  /**
   * Error thrown when file type cannot be converted to upstairs URL.
   */
  export class InvalidFileTypeForUrlError extends ScriptOperationError {
    constructor(fileType: string) {
      super(`Unexpected type: \`${fileType}\`, cannot convert to upstairs URL`);
      this.name = "InvalidFileTypeForUrlError";
    }
  }

  /**
   * Error thrown when hash calculation fails.
   */
  export class HashCalculationError extends ScriptOperationError {
    constructor() {
      super("Could not compute hash of local file");
      this.name = "HashCalculationError";
    }
  }

  /**
   * Error thrown when file modification time cannot be determined.
   */
  export class ModificationTimeError extends ScriptOperationError {
    constructor() {
      super("Could not determine last modified time");
      this.name = "ModificationTimeError";
    }
  }

  /**
   * Error thrown when file integrity verification fails.
   */
  export class FileIntegrityError extends ScriptOperationError {
    constructor() {
      super("Downloaded file hash does not match upstairs hash, disk corruption detected");
      this.name = "FileIntegrityError";
    }
  }

  /**
   * Error thrown when ETag parsing fails.
   */
  export class EtagParsingError extends ScriptOperationError {
    constructor(etag: string) {
      super(`Could not parse upstairs etag; \`${etag}\`, cannot verify integrity`);
      this.name = "EtagParsingError";
    }
  }

  /**
   * Error thrown when node/file does not exist.
   */
  export class NodeNotFoundError extends ScriptOperationError {
    constructor() {
      super("Node does not exist");
      this.name = "NodeNotFoundError";
    }
  }

  /**
   * Error thrown when config file is not found or multiple are found.
   */
  export class ConfigFileError extends ScriptOperationError {
    constructor(fileName: string, foundCount: number) {
      super(`Could not find ${fileName} file, found: ${foundCount === 0 ? "none" : foundCount}`);
      this.name = "ConfigFileError";
    }
  }

  /**
   * Error thrown when target path cannot be determined.
   */
  export class DestinationPathError extends ScriptOperationError {
    constructor(uri: string) {
      super(`Failed to determine destination path for file: ${uri}`);
      this.name = "DestinationPathError";
    }
  }

  /**
   * Error thrown when file send operation fails.
   */
  export class FileSendError extends ScriptOperationError {
    constructor(details: string) {
      super(`Failed to send file${details}`);
      this.name = "FileSendError";
    }
  }

  /**
   * Error thrown when trying to operate on build folder files.
   */
  export class BuildFolderOperationError extends ScriptOperationError {
    constructor(operation: string, filename: string) {
      super(`Cannot ${operation} a file (${filename}) that is already in a build folder`);
      this.name = "BuildFolderOperationError";
    }
  }

  /**
   * Error thrown when trying to operate on snapshot files.
   */
  export class SnapshotOperationError extends ScriptOperationError {
    constructor(operation: string) {
      super(`Cannot ${operation} a file that is already in a build folder`);
      this.name = "SnapshotOperationError";
    }
  }

  /**
   * Error thrown when provided URI doesn't point to expected resource type.
   */
  export class InvalidResourceTypeError extends ScriptOperationError {
    constructor(resourceType: string) {
      super(`Provided URI does not point to a ${resourceType}`);
      this.name = "InvalidResourceTypeError";
    }
  }

  /**
   * Error thrown when required configuration is missing.
   */
  export class MissingConfigurationError extends ScriptOperationError {
    constructor(configName: string) {
      super(`${configName} not specified`);
      this.name = "MissingConfigurationError";
    }
  }

  // VS Code Integration Errors

  /**
   * Error thrown when no active editor is found.
   */
  export class NoActiveEditorError extends Error {
    constructor() {
      super("No active editor found");
      this.name = "NoActiveEditorError";
    }
  }

  /**
   * Error thrown when no active file is found.
   */
  export class NoActiveFileError extends Error {
    constructor() {
      super("No active file found");
      this.name = "NoActiveFileError";
    }
  }

  /**
   * Error thrown when multiple folders are found when one is expected.
   */
  export class MultipleFoldersFoundError extends Error {
    constructor(context: string) {
      super(`Multiple folders found for ${context}`);
      this.name = "MultipleFoldersFoundError";
    }
  }

  /**
   * Error thrown when no folder is found for the specified context.
   */
  export class NoFolderFoundError extends Error {
    constructor(context: string) {
      super(`No folder found for ${context}`);
      this.name = "NoFolderFoundError";
    }
  }

  /**
   * Error thrown when no matching file is found.
   */
  export class NoMatchingFileFoundError extends Error {
    constructor() {
      super("No matching file found");
      this.name = "NoMatchingFileFoundError";
    }
  }

  /**
   * Error thrown when package.json cannot be found.
   */
  export class PackageJsonNotFoundError extends Error {
    constructor() {
      super("Could not find extension package.json");
      this.name = "PackageJsonNotFoundError";
    }
  }

  // Update System Errors

  /**
   * Error thrown when GitHub token is not available.
   */
  export class GitHubTokenNotAvailableError extends Error {
    constructor() {
      super("No GitHub token available");
      this.name = "GitHubTokenNotAvailableError";
    }
  }

  /**
   * Error thrown when GitHub API returns an error status.
   */
  export class GitHubApiError extends Error {
    constructor(status: number) {
      super(`GitHub API returned status ${status}`);
      this.name = "GitHubApiError";
    }
  }

  /**
   * Error thrown when update check request times out.
   */
  export class UpdateCheckTimeoutError extends Error {
    constructor() {
      super("Update check request timed out");
      this.name = "UpdateCheckTimeoutError";
    }
  }

  /**
   * Error thrown when auto-install requires a direct download link.
   */
  export class AutoInstallRequiresDirectLinkError extends Error {
    constructor() {
      super("Auto-install requires a direct .vsix download link");
      this.name = "AutoInstallRequiresDirectLinkError";
    }
  }

  /**
   * Error thrown when extension download fails.
   */
  export class ExtensionDownloadError extends Error {
    constructor(status: number) {
      super(`Download failed with status ${status}`);
      this.name = "ExtensionDownloadError";
    }
  }

  /**
   * Error thrown when extension installation fails.
   */
  export class ExtensionInstallationError extends Error {
    constructor(message: string) {
      super(`Failed to install extension: ${message}`);
      this.name = "ExtensionInstallationError";
    }
  }

  // Data Access Errors

  /**
   * Error thrown when trying to delete a non-existent key from TypedMap.
   */
  export class KeyNotFoundInMapError extends Error {
    constructor(key: string) {
      super(`Key ${key} does not exist in TypedMap and cannot be deleted`);
      this.name = "KeyNotFoundInMapError";
    }
  }

  /**
   * Error thrown when persistence map is not fully initialized.
   */
  export class PersistenceNotInitializedError extends Error {
    constructor(mapType: string, key: string) {
      super(`${mapType} for ${key} not fully initialized`);
      this.name = "PersistenceNotInitializedError";
    }
  }

  // GraphQL Errors

  /**
   * Error thrown when GraphQL query fails.
   */
  export class GraphQLError extends Error {
    constructor(errors: unknown) {
      super(`GraphQL errors found: ${JSON.stringify(errors)}`);
      this.name = "GraphQLError";
    }
  }

  /**
   * Error thrown when GraphQL data fetching fails.
   */
  export class GraphQLFetchError extends Error {
    constructor(error: unknown) {
      super(`Error fetching GraphQL data: ${error}`);
      this.name = "GraphQLFetchError";
    }
  }

  // General Utility Errors

  /**
   * Error thrown when required cleanup parameters are missing.
   */
  export class CleanupParametersError extends Error {
    constructor() {
      super("Both downstairsRootFolderUri and upstairsRootUrlString are required for cleanup");
      this.name = "CleanupParametersError";
    }
  }

  /**
   * Error thrown when getting script for cleanup fails.
   */
  export class CleanupScriptError extends Error {
    constructor() {
      super("Failed to get script for cleanup");
      this.name = "CleanupScriptError";
    }
  }

  /**
   * Error thrown when script cannot be found with specified parameters.
   */
  export class ScriptNotFoundError extends Error {
    constructor(origin: string, topId: string) {
      super(`Could not find script at ${origin} with topId ${topId}`);
      this.name = "ScriptNotFoundError";
    }
  }

  /**
   * Error thrown when no script root folder is found for topId.
   */
  export class ScriptRootFolderNotFoundError extends Error {
    constructor(topId: string) {
      super(`No script root folder found for topId: ${topId}`);
      this.name = "ScriptRootFolderNotFoundError";
    }
  }

  /**
   * Error thrown when fetching script WebDAV ID fails.
   */
  export class WebdavIdFetchError extends Error {
    constructor(origin: string, topId: string) {
      super(`Error fetching script WebDAV ID from ${origin} for topId ${topId}`);
      this.name = "WebdavIdFetchError";
    }
  }

  /**
   * Error thrown when fetching the metadata.json fails.
   */
  export class MetadataDotJsonFetchError extends Error {
    constructor(webDavId: string) {
      super(`Error fetching metadata.json for WebDAV ID ${webDavId}`);
      this.name = "MetadataDotJsonFetchError";
    }
  }

  // Stack trace utility errors

  /**
   * Error thrown when stack trace is not available.
   */
  export class NoStackTraceError extends Error {
    constructor() {
      super("no stack");
      this.name = "NoStackTraceError";
    }
  }

  /**
   * Error thrown when extracted value is not available.
   */
  export class NoExtractedValueError extends Error {
    constructor() {
      super("no extracted value");
      this.name = "NoExtractedValueError";
    }
  }

  /**
   * Error thrown when an operation is attempted in an invalid state.
   */
  export class InvalidStateError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "InvalidStateError";
    }
  }

  /**
   * Error thrown when an error has already been alerted to the user and we should know to not trigger another alert.
   */
  export class AlreadyAlertedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "AlreadyHandledError";
    }
  }

  /**
   * Error thrown when user cancels an operation and we should know to not alert them again.
   */
  export class UserCancelledError extends AlreadyAlertedError {
    constructor(message: string) {
      super(message);
      this.name = "UserCancelledError";
    }
  }

  /**
   * Thrown when a push stops because overwriting a platform-side change was not confirmed,
   * including when it was declined without a human answer (an empty answer, or the CLI's `--yes`,
   * which take the safe default). A {@link UserCancelledError}, so existing handlers still match.
   * @lastreviewed null
   */
  export class OverwriteDeclinedError extends UserCancelledError {
    /**
     * Draft-relative, `/`-separated paths of the files that were not overwritten, for a consumer
     * that reports them in machine-readable output.
     * @lastreviewed null
     */
    readonly paths: string[];
    constructor(message: string, paths: string[]) {
      super(message);
      this.name = "OverwriteDeclinedError";
      this.paths = paths;
    }
  }

  /**
   * Error thrown when BlueHq helper endpoint has any sort of problem.
   */
  export class BlueHqHelperEndpointError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "BlueHqHelperEndpointError";
    }
  }

  /**
   * Error thrown when OrgWorker encounters an issue.
   */
  export class OrgWorkerError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OrgWorkerError";
    }
  }

  export class OrgCacheError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OrgCacheError";
    }
  }

  export class ScriptUrlParserError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ScriptUrlParserError";
    }
  }
  // Gateway (web-global) errors

  /**
   * Base of every error the gateway client throws. Messages say what happened, never how to
   * respond, and never contain the access token.
   * @lastreviewed null
   */
  export class GatewayError extends Error {
    /**
     * The HTTP status, or `null` when no response was received or the failure is local.
     * @lastreviewed null
     */
    readonly status: number | null;
    /**
     * The `error` code from the response body, a local code (`token-missing`, `token-malformed`),
     * or `null` when none was given.
     * @lastreviewed null
     */
    readonly code: string | null;
    constructor(message: string, status: number | null, code: string | null) {
      super(message);
      this.name = "GatewayError";
      this.status = status;
      this.code = code;
    }
  }

  /**
   * The request carried no usable access token: none is available (`token-missing`, also thrown
   * locally before any request is sent), the gateway refused it (`token-invalid`), or it is not
   * shaped like a gateway token (`token-malformed`, local, nothing sent).
   * @lastreviewed null
   */
  export class GatewayAuthError extends GatewayError {
    /**
     * Which of the three it was.
     * @lastreviewed null
     */
    readonly reason: "token-missing" | "token-invalid" | "token-malformed";
    constructor(message: string, reason: "token-missing" | "token-invalid" | "token-malformed", status: number | null) {
      super(message, status, reason);
      this.name = "GatewayAuthError";
      this.reason = reason;
    }
  }

  /**
   * `403 scope-missing`: the token is valid but lacks the scope the route needs.
   * @lastreviewed null
   */
  export class GatewayScopeError extends GatewayError {
    /**
     * The missing scope (e.g. `kb:push`), or `null` when the gateway did not name it.
     * @lastreviewed null
     */
    readonly scope: string | null;
    constructor(message: string, scope: string | null) {
      super(message, 403, "scope-missing");
      this.name = "GatewayScopeError";
      this.scope = scope;
    }
  }

  /**
   * `403 not-permitted` (or a `403` with no recognised body): the global user may not do this to
   * this target, whatever the token's scopes.
   * @lastreviewed null
   */
  export class GatewayNotPermittedError extends GatewayError {
    /**
     * The `reason` the response body gave (`expiry-exceeds-presenting`, `restricted-mints-disabled`,
     * `rewrite-not-permitted`, or a
     * value this version does not know), or `null` when it gave none.
     * @lastreviewed null
     */
    readonly reason: string | null;
    /**
     * With reason `expiry-exceeds-presenting`: when the presenting token expires, ISO 8601; else `null`.
     * @lastreviewed null
     */
    readonly presentingExpiresAt: string | null;
    /**
     * With reason `rewrite-not-permitted`: the scope that was refused (`kb:rewrite`); else `null`. Only a
     * short scope-shaped value is kept.
     * @lastreviewed null
     */
    readonly scope: string | null;
    constructor(
      message: string,
      code: string | null,
      reason: string | null = null,
      presentingExpiresAt: string | null = null,
      scope: string | null = null
    ) {
      super(message, 403, code);
      this.name = "GatewayNotPermittedError";
      this.reason = reason;
      this.presentingExpiresAt = presentingExpiresAt;
      this.scope = scope;
    }
  }

  /**
   * `403 not-permitted` with reason `expiry-exceeds-presenting` on a token mint (`POST /api/v1/tokens`)
   * or rotate: the token asked for would outlive the token making the request, whose expiry caps
   * every new token's.
   * @lastreviewed null
   */
  export class GatewayTokenExpiryRefusedError extends GatewayNotPermittedError {
    /**
     * The expiry asked for, ISO 8601; `null` for a token that never expires; `undefined` when the
     * request named none (a rotate keeps the rotated token's own lifetime).
     * @lastreviewed null
     */
    readonly requestedExpiresAt: string | null | undefined;
    /**
     * When the presenting token expires, ISO 8601, as the gateway reported it.
     * @lastreviewed null
     */
    override readonly presentingExpiresAt: string;
    constructor(message: string, requestedExpiresAt: string | null | undefined, presentingExpiresAt: string) {
      super(message, "not-permitted", "expiry-exceeds-presenting", presentingExpiresAt);
      this.name = "GatewayTokenExpiryRefusedError";
      this.requestedExpiresAt = requestedExpiresAt;
      this.presentingExpiresAt = presentingExpiresAt;
    }
  }

  /**
   * `403 not-permitted` with reason `restricted-mints-disabled` on a token mint or rotate: the gateway
   * is not yet issuing tokens beyond the `mcp` scope (a rollout switch, not a property of the user).
   * @lastreviewed null
   */
  export class GatewayRestrictedMintsDisabledError extends GatewayNotPermittedError {
    constructor(message: string) {
      super(message, "not-permitted", "restricted-mints-disabled");
      this.name = "GatewayRestrictedMintsDisabledError";
    }
  }

  /**
   * `403 not-permitted` with reason `rewrite-not-permitted` on a token mint or rotate: this account may
   * not hold the `kb:rewrite` scope, whatever the presenting token holds.
   * @lastreviewed null
   */
  export class GatewayRewriteNotPermittedError extends GatewayNotPermittedError {
    constructor(message: string, scope: string) {
      super(message, "not-permitted", "rewrite-not-permitted", null, scope);
      this.name = "GatewayRewriteNotPermittedError";
    }
  }

  /**
   * `404`: the target does not exist, or exists but is not visible to this user. The gateway
   * deliberately does not say which.
   * @lastreviewed null
   */
  export class GatewayNotFoundError extends GatewayError {
    constructor(message: string, code: string | null) {
      super(message, 404, code);
      this.name = "GatewayNotFoundError";
    }
  }

  /**
   * `400 invalid-request`: the gateway rejected the request itself (malformed body or query, bad
   * alias, an expiry in the past, no vocabulary scope, an unknown scope, a bad filter value). The
   * gateway's own message says which; `code` is `invalid-request` or `null`.
   * @lastreviewed null
   */
  export class GatewayInvalidRequestError extends GatewayError {
    constructor(message: string, code: string | null) {
      super(message, 400, code);
      this.name = "GatewayInvalidRequestError";
    }
  }

  /**
   * `409 token-limit`: the user already holds the maximum number of live tokens.
   * @lastreviewed null
   */
  export class GatewayTokenLimitError extends GatewayError {
    /**
     * The maximum number of live tokens (50 at the time of writing) when the response states it,
     * else `null`.
     * @lastreviewed null
     */
    readonly limit: number | null;
    constructor(message: string, limit: number | null) {
      super(message, 409, "token-limit");
      this.name = "GatewayTokenLimitError";
      this.limit = limit;
    }
  }

  /**
   * A `409` conflict. `non-fast-forward` (or a code-less `409` from the git routes) means the push
   * does not build on the branch's current head; any other code is a different conflict (e.g.
   * `alias-taken`) and the message says only that the request conflicts with current state.
   * @lastreviewed null
   */
  export class GatewayConflictError extends GatewayError {
    constructor(message: string, code: string | null) {
      super(message, 409, code);
      this.name = "GatewayConflictError";
    }
  }

  /**
   * `409 live-branch-unprotected`: a push to a knowledge base's live branch was refused because the
   * forge's protection rule for that branch is missing or has drifted. Nothing was pushed.
   * @lastreviewed null
   */
  export class GatewayLiveBranchUnprotectedError extends GatewayConflictError {
    constructor(message: string) {
      super(message, "live-branch-unprotected");
      this.name = "GatewayLiveBranchUnprotectedError";
    }
  }

  /**
   * `413 too-large`: the request body exceeds what the gateway accepts.
   * @lastreviewed null
   */
  export class GatewayTooLargeError extends GatewayError {
    constructor(message: string, code: string | null) {
      super(message, 413, code);
      this.name = "GatewayTooLargeError";
    }
  }

  /**
   * The gateway, or the forge behind it, could not be reached: `502 forge-unavailable`, `503`
   * (`registry-unavailable` means web-global, which holds the registry, could not answer), `504`, a network failure or a timeout (`status` is then `null`).
   * @lastreviewed null
   */
  export class GatewayUnavailableError extends GatewayError {
    constructor(message: string, status: number | null, code: string | null) {
      super(message, status, code);
      this.name = "GatewayUnavailableError";
    }
  }

  /**
   * Any other non-2xx status, a refused redirect (code `redirect-refused`; redirects are never
   * followed), or a 2xx whose body is not the JSON the route promises.
   * @lastreviewed null
   */
  export class GatewayUnexpectedResponseError extends GatewayError {
    constructor(message: string, status: number | null, code: string | null) {
      super(message, status, code);
      this.name = "GatewayUnexpectedResponseError";
    }
  }

  /**
   * The configured gateway URL is unusable (not a URL, not `https:` off loopback, or carrying
   * credentials, a query or a fragment), or a URL handed to the client is not on the gateway's
   * origin. Thrown before any request, so the token is never sent anywhere unintended.
   * @lastreviewed null
   */
  export class GatewayConfigError extends GatewayError {
    constructor(message: string) {
      super(message, null, null);
      this.name = "GatewayConfigError";
    }
  }

  /**
   * A pull would overwrite local changes: the files the incoming commits change are modified,
   * staged, deleted or untracked in the working copy. Nothing was changed.
   * @lastreviewed null
   */
  export class GatewayDirtyWorkingTreeError extends GatewayError {
    /**
     * Repo-relative, `/`-separated paths with local changes that the incoming commits also touch.
     * @lastreviewed null
     */
    readonly paths: string[];
    constructor(message: string, paths: string[]) {
      super(message, null, "dirty-working-tree");
      this.name = "GatewayDirtyWorkingTreeError";
      this.paths = paths;
    }
  }

  /**
   * The local folder is not in a state the git operation can use. `reason` is `not-empty` (a clone
   * target that has files), `not-a-clone` (no git repository there), `detached` (no current
   * branch), `no-upstream` (the branch tracks nothing), `diverged` (the branch and its upstream
   * each have commits the other lacks, so a fast-forward is impossible), `ref-not-found` (the
   * remote has no such branch or tag) or `unsafe-target` (a clone target with a `.git` or `git~N`
   * path component, which would put the clone's config inside a git directory).
   * @lastreviewed null
   */
  export class GatewayWorkingCopyError extends GatewayError {
    /**
     * Which of the states it was.
     * @lastreviewed null
     */
    readonly reason:
      | "not-empty"
      | "not-a-clone"
      | "detached"
      | "no-upstream"
      | "diverged"
      | "ref-not-found"
      | "unsafe-target";
    constructor(
      message: string,
      reason: "not-empty" | "not-a-clone" | "detached" | "no-upstream" | "diverged" | "ref-not-found" | "unsafe-target"
    ) {
      super(message, null, reason);
      this.name = "GatewayWorkingCopyError";
      this.reason = reason;
    }
  }

  /**
   * A request that mints or rotates a token (code `outcome-unknown`) failed in a way that does
   * not say whether the gateway acted: the connection dropped, no answer came in time, or a
   * `502`/`503`/`504` came back. The token may have been minted (create) or rotated (rotate, in
   * which case the old one is revoked), and any new secret was never received. It extends
   * {@link GatewayUnavailableError}, so a generic handler still sees "unavailable", but it is a
   * distinct type so a consumer can tell it apart from a request that never reached the gateway.
   *
   * A rotation is retried once, with the same `Idempotency-Key` and the same presenting token,
   * before this is thrown (`retried: true`): when the retry is also unanswered, or when it is a
   * `401`/`404` for the stored token (the first attempt most likely rotated it, which revoked it).
   * A create is never retried.
   * @lastreviewed null
   */
  export class GatewayOutcomeUnknownError extends GatewayUnavailableError {
    /**
     * Which operation's outcome is unknown.
     * @lastreviewed null
     */
    readonly operation: "create" | "rotate";
    /**
     * `true` when the request was retried once (with the same idempotency key) before giving up.
     * @lastreviewed null
     */
    readonly retried: boolean;
    constructor(message: string, operation: "create" | "rotate", status: number | null, retried: boolean = false) {
      super(message, status, "outcome-unknown");
      this.name = "GatewayOutcomeUnknownError";
      this.operation = operation;
      this.retried = retried;
    }
  }

  /**
   * `403 scope-escalation`: a token was asked for with a scope the presenting token does not
   * hold. A new token's scopes never exceed the presenting token's.
   * @lastreviewed null
   */
  export class GatewayScopeEscalationError extends GatewayError {
    constructor(message: string) {
      super(message, 403, "scope-escalation");
      this.name = "GatewayScopeEscalationError";
    }
  }

  /**
   * `409 alias-taken`: another of this user's tokens already has the alias.
   * @lastreviewed null
   */
  export class GatewayAliasTakenError extends GatewayError {
    constructor(message: string) {
      super(message, 409, "alias-taken");
      this.name = "GatewayAliasTakenError";
    }
  }

  /**
   * An argument to a gateway operation was refused before anything was sent (code
   * `invalid-argument`): an empty alias or scope list, an expiry that is not a date, or a value
   * shaped like a token secret where an id or alias belongs. The value is never quoted.
   * @lastreviewed null
   */
  export class GatewayInvalidArgumentError extends GatewayError {
    constructor(message: string) {
      super(message, null, "invalid-argument");
      this.name = "GatewayInvalidArgumentError";
    }
  }

  /**
   * An id-or-alias matched more than one of the caller's tokens (one by id, another by alias), so
   * nothing was revoked or rotated (code `ambiguous`).
   * @lastreviewed null
   */
  export class GatewayTokenAmbiguousError extends GatewayError {
    /**
     * The ids of the tokens it matched.
     * @lastreviewed null
     */
    readonly ids: readonly string[];
    constructor(message: string, ids: readonly string[]) {
      super(message, null, "ambiguous");
      this.name = "GatewayTokenAmbiguousError";
      this.ids = ids;
    }
  }

  /**
   * The gateway rotated the stored token, so the old one is already revoked, but storing the
   * replacement failed (code `store-failed`). The replacement's secret exists only here: it is
   * carried in {@link replacement} so the consumer can show it and the user is not locked out.
   *
   * `replacement` is non-enumerable, so a generic error logger or `JSON.stringify` does not print
   * the secret; read the property by name. The message never contains it.
   * @lastreviewed null
   */
  export class GatewayTokenStoreError extends GatewayError {
    /**
     * The minted replacement, secret included.
     * @lastreviewed null
     */
    declare readonly replacement: GatewayMintedToken;
    constructor(message: string, replacement: GatewayMintedToken) {
      super(message, null, "store-failed");
      this.name = "GatewayTokenStoreError";
      Object.defineProperty(this, "replacement", {
        value: replacement,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
  }

  /**
   * The gateway minted or rotated a token (code `off-contract`), but its `2xx` answer about the
   * token was malformed (a field missing or of the wrong type). The answer did carry the secret,
   * which exists nowhere else, so this error carries it in {@link secret} rather than dropping it.
   *
   * For a rotation of the stored token, the old token is already revoked, and the secret was
   * still offered to the store; {@link stored} says whether that worked. `secret` is
   * non-enumerable, so a generic error logger or `JSON.stringify` does not print it; read the
   * property by name. The message never contains it.
   * @lastreviewed null
   */
  export class GatewayOffContractTokenError extends GatewayError {
    /**
     * The minted `b6pt_…` secret.
     * @lastreviewed null
     */
    declare readonly secret: string;
    /**
     * Which operation minted it.
     * @lastreviewed null
     */
    readonly operation: "create" | "rotate";
    /**
     * Whether the secret is now the stored token (only ever `true` for a rotation of the stored token).
     * @lastreviewed null
     */
    readonly stored: boolean;
    constructor(message: string, operation: "create" | "rotate", secret: string, stored: boolean) {
      super(message, null, "off-contract");
      this.name = "GatewayOffContractTokenError";
      this.operation = operation;
      this.stored = stored;
      Object.defineProperty(this, "secret", {
        value: secret,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
  }
}
