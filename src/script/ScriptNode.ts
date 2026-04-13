import * as path from 'path';
import { FolderNames, Http } from '../constants';
import { DownstairsPathParser } from '../data/DownstairsPathParser';
import { GlobMatcher } from '../data/GlobMatcher';
import { Err } from '../Err';
import { ScriptPathElement } from './ScriptPathElement';
import type { ScriptFolder } from './ScriptFolder';
import { ScriptRoot } from './ScriptRoot';
import { TsConfig } from './TsConfig';
import { ScriptUrlParser } from '../data/ScriptUrlParser';
import { B6PUri } from '../B6PUri';
import type { FileStat } from '../providers';
import type { ScriptContext } from './ScriptContext';
import type { ScriptFactory } from './ScriptFactory';

/**
 * A class representing a file or folder element of a script.
 *
 * @lastreviewed 2025-09-15
 */
export abstract class ScriptNode implements ScriptPathElement {

  /**
   * The parser for the downstairs URI of this file.
   */
  protected parser: DownstairsPathParser;

  /**
   * The downstairs root object.
   */
  protected scriptRoot: ScriptRoot;

  /**
   * Caches the existence check result to avoid redundant filesystem calls.
   */
  private _exists: boolean | undefined;

  constructor(public readonly downstairsUri: B6PUri, scriptRoot: ScriptRoot) {
    this.parser = new DownstairsPathParser(downstairsUri.fsPath);
    this.scriptRoot = scriptRoot;
  }

  /** The script context (fs, session, logger, prompt, stores, etc.). */
  protected get ctx(): ScriptContext {
    return this.scriptRoot.ctx;
  }

  /** The script factory bound to this node's context. */
  protected get factory(): ScriptFactory {
    return this.scriptRoot.factory;
  }

  /**
   * Meant to convert the current node to a matching upstairs {@link URL}.
   */
  abstract upstairsUrl(): Promise<URL>;

  /**
   * Creates a familial node with the given downstairs {@link B6PUri} after verifying that it indeed has a familial relation.
   */
  abstract createFamilial(downstairsUri: B6PUri): ScriptNode;

  public uri(): B6PUri {
    return this.downstairsUri;
  }

  public path() {
    return this.uri().fsPath;
  }

  public async getUpstairsLastModified(): Promise<Date> {
    const response = await this.ctx.sessionManager.fetch(await this.upstairsUrl(), {
      method: Http.Methods.HEAD
    });
    const lastModifiedHeaderValue = response.headers.get("Last-Modified");
    if (!lastModifiedHeaderValue) {
      throw new Err.ModificationTimeError();
    }
    return new Date(lastModifiedHeaderValue);
  }

  public async getUpstairsContent(): Promise<string> {
    const response = await this.ctx.sessionManager.fetch(await this.upstairsUrl(), {
      method: Http.Methods.GET,
      headers: {
        [Http.Headers.ACCEPT]: Http.Headers.ACCEPT_ALL,
      }
    });
    if (response.status >= 400) {
      throw new Err.HttpResponseError(`Error fetching upstairs file. Status: ${response.status}.\n ${response.statusText}`);
    }
    return await response.text();
  }

  private b6pUri(): B6PUri {
    return this.uri();
  }

  public async writeContent(buffer: ArrayBuffer) {
    await this.ctx.fs.writeFile(this.b6pUri(), Buffer.from(buffer));
  }

  public async exists(): Promise<boolean> {
    if (this._exists) {
      return this._exists;
    }
    try {
      await this.ctx.fs.stat(this.b6pUri());
      this._exists = true;
      return true;
    } catch (e) {
      this._exists = false;
      return false;
    }
  }

  public async stat(): Promise<FileStat | null> {
    try {
      return await this.ctx.fs.stat(this.b6pUri());
    } catch (e) {
      return null;
    }
  }

  public async lastModifiedTime(): Promise<Date> {
    const stat = await this.stat();
    if (!stat) {
      throw new Err.NodeNotFoundError();
    }
    return new Date(stat.mtime);
  }

  public getScriptRoot(parser?: ScriptUrlParser): ScriptRoot {
    if (parser) {
      this.scriptRoot.withParser(parser);
    }
    return this.scriptRoot;
  }

  withScriptRoot(root: ScriptRoot): ScriptNode {
    this.scriptRoot = root;
    if (this.parser.type === "metadata") {
      throw new Err.MetadataFileOperationError("overwrite script root");
    }
    return this;
  }

  withParser(parser: DownstairsPathParser): ScriptNode {
    this.parser = parser;
    return this;
  }

  public equals(other: ScriptPathElement): boolean {
    return this.path() === other.path();
  }

  public isInDeclarations(): boolean {
    return this.parser.type === "declarations";
  }

  public isInSnapshot(): boolean {
    return this.parser.type === "snapshot";
  }

  public isInDraft(): boolean {
    return this.parser.type === "draft";
  }

  public async isCopacetic(): Promise<boolean> {
    return await this.exists();
  }

  public async isInGitIgnore(): Promise<boolean> {
    const scriptRoot = this.getScriptRoot();
    const gitIgnorePatterns = await scriptRoot.getGitIgnore();
    const globMatcher = new GlobMatcher(scriptRoot.getRootUri().fsPath, gitIgnorePatterns);
    return globMatcher.matches(this.uri().fsPath);
  }

  public async getRest(): Promise<string> {
    return (await this.upstairsUrl()).pathname;
  }

  public folder(): ScriptFolder {
    return this.factory.createFolder(this.uri().dirname, this.scriptRoot);
  }

  public async getMatchingTsConfigFile() {
    return await this.getClosestTsConfigFile();
  }

  public async getClosestTsConfigFile() {
    const tsConfigUri = await this.getClosestTsConfigUri();
    if (!tsConfigUri) {
      throw new Err.ConfigFileError(TsConfig.NAME, 0);
    }
    return this.factory.createTsConfig(tsConfigUri, this.scriptRoot);
  }

  private async getClosestTsConfigUri(): Promise<B6PUri | null> {
    return await this.ctx.fs.closest(this.b6pUri(), TsConfig.NAME);
  }

  public async closest(name: string): Promise<B6PUri | null> {
    return await this.ctx.fs.closest(this.b6pUri(), name);
  }

  public async isInItsRespectiveBuildFolder() {
    const buildFolder = await this.getBuildFolder();
    return buildFolder.contains(this);
  }

  public async getBuildFolder() {
    const tsConfig = await this.getMatchingTsConfigFile();
    return await tsConfig.getBuildFolder();
  }

  public pathWithRespectToDraftRoot() {
    return path.relative(this.getScriptRoot().getRootUri().joinPath(FolderNames.DRAFT).fsPath, this.uri().fsPath);
  }

  public async pathWithRespectToTsConfigFolder() {
    const closestTsConfigFile = await this.getClosestTsConfigFile();
    if (!closestTsConfigFile) {
      throw new Err.ConfigFileError(TsConfig.NAME, 0);
    }
    const closestTsConfigFolderUri = closestTsConfigFile.folder().uri();
    return path.relative(closestTsConfigFolderUri.fsPath, this.uri().fsPath);
  }

  abstract upload(arg?: { upstairsUrlOverrideString?: string, isSnapshot?: boolean; }): Promise<Response | void>;

  abstract download(): Promise<Response>;

  public async isFolder() {
    const stat = await this.ctx.fs.stat(this.b6pUri());
    return stat.type === 'directory';
  }

  public async isFile() {
    return !(await this.isFolder());
  }

  abstract getReasonToNotPush(arg?: { upstairsOverride?: URL; }): Promise<string | null>;

  public async copyDraftFileToBuild() {
    if (await this.isInItsRespectiveBuildFolder()) {
      throw new Err.BuildFolderOperationError("copy", this.path());
    }
    if (!(await this.isCopacetic())) {
      throw new Err.ScriptNotCopaceticError();
    }
    const tsConfig = await this.getClosestTsConfigFile();
    const buildUri = tsConfig.folder().uri().joinPath(
      await tsConfig.relativePathToBuildFolder(),
      await this.pathWithRespectToTsConfigFolder()
    );
    await this.copyTo(buildUri);
  }

  public async readContents(): Promise<Uint8Array<ArrayBufferLike>> {
    return await this.ctx.fs.readFile(this.b6pUri());
  }

  public async copyTo(uri: B6PUri): Promise<void> {
    if (await this.isInItsRespectiveBuildFolder()) {
      throw new Err.BuildFolderOperationError("copy", this.path());
    }
    if (!(await this.isCopacetic())) {
      throw new Err.ScriptNotCopaceticError();
    }
    await this.ctx.fs.copy(this.b6pUri(), uri, { overwrite: true });
  }

  public async delete(): Promise<void> {
    if (await this.isCopacetic()) {
      await this.ctx.fs.delete(this.b6pUri(), { recursive: true });
    } else {
      throw new Err.ScriptNotCopaceticError();
    }
  }

  abstract name(): string;

  public async rename(newName: string): Promise<void> {
    await this.isCopacetic();
    if (this.uri().fsPath === this.scriptRoot.getRootUri().fsPath) {
      throw new Err.ScriptOperationError("Cannot rename the script root folder; the folder name is used as a metadata lookup key.");
    }
    if (this.name() === newName) {
      this.ctx.logger.info("Ignoring rename operation; new name is the same as the current name.");
      return;
    }
    const parentUri = this.uri().dirname;
    const newUri = parentUri.joinPath(newName);
    await this.ctx.fs.rename(this.uri(), newUri);
  }
}
