import * as path from "path";
import { Err } from "../Err";
import { FolderNames } from "../constants";
import { ScriptPathElement } from "./ScriptPathElement";
import type { ScriptFile } from "./ScriptFile";
import type { ScriptRoot } from "./ScriptRoot";
import { B6PUri } from "../B6PUri";

/**
 * A specialized {@link ScriptPathElement} representing a tsconfig.json file.
 *
 * We want this to extend {@link ScriptFile} for cleanliness (since it truly is the same thing),
 * but there were some circular dependency issues that were difficult to resolve. If at some point
 * in the future ScriptFile is refactored such that it isn't an issue, we can revisit this.
 *
 * Instead, TsConfig merely wraps a ScriptFile and delegates relevant methods to it.
 */
export class TsConfig implements ScriptPathElement {
  static NAME = "tsconfig.json";
  private sf: ScriptFile;
  private readonly scriptRoot: ScriptRoot;

  constructor(
    protected readonly rawUri: B6PUri,
    scriptRoot: ScriptRoot
  ) {
    if (!this.path().endsWith(TsConfig.NAME)) {
      throw new Err.InvalidResourceTypeError("tsconfig.json file");
    }
    this.scriptRoot = scriptRoot;
    this.sf = scriptRoot.factory.createFile(rawUri, scriptRoot);
  }

  public equals(other: TsConfig): boolean {
    if (!(other instanceof TsConfig)) {
      return false;
    }
    return this.sf.equals(other.sf);
  }

  public path(): string {
    return this.rawUri.fsPath;
  }

  public uri(): B6PUri {
    return this.rawUri;
  }

  public folder() {
    return this.scriptRoot.factory.createFolder(this.rawUri.dirname, this.scriptRoot);
  }

  public async isCopacetic(): Promise<boolean> {
    const exists = await this.sf.exists();
    if (!exists) {
      return false;
    }
    const fileContents = await this.scriptRoot.ctx.fs.readFile(this.uri());
    const fileString = Buffer.from(fileContents).toString("utf-8");
    try {
      const parsed = JSON.parse(fileString);
      if (parsed.compilerOptions && parsed.include) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public async getBuildFolder() {
    const fileContents = await this.scriptRoot.ctx.fs.readFile(this.uri());
    const config = JSON.parse(Buffer.from(fileContents).toString("utf-8"));
    const outDir = TsConfig.resolveOutDir(config.compilerOptions?.outDir);
    if (outDir !== config.compilerOptions?.outDir) {
      // A fresh pull of a MergeReport `static/` sub-project can leave `outDir`
      // as an empty string (or omit it). Rather than aborting the whole push
      // with `MissingConfigurationError` (b6p-cli#9), fall back to the same
      // default the transpiler uses (`.build`) so the build step tolerates it.
      this.scriptRoot.ctx.logger.info(
        `tsconfig at ${this.path()} has no usable outDir; defaulting build folder to "${outDir}".`
      );
    }
    return this.scriptRoot.factory.createFolder(this.folder().uri().joinPath(outDir), this.scriptRoot);
  }

  /**
   * Normalize a tsconfig `outDir` to a usable build-folder name.
   *
   * An empty string, whitespace, or a missing/non-string value all mean "not
   * specified"; we fall back to {@link FolderNames.DOT_BUILD} (`.build`) — the
   * same default {@link ScriptTranspiler.DEFAULT_TS_CONFIG} emits to — instead
   * of throwing. `.build` (rather than `.`) is deliberate: it keeps a source
   * `.ts` OUT of "its respective build folder", so the file stays eligible for
   * transpile and the push collision-prompt logic behaves normally.
   * @lastreviewed null
   */
  static resolveOutDir(rawOutDir: unknown): string {
    if (typeof rawOutDir === "string" && rawOutDir.trim().length > 0) {
      return rawOutDir;
    }
    return FolderNames.DOT_BUILD;
  }

  public async relativePathToBuildFolder(): Promise<string> {
    const buildFolder = await this.getBuildFolder();
    const relativePath = path.relative(this.uri().fsPath, buildFolder.uri().fsPath);
    return relativePath;
  }
}
