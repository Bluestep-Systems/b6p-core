// ─── Top-level entry points ──────────────────────────────────────────
export { B6PCore } from "./B6PCore";
export type { ReportResult } from "./B6PCore";
export { B6PUri } from "./B6PUri";
export { Err } from "./Err";
export { describeBuildStatus, executePush, legacySyncRecords } from "./script/push";
export type { BuildIncomplete, PushResult } from "./script/push";
export { resolveGitIdentity } from "./script/GitIdentity";
export type { GitConfigReader, GitIdentitySources } from "./script/GitIdentity";
export {
  GitSwitchDeclinedError,
  GitWrongBranchError,
  GitStagedChangesError,
  GitSymlinkError,
  legacyIgnoreRulesForDraft,
  auditDraft,
  confirmOverwrittenFiles,
  pullDraft,
  pushDraft,
} from "./script/GitSync";
export type {
  DraftAudit,
  DraftBuildOutcome,
  DraftPullOutcome,
  DraftPullOptions,
  DraftPushOptions,
  DraftPushOutcome,
  LastSyncedLookup,
  PublishRefusal,
} from "./script/GitSync";
export type { PlatformContext } from "./PlatformContext";

// ─── Provider interfaces ─────────────────────────────────────────────
export type {
  AuthProvider,
  B6PProviders,
  ConfirmOptions,
  FileStat,
  FileSystem,
  GatewayTokenSource,
  GatewayTokenStore,
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
export type { PushRoute, SnapshotRefusal } from "./data/ServerVersion";
export {
  MIN_SERVER_VERSION,
  meetsMinimumVersion,
  parseReleaseTag,
  resolvePushRoute,
  snapshotRefusalFor,
} from "./data/ServerVersion";

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
export { isOwnSourceDiagnostic, typeCheckErrorsOf } from "./script/ServerCompile";
export type { TypeCheckError } from "./script/ServerCompile";
export type { AuditResult, DeployConfig, DeployTargetResult, PullResult } from "./script/ScriptService";

// ─── Schema apply ────────────────────────────────────────────────────
export { SchemaService } from "./schema/SchemaService";
export type { SchemaContext } from "./schema/SchemaContext";
export type { SchemaGenerateOptions, SchemaTestOptions, SchemaTestThenApplyResult } from "./schema/SchemaService";

// ─── Gateway (web-global) ────────────────────────────────────────────
export { GatewayService } from "./gateway/GatewayService";
export { GatewayGit } from "./gateway/GatewayGit";
export type {
  GatewayCloneOptions,
  GatewayCloneResult,
  GatewayGitOptions,
  GatewayGitInspection,
  GatewayGitStatus,
  GatewayGitStatusOptions,
  GatewayPullResult,
  GatewayPushResult,
} from "./gateway/GatewayGit";
export { GatewayTokenService } from "./gateway/GatewayTokenService";
export { GatewayMarketplace } from "./gateway/GatewayMarketplace";
export type { GatewayMarketplacePullOptions, GatewayMarketplacePullResult } from "./gateway/GatewayMarketplace";
export { GatewayKb } from "./gateway/GatewayKb";
export type {
  GatewayKbListOptions,
  GatewayKbPullOptions,
  GatewayKbPullResult,
  GatewayKbPushOptions,
  GatewayKbPushResult,
} from "./gateway/GatewayKb";
export { GatewayClient, gatewayErrorFor, parseGatewayOrigin } from "./gateway/GatewayClient";
export type {
  GatewayClientOptions,
  GatewayRequestOptions,
  GatewayResponse,
  GatewaySequence,
} from "./gateway/GatewayClient";
export type { GatewayContext, GatewayFetch } from "./gateway/GatewayContext";
export { gatewayTokenProblem, redactToken } from "./gateway/GatewayToken";

// ─── git's credential helper ─────────────────────────────────────────
export { GitCredentialService, parseCredentialRequest } from "./gitCredential/GitCredentialService";
export type {
  GitCredentialHelperOptions,
  GitCredentialHost,
  GitCredentialHostSource,
  GitCredentialHostStatus,
  GitCredentialRemoveOptions,
  GitCredentialRemoveResult,
  GitCredentialSetupResult,
  GitCredentialSetupStatus,
} from "./gitCredential/GitCredentialService";
export type { GitCredentialContext } from "./gitCredential/GitCredentialContext";
export { gitConfigRunner } from "./gitCredential/GitConfigRunner";
export type { GitConfigOutcome, GitConfigRunner } from "./gitCredential/GitConfigRunner";
export { credentialHostOf, requestedCredentialHost } from "./gitCredential/hosts";

// ─── Constants ───────────────────────────────────────────────────────
export {
  ApiEndpoints,
  AuthTypes,
  BlueHQ,
  CryptoAlgorithms,
  ExtensionConfig,
  FileExtensions,
  FolderNames,
  Gateway,
  GitCredential,
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
export { GitCredentialHosts } from "./cache/GitCredentialHosts";

// ─── Update service ──────────────────────────────────────────────────
export { UpdateService } from "./update/UpdateService";
export type { UpdateInfo, GithubRelease, ClientInfo, UpdateServiceConfig } from "./update/types";

// ─── Test utilities (still in core because they're vscode-free) ──────
export { MockFileSystem } from "./testing/MockFileSystem";
export { FakeGateway } from "./testing/FakeGateway";
export type {
  FakeGatewayFailure,
  FakeGatewayRequest,
  FakeGatewayRoute,
  FakeGatewayToken,
  FakeGatewayTokenOptions,
} from "./testing/FakeGateway";

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
  SchemaRecipeName,
  SchemaRecipeFindingSeverity,
  SchemaRecipeFindingCode,
  SchemaRecipeFinding,
  SchemaRecipeResult,
  SchemaGateStage,
  SchemaRefusalCode,
  SchemaActionKind,
  SchemaDeltaKind,
  SchemaDelta,
  SchemaConflictReason,
  SchemaPlannedAction,
  SchemaMatchHit,
  SchemaRefusal,
  SchemaApplyRefusal,
  SchemaWarning,
  SchemaTestResult,
  SchemaAppliedObject,
  SchemaApplyResult,
  ConfigJsonContent,
  GatewayErrorCode,
  GatewayErrorBody,
  GatewayKnowledgeBase,
  GatewayKnowledgeBaseStatus,
  GatewayKnowledgeBaseList,
  GatewayKnowledgeBaseAccess,
  GatewayKnowledgeBaseAccessInput,
  GatewayKnowledgeBaseDetail,
  GatewayKnowledgeBaseVersion,
  GatewayKnowledgeBaseCreateRequest,
  GatewayKnowledgeBaseChanges,
  GatewayMarketplaceRepo,
  GatewayMarketplaceRepoList,
  GatewayCreatedToken,
  GatewayExpiryCap,
  GatewayMintedToken,
  GatewayMintedTokenBody,
  GatewayTokenCreateRequest,
  GatewayTokenList,
  GatewayTokenRecord,
  GatewayTokenRevokeResult,
  GatewayTokenRotateResult,
  GatewayTokenSummary,
} from "./types";

// ─── Browser-safe git client (separate package, re-exported for consumers of this one) ───
export * as bsjsGit from "@bluestep-systems/b6p-core-bsjs-git";
