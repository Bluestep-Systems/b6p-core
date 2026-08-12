import path from "path";
import { Err } from "../Err";
import { ResponseCodes } from "../network/StatusCodes";
import { ScriptPathElement } from "./ScriptPathElement";
import type { ScriptFile } from "./ScriptFile";
import { ScriptNode } from "./ScriptNode";
import { TsConfig } from "./TsConfig";
import { B6PUri } from "../B6PUri";

/**
 * Represents a folder in the script project structure.
 */
export class ScriptFolder extends ScriptNode {
  public createFamilial(downstairsUri: B6PUri): ScriptFolder {
    if (!this.scriptRoot.getAsFolder().contains(downstairsUri)) {
      throw new Err.ScriptOperationError("The provided URI is not a sibling within the same script root.");
    }
    return new ScriptFolder(downstairsUri, this.scriptRoot);
  }

  public override async upload(_arg?: {
    upstairsUrlOverrideString?: string;
    isSnapshot?: boolean;
  }): Promise<Response | void> {
    this.ctx.logger.info(`ScriptFolder.upload() called on ${this.path()}; no action taken.`);
    return;
  }

  public override async getReasonToNotPush(_arg?: {
    upstairsOverride?: URL;
    isSnapshot?: boolean;
  }): Promise<string | null> {
    return `Node (${this.path()}) is a folder`;
  }

  public override async download(): Promise<Response> {
    return new Response(null, { status: ResponseCodes.TEAPOT, statusText: "No Content" });
  }

  public async findAllTsConfigFiles(): Promise<TsConfig[]> {
    const uris = await this.ctx.fs.findFiles(this.uri(), "**/tsconfig.json");
    return uris.map((uri) => this.factory.createTsConfig(uri, this.scriptRoot));
  }

  public override equals(other: ScriptFolder): boolean {
    if (!(other instanceof ScriptFolder)) {
      return false;
    }
    const thisPath = path.normalize(this.uri().fsPath);
    const otherPath = path.normalize(other.uri().fsPath);
    return thisPath === otherPath;
  }

  public override path(): string {
    return this.uri().fsPath;
  }

  public override uri(): B6PUri {
    return super.uri();
  }

  public getChildFolder(folderName: string): ScriptFolder {
    return this.factory.createFolder(this.uri().joinPath(folderName), this.scriptRoot);
  }

  /**
   * Normalizes a path for containment comparison: `path.normalize` first (so `.`/`..`
   * and duplicate separators collapse), then the shared marker strip, so a marked and
   * an unmarked spelling of one directory compare equal.
   *
   * The strip itself is {@link B6PUri.stripDirectoryMarker} rather than a local loop —
   * every marker-insensitive comparison in the codebase must agree, and they did not
   * when this logic was duplicated.
   * @lastreviewed null
   */
  private static forComparison(rawPath: string): string {
    return B6PUri.stripDirectoryMarker(path.normalize(rawPath));
  }

  /**
   * Whether `other` is this folder or lives beneath it.
   *
   * Both sides are compared with the trailing folder marker removed. Without that,
   * a marked folder path built `thisPath + path.sep` into a doubled separator
   * (`/a/b/` + `/` = `/a/b//`), which no child path starts with — so containment
   * returned `false` for genuine children. That was live: `ScriptRoot.getAsFolder()`
   * yields a marked URI, and it is the receiver in both `createFamilial` guards.
   * @lastreviewed null
   */
  public contains(other: ScriptPathElement | B6PUri): boolean {
    const thisPath = ScriptFolder.forComparison(this.path());
    const otherPath = ScriptFolder.forComparison(other instanceof B6PUri ? other.fsPath : other.path());
    const prefix = thisPath.endsWith(path.sep) ? thisPath : thisPath + path.sep;
    return otherPath === thisPath || otherPath.startsWith(prefix);
  }

  /**
   * Recursively flattens all files in this folder and returns them as ScriptFile instances with a shared root.
   */
  public async flatten(): Promise<ScriptNode[]> {
    const rawUris = await this.flattenRaw();
    const mappedUris = rawUris.map((uri) => this.factory.createNode(uri, this.scriptRoot));
    return mappedUris;
  }

  /**
   * Recursively flattens all files in this folder and returns their URIs.
   */
  public async flattenRaw(): Promise<B6PUri[]> {
    return this.flattenDirectory(this);
  }

  private async flattenDirectory(dir: ScriptFolder): Promise<B6PUri[]> {
    const result: B6PUri[] = [];
    const dirUri = dir.uri();
    const items = await this.ctx.fs.readDirectory(dirUri);

    result.push(dirUri.asDirectory()); // include the directory itself, marked as a folder
    for (const [name, type] of items) {
      const fullPath = dirUri.joinPath(name);
      if (type === "directory") {
        const subFolder = this.factory.createFolder(fullPath, this.scriptRoot);
        result.push(...(await this.flattenDirectory(subFolder)));
      } else {
        result.push(fullPath);
      }
    }
    return result;
  }

  public name(): string {
    return path.basename(this.path());
  }

  public currentIntegrityMatches(_ops?: { upstairsOverride?: URL }): Promise<boolean> {
    throw new Err.MethodNotImplementedError();
  }

  upstairsUrl(): Promise<URL> {
    throw new Err.MethodNotImplementedError();
  }

  getImmediateChildNode(name: string): ScriptNode {
    return this.factory.createNode(this.uri().joinPath(name), this.scriptRoot);
  }

  getImmediateChildFile(name: string): ScriptFile {
    return this.factory.createFile(this.uri().joinPath(name), this.scriptRoot);
  }

  getImmediateChildFolder(name: string): ScriptFolder {
    return this.factory.createFolder(this.uri().joinPath(name), this.scriptRoot);
  }
}
