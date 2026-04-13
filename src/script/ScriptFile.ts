import * as path from 'path';
import { CryptoAlgorithms, FileExtensions, FolderNames, Http, MimeTypes } from '../constants';
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { Err } from "../Err";
import { ResponseCodes } from "../network/StatusCodes";
import { ScriptNode } from "./ScriptNode";
import { TsConfig } from './TsConfig';
import { B6PUri } from '../B6PUri';

/**
 * Represents a script file within the system. This is very similar to the webapps "RemoteObject" concept
 * where this object is only a shell around the concept of the file, but does not actually contain the file data itself.
 */
export class ScriptFile extends ScriptNode {

  private static ComplexEtagPattern = /^"?\d{10,13}-\{.*?"class":\s*"myassn\.document\.(Proxy|LibraryServlet)MemoryDocumentKey".*?"classId":\s*\d+.*?\}"?$/;
  private static NumericEtagPattern = /^"?\d{10,13}-[\d_]+"?$/;
  private static EtagPattern = /^"[a-f0-9]{128}"$/;
  private static WeakEtagPattern = /^W\/"[a-f0-9]{128}"$/;

  public createFamilial(downstairsUri: B6PUri): ScriptFile {
    if (!this.scriptRoot.getAsFolder().contains(downstairsUri)) {
      throw new Err.ScriptOperationError("The provided URI is not a proper sibling within the same script root.");
    }
    return new ScriptFile(downstairsUri, this.scriptRoot);
  }

  private _reasonToNotPush: string | undefined | null;

  public async getHash(): Promise<string | null> {
    await this.requireExists();
    const bufferSource = await this.ctx.fs.readFile(B6PUri.fromFsPath(this.uri().fsPath));
    const localHashBuffer = await crypto.subtle.digest(CryptoAlgorithms.SHA_512, bufferSource);
    const hexArray = Array.from(new Uint8Array(localHashBuffer));
    if (hexArray.length !== 64) {
      throw new Err.HashCalculationError();
    }
    return hexArray.map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
  }

  public async getUpstairsHash(ops?: { required?: boolean, upstairsOverride?: URL; }): Promise<string | null> {
    const response = await this.ctx.sessionManager.fetch(ops?.upstairsOverride || await this.upstairsUrl(), {
      method: Http.Methods.HEAD
    });
    const etagHeader = response.headers.get(Http.Headers.ETAG);

    let etag: string | null = null;
    if (ScriptFile.EtagPattern.test(etagHeader || "")) {
      etag = JSON.parse(etagHeader?.toLowerCase() || "null");
    } else if (ScriptFile.WeakEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("weak etagHeader:", etagHeader);
      etag = JSON.parse(etagHeader?.substring(2).toLowerCase() || "null");
    } else if (ScriptFile.NumericEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("numeric etagHeader:", etagHeader);
    } else {
      this.ctx.logger.debug("complex etagHeader:", etagHeader);
    }
    if (!etag) {
      if (ops?.required) {
        throw new Err.HashCalculationError();
      }
      return null;
    }
    return etag.toLowerCase();
  }

  public async getLastVerifiedHash(): Promise<string | null> {
    await this.requireExists();
    const md = await this.getScriptRoot().getMetaData();
    if (!md) {
      return null;
    }
    const record = md.pushPullRecords.find(record => record.downstairsPath === this.uri().fsPath);
    return record ? record.lastVerifiedHash : null;
  }

  public async currentIntegrityMatches(ops?: { upstairsOverride?: URL; }): Promise<boolean> {
    const localHash = await this.getHash();
    const upstairsHash = await this.getUpstairsHash(ops);
    const matches = localHash === upstairsHash;
    this.ctx.logger.debug("filename:", this.name(), "\n", "matches:", matches, "\n", "local:", localHash, "\n", "upstairs:", upstairsHash);
    return matches;
  }

  public async oldIntegrityMatches(ops?: { upstairsOverride?: URL; }): Promise<boolean> {
    const lastHash = await this.getLastVerifiedHash();
    if (!lastHash) {
      return false;
    }
    const upstairsHash = await this.getUpstairsHash(ops);
    const matches = lastHash === upstairsHash;
    this.ctx.logger.debug("filename:", this.name(), "\n", "matches:", matches, "\n", "local:", lastHash, "\n", "upstairs:", upstairsHash);
    return matches;
  }

  /**
   * Downloads the file from the upstairs location and writes it to the local file system.
   * Performs integrity verification using ETag headers (SHA-512 hashes only) and updates the lastPulled timestamp.
   * Skips download if the file is in .gitignore and removes it from metadata instead.
   * Skips integrity verification for numeric and complex ETags (no hash available).
   *
   * @returns Response object with status 418 if file is in .gitignore, otherwise the actual HTTP response
   * @throws an {@link Err.HttpResponseError} When the download fails due to a bad response
   * @throws an {@link Err.FileIntegrityError} When the downloaded file's integrity check fails
   * @throws an {@link Err.EtagParsingError} When the ETag header cannot be parsed
   * @lastreviewed 2025-10-01
   */
  public async download(parser?: ScriptUrlParser): Promise<Response> {
    const ignore = await super.isInGitIgnore();
    if (ignore) {
      this.ctx.logger.info(`not downloading \`${this.name()}\` because in .gitignore`);
      await this.deleteFromMetadata();
      return new Response("", { status: ResponseCodes.TEAPOT });
    }
    const lookupUri = await this.upstairsUrl(parser);
    this.ctx.logger.info("downloading from:" + lookupUri);
    const response = await this.ctx.sessionManager.fetch(lookupUri, {
      method: Http.Methods.GET,
      headers: {
        [Http.Headers.ACCEPT]: Http.Headers.ACCEPT_ALL,
      }
    });
    if (response.status >= ResponseCodes.BAD_REQUEST) {
      this.ctx.logger.error(`Error fetching file ${lookupUri.toString()}: ${response.status} ${response.statusText}`);
      throw new Err.HttpResponseError(`Error fetching file ${lookupUri.toString()}: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    await this.writeContent(buffer);
    const etagHeader = response.headers.get(Http.Headers.ETAG);

    if (ScriptFile.EtagPattern.test(etagHeader || "")) {
      const etag = JSON.parse(etagHeader?.toLowerCase() || "null");
      const hash = await this.getHash();
      if (hash !== etag) {
        throw new Err.FileIntegrityError();
      }
    } else if (ScriptFile.WeakEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("weak etagHeader:", etagHeader);
      const etag = JSON.parse(etagHeader?.substring(2).toLowerCase() || "null");
      const hash = await this.getHash();
      if (hash !== etag) {
        throw new Err.FileIntegrityError();
      }
    } else if (ScriptFile.NumericEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("numeric etagHeader:", etagHeader);
    } else if (ScriptFile.ComplexEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("complex etagHeader:", etagHeader);
    } else {
      throw new Err.EtagParsingError(etagHeader || 'null');
    }

    await this.touch();
    return response;
  }

  private async deleteFromMetadata() {
    await this.getScriptRoot().modifyMetaData((md) => {
      const index = md.pushPullRecords.findIndex(record => record.downstairsPath === this.uri().fsPath);
      if (index !== -1) {
        md.pushPullRecords.splice(index, 1);
      }
    });
  }

  public async delete() {
    await super.delete();
    await this.deleteFromMetadata();
  }

  public name(): string {
    return path.parse(this.uri().fsPath).base;
  }

  public async upstairsUrl(parser?: ScriptUrlParser): Promise<URL> {
    const upstairsBaseUrl = await this.getScriptRoot(parser).getBaseWebDavUrl();
    this.ctx.logger.debug("base upstairs URL:", upstairsBaseUrl.toString());
    const newUrl = new URL(upstairsBaseUrl);
    if (this.parser.type === "root") {
      return newUrl;
    } else if (this.parser.type === "metadata") {
      newUrl.pathname = upstairsBaseUrl.pathname + this.name();
    } else if (this.parser.isInDefinedFolders()) {
      newUrl.pathname = upstairsBaseUrl.pathname + this.parser.type + "/" + this.parser.rest;
    } else {
      throw new Err.InvalidFileTypeForUrlError(this.parser.type);
    }

    return newUrl;
  }

  public async getReasonToNotPush(ops?: { upstairsOverride?: URL; }): Promise<string | null> {
    if (this._reasonToNotPush !== undefined) {
      return this._reasonToNotPush;
    }
    return await this.setReasonToNotPush(ops);
  }

  private async setReasonToNotPush(ops?: { upstairsOverride?: URL; }): Promise<string | null> {
    if (this.parser.type === "root") {
      this._reasonToNotPush = "Node is the root folder";
    } else if (this.isInDeclarations()) {
      this._reasonToNotPush = "Node is in declarations";
    } else if (this.isInGitFolder()) {
      this._reasonToNotPush = "Node is in .git folder";
    } else if (await this.isInGitIgnore()) {
      this._reasonToNotPush = "Node is ignored by .gitignore";
    } else if ((await this.isFile()) && await this.currentIntegrityMatches(ops)) {
      this._reasonToNotPush = "File integrity matches";
    } else if (!this._reasonToNotPush) {
      this._reasonToNotPush = null;
    }
    return this._reasonToNotPush;
  }

  private isInGitFolder(): boolean {
    const gitFolder = path.sep + ".git" + path.sep;
    const normalizedPath = path.normalize(this.uri().fsPath);
    return normalizedPath.includes(gitFolder);
  }

  public shouldCopyRaw() {
    return path.extname(this.name()).toLowerCase() !== FileExtensions.TYPESCRIPT;
  }

  public get extension() {
    return path.extname(this.name()).toLowerCase();
  }

  public isTypescript(): boolean {
    return [FileExtensions.TYPESCRIPT, FileExtensions.TYPESCRIPT_JSX].includes(this.extension);
  }

  public isNotTypescript(): boolean {
    return !this.isTypescript();
  }

  async upload(arg?: { upstairsUrlOverrideString?: string, isSnapshot?: boolean; }): Promise<Response | void> {
    if (await this.isFolder()) {
      throw new Err.ScriptOperationError("somehow a folder got created to upload with this method. ");
    }
    this.ctx.logger.info("Preparing to send file:", this.uri().fsPath);
    this.ctx.logger.info("To target formula URI:", arg?.upstairsUrlOverrideString);
    const upstairsOverride = new URL(arg?.upstairsUrlOverrideString || (await this.upstairsUrl()).toString());
    const thisUpstairs = await this.upstairsUrl();
    upstairsOverride.pathname = thisUpstairs.pathname;
    if (!this.isInSnapshot() && !(await this.isInItsRespectiveBuildFolder()) && !(await this.oldIntegrityMatches())) {
      const OVERWRITE = 'Overwrite';
      const CANCEL = 'Cancel';
      const overwrite = await this.ctx.prompt.confirm(
        `The upstairs file (${upstairsOverride}) has changed since the last time you pushed or pulled. Do you wish to overwrite it?`,
        [OVERWRITE, CANCEL]
      );
      if (overwrite !== OVERWRITE) {
        await this.ctx.prompt.popup((arg?.isSnapshot ? "Snapshot" : "Push") + " cancelled by user.");
        throw new Err.UserCancelledError(`User ${overwrite ? overwrite + "ed" : "cancelled"} push due to upstairs file change`);
      }
    }
    const reason = await this.getReasonToNotPush({ upstairsOverride });

    if (reason) {
      this.ctx.logger.info(`${reason}; not pushing file:`, this.uri().fsPath);
      return;
    }
    this.ctx.logger.info("Destination:", upstairsOverride.toString());

    const fileContents = await this.ctx.fs.readFile(B6PUri.fromFsPath(this.uri().fsPath));
    const requestOptions = {
      method: Http.Methods.PUT,
      headers: {
        [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON,
      },
      body: fileContents
    };
    let resp = await this.ctx.sessionManager.fetch(upstairsOverride, requestOptions);
    if (!resp.ok) {
      const details = await getDetails(resp);
      throw new Err.FileSendError(details);
    }
    if (arg?.isSnapshot) {
      if (this.parser.type !== FolderNames.DRAFT) {
        throw new Err.ScriptOperationError("This should never happen, this is here as a safetycheck and should be removed when we're confident.");
      }
      const snapshotOverride = new URL(upstairsOverride);
      snapshotOverride.pathname = snapshotOverride.pathname.replace(new RegExp(FolderNames.DRAFT), FolderNames.SNAPSHOT);

      resp = await this.ctx.sessionManager.fetch(snapshotOverride, requestOptions);
    }
    await this.touch();
    this.ctx.logger.info("File sent successfully:", this.uri().fsPath);
    return resp;
    async function getDetails(resp: Response) {
      return `
  ========
  ========
  status: ${resp.status}
  statusText: ${resp.statusText}
  ========
  ========
  text: ${await resp.text()}
  ========
  ========`;
    }
  }

  public isTsConfig(): boolean {
    return this.name() === TsConfig.NAME;
  }

  public isMarkdown(): boolean {
    return this.extension === FileExtensions.MARKDOWN;
  }

  public async getDownstairsContent(): Promise<string> {
    await this.requireExists();
    const downstairsUri = this.uri();
    try {
      const fileData = await this.ctx.fs.readFile(B6PUri.fromFsPath(downstairsUri.fsPath));
      return Buffer.from(fileData).toString('utf8');
    } catch (e) {
      if (e instanceof Error || typeof e === 'string') {
        this.ctx.logger.error(e);
      } else {
        this.ctx.logger.error(`Error reading downstairs file: ${e}`);
      }
      throw new Err.FileReadError(`Error reading downstairs file: ${e}`);
    }
  }

  async touch(): Promise<void> {
    await this.requireExists();
    const lastHash = await this.getHash();
    const metaData = await this.getScriptRoot().modifyMetaData(md => {
      const downstairsPath = this.uri().fsPath;
      const existingEntryIndex = md.pushPullRecords.findIndex(entry => entry.downstairsPath === downstairsPath);
      if (existingEntryIndex !== -1) {
        md.pushPullRecords[existingEntryIndex].lastVerifiedHash = lastHash;
      } else {
        md.pushPullRecords.push({
          downstairsPath,
          lastVerifiedHash: lastHash
        });
      }
    });
    this.ctx.isDebugMode() && console.log("Updated metadata:", metaData);
  }

  private async requireExists(): Promise<void> {
    if (!await this.exists()) {
      throw new Err.FileNotFoundError(this.uri().fsPath);
    }
  }
}
