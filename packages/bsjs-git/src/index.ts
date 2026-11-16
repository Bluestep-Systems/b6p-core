/**
 * Browser- and Node-safe git client for BlueStep BSJS scripts. Nothing here imports a Node built-in; the file system
 * is injected (see {@link ScriptRepoOptions.fs}) and HTTP is the platform `fetch`.
 * @lastreviewed null
 */
import "./bufferShim";
export {
  ScriptRepo,
  DRAFT_BRANCH,
  PUBLISHED_BRANCH,
  decodeText,
  type BuildFastForward,
  type BuildFastForwardState,
  type CloneOptions,
  type CommitOptions,
  type CommitInfo,
  type CompileDraftOptions,
  type DraftBuildResult,
  type LogPage,
  type FileChange,
  type GitIdentity,
  type LogOptions,
  type PublishResult,
  type PushOutcome,
  type ScriptRepoOptions,
  type TreeFile,
  type WorkingChange,
} from "./ScriptRepo";
export {
  LegacyHistoryClient,
  parseSaveState,
  treeFiles,
  type HistoryTree,
  type HistoryTreeEntry,
  type LegacyHistoryClientOptions,
  type LegacyHistoryEntry,
  type LegacyListOptions,
} from "./legacy";
export {
  compoundId,
  parseCompoundId,
  publishMutationFor,
  SCRIPT_PUBLISH_TYPES,
  type PublishMutation,
  type ScriptRef,
} from "./scriptKey";
export {
  BUILD_COMMIT_SUBJECT,
  BUILD_OF_TRAILER,
  buildSourceOf,
  COMPILE_RETRY,
  KNOWN_DRAFT_COMPILE_STATUSES,
  PUBLISHABLE_COMPILE_STATUSES,
  compileAllowsPublish,
  parseDraftBuildCommit,
  parseDraftCompileOutcome,
  type CompileDiagnostic,
  type DraftBuildCommit,
  type DraftCompileOutcome,
  type DraftCompileStatus,
  type GateProblem,
  type GateReport,
  type RetryPolicy,
} from "./serverBuild";
export { CsrfFetch, type ScriptAuth } from "./csrf";
export { basicTokenFetch, createProxyHttp, gitAuthHeader, refusalFor, type FetchLike } from "./http";
export * from "./errors";
export {
  BUILD_MANIFEST_NAME,
  buildManifestPath,
  buildOutputFolder,
  isBuildOutputPath,
  type BuildProjectConfig,
  hasNoTsconfig,
  isBuildSource,
  isTypeScriptSource,
  parseJsonc,
} from "./buildManifest";
