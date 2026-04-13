import * as path from 'path';
import { Err } from "../Err";
import { ScriptPathElement } from "./ScriptPathElement";
import type { ScriptFile } from "./ScriptFile";
import type { ScriptRoot } from "./ScriptRoot";
import { B6PUri } from '../B6PUri';

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

  constructor(protected readonly rawUri: B6PUri, scriptRoot: ScriptRoot) {
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
    const fileString = Buffer.from(fileContents).toString('utf-8');
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
    const config = JSON.parse(Buffer.from(fileContents).toString('utf-8'));
    const outDir = config.compilerOptions?.outDir || (() => { throw new Err.MissingConfigurationError("outDir"); })();
    return this.scriptRoot.factory.createFolder(this.folder().uri().joinPath(outDir), this.scriptRoot);
  }

  public async relativePathToBuildFolder(): Promise<string> {
    const buildFolder = await this.getBuildFolder();
    const relativePath = path.relative(this.uri().fsPath, buildFolder.uri().fsPath);
    return relativePath;
  }
}
