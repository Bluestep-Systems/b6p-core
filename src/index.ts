// ─── Top-level entry points ──────────────────────────────────────────
export { B6PCore } from './B6PCore';
export type { AuditResult, ReportResult } from './B6PCore';
export { B6PUri } from './B6PUri';
export { Err } from './Err';
export { executePush } from './push';

// ─── Provider interfaces ─────────────────────────────────────────────
export type {
  B6PProviders,
  FileStat,
  IFileSystem,
  ILogger,
  IPersistence,
  IProgress,
  IPrompt,
  ProgressTask,
} from './providers';

// ─── Pure data classes ───────────────────────────────────────────────
export { DownstairsPathParser } from './data/DownstairsPathParser';
export { GlobMatcher } from './data/GlobMatcher';
export { IdUtility } from './data/IdUtility';
export { OrgWorker } from './data/OrgWorker';
export { ScriptKey } from './data/ScriptKey';
export { ScriptUrlParser } from './data/ScriptUrlParser';

// ─── Auth + sessions ─────────────────────────────────────────────────
export { BasicAuthProvider } from './auth/BasicAuthProvider';
export { SessionManager } from './session/SessionManager';

// ─── Network ─────────────────────────────────────────────────────────
export { HttpClient } from './network/HttpClient';
export { ResponseCodes } from './network/StatusCodes';

// ─── Script tree ─────────────────────────────────────────────────────
export { ScriptFactory } from './script/ScriptFactory';
export { ScriptNode } from './script/ScriptNode';
export { ScriptRoot } from './script/ScriptRoot';
export { ScriptFile } from './script/ScriptFile';
export type { ScriptFolder } from './script/ScriptFolder';
export type { ScriptContext } from './script/ScriptContext';

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
} from './constants';

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
} from './persistence';
export type { SerializableClass, Serializable } from './persistence';
export { SharedFilePersistence } from './persistence/SharedFilePersistence';

// ─── Caches ──────────────────────────────────────────────────────────
export { OrgCache } from './cache/OrgCache';
export { ScriptMetaDataStore } from './cache/ScriptMetaDataStore';

// ─── Update service ──────────────────────────────────────────────────
export { UpdateService } from './update/UpdateService';
export type { UpdateInfo, GithubRelease, ClientInfo, UpdateServiceConfig } from './update/types';

// ─── Test utilities (still in core because they're vscode-free) ──────
export { MockFileSystem } from './testing/MockFileSystem';

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
  BasicAuthParams,
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
} from './types';
