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
  type CloneOptions,
  type CommitOptions,
  type CommitInfo,
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
export { CsrfFetch, type ScriptAuth } from "./csrf";
export { basicTokenFetch, createProxyHttp, gitAuthHeader, refusalFor, type FetchLike } from "./http";
export * from "./errors";
export {
  BUILD_MANIFEST_BUILDER,
  BUILD_MANIFEST_NAME,
  buildManifestPath,
  buildOutputFolder,
  formatBuildManifest,
  gitBlobSha1,
  hasNoTsconfig,
  isBuildSource,
  parseJsonc,
  planBuildManifest,
  type BuildManifestPlan,
} from "./buildManifest";
