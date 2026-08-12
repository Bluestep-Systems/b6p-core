import type { PlatformContext } from "../PlatformContext";
import type { ScriptMetaDataStore } from "../cache/ScriptMetaDataStore";
import type { OrgCache } from "../cache/OrgCache";

/**
 * What the script subsystem needs on top of {@link PlatformContext}: the script-tree
 * classes ({@link ScriptRoot}, {@link ScriptFile}, {@link ScriptFolder}, …),
 * {@link ScriptService}, and {@link ScriptTranspiler}.
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
   * Consumer-supplied directories containing TypeScript's `lib.*.d.ts`, searched
   * (in order) before the project-local `node_modules/typescript/lib` when the
   * transpile step resolves the default library. See {@link B6PProviders.typescriptLibDirs}.
   * @lastreviewed null
   */
  readonly typescriptLibDirs?: readonly string[];
}
