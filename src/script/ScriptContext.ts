import type { IFileSystem, ILogger, IPrompt } from "../providers";
import type { SessionManager } from "../session/SessionManager";
import type { BasicAuthProvider } from "../auth/BasicAuthProvider";
import type { ScriptMetaDataStore } from "../cache/ScriptMetaDataStore";
import type { OrgCache } from "../cache/OrgCache";
import type { ScriptFactory } from "./ScriptFactory";

/**
 * The set of services that the script-tree classes ({@link ScriptRoot}, {@link ScriptFile},
 * {@link ScriptFolder}, etc.) need in order to function.
 *
 * `B6PCore` is the canonical implementation; the App-side singleton can also satisfy this
 * shape via an adapter.
 */
export interface ScriptContext {
  readonly fs: IFileSystem;
  readonly sessionManager: SessionManager;
  readonly logger: ILogger;
  readonly prompt: IPrompt;
  readonly auth: BasicAuthProvider;
  readonly scriptMetadataStore: ScriptMetaDataStore;
  readonly orgCache: OrgCache;
  isDebugMode(): boolean;
  getScriptFactory(): ScriptFactory;
}
