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
    const etag = this.hashFromEtag(response.headers.get(Http.Headers.ETAG));
    if (!etag) {
      if (ops?.required) {
        throw new Err.HashCalculationError();
      }
      return null;
    }
    return etag;
  }

  /**
   * The SHA-512 content hash an ETag header carries, strong (`"<sha512>"`) or weak
   * (`W/"<sha512>"`), lowercased. Numeric and other ETags carry no content hash.
   * @param etagHeader The raw `ETag` header, if any
   * @returns The hex hash, or `null` when the header has none
   * @lastreviewed null
   */
  private hashFromEtag(etagHeader: string | null): string | null {
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
    return etag ? etag.toLowerCase() : null;
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

  /**
   * Whether an upload would overwrite a platform-side version nobody here has seen, which is what
   * the overwrite prompt guards. A file is at risk only when all of these hold:
   *  - it isn't a snapshot or build-folder file (compiled output is always rewritten);
   *  - the platform has a `draft/` copy (its `HEAD` isn't 404);
   *  - that copy differs from the local bytes (writing the same bytes loses nothing);
   *  - it differs from the last sync record, or there is no record (never pulled or pushed here).
   *
   * A copy served without a content hash can't be compared, so it counts as at risk. A missing
   * sync record used to count as a platform change on its own, so every new file asked. Once the
   * prompt's default became "Cancel", that would have stopped every auto-confirmed push (the CLI's
   * `--yes`) that adds a file.
   * @param upstairsOverride The file's `draft/` URL, when it differs from {@link upstairsUrl}
   * @returns `"changed"` when the platform copy moved since the last sync here, `"unsynced"` when
   *   the platform has a different copy and this machine never synced it, or `null` when nothing
   *   is at risk
   * @lastreviewed null
   */
  public async platformChangeAtRisk(upstairsOverride?: URL): Promise<"changed" | "unsynced" | null> {
    if (this.isInSnapshot() || (await this.isInItsRespectiveBuildFolder())) {
      return null;
    }
    const response = await this.ctx.sessionManager.fetch(upstairsOverride ?? (await this.upstairsUrl()), {
      method: Http.Methods.HEAD,
    });
    if (response.status === ResponseCodes.NOT_FOUND) {
      return null;
    }
    const upstairsHash = this.hashFromEtag(response.headers.get(Http.Headers.ETAG));
    const lastHash = await this.getLastVerifiedHash();
    if (upstairsHash !== null && (upstairsHash === (await this.getHash()) || upstairsHash === lastHash)) {
      return null;
    }
    return lastHash ? "changed" : "unsynced";
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

  public async getReasonToNotPush(ops?: { upstairsOverride?: URL; isSnapshot?: boolean }): Promise<string | null> {
    // The answer is cached for the life of this instance and ignores later `ops`. That is safe
    // because executePush() builds one ScriptFile per file per push, so a draft-only answer from a
    // plain push can never be served to a snapshot push, which also needs the snapshot/ check.
    if (this._reasonToNotPush !== undefined) {
      return this._reasonToNotPush;
    }
    return await this.setReasonToNotPush(ops);
  }

  private async setReasonToNotPush(ops?: { upstairsOverride?: URL; isSnapshot?: boolean }): Promise<string | null> {
    if (this.parser.type === "root") {
      this._reasonToNotPush = "Node is the root folder";
    } else if (this.isInDeclarations()) {
      this._reasonToNotPush = "Node is in declarations";
    } else if (this.isInGitFolder()) {
      this._reasonToNotPush = "Node is in .git folder";
    } else if (await this.isInGitIgnore()) {
      this._reasonToNotPush = "Node is ignored by .gitignore";
    } else if ((await this.isFile()) && (await this.platformCopiesMatch(ops))) {
      this._reasonToNotPush = "File integrity matches";
    } else if (!this._reasonToNotPush) {
      this._reasonToNotPush = null;
    }
    return this._reasonToNotPush;
  }

  /**
   * Whether the platform already holds this file's local bytes, so a push may skip it. A plain push
   * checks the `draft/` copy. A snapshot push also checks the `snapshot/` copy the runtime serves,
   * with one extra `HEAD` made only when `draft/` already matches.
   *
   * Checking `draft/` alone left a snapshot stuck: after a failed `snapshot/` write, `draft/` holds
   * the new bytes, so every later snapshot push skipped the file and the old version stayed live
   * (ClickUp 86bbqnrtp). An indeterminate `snapshot/` hash (a copy that doesn't exist yet answers
   * with no ETag) counts as not matching, so the file is uploaded.
   * @param ops.upstairsOverride The file's `draft/` URL, when it differs from {@link upstairsUrl}
   * @param ops.isSnapshot Whether the push also publishes to `snapshot/`
   * @returns `true` only when every copy the push would write already matches local
   * @lastreviewed null
   */
  private async platformCopiesMatch(ops?: { upstairsOverride?: URL; isSnapshot?: boolean }): Promise<boolean> {
    const draftUrl = ops?.upstairsOverride ?? (await this.upstairsUrl());
    if (!(await this.currentIntegrityMatches({ upstairsOverride: draftUrl }))) {
      return false;
    }
    if (!ops?.isSnapshot) {
      return true;
    }
    return await this.currentIntegrityMatches({ upstairsOverride: ScriptFile.snapshotUrl(draftUrl) });
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

  /**
   * The `snapshot/` twin of a `draft/` WebDAV URL: where a snapshot push writes the same bytes, and
   * what the platform runtime reads. Swaps the first `draft` in the pathname for `snapshot`, the
   * same rule `upload()` has always used. The host (a deploy target override included) and the
   * input URL are left untouched.
   * @param draftUrl The file's `draft/` URL
   * @returns A new URL for the file's `snapshot/` copy
   * @lastreviewed null
   */
  public static snapshotUrl(draftUrl: URL): URL {
    const snapshotUrl = new URL(draftUrl);
    snapshotUrl.pathname = snapshotUrl.pathname.replace(new RegExp(FolderNames.DRAFT), FolderNames.SNAPSHOT);
    return snapshotUrl;
  }

  /**
   * Pushes this file to its `draft/` copy and, on a snapshot push, to its `snapshot/` copy too,
   * unless {@link getReasonToNotPush} says to skip it. Asks before overwriting a `draft/` copy that
   * changed on the platform since the last push or pull.
   * @param arg.upstairsUrlOverrideString A URL whose host replaces the file's own (deploy targets)
   * @param arg.isSnapshot Whether to publish to `snapshot/` as well
   * @returns `undefined` when the file was skipped; otherwise the response of the last write. A
   *   resolved `Response` means every copy the push targets was written and accepted: any refused
   *   write throws. `executePush` reads it to pick the files the read-back verifies.
   * @throws an {@link Err.FileSendError} when the platform refuses either write
   * @throws an {@link Err.UserCancelledError} when the user declines the overwrite
   * @lastreviewed null
   */
  async upload(arg?: { upstairsUrlOverrideString?: string; isSnapshot?: boolean }): Promise<Response | void> {
    if (await this.isFolder()) {
      throw new Err.ScriptOperationError("somehow a folder got created to upload with this method. ");
    }
    this.ctx.logger.info("Preparing to send file:", this.uri().fsPath);
    this.ctx.logger.info("To target formula URI:", arg?.upstairsUrlOverrideString);
    const upstairsOverride = new URL(arg?.upstairsUrlOverrideString || (await this.upstairsUrl()).toString());
    const thisUpstairs = await this.upstairsUrl();
    upstairsOverride.pathname = thisUpstairs.pathname;
    const risk = await this.platformChangeAtRisk(upstairsOverride);
    if (risk) {
      // "Cancel" is FIRST: an empty answer and the CLI's --yes both take options[0], and this
      // prompt authorizes overwriting someone's edit on the platform (ClickUp 86bc2h3ef).
      const CANCEL = "Cancel";
      const OVERWRITE = "Overwrite";
      const relative = this.pathWithRespectToDraftRoot().split(path.sep).join("/");
      const why =
        risk === "changed"
          ? `${relative} changed on the platform since the last push or pull from here.`
          : `The platform has a different ${relative}, and this machine has never pulled or pushed it.`;
      const answer = await this.ctx.prompt.confirm(
        `${why} Overwrite the platform copy (${upstairsOverride}) with your local file?`,
        [CANCEL, OVERWRITE],
        { destructive: true, safeOption: CANCEL }
      );
      if (answer !== OVERWRITE) {
        const kind = arg?.isSnapshot ? "Snapshot push" : "Push";
        await this.ctx.prompt.popup(`${kind} cancelled: ${relative} was not overwritten.`);
        // The message is all a non-interactive caller sees, so it says what was kept and why.
        // How to confirm an overwrite depends on the consumer (a flag, a button), so it is left to
        // the consumer, which gets the files in `paths`.
        throw new Err.OverwriteDeclinedError(
          `${kind} stopped: ${relative} was not overwritten. ${why} Pull or audit it to see the ` +
            `platform version before overwriting it.`,
          [relative]
        );
      }
    }
    const reason = await this.getReasonToNotPush({ upstairsOverride, isSnapshot: arg?.isSnapshot });

    if (reason) {
      this.ctx.logger.info(`${reason}; not pushing file:`, this.uri().fsPath);
      return;
    }
    this.ctx.logger.info("Destination:", upstairsOverride.toString());
    if (arg?.isSnapshot && this.parser.type !== FolderNames.DRAFT) {
      throw new Err.ScriptOperationError(
        "This should never happen, this is here as a safetycheck and should be removed when we're confident."
      );
    }

    const draftResp = await this.putTo(upstairsOverride);
    // The sync record describes the draft/ copy (platformChangeAtRisk compares it with the draft/
    // ETag), so it is written as soon as that copy lands. Writing it only after the snapshot/ PUT
    // would make a failed snapshot write look like a platform-side edit on the next push.
    await this.touch();
    if (!arg?.isSnapshot) {
      this.ctx.logger.info("File sent successfully:", this.uri().fsPath);
      return draftResp;
    }
    // A failed snapshot/ write leaves the previous version live, so it fails the push exactly like
    // a failed draft/ write. It used to be ignored and reported as success (ClickUp 86bbqnrtp).
    const snapshotResp = await this.putTo(ScriptFile.snapshotUrl(upstairsOverride));
    this.ctx.logger.info("File sent successfully:", this.uri().fsPath);
    return snapshotResp;
  }

  /**
   * PUTs the local bytes to one WebDAV location, with no prompt, skip check or sync record. It is
   * the single write both copies of an upload go through, and what the post-publish read-back uses
   * to re-send a `snapshot/` copy that came back wrong.
   * @param target The WebDAV URL to write, e.g. a `draft/` URL or its {@link snapshotUrl}
   * @returns The platform's response, always ok
   * @throws an {@link Err.FileSendError} naming the URL and status when the platform refuses the write
   * @lastreviewed null
   */
  public async putTo(target: URL): Promise<Response> {
    const fileContents = await this.ctx.fs.readFile(B6PUri.fromFsPath(this.uri().fsPath));
    const resp = await this.ctx.sessionManager.fetch(target, {
      method: Http.Methods.PUT,
      headers: {
        [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON,
      },
      body: fileContents,
    });
    if (!resp.ok) {
      throw new Err.FileSendError(await getDetails(resp, target));
    }
    return resp;
    async function getDetails(resp: Response, target: URL) {
      return `
  ========
  ========
  url: ${target}
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
