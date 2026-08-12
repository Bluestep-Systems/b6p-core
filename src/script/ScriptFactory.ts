import * as path from "path";
import { B6PUri } from "../B6PUri";
import type { ScriptContext } from "./ScriptContext";
import { ScriptFile } from "./ScriptFile";
import { ScriptFolder } from "./ScriptFolder";
import type { ScriptNode } from "./ScriptNode";
import { ScriptRoot } from "./ScriptRoot";
import { TsConfig } from "./TsConfig";

/**
 * Factory for creating ScriptNode instances bound to a {@link ScriptContext}.
 *
 * This `VERY SPECIFICALLY` exists to instantiate any ScriptNode objects.
 * You must `NEVER` call those constructors directly. This is because TypeScript
 * absolutely hates it when you do, and you risk being incapable of launching the
 * extension due to circular dependancies.
 *
 * Every instance is bound to a context at construction. There is deliberately no
 * ambient default: a module-scoped mutable context plus `static` create* shims
 * used to exist here, which made the factory's behaviour depend on whether some
 * unrelated code had called a registration method first, and made two contexts in
 * one process (a test double alongside a live core) impossible to keep apart.
 * Obtain a bound factory from {@link ScriptService.getFactory}, from
 * {@link ScriptRoot.factory}, or by constructing one over a {@link ScriptContext}
 * directly.
 * @lastreviewed null
 */
export class ScriptFactory {
  constructor(public readonly ctx: ScriptContext) {}

  /**
   * Creates a {@link ScriptNode} (either {@link ScriptFile} or {@link ScriptFolder})
   * based on the URI path.
   *
   * A **trailing separator is the only folder signal.** Everything else is a file,
   * including an extensionless path like `.../draft/README` — this method cannot
   * touch the filesystem, so a path is classified by its shape alone.
   *
   * This previously branched on `path.basename(fsPath).includes(".")` and returned
   * `new ScriptFile(uri, sr)` from **both** arms, so the extension test decided
   * nothing. The branch is gone rather than completed: making an extensionless path
   * a {@link ScriptFolder} would be a behaviour change, and the callers that reach
   * this (`ScriptRoot.compileDraftFolder` over emitted `.js` paths, and
   * {@link ScriptService.getFactory} consumers) pass paths that already carry an
   * extension or a trailing separator.
   * @lastreviewed null
   */
  createNode(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): ScriptNode {
    const uri = uriSupplier instanceof Function ? uriSupplier() : uriSupplier;
    const fsPath = uri.fsPath;
    const sr = scriptRoot ?? this.createScriptRoot(uri);

    if (fsPath.endsWith(path.sep) || fsPath.endsWith("/")) {
      return new ScriptFolder(uri, sr);
    }
    return new ScriptFile(uri, sr);
  }

  createFolder(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): ScriptFolder {
    const uri = uriSupplier instanceof Function ? uriSupplier() : uriSupplier;
    return new ScriptFolder(uri, scriptRoot ?? this.createScriptRoot(uri));
  }

  createFile(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): ScriptFile {
    const uri = uriSupplier instanceof Function ? uriSupplier() : uriSupplier;
    return new ScriptFile(uri, scriptRoot ?? this.createScriptRoot(uri));
  }

  createScriptRoot(uriSupplier: (() => B6PUri) | B6PUri): ScriptRoot {
    const uri = uriSupplier instanceof Function ? uriSupplier() : uriSupplier;
    return new ScriptRoot(uri, this.ctx);
  }

  createTsConfig(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): TsConfig {
    const uri = uriSupplier instanceof Function ? uriSupplier() : uriSupplier;
    return new TsConfig(uri, scriptRoot ?? this.createScriptRoot(uri));
  }
}
