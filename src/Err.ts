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
    constructor(message: string, public readonly input?: string) {
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
      super(`Could not find ${fileName} file, found: ${foundCount === 0 ? 'none' : foundCount}`);
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
}