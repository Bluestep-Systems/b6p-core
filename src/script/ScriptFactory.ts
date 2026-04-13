import * as path from 'path';
import { B6PUri } from "../B6PUri";
import type { ScriptContext } from "./ScriptContext";
import { ScriptFile } from "./ScriptFile";
import { ScriptFolder } from "./ScriptFolder";
import type { ScriptNode } from "./ScriptNode";
import { ScriptRoot } from "./ScriptRoot";
import { TsConfig } from "./TsConfig";


/**
 * Module-scoped default context. Set via {@link ScriptFactory.setDefaultContext}.
 * Used by the static convenience methods on {@link ScriptFactory} for backwards
 * compatibility with callers that don't have direct access to a {@link ScriptContext}.
 */
let _defaultCtx: ScriptContext | null = null;

function defaultFactory(): ScriptFactory {
  if (!_defaultCtx) {
    throw new Error("ScriptFactory: no default context set. Call ScriptFactory.setDefaultContext(ctx) first.");
  }
  return new ScriptFactory(_defaultCtx);
}
/**
 * Factory for creating ScriptNode instances bound to a {@link ScriptContext}.
 *
 * This `VERY SPECIFICALLY` exists to instantiate any ScriptNode objects.
 * You must `NEVER` call those constructors directly. This is because TypeScript
 * absolutely hates it when you do, and you risk being incapable of launching the
 * extension due to circular dependancies.
 */
export class ScriptFactory {
  constructor(public readonly ctx: ScriptContext) {}

  /**
   * Sets the module-scoped default context used by the `static` convenience
   * methods. Consumers that already have direct access to a context should
   * prefer instantiating `new ScriptFactory(ctx)` directly.
   */
  static setDefaultContext(ctx: ScriptContext): void {
    _defaultCtx = ctx;
  }

  /** Static shim — uses the default context. See {@link setDefaultContext}. */
  static createNode(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): ScriptNode {
    return defaultFactory().createNode(uriSupplier, scriptRoot);
  }
  /** Static shim — uses the default context. */
  static createFolder(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): ScriptFolder {
    return defaultFactory().createFolder(uriSupplier, scriptRoot);
  }
  /** Static shim — uses the default context. */
  static createFile(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): ScriptFile {
    return defaultFactory().createFile(uriSupplier, scriptRoot);
  }
  /** Static shim — uses the default context. */
  static createScriptRoot(uriSupplier: (() => B6PUri) | B6PUri): ScriptRoot {
    return defaultFactory().createScriptRoot(uriSupplier);
  }
  /** Static shim — uses the default context. */
  static createTsConfig(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): TsConfig {
    return defaultFactory().createTsConfig(uriSupplier, scriptRoot);
  }

  /**
   * Creates a {@link ScriptNode} (either {@link ScriptFile} or {@link ScriptFolder})
   * based on the URI path.
   */
  createNode(uriSupplier: (() => B6PUri) | B6PUri, scriptRoot?: ScriptRoot): ScriptNode {
    const uri = uriSupplier instanceof Function ? uriSupplier() : uriSupplier;
    const fsPath = uri.fsPath;
    const sr = scriptRoot ?? this.createScriptRoot(uri);

    if (fsPath.endsWith(path.sep) || fsPath.endsWith('/')) {
      return new ScriptFolder(uri, sr);
    }
    const basename = path.basename(fsPath);
    if (basename.includes('.')) {
      return new ScriptFile(uri, sr);
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
