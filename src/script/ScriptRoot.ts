import path from "path";
import { ScriptMetaData } from "../types";
import { FolderNames, SpecialFiles } from "../constants";
import { DownstairsPathParser } from "../data/DownstairsPathParser";
import { OrgWorker } from "../data/OrgWorker";
import { ScriptKey } from "../data/ScriptKey";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { Err } from "../Err";
import { ScriptFactory } from "./ScriptFactory";
import { B6PUri } from "../B6PUri";
import type { ScriptFolder } from "./ScriptFolder";
import { ScriptNode } from "./ScriptNode";
import { TsConfig } from "./TsConfig";
import type { ScriptContext } from "./ScriptContext";

/**
 * Object representing the root of an individual script on the filesystem.
 *
 * This originally was the webdavid root file.
 * @lastreviewed 2025-09-15
 */
export class ScriptRoot {
  public static readonly GITIGNORE_FILENAME = SpecialFiles.GITIGNORE;
  private _orgWorker: OrgWorker | null;
  public readonly rootUri: B6PUri;
  private parser: DownstairsPathParser;
  private scriptParser: ScriptUrlParser | null;
  private _factory: ScriptFactory | null = null;

  constructor(
    public readonly uri: B6PUri,
    public readonly ctx: ScriptContext
  ) {
    this.parser = new DownstairsPathParser(uri.fsPath);
    const shavedName = this.parser.getShavedName();
    this.rootUri = B6PUri.fromFsPath(shavedName).asDirectory();
    this._orgWorker = null;
    this.scriptParser = null;
  }

  /** Lazily-instantiated factory bound to this root's context. */
  public get factory(): ScriptFactory {
    return (this._factory ??= new ScriptFactory(this.ctx));
  }

  public orgWorker(): OrgWorker {
    if (this._orgWorker === null) {
      if (this.scriptParser !== null) {
        this._orgWorker = this.scriptParser.orgWorker();
        return this._orgWorker;
      }
      throw new Err.InvalidStateError("OrgWorker not initialized");
    }
    return this._orgWorker;
  }

  private getGitIgnoreFileUri(): B6PUri {
    return this.getRootUri().joinPath(SpecialFiles.GITIGNORE);
  }

  private getUFromPath(): string {
    return path.basename(this.getOrgUri().fsPath);
  }

  private getScriptNameFromPath(): string {
    return path.basename(this.rootUri.fsPath);
  }

  public async modifyMetaData(callBack?: (meta: ScriptMetaData) => void): Promise<ScriptMetaData> {
    await this.ctx.scriptMetadataStore.whenReady();
    const pathU = this.getUFromPath();
    const pathScriptName = this.getScriptNameFromPath();

    let entry = this.ctx.scriptMetadataStore.findByScriptName(pathU, pathScriptName);

    if (!entry) {
      if (this.scriptParser !== null) {
        const scriptName =
          (await this.scriptParser.getScriptName()) ||
          (() => {
            throw new Err.FileReadError("Missing script name");
          })();
        const U =
          (await this.scriptParser.getU()) ||
          (() => {
            throw new Err.FileReadError("Missing U");
          })();
        const webdavId =
          this.scriptParser.webDavId ||
          (() => {
            throw new Err.FileReadError("Missing webdavId");
          })();
        const scriptKey =
          (await this.scriptParser.getScriptBaseKey()) ||
          (() => {
            throw new Err.FileReadError("Missing scriptKey");
          })();

        entry = { scriptName, U, webdavId, pushPullRecords: [], scriptKey };
      } else {
        throw new Err.InvalidStateError(
          `No metadata found for script "${pathScriptName}" in org "${pathU}" and no parser available to create it.`
        );
      }
    }

    if (callBack) {
      callBack(entry);
    }

    await this.ctx.scriptMetadataStore.upsert(entry);
    return entry;
  }

  withParser(parser: ScriptUrlParser) {
    this.scriptParser = parser;
  }

  public async getMetaData(): Promise<ScriptMetaData | null> {
    await this.ctx.scriptMetadataStore.whenReady();
    const pathU = this.getUFromPath();
    const pathScriptName = this.getScriptNameFromPath();
    return this.ctx.scriptMetadataStore.findByScriptName(pathU, pathScriptName) || null;
  }

  public async modifyGitIgnore(callBack?: (currentContents: string[]) => void): Promise<string[]> {
    const gitIgnoreUri = this.getGitIgnoreFileUri();
    let currentContents: string[] = [];
    let modified = false;
    try {
      try {
        await this.ctx.fs.stat(gitIgnoreUri);
      } catch (e) {
        throw new Err.FileNotFoundError("Gitignore file does not exist at: `" + gitIgnoreUri.fsPath + "`");
      }
      const fileContents = await this.ctx.fs.readFile(gitIgnoreUri);
      const fileString = Buffer.from(fileContents).toString("utf-8");
      currentContents = fileString
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (e) {
      this.ctx.logger.error("Error reading .gitignore file: " + e);
      if (!(e instanceof Err.FileNotFoundError)) {
        throw e;
      }
      this.ctx.logger.warn(".gitignore file does not exist; creating a new one.");
      currentContents = ["**/.DS_Store"];
      modified = true;
    }
    const preSerialized = JSON.stringify(currentContents);
    if (callBack) {
      callBack(currentContents);
      if (JSON.stringify(currentContents) !== preSerialized) {
        modified = true;
      }
    }
    if (modified) {
      await this.ctx.fs.writeFile(this.getGitIgnoreFileUri(), Buffer.from(currentContents.join("\n") + "\n"));
    }
    return currentContents;
  }

  public async getGitIgnore(): Promise<string[]> {
    return await this.modifyGitIgnore();
  }

  public getRootUri(): B6PUri {
    return this.rootUri;
  }

  public getOrgUri(): B6PUri {
    return this.getRootUri().dirname;
  }

  public async getScriptName(): Promise<string> {
    const metadata = await this.getMetaData();
    if (!metadata) {
      throw new Err.InvalidStateError("Missing metadata");
    }
    return (
      metadata.scriptName ||
      (() => {
        throw new Err.InvalidStateError("Missing scriptName in metadata");
      })()
    );
  }

  async getWebdavId() {
    if (this.scriptParser !== null) {
      return this.scriptParser.webDavId;
    }
    const metadata = await this.getMetaData();
    if (!metadata) {
      throw new Err.InvalidStateError("Missing metadata");
    }
    return (
      metadata.webdavId ||
      (() => {
        throw new Err.InvalidStateError("Missing webdavId in metadata");
      })()
    );
  }

  async getScriptKey(): Promise<ScriptKey> {
    if (this.scriptParser !== null) {
      return this.scriptParser.getScriptBaseKey();
    }
    const metadata = await this.getMetaData();
    if (!metadata) {
      throw new Err.InvalidStateError("Missing metadata");
    }
    if (metadata.scriptKey) {
      return metadata.scriptKey;
    }
    try {
      this.scriptParser = new ScriptUrlParser(
        (await this.getBaseWebDavUrl()).toString(),
        this.ctx.sessionManager,
        this.ctx.logger,
        this.ctx.prompt
      );
      const key = await this.scriptParser.getScriptBaseKey();
      await this.modifyMetaData((meta) => {
        meta.scriptKey = key;
      });
      return key;
    } catch (e) {
      throw new Err.FileReadError(
        "Can't obtain scriptKey in metadata, even after trying to instantiate a scriptParser."
      );
    }
  }

  async getU() {
    // The U is the name of the org folder on disk, so the filesystem path is
    // the authoritative source. Metadata may not yet exist (fresh clone, or
    // persistence wiped), and OrgWorker only exists to *fetch* a U from a
    // live URL — we already know it.
    return this.getUFromPath();
  }

  public async anyOrigin() {
    return await this.ctx.orgCache.getAnyBaseUrl(await this.getU());
  }

  public getAsFolder(): ScriptFolder {
    return this.factory.createFolder(this.getRootUri().asDirectory(), this);
  }

  public async getBaseWebDavUrlString() {
    const origin = await this.anyOrigin();
    const webdavId = await this.getWebdavId();
    return `${origin.toString()}files/${webdavId}/`;
  }

  public async getBaseWebDavUrl(): Promise<URL> {
    const urlString = await this.getBaseWebDavUrlString();
    return new URL(urlString);
  }

  public async getDraftScriptsFolder() {
    return this.getDraftFolder().getChildFolder("scripts");
  }

  equals(b: ScriptRoot) {
    return this.rootUri.fsPath === b.rootUri.fsPath;
  }

  public getDraftFolder() {
    return this.factory.createFolder(this.rootUri.joinPath(FolderNames.DRAFT), this);
  }

  public getDeclarationsFolder() {
    return this.factory.createFolder(this.rootUri.joinPath(FolderNames.DECLARATIONS), this);
  }

  public async findTsConfigFiles(): Promise<TsConfig[]> {
    const tsConfigFiles = await this.ctx.fs.findFiles(this.getDraftFolder().uri(), "**/" + TsConfig.NAME);
    return tsConfigFiles.map((f) => this.factory.createTsConfig(f, this));
  }

  public async getBadTsFiles(): Promise<string[]> {
    const tsConfigFiles = this.findTsConfigFiles();
    const badFiles: string[] = [];
    for (const tsConfig of await tsConfigFiles) {
      if (!(await tsConfig.isCopacetic())) {
        badFiles.push(tsConfig.path());
      }
    }
    return badFiles;
  }

  public async getPushableNodes(): Promise<ScriptNode[]> {
    const flattenedDraft = await this.getDraftFolder().flatten();
    const pushableNodes: ScriptNode[] = [];
    for (const f of flattenedDraft) {
      const reason = await f.getReasonToNotPush();
      if (reason) {
        this.ctx.logger.info(`Excluding draft file from push: ${f.path()} (${reason})`);
        continue;
      }

      const fileName = f.path();
      if (!(await f.isInItsRespectiveBuildFolder())) {
        pushableNodes.push(f);
      } else {
        this.ctx.logger.info(`Excluding file in build folder from push: ${fileName}`);
      }
    }

    return pushableNodes;
  }

  public async preflightCheck(): Promise<string> {
    const badTsFiles = await this.getBadTsFiles();
    if (badTsFiles.length > 0) {
      return `The following tsconfig files are invalid:\n\n${badTsFiles.join("\n")}\n\n
      SPECIFICALLY: ensure that there are no trailing commas in the JSON files; the IDE does not flag this with
      red squigglies, but it renders the JSON invalid and the webapp cannot parse it properly.`;
    }
    return "";
  }

  public async getDraftTsConfig(): Promise<TsConfig> {
    const draftFolderUri = this.getDraftFolder().uri();
    const uri = draftFolderUri.joinPath(TsConfig.NAME);
    const tsConfig = this.factory.createTsConfig(uri, this);
    if (!(await tsConfig.isCopacetic())) {
      throw new Err.ScriptOperationError(`No ${TsConfig.NAME} file found in script root.`);
    }
    return tsConfig;
  }
}
