import * as path from "path";
import { B6PUri } from "../B6PUri";
import { DownstairsPathParser } from "../data/DownstairsPathParser";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { executePush } from "./push";
import type { ScriptContext } from "./ScriptContext";
import { ScriptFactory } from "./ScriptFactory";

/**
 * Result returned by {@link ScriptService.audit}.
 * @lastreviewed null
 */
export interface AuditResult {
  changedFiles: string[];
  baseUrl: string;
}

/**
 * Shape of the JSON config file consumed by {@link ScriptService.deploy}.
 * @lastreviewed null
 */
export interface DeployConfig {
  /** Local path to the script root whose `draft/` folder is pushed. */
  sourceRootPath: string;
  /** One entry per destination formula URL. */
  targets: Array<{
    url: string;
    snapshot?: boolean;
  }>;
}

/**
 * Every script-management operation: moving a script tree between the local
 * filesystem and the BlueStep platform over WebDAV, and reasoning about the
 * difference between the two.
 *
 * Reached as `B6PCore.script`. It is one subsystem of the SDK, not the whole of
 * it — anything that is not about the script tree belongs beside it in its own
 * service, rather than being added here.
 *
 * Everything it needs arrives through the constructor as a {@link ScriptContext}.
 * It holds no reference to the orchestrator that built it, and this file must not
 * import `B6PCore` — not even `import type` for a JSDoc `{@link}`, which is what
 * previously created a source-level cycle here. Refer to it in plain backticks.
 * @lastreviewed null
 */
export class ScriptService {
  private factory: ScriptFactory | null = null;

  constructor(private readonly ctx: ScriptContext) {}

  /**
   * The lazily-created {@link ScriptFactory} bound to this service's context.
   *
   * Script-tree classes should not reach for this — a {@link ScriptRoot} mints its
   * own factory from the context it already holds. It is here for callers that
   * start from a bare path and need to enter the tree.
   * @lastreviewed null
   */
  getFactory(): ScriptFactory {
    return (this.factory ??= new ScriptFactory(this.ctx));
  }

  /**
   * Create a {@link ScriptUrlParser} wired to this service's session and logger.
   * @lastreviewed null
   */
  private createParser(url: string): ScriptUrlParser {
    return new ScriptUrlParser(url, this.ctx.sessionManager, this.ctx.logger, this.ctx.prompt);
  }

  /**
   * Derive the base WebDAV URL from a local file path by parsing the
   * downstairs path structure and looking up stored metadata.
   * @lastreviewed null
   */
  private async deriveBaseUrl(filePath: string): Promise<string | null> {
    try {
      const sf = this.getFactory().createFile(B6PUri.fromFsPath(filePath));
      return sf.getScriptRoot().getBaseWebDavUrlString();
    } catch {
      this.ctx.logger.warn(`Could not parse downstairs path: ${filePath}`);
      return null;
    }
  }

  /**
   * Derive the workspace folder (parent of the org folder) from a file path
   * inside a script root. Returns null if the path can't be parsed.
   * @lastreviewed null
   */
  deriveWorkspacePath(filePath: string): string | null {
    try {
      const sf = this.getFactory().createFile(B6PUri.fromFsPath(filePath));
      return sf.getScriptRoot().getOrgUri().dirname.fsPath;
    } catch {
      return null;
    }
  }

  // ── Push / Pull ───────────────────────────────────────────────────

  async push(opts: { targetUrl?: string; rootPath: string; snapshot?: boolean; message?: string }): Promise<void> {
    const targetUrl = opts.targetUrl ?? (await this.ctx.prompt.inputBox({ prompt: "Paste in the target formula URI" }));
    if (targetUrl === undefined) {
      this.ctx.prompt.error("No target formula URI provided");
      return;
    }
    this.ctx.logger.info(`Pushing script from ${opts.rootPath} to ${targetUrl}${opts.snapshot ? " (snapshot)" : ""}`);
    await executePush({
      ctx: this.ctx,
      targetUrl,
      rootPath: opts.rootPath,
      snapshot: opts.snapshot ?? false,
      message: opts.message,
    });
  }

  async pushCurrent(opts: { filePath: string; snapshot?: boolean; message?: string }): Promise<void> {
    this.ctx.logger.info(`Push current for file: ${opts.filePath}`);
    const baseUrl = await this.deriveBaseUrl(opts.filePath);
    if (!baseUrl) {
      const url = await this.ctx.prompt.inputBox({
        prompt: "Could not determine script URL. Paste the target formula URI:",
      });
      if (!url) {
        return;
      }
      // Derive rootPath from the file's path structure
      const parser = new DownstairsPathParser(opts.filePath);
      await this.push({
        targetUrl: url,
        rootPath: parser.getShavedName(),
        snapshot: opts.snapshot,
        message: opts.message,
      });
      return;
    }
    const parser = new DownstairsPathParser(opts.filePath);
    await this.push({
      targetUrl: baseUrl,
      rootPath: parser.getShavedName(),
      snapshot: opts.snapshot,
      message: opts.message,
    });
  }

  async pull(opts: { formulaUrl?: string; workspacePath: string }): Promise<void> {
    const formulaUrl =
      opts.formulaUrl ?? (await this.ctx.prompt.inputBox({ prompt: "Paste in the desired formula URL" }));
    if (formulaUrl === undefined) {
      this.ctx.prompt.error("No formula URL provided");
      return;
    }
    this.ctx.logger.info(`Pulling script from ${formulaUrl} into ${opts.workspacePath}`);

    const parser = this.createParser(formulaUrl);
    const fetchedScriptObject = await parser.getScript();
    if (!fetchedScriptObject) {
      this.ctx.logger.warn("fetchedScriptObject is null");
      return;
    }

    const U = await parser.getU();
    const scriptName = await parser.getScriptName();
    this.ctx.logger.info(`Resolved script name: "${scriptName}" (webdavId: ${parser.webDavId})`);

    // Guard against a known bug where getScriptName() returns the name of a
    // recently-pulled script instead of the correct one (observed when two
    // merge reports share a common name prefix, e.g. "Test_Green" and
    // "Test_bp6_CLI"). If the resolved name is already linked to a *different*
    // webdavId in local metadata, aborting here prevents overwriting the wrong
    // directory and corrupting both scripts.
    await this.ctx.scriptMetadataStore.whenReady();
    const conflictingEntry = this.ctx.scriptMetadataStore.findByScriptName(U, scriptName);
    if (conflictingEntry && conflictingEntry.webdavId !== parser.webDavId) {
      this.ctx.prompt.error(
        `Pull aborted: the server returned script name "${scriptName}" for webdavId ${parser.webDavId}, ` +
          `but that name is already linked locally to webdavId ${conflictingEntry.webdavId}. ` +
          `Proceeding would overwrite the wrong directory. ` +
          `Please report this issue — try pulling again or clearing your local metadata.`
      );
      return;
    }

    const factory = this.getFactory();

    const pullTasks = fetchedScriptObject.map((entry) => ({
      execute: async () => {
        const ultimatePath = path.join(opts.workspacePath, U, entry.downstairsPath);
        const isDirectory = ultimatePath.endsWith("/") || entry.downstairsPath.endsWith("/");

        if (isDirectory) {
          const uri = B6PUri.fromFsPath(ultimatePath);
          if (!(await this.ctx.fs.exists(uri))) {
            await this.ctx.fs.createDirectory(uri);
          }
        } else {
          // Use ScriptFile.download() so that we get gitignore filtering, ETag-based
          // integrity verification, and `lastPulled` metadata tracking — all the
          // behaviour the previous inline fetch+writeFile loop was missing.
          const fileUri = B6PUri.fromFsPath(ultimatePath);
          const scriptRoot = factory.createScriptRoot(fileUri);
          scriptRoot.withParser(parser);
          const file = factory.createFile(fileUri, scriptRoot);
          // Make sure the parent directory exists before download writes the file.
          const parentUri = fileUri.dirname;
          if (!(await this.ctx.fs.exists(parentUri))) {
            await this.ctx.fs.createDirectory(parentUri);
          }
          await file.download(parser);
        }
        return ultimatePath;
      },
      description: "scripts",
    }));

    // Coalesce the per-script metadata writes into a single atomic write at the
    // end of the pull. Each task's upsert would otherwise rewrite state.json in
    // a rapid burst, which trips AV / ransomware heuristics on Windows (see the
    // retry logic in SharedFilePersistence). On a failed pull the finally still
    // makes a best-effort flush of what was pulled so far; if that flush also
    // fails it is logged (not thrown) so the pull's own error is what surfaces.
    await this.ctx.scriptMetadataStore.beginBatch();
    let pullSucceeded = false;
    try {
      await this.ctx.progress.withProgress(pullTasks, {
        title: "Pulling Script...",
        cleanupMessage: "Cleaning up the downstairs folder...",
      });
      pullSucceeded = true;
    } finally {
      try {
        await this.ctx.scriptMetadataStore.flush();
      } catch (flushError) {
        // If the pull itself failed, that error is the useful one — keep it and
        // don't let a failed metadata flush mask it. Only surface the flush
        // error when the pull otherwise succeeded.
        if (pullSucceeded) {
          throw flushError;
        }
        this.ctx.logger.error(`Failed to flush script metadata after a failed pull: ${String(flushError)}`);
      }
    }

    this.ctx.prompt.info("Pull complete!");
  }

  async pullCurrent(opts: { filePath: string; workspacePath: string }): Promise<void> {
    const baseUrl = await this.deriveBaseUrl(opts.filePath);
    if (!baseUrl) {
      const url = await this.ctx.prompt.inputBox({ prompt: "Could not determine script URL. Paste the formula URL:" });
      if (!url) {
        return;
      }
      await this.pull({ formulaUrl: url, workspacePath: opts.workspacePath });
      return;
    }
    await this.pull({ formulaUrl: baseUrl, workspacePath: opts.workspacePath });
  }

  // ── Audit ─────────────────────────────────────────────────────────

  async audit(opts: { filePath: string; workspacePath: string }): Promise<AuditResult | null> {
    this.ctx.logger.info(`Auditing file: ${opts.filePath}`);

    const baseUrl = await this.deriveBaseUrl(opts.filePath);
    if (!baseUrl) {
      const url = await this.ctx.prompt.inputBox({ prompt: "Could not determine script URL. Paste the formula URL:" });
      if (!url) {
        return null;
      }
      return this.auditWithUrl(url, opts.workspacePath);
    }
    return this.auditWithUrl(baseUrl, opts.workspacePath);
  }

  private async auditWithUrl(baseUrl: string, workspacePath: string): Promise<AuditResult | null> {
    const parser = this.createParser(baseUrl);
    const fetchedScriptObject = await parser.getScript();
    if (!fetchedScriptObject) {
      this.ctx.logger.warn("fetchedScriptObject is null during audit");
      return null;
    }

    const U = await parser.getU();
    const changedFiles: string[] = [];
    const factory = this.getFactory();

    for (const entry of fetchedScriptObject) {
      const ultimatePath = path.join(workspacePath, U, entry.downstairsPath);
      if (ultimatePath.endsWith("/") || entry.downstairsPath.endsWith("/")) {
        continue; // skip directories
      }
      const fileUri = B6PUri.fromFsPath(ultimatePath);
      if (!(await this.ctx.fs.exists(fileUri))) {
        changedFiles.push(entry.downstairsPath + " (new)");
        continue;
      }
      // Use ScriptFile.currentIntegrityStatus() so that we get the same robust ETag handling
      // (standard / weak / numeric / complex) used by download(). Files served with numeric or
      // complex ETags (declaration/library files) expose no content hash, so their status is
      // "indeterminate" — we cannot assert a difference and must not report them as changed,
      // exactly as download() skips their integrity verification. Only a genuine "mismatch",
      // where both hashes are known and differ, counts as a changed file.
      const scriptRoot = factory.createScriptRoot(fileUri);
      scriptRoot.withParser(parser);
      const file = factory.createFile(fileUri, scriptRoot);
      const upstairsOverride = new URL(entry.upstairsPath);
      const status = await file.currentIntegrityStatus({ upstairsOverride });
      if (status === "mismatch") {
        changedFiles.push(entry.downstairsPath);
      } else if (status === "indeterminate") {
        this.ctx.logger.debug(`Skipping ${entry.downstairsPath}: server exposes no content hash to compare against`);
      }
    }

    if (changedFiles.length === 0) {
      this.ctx.prompt.info("No differences detected. Local script is in sync with the server.");
    } else {
      this.ctx.prompt.info(`Detected ${changedFiles.length} file(s) with differences:\n\n${changedFiles.join("\n")}`);
    }

    return { changedFiles, baseUrl };
  }

  async auditPull(opts: { filePath: string; workspacePath: string }): Promise<void> {
    const result = await this.audit(opts);
    if (!result || result.changedFiles.length === 0) {
      return;
    }

    const YES = "Sync";
    const NO = "Cancel";
    const response = await this.ctx.prompt.confirm(
      `Detected ${result.changedFiles.length} file(s) with differences:\n\n${result.changedFiles.join("\n")}\n\nSync local copy with the server?`,
      [YES, NO]
    );

    if (response !== YES) {
      this.ctx.logger.info("User declined audit-pull sync");
      return;
    }

    await this.pull({ formulaUrl: result.baseUrl, workspacePath: opts.workspacePath });
  }

  // ── Deploy ────────────────────────────────────────────────────────

  async deploy(opts: { configPath: string }): Promise<void> {
    this.ctx.logger.info(`Quick deploy from config: ${opts.configPath}`);

    // Read config file
    const configUri = B6PUri.fromFsPath(opts.configPath);
    if (!(await this.ctx.fs.exists(configUri))) {
      this.ctx.prompt.error(`Config file not found: ${opts.configPath}`);
      return;
    }

    const configContent = await this.ctx.fs.readFile(configUri);
    const configText = Buffer.from(configContent).toString("utf-8");

    let config: DeployConfig;
    try {
      config = JSON.parse(configText) as DeployConfig;
    } catch (error) {
      this.ctx.prompt.error(`Failed to parse config file: ${error instanceof Error ? error.message : error}`);
      return;
    }

    if (!config.sourceRootPath || !config.targets || config.targets.length === 0) {
      this.ctx.prompt.error("Invalid config file. Required fields: sourceRootPath, targets[]");
      return;
    }

    this.ctx.logger.info(`Deploying to ${config.targets.length} target(s)`);

    for (const target of config.targets) {
      this.ctx.logger.info(`Deploying to: ${target.url}`);
      try {
        await this.push({
          targetUrl: target.url,
          rootPath: config.sourceRootPath,
          snapshot: target.snapshot ?? false,
        });
      } catch (error) {
        this.ctx.logger.error(`Failed to deploy to ${target.url}: ${error instanceof Error ? error.message : error}`);
      }
    }

    this.ctx.prompt.info("Deploy complete!");
  }

  // ── Setup URL ─────────────────────────────────────────────────────

  /**
   * Builds the web-UI setup URL for a locally-pulled script, resolving its
   * stored metadata (org, classid, seqnum) from the {@link ScriptMetaDataStore}
   * the same way `audit` and `push` do.
   * @param opts.filePath Absolute path to any file inside the pulled script root.
   * @returns The setup URL, or `null` if no metadata is stored for the script
   *   (not yet pulled) or its script type has no known setup page.
   * @lastreviewed null
   */
  async getSetupUrl(opts: { filePath: string }): Promise<string | null> {
    try {
      // Resolve stored metadata via the same script-root mechanism that `audit`
      // and `push` use, rather than a raw `scriptMeta.<name>` persistence key
      // that `pull` never writes. The metadata store is keyed by U + scriptName;
      // the ScriptRoot derives both from the file path.
      const root = this.getFactory().createFile(B6PUri.fromFsPath(opts.filePath)).getScriptRoot();
      const meta = await root.getMetaData();

      if (!meta) {
        const scriptName = new DownstairsPathParser(opts.filePath).scriptName;
        this.ctx.prompt.error(`No stored metadata found for script "${scriptName}". Pull the script first.`);
        return null;
      }

      // The ScriptKey (classid + seqnum) knows its own setup page and can build
      // the setup URL against the org's origin.
      const scriptKey = await root.getScriptKey();
      if (!scriptKey.setupPage) {
        this.ctx.prompt.error(`Unknown script type (classid: ${scriptKey.classid}). Cannot generate setup URL.`);
        return null;
      }

      const origin = await root.anyOrigin();
      return scriptKey.buildSetupUrl(origin);
    } catch (error) {
      this.ctx.logger.error(`Error generating setup URL: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }
}
