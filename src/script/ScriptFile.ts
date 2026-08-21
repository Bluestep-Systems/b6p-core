import * as path from "path";
import { webcrypto } from "node:crypto";
import { CryptoAlgorithms, FileExtensions, FolderNames, Http, MimeTypes } from "../constants";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { Err } from "../Err";
import { ResponseCodes } from "../network/StatusCodes";
import { ScriptNode } from "./ScriptNode";
import { TsConfig } from "./TsConfig";
import { B6PUri } from "../B6PUri";

/**
 * Represents a script file within the system. This is very similar to the webapps "RemoteObject" concept
 * where this object is only a shell around the concept of the file, but does not actually contain the file data itself.
 */
export class ScriptFile extends ScriptNode {
  private static ComplexEtagPattern =
    /^"?\d{10,13}-\{.*?"class":\s*"myassn\.document\.(Proxy|LibraryServlet)MemoryDocumentKey".*?"classId":\s*\d+.*?\}"?$/;
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

  /**
   * SHA-512 of the file's bytes, hex-encoded — the local half of the ETag
   * integrity comparison.
   *
   * Uses `webcrypto` imported from `node:crypto` rather than the ambient `crypto`
   * global. The global is only unflagged from Node 19, so on Node 18 this threw
   * `crypto is not defined` and took out the integrity check behind both `push`
   * and `audit` — while `package.json` declared `engines: >=18`. The engines floor
   * has since moved to 20, but the explicit import stays: it makes this independent
   * of which runtime happens to expose which global.
   * @lastreviewed null
   */
  public async getHash(): Promise<string | null> {
    await this.requireExists();
    const bufferSource = await this.ctx.fs.readFile(B6PUri.fromFsPath(this.uri().fsPath));
    return ScriptFile.computeHash(bufferSource);
  }

  /**
   * SHA-512 of the given bytes, hex-encoded — same encoding as {@link getHash},
   * for content that is not (yet) on disk, e.g. a downloaded body that has not
   * been written.
   * @param bytes The raw content to hash (a fetched body or a file read)
   * @returns The lowercase hex-encoded SHA-512 digest
   * @throws an {@link Err.HashCalculationError} When the digest is not the expected 64 bytes
   * @lastreviewed null
   */
  private static async computeHash(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const hashBuffer = await webcrypto.subtle.digest(CryptoAlgorithms.SHA_512, bytes);
    const hexArray = Array.from(new Uint8Array(hashBuffer));
    if (hexArray.length !== 64) {
      throw new Err.HashCalculationError();
    }
    return hexArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toLowerCase();
  }

  public async getUpstairsHash(ops?: { required?: boolean; upstairsOverride?: URL }): Promise<string | null> {
    const response = await this.ctx.sessionManager.fetch(ops?.upstairsOverride || (await this.upstairsUrl()), {
      method: Http.Methods.HEAD,
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
    const record = md.pushPullRecords.find((record) => record.downstairsPath === this.uri().fsPath);
    return record ? record.lastVerifiedHash : null;
  }

  /**
   * Compares the local content hash against the upstairs hash, distinguishing a genuine
   * mismatch from the case where the server exposes no comparable content hash.
   *
   * The server serves some files (declaration/library files handled by the memory-document
   * servlets) with numeric or complex ETags rather than a SHA-512 content hash. For those,
   * {@link getUpstairsHash} returns `null`: we cannot assert whether the file matches, so the
   * status is `"indeterminate"` rather than `"mismatch"`. This mirrors {@link download}, which
   * likewise skips integrity verification for those same ETag classes.
   *
   * @returns `"match"` when hashes are equal, `"mismatch"` when both hashes are known but
   *   differ, and `"indeterminate"` when no upstairs content hash is available to compare.
   * @lastreviewed null
   */
  public async currentIntegrityStatus(ops?: {
    upstairsOverride?: URL;
  }): Promise<"match" | "mismatch" | "indeterminate"> {
    const localHash = await this.getHash();
    const upstairsHash = await this.getUpstairsHash(ops);
    const status = upstairsHash === null ? "indeterminate" : localHash === upstairsHash ? "match" : "mismatch";
    this.ctx.logger.debug(
      "filename:",
      this.name(),
      "\n",
      "status:",
      status,
      "\n",
      "local:",
      localHash,
      "\n",
      "upstairs:",
      upstairsHash
    );
    return status;
  }

  public async currentIntegrityMatches(ops?: { upstairsOverride?: URL }): Promise<boolean> {
    return (await this.currentIntegrityStatus(ops)) === "match";
  }

  public async oldIntegrityMatches(ops?: { upstairsOverride?: URL }): Promise<boolean> {
    const lastHash = await this.getLastVerifiedHash();
    if (!lastHash) {
      return false;
    }
    const upstairsHash = await this.getUpstairsHash(ops);
    const matches = lastHash === upstairsHash;
    this.ctx.logger.debug(
      "filename:",
      this.name(),
      "\n",
      "matches:",
      matches,
      "\n",
      "local:",
      lastHash,
      "\n",
      "upstairs:",
      upstairsHash
    );
    return matches;
  }

  /**
   * Downloads the file from the upstairs location and writes it to the local file system.
   * Performs integrity verification using ETag headers (SHA-512 hashes only) and records the
   * file's `lastVerifiedHash` via {@link touch}.
   * Skips download if the file is in .gitignore and removes it from metadata instead.
   * Skips integrity verification for numeric and complex ETags (no hash available).
   *
   * Both the integrity check and the local-divergence guard run against the
   * downloaded bytes BEFORE anything is written, so a failed integrity check or
   * a kept local file leaves the disk exactly as it was.
   *
   * When the local file has been edited since the last push/pull (its content
   * hash no longer matches the recorded `lastVerifiedHash`) and the platform
   * copy differs from it, the local copy is KEPT and reported rather than
   * overwritten — deliberately without prompting, because download() runs once
   * per file inside a pull loop where a blocking read can never complete on
   * non-interactive stdin. A flow that has already confirmed the user's intent
   * to take the platform copy (e.g. an audit pull) passes
   * `opts.overwriteLocal: true` to bypass the guard. A kept file's metadata is
   * left untouched so `audit` keeps reporting the divergence.
   *
   * @param opts.overwriteLocal platform copy wins even over local edits (caller has confirmed intent)
   * @param opts.onLocalKept called instead of the per-file warning when the guard keeps a local file,
   *   so a batch caller (pull) can aggregate into one summary
   * @returns Response object with status 418 if file is in .gitignore, otherwise the actual HTTP response
   * @throws an {@link Err.HttpResponseError} When the download fails due to a bad response
   * @throws an {@link Err.FileIntegrityError} When the downloaded file's integrity check fails
   * @throws an {@link Err.EtagParsingError} When the ETag header cannot be parsed
   * @lastreviewed null
   */
  public async download(
    parser?: ScriptUrlParser,
    opts?: { overwriteLocal?: boolean; onLocalKept?: (fsPath: string) => void }
  ): Promise<Response> {
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
      },
    });
    if (response.status >= ResponseCodes.BAD_REQUEST) {
      this.ctx.logger.error(`Error fetching file ${lookupUri.toString()}: ${response.status} ${response.statusText}`);
      throw new Err.HttpResponseError(
        `Error fetching file ${lookupUri.toString()}: ${response.status} ${response.statusText}`
      );
    }
    const buffer = await response.arrayBuffer();
    const incomingHash = await ScriptFile.computeHash(buffer);
    const etagHeader = response.headers.get(Http.Headers.ETAG);

    if (ScriptFile.EtagPattern.test(etagHeader || "")) {
      const etag = JSON.parse(etagHeader?.toLowerCase() || "null");
      if (incomingHash !== etag) {
        throw new Err.FileIntegrityError();
      }
    } else if (ScriptFile.WeakEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("weak etagHeader:", etagHeader);
      const etag = JSON.parse(etagHeader?.substring(2).toLowerCase() || "null");
      if (incomingHash !== etag) {
        throw new Err.FileIntegrityError();
      }
    } else if (ScriptFile.NumericEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("numeric etagHeader:", etagHeader);
    } else if (ScriptFile.ComplexEtagPattern.test(etagHeader || "")) {
      this.ctx.logger.debug("complex etagHeader:", etagHeader);
    } else {
      throw new Err.EtagParsingError(etagHeader || "null");
    }

    if (!(await this.shouldOverwriteLocal(incomingHash, opts))) {
      const message =
        `Keeping the local copy of ${this.uri().fsPath} — it differs from what was last synced ` +
        `(local edits, or a previously interrupted pull) and was NOT synced with the platform. ` +
        `Sync via an audit pull to take the platform version, or delete the file and pull again.`;
      if (opts?.onLocalKept) {
        opts.onLocalKept(this.uri().fsPath);
        this.ctx.logger.info(message);
      } else {
        this.ctx.prompt.warn(message);
      }
      return response;
    }

    await this.writeContent(buffer);
    await this.touch();
    return response;
  }

  /**
   * Divergence guard for {@link download}: decides whether the incoming platform
   * content may overwrite the local file. Never prompts — see the download() doc
   * for why.
   *
   * Overwriting is fine when the caller has already confirmed the intent
   * (`overwriteLocal`), when the local file does not exist, when the incoming
   * content is identical to it, or when the local content still matches the
   * recorded `lastVerifiedHash` (i.e. it has not been edited since the last
   * push/pull — only the platform side moved). A file with content differences
   * but NO metadata record also overwrites: the record store is machine-local
   * and routinely empty (fresh clone, new machine, cleared state), so treating
   * "no record" as a local edit would make a first pull on such a machine write
   * nothing at all. Only a recorded last-sync hash that no longer matches the
   * local content — a genuine local edit — keeps the local copy.
   *
   * @param incomingHash SHA-512 (hex) of the fetched platform content
   * @param opts.overwriteLocal caller-confirmed intent to take the platform copy
   * @returns `true` when writing may proceed, `false` when the local copy must be kept
   * @lastreviewed null
   */
  private async shouldOverwriteLocal(incomingHash: string, opts?: { overwriteLocal?: boolean }): Promise<boolean> {
    if (opts?.overwriteLocal) {
      return true;
    }
    if (!(await this.exists())) {
      return true;
    }
    const localHash = await this.getHash();
    if (localHash === incomingHash) {
      return true;
    }
    const lastVerifiedHash = await this.getLastVerifiedHash();
    if (lastVerifiedHash === null) {
      return true;
    }
    return localHash === lastVerifiedHash;
  }

  private async deleteFromMetadata() {
    await this.getScriptRoot().modifyMetaData((md) => {
      const index = md.pushPullRecords.findIndex((record) => record.downstairsPath === this.uri().fsPath);
      if (index !== -1) {
        md.pushPullRecords.splice(index, 1);
      }
    });
  }

  public override async delete() {
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

  public async getReasonToNotPush(ops?: { upstairsOverride?: URL }): Promise<string | null> {
    if (this._reasonToNotPush !== undefined) {
      return this._reasonToNotPush;
    }
    return await this.setReasonToNotPush(ops);
  }

  private async setReasonToNotPush(ops?: { upstairsOverride?: URL }): Promise<string | null> {
    if (this.parser.type === "root") {
      this._reasonToNotPush = "Node is the root folder";
    } else if (this.isInDeclarations()) {
      this._reasonToNotPush = "Node is in declarations";
    } else if (this.isInGitFolder()) {
      this._reasonToNotPush = "Node is in .git folder";
    } else if (await this.isInGitIgnore()) {
      this._reasonToNotPush = "Node is ignored by .gitignore";
    } else if ((await this.isFile()) && (await this.currentIntegrityMatches(ops))) {
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

  async upload(arg?: { upstairsUrlOverrideString?: string; isSnapshot?: boolean }): Promise<Response | void> {
    if (await this.isFolder()) {
      throw new Err.ScriptOperationError("somehow a folder got created to upload with this method. ");
    }
    this.ctx.logger.info("Preparing to send file:", this.uri().fsPath);
    this.ctx.logger.info("To target formula URI:", arg?.upstairsUrlOverrideString);
    const upstairsOverride = new URL(arg?.upstairsUrlOverrideString || (await this.upstairsUrl()).toString());
    const thisUpstairs = await this.upstairsUrl();
    upstairsOverride.pathname = thisUpstairs.pathname;
    if (!this.isInSnapshot() && !(await this.isInItsRespectiveBuildFolder()) && !(await this.oldIntegrityMatches())) {
      const OVERWRITE = "Overwrite";
      const CANCEL = "Cancel";
      const overwrite = await this.ctx.prompt.confirm(
        `The upstairs file (${upstairsOverride}) has changed since the last time you pushed or pulled. Do you wish to overwrite it?`,
        [OVERWRITE, CANCEL]
      );
      if (overwrite !== OVERWRITE) {
        await this.ctx.prompt.popup((arg?.isSnapshot ? "Snapshot" : "Push") + " cancelled by user.");
        throw new Err.UserCancelledError(
          `User ${overwrite ? overwrite + "ed" : "cancelled"} push due to upstairs file change`
        );
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
      body: fileContents,
    };
    let resp = await this.ctx.sessionManager.fetch(upstairsOverride, requestOptions);
    if (!resp.ok) {
      const details = await getDetails(resp);
      throw new Err.FileSendError(details);
    }
    if (arg?.isSnapshot) {
      if (this.parser.type !== FolderNames.DRAFT) {
        throw new Err.ScriptOperationError(
          "This should never happen, this is here as a safetycheck and should be removed when we're confident."
        );
      }
      const snapshotOverride = new URL(upstairsOverride);
      snapshotOverride.pathname = snapshotOverride.pathname.replace(
        new RegExp(FolderNames.DRAFT),
        FolderNames.SNAPSHOT
      );

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
      return Buffer.from(fileData).toString("utf8");
    } catch (e) {
      if (e instanceof Error || typeof e === "string") {
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
    const metaData = await this.getScriptRoot().modifyMetaData((md) => {
      const downstairsPath = this.uri().fsPath;
      const existingEntryIndex = md.pushPullRecords.findIndex((entry) => entry.downstairsPath === downstairsPath);
      if (existingEntryIndex !== -1) {
        md.pushPullRecords[existingEntryIndex].lastVerifiedHash = lastHash;
      } else {
        md.pushPullRecords.push({
          downstairsPath,
          lastVerifiedHash: lastHash,
        });
      }
    });
    this.ctx.isDebugMode() && console.log("Updated metadata:", metaData);
  }

  private async requireExists(): Promise<void> {
    if (!(await this.exists())) {
      throw new Err.FileNotFoundError(this.uri().fsPath);
    }
  }
}
