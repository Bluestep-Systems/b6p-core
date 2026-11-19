import type { PlatformContext } from "../PlatformContext";
import type { ScriptMetaDataStore } from "../cache/ScriptMetaDataStore";
import type { OrgCache } from "../cache/OrgCache";
import type { GitCredentialHosts } from "../cache/GitCredentialHosts";
import type { FetchLike, ScriptRepoOptions } from "@bluestep-systems/b6p-core-bsjs-git";

/**
 * What the script subsystem needs on top of {@link PlatformContext}: the script-tree
 * classes ({@link ScriptRoot}, {@link ScriptFile}, {@link ScriptFolder}, …),
 * and {@link ScriptService}.
 *
 * This is a **dependency bundle, not a facade**: nothing implements it by being a
 * larger object that happens to contain these members. {@link B6PCore} *builds* one
 * and hands it to {@link ScriptService}. Keeping it a thing that is *held* rather
 * than a shape that is *inherited* is what stops it from re-accumulating members no
 * script-tree class reads — which is how `auth` and `getScriptFactory()` once ended
 * up here.
 *
 * Only script-specific members belong below. Anything a *second* subsystem would
 * also want goes in {@link PlatformContext} instead, so it keeps one construction
 * site rather than being restated per subsystem. Every member here has at least one
 * reader under `src/script/`; do not add one speculatively.
 * @lastreviewed null
 */
export interface ScriptContext extends PlatformContext {
  readonly scriptMetadataStore: ScriptMetaDataStore;
  readonly orgCache: OrgCache;
  /**
   * Where a pull records the tenant host it reached with the stored token, which b6p then answers
   * git's credential requests for.
   * @lastreviewed null
   */
  readonly gitCredentialHosts: GitCredentialHosts;
  /**
   * The file system git works on: the draft folder is a git working tree, and isomorphic-git needs a Node-style
   * `fs` (with `.promises`) rather than the {@link FileSystem} provider. Reads and writes the same disk as `fs`.
   * @lastreviewed null
   */
  readonly gitFs: ScriptRepoOptions["fs"];
  /**
   * The `b6pt_` access token the platform's git proxy and publish accept, read when a script is first touched.
   * @lastreviewed null
   */
  gitToken(): Promise<string>;
  /**
   * Overrides `fetch` for git and publish requests (tests); default is the global one.
   * @lastreviewed null
   */
  readonly gitFetch?: FetchLike;
  /**
   * The environment commit authors are looked up in as a last resort; default `process.env`.
   * @lastreviewed null
   */
  readonly gitEnv?: Readonly<Record<string, string | undefined>>;
}
