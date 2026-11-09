// ─── Top-level entry points ──────────────────────────────────────────
export { B6PCore } from "./B6PCore";
export type { ReportResult } from "./B6PCore";
export { B6PUri } from "./B6PUri";
export { Err } from "./Err";
export {
  checkEmittedEntrypoint,
  cleanupUnusedUpstairsPaths,
  collectOverwriteCandidates,
  confirmOverwrites,
  executePush,
  uploadAndCompile,
  verifyLiveSnapshot,
} from "./script/push";
export type { EmittedEntrypointCheck, LiveSnapshotCheck, OverwriteCandidate, PushResult } from "./script/push";
export type { PlatformContext } from "./PlatformContext";

// ─── Provider interfaces ─────────────────────────────────────────────
export type {
  AuthProvider,
  B6PProviders,
  ConfirmOptions,
  FileStat,
  FileSystem,
  LockDiagnoser,
  LockHolder,
  Logger,
  Persistence,
  Progress,
  ProgressTask,
  Prompt,
} from "./providers";

// ─── Pure data classes ───────────────────────────────────────────────
export { DownstairsPathParser } from "./data/DownstairsPathParser";
export { GlobMatcher } from "./data/GlobMatcher";
export { IdUtility } from "./data/IdUtility";
export { OrgWorker } from "./data/OrgWorker";
export { ScriptKey } from "./data/ScriptKey";
export { ScriptUrlParser } from "./data/ScriptUrlParser";
export { MIN_SERVER_VERSION, meetsMinimumVersion, parseReleaseTag, resolveCompileRoute } from "./data/ServerVersion";
export type { CompileRoute } from "./data/ServerVersion";

// ─── Auth + sessions ─────────────────────────────────────────────────
export { BearerAuthProvider } from "./auth/BearerAuthProvider";
export { SessionManager } from "./session/SessionManager";

// ─── Network ─────────────────────────────────────────────────────────
export { HttpClient } from "./network/HttpClient";
export { ResponseCodes } from "./network/StatusCodes";

// ─── Script tree ─────────────────────────────────────────────────────
export { ScriptFactory } from "./script/ScriptFactory";
export { ScriptNode } from "./script/ScriptNode";
export { ScriptRoot } from "./script/ScriptRoot";
export { ScriptFile } from "./script/ScriptFile";
export type { ScriptFolder } from "./script/ScriptFolder";
export type { ScriptContext } from "./script/ScriptContext";
export { ScriptService } from "./script/ScriptService";
export { ScriptTranspiler, resolveNativeCompilerPath, startNativeCompiler } from "./script/ScriptTranspiler";
export type { CompilerApi, CompilerApiFactory, TranspileOutcome } from "./script/ScriptTranspiler";
export {
  COMPILE_RETRY,
  KNOWN_DRAFT_COMPILE_STATUSES,
  KNOWN_PUBLISH_REFUSAL_REASONS,
  PUBLISHABLE_COMPILE_STATUSES,
  compileAllowsPublish,
  compileDraft,
  parseDraftCompileOutcome,
  parsePublishOutcome,
  takeSnapshot,
} from "./script/ServerCompile";
export type {
  CompileDiagnostic,
  DraftCompileOutcome,
  DraftCompileStatus,
  GateProblem,
  GateReport,
  PublishOutcome,
  PublishRefusalReason,
  RetryPolicy,
  ServerCompileOptions,
  ServerCompileTarget,
} from "./script/ServerCompile";
export type { AuditResult, DeployConfig, PullResult } from "./script/ScriptService";

// ─── Constants ───────────────────────────────────────────────────────
export {
  ApiEndpoints,
  AuthTypes,
  BlueHQ,
  CryptoAlgorithms,
  ExtensionConfig,
  FileExtensions,
  FolderNames,
  GitHubUrls,
  Http,
  MimeTypes,
  Numerical,
  OutputChannels,
  SettingsKeys,
  SpecialFiles,
  WebDAVElements,
} from "./constants";

// ─── Persistence ─────────────────────────────────────────────────────
export {
  PseudoMap,
  TypedMap,
  Persistable,
  registerSerializable,
  revive,
  PrivateKeys,
  PublicKeys,
  PersistablePseudoMap,
  PublicPersistanceMap,
  PrivateGenericMap,
  TypedPersistable,
  PrivateTypedPersistable,
} from "./persistence";
export type { SerializableClass, Serializable } from "./persistence";
export { SharedFilePersistence } from "./persistence/SharedFilePersistence";

// ─── Caches ──────────────────────────────────────────────────────────
export { OrgCache } from "./cache/OrgCache";
export { ScriptMetaDataStore } from "./cache/ScriptMetaDataStore";

// ─── Update service ──────────────────────────────────────────────────
export { UpdateService } from "./update/UpdateService";
export type { UpdateInfo, GithubRelease, ClientInfo, UpdateServiceConfig } from "./update/types";

// ─── Test utilities (still in core because they're vscode-free) ──────
export { MockFileSystem } from "./testing/MockFileSystem";

// ─── Shared ambient-style types (formerly types/index.d.ts) ──────────
export type {
  ReadOnlyMap,
  JsonPrimitive,
  JsonArray,
  JsonObject,
  JsonValue,
  PrimitiveNestedObject,
  XMLResponse,
  SessionData,
  AuthParams,
  BearerAuthParams,
  MetaDataDotJsonContent,
  Settings,
  TsConfig,
  BlueHqAnyUrlResp,
  GqlParentNameResp,
  ScriptMetaData,
  SourceOps,
  OrgCacheElement,
  ScriptGqlResp,
  ScriptGQLGoodResp,
  ScriptGQLBadResp,
  ConfigJsonContent,
} from "./types";
