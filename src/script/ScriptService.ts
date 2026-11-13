import * as path from "path";
import { B6PUri } from "../B6PUri";
import { DownstairsPathParser } from "../data/DownstairsPathParser";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import type { GitIdentity } from "@bluestep-systems/b6p-core-bsjs-git";
import { FolderNames } from "../constants";
import type { PublishRefusal } from "./GitSync";
import { auditDraft, draftFolderOf, GitSwitchDeclinedError, pullDraft, type DraftTarget } from "./GitSync";
import { executePush, legacySyncRecords, type PushResult } from "./push";
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
 * Outcome of a pull, for callers that need more signal than the human-facing
 * messages — the pull-side counterpart of `PushResult`. A machine consumer
 * (CLI `--json`, the VS Code LM tool) that only sees "the promise resolved"
 * would otherwise report unqualified success for a pull that deliberately
 * left locally-edited files unsynced.
 * @lastreviewed null
 */
export interface PullResult {
  /**
   * Local file paths the divergence guard kept instead of overwriting —
   * files whose content differed from both the platform copy and the recorded
   * last-synced hash. Empty when everything synced.
   * @lastreviewed null
   */
  keptLocalPaths: string[];
  /**
   * True when this pull switched the script from WebDAV to git publishing, which cannot be undone: its draft and
   * snapshot no longer accept WebDAV writes.
   * @lastreviewed null
   */
  switchedToGit: boolean;
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
  /**
   * Who the deploy's commits are by; default: the git config of the source draft folder, then the environment.
   * @lastreviewed null
   */
  author?: GitIdentity;
  /**
   * The commit message of each target's commit.
   * @lastreviewed null
   */
  message?: string;
  /**
   * The caller already confirmed switching WebDAV targets to git (one-way), so do not ask.
   * @lastreviewed null
   */
  enableGit?: boolean;
  /**
   * The targets are built by a bundler outside this tool: no build manifest is written for them.
   * @lastreviewed null
   */
  externallyBuilt?: boolean;
}

/**
 * What {@link ScriptService.deploy} did for one target. `error` carries the typed error (for example a
 * `GitIdentityError`) when the target failed before or during the push; the other fields are then empty.
 * @lastreviewed null
 */
export interface DeployTargetResult {
  target: string;
  pushed: boolean;
  commitSha: string | null;
  publishedSha: string | null;
  publishError: string | null;
  /**
   * The platform's structured refusal of the publish, when it refused.
   * @lastreviewed null
   */
  publishRefusal: PublishRefusal | null;
  switchedToGit: boolean;
  error?: unknown;
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

  /**
   * Pushes the script at `rootPath` to its target (asked for when `targetUrl` is missing).
   * @param opts.overwrite Draft-relative paths whose overwrite the caller confirms up front, so
   *   the push doesn't ask about them; see {@link executePush}
   * @returns The push's outcome, or `null` when no target was given
   * @throws an {@link Err.OverwriteDeclinedError} when an overwrite is not confirmed
   * @lastreviewed null
   */
  async push(opts: {
    targetUrl?: string;
    rootPath: string;
    snapshot?: boolean;
    message?: string;
    overwrite?: string[];
    author?: GitIdentity;
    adoptUnbound?: boolean;
    enableGit?: boolean;
    externallyBuilt?: boolean;
  }): Promise<PushResult | null> {
    const targetUrl = opts.targetUrl ?? (await this.ctx.prompt.inputBox({ prompt: "Paste in the target formula URI" }));
    if (targetUrl === undefined) {
      this.ctx.prompt.error("No target formula URI provided");
      return null;
    }
    this.ctx.logger.info(`Pushing script from ${opts.rootPath} to ${targetUrl}${opts.snapshot ? " (snapshot)" : ""}`);
    return await executePush({
      ctx: this.ctx,
      targetUrl,
      rootPath: opts.rootPath,
      snapshot: opts.snapshot ?? false,
      message: opts.message,
      overwrite: opts.overwrite,
      author: opts.author,
      adoptUnbound: opts.adoptUnbound,
      enableGit: opts.enableGit,
      externallyBuilt: opts.externallyBuilt,
    });
  }

  async pushCurrent(opts: {
    filePath: string;
    snapshot?: boolean;
    message?: string;
    overwrite?: string[];
    author?: GitIdentity;
    enableGit?: boolean;
    externallyBuilt?: boolean;
  }): Promise<PushResult | null> {
    this.ctx.logger.info(`Push current for file: ${opts.filePath}`);
    const baseUrl = await this.deriveBaseUrl(opts.filePath);
    if (!baseUrl) {
      const url = await this.ctx.prompt.inputBox({
        prompt: "Could not determine script URL. Paste the target formula URI:",
      });
      if (!url) {
        return null;
      }
      // Derive rootPath from the file's path structure
      const parser = new DownstairsPathParser(opts.filePath);
      return await this.push({
        targetUrl: url,
        rootPath: parser.getShavedName(),
        snapshot: opts.snapshot,
        message: opts.message,
        overwrite: opts.overwrite,
        author: opts.author,
        enableGit: opts.enableGit,
        externallyBuilt: opts.externallyBuilt,
      });
    }
    const parser = new DownstairsPathParser(opts.filePath);
    return await this.push({
      targetUrl: baseUrl,
      rootPath: parser.getShavedName(),
      snapshot: opts.snapshot,
      message: opts.message,
      overwrite: opts.overwrite,
      author: opts.author,
      enableGit: opts.enableGit,
      externallyBuilt: opts.externallyBuilt,
    });
  }

  /**
   * Pull a script from the platform into the workspace.
   *
   * The draft is the script's git draft branch: a first pull clones it into `<U>/<script>/draft` (a script still
   * publishing over WebDAV is switched to git first, which cannot be undone, after a confirmation), a later one
   * fetches and fast-forwards it. The generated `declarations/` folder is still read over WebDAV.
   *
   * @param opts.overwriteLocalPaths `downstairsPath` entries (as returned by {@link audit}) for which the platform
   *   copy may overwrite even a locally-edited file. Scoped per file — never the whole tree — so a confirmation shown
   *   to the user covers exactly the files that can be force-overwritten and nothing more.
   * @param opts.enableGit The caller already confirmed switching a WebDAV script to git; don't ask.
   * @returns The kept-files outcome, or `null` when the pull aborted before
   *   fetching (no URL, unreadable listing, the wrong-directory guard, or a declined switch to git).
   * @lastreviewed null
   */
  async pull(opts: {
    formulaUrl?: string;
    workspacePath: string;
    overwriteLocalPaths?: string[];
    enableGit?: boolean;
  }): Promise<PullResult | null> {
    const formulaUrl =
      opts.formulaUrl ?? (await this.ctx.prompt.inputBox({ prompt: "Paste in the desired formula URL" }));
    if (formulaUrl === undefined) {
      this.ctx.prompt.error("No formula URL provided");
      return null;
    }
    this.ctx.logger.info(`Pulling script from ${formulaUrl} into ${opts.workspacePath}`);

    const parser = this.createParser(formulaUrl);
    const fetchedScriptObject = await parser.getScript();
    if (!fetchedScriptObject) {
      this.ctx.logger.warn("fetchedScriptObject is null");
      return null;
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
      return null;
    }

    const factory = this.getFactory();
    const rootPath = path.join(opts.workspacePath, U, scriptName);
    const draftPath = draftFolderOf(rootPath);
    const draftPrefix = `${scriptName}/${FolderNames.DRAFT}/`;
    const draftOverwrite = (opts.overwriteLocalPaths ?? [])
      .filter((p) => p.startsWith(draftPrefix))
      .map((p) => p.slice(draftPrefix.length));
    // Locally-edited files the divergence guard kept instead of overwriting;
    // reported as one summary after the loop rather than one warning per file.
    const keptLocalPaths: string[] = [];
    let switchedToGit = false;

    // The script's metadata (what `push`, `audit` and `getSetupUrl` resolve a script by) is written here, since the git
    // pull no longer touches it file by file.
    const scriptRoot = factory.createScriptRoot(B6PUri.fromFsPath(rootPath).asDirectory());
    scriptRoot.withParser(parser);
    const target: DraftTarget = {
      ctx: this.ctx,
      script: await parser.getScriptBaseKey(),
      baseUrl: `${parser.url.origin}/`,
      draftPath,
    };
    try {
      const drafted = await pullDraft(target, {
        enableGit: opts.enableGit,
        overwrite: draftOverwrite,
        lastSynced: await legacySyncRecords(scriptRoot, draftPath),
      });
      keptLocalPaths.push(...drafted.keptLocalPaths);
      switchedToGit = drafted.switchedToGit;
    } catch (error) {
      if (error instanceof GitSwitchDeclinedError) {
        this.ctx.prompt.error(`Pull aborted: ${error.message}.`);
        return null;
      }
      throw error;
    }
    if (switchedToGit) {
      this.ctx.prompt.warn(
        "This script now publishes through git. The switch cannot be undone: its draft and snapshot no longer " +
          "accept WebDAV writes, and its history is the git history from here on."
      );
    }

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
          const fileRoot = factory.createScriptRoot(fileUri);
          fileRoot.withParser(parser);
          const file = factory.createFile(fileUri, fileRoot);
          // Make sure the parent directory exists before download writes the file.
          const parentUri = fileUri.dirname;
          if (!(await this.ctx.fs.exists(parentUri))) {
            await this.ctx.fs.createDirectory(parentUri);
          }
          await file.download(parser, {
            overwriteLocal: opts.overwriteLocalPaths?.includes(entry.downstairsPath) ?? false,
            onLocalKept: (fsPath) => keptLocalPaths.push(fsPath),
          });
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
      await scriptRoot.modifyMetaData();
      await this.ctx.progress.withProgress(pullTasks, {
        title: "Pulling Script...",
        cleanupMessage: "Cleaning up the downstairs folder...",
      });
      pullSucceeded = true;
    } finally {
      // The kept-files report is emitted here — not after the try/finally — so
      // it survives a pull that throws mid-loop. onLocalKept suppressed the
      // per-file warnings on the promise that this aggregate would be shown;
      // parking it after the block would break that promise on exactly the
      // runs where files were already overwritten before the error.
      if (keptLocalPaths.length > 0) {
        const shown = keptLocalPaths.slice(0, 10);
        const more = keptLocalPaths.length - shown.length;
        this.ctx.prompt.warn(
          `Kept ${keptLocalPaths.length} file(s) that differ from what was last synced ` +
            `(local edits, or a previously interrupted pull) — NOT synced:\n\n${shown.join("\n")}` +
            `${more > 0 ? `\n…and ${more} more` : ""}\n\n` +
            `Sync via an audit pull to take the platform versions, or delete a file and pull again.`
        );
      }
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
    return { keptLocalPaths, switchedToGit };
  }

  async pullCurrent(opts: {
    filePath: string;
    workspacePath: string;
    enableGit?: boolean;
  }): Promise<PullResult | null> {
    const baseUrl = await this.deriveBaseUrl(opts.filePath);
    if (!baseUrl) {
      const url = await this.ctx.prompt.inputBox({ prompt: "Could not determine script URL. Paste the formula URL:" });
      if (!url) {
        return null;
      }
      return await this.pull({ formulaUrl: url, workspacePath: opts.workspacePath, enableGit: opts.enableGit });
    }
    return await this.pull({ formulaUrl: baseUrl, workspacePath: opts.workspacePath, enableGit: opts.enableGit });
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
    const U = await parser.getU();
    const scriptName = await parser.getScriptName();
    const audit = await auditDraft({
      ctx: this.ctx,
      script: await parser.getScriptBaseKey(),
      baseUrl: `${parser.url.origin}/`,
      draftPath: draftFolderOf(path.join(workspacePath, U, scriptName)),
    });
    if (!audit) {
      this.ctx.prompt.error(
        `The draft of "${scriptName}" is not a git working copy yet, so there is nothing to compare it against. ` +
          `Pull the script first.`
      );
      return null;
    }

    const draftPrefix = `${scriptName}/${FolderNames.DRAFT}/`;
    const changedFiles = [
      ...audit.changed.map((p) => draftPrefix + p),
      ...audit.missingLocally.map((p) => `${draftPrefix}${p} (new)`),
    ];

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

    // "Cancel" is deliberately FIRST: prompt implementations answer with
    // options[0] on an empty answer and under non-interactive auto-confirm
    // (the CLI's --yes), and this prompt authorizes overwriting locally-edited
    // files. An auto-supplied answer is not a human decision, so the default
    // must be the safe branch; syncing requires typing "Sync" (or clicking it).
    // The ConfirmOptions say the same to implementations that read them.
    const SYNC = "Sync";
    const CANCEL = "Cancel";
    const response = await this.ctx.prompt.confirm(
      `Detected ${result.changedFiles.length} file(s) with differences:\n\n${result.changedFiles.join("\n")}\n\n` +
        `Sync local copy with the server? Locally-edited files in this list will be OVERWRITTEN ` +
        `with the platform copy.`,
      [CANCEL, SYNC],
      { destructive: true, safeOption: CANCEL }
    );

    if (response !== SYNC) {
      this.ctx.logger.info("User declined audit-pull sync");
      return;
    }

    // The user confirmed "Sync" over the explicit changed-file list, so the
    // platform copy wins over local edits — but only for the files that were
    // actually in that list. Scoping the overwrite to the confirmed set keeps
    // the confirmation honest: files audit could not compare (no server content
    // hash) were never disclosed, so they stay protected by the download-side
    // divergence guard. "(new)" entries have no local file to overwrite.
    const NEW_SUFFIX = " (new)";
    const confirmedPaths = result.changedFiles.filter((f) => !f.endsWith(NEW_SUFFIX));
    await this.pull({
      formulaUrl: result.baseUrl,
      workspacePath: opts.workspacePath,
      overwriteLocalPaths: confirmedPaths,
    });
  }

  // ── Deploy ────────────────────────────────────────────────────────

  async deploy(opts: { configPath: string }): Promise<DeployTargetResult[] | null> {
    this.ctx.logger.info(`Quick deploy from config: ${opts.configPath}`);

    // Read config file
    const configUri = B6PUri.fromFsPath(opts.configPath);
    if (!(await this.ctx.fs.exists(configUri))) {
      this.ctx.prompt.error(`Config file not found: ${opts.configPath}`);
      return null;
    }

    const configContent = await this.ctx.fs.readFile(configUri);
    const configText = Buffer.from(configContent).toString("utf-8");

    let config: DeployConfig;
    try {
      config = JSON.parse(configText) as DeployConfig;
    } catch (error) {
      this.ctx.prompt.error(`Failed to parse config file: ${error instanceof Error ? error.message : error}`);
      return null;
    }

    if (!config.sourceRootPath || !config.targets || config.targets.length === 0) {
      this.ctx.prompt.error("Invalid config file. Required fields: sourceRootPath, targets[]");
      return null;
    }

    this.ctx.logger.info(`Deploying to ${config.targets.length} target(s)`);

    const results: DeployTargetResult[] = [];
    for (const target of config.targets) {
      this.ctx.logger.info(`Deploying to: ${target.url}`);
      try {
        const pushed = await this.push({
          targetUrl: target.url,
          rootPath: config.sourceRootPath,
          snapshot: target.snapshot ?? false,
          message: config.message,
          author: config.author,
          adoptUnbound: false,
          enableGit: config.enableGit,
          externallyBuilt: config.externallyBuilt,
        });
        results.push({
          target: target.url,
          pushed: pushed?.pushed ?? false,
          commitSha: pushed?.commitSha ?? null,
          publishedSha: pushed?.publishedSha ?? null,
          publishError: pushed?.publishError ?? null,
          publishRefusal: pushed?.publishRefusal ?? null,
          switchedToGit: pushed?.switchedToGit ?? false,
        });
      } catch (error) {
        this.ctx.logger.error(`Failed to deploy to ${target.url}: ${error instanceof Error ? error.message : error}`);
        results.push({
          target: target.url,
          pushed: false,
          commitSha: null,
          publishedSha: null,
          publishError: null,
          publishRefusal: null,
          switchedToGit: (error as { switchedToGit?: boolean } | null)?.switchedToGit === true,
          error,
        });
      }
    }

    const failed = results.filter((r) => r.error !== undefined || !r.pushed || r.publishError !== null);
    if (failed.length === 0) {
      this.ctx.prompt.info("Deploy complete!");
    } else {
      this.ctx.prompt.error(
        `Deploy finished with ${failed.length} of ${results.length} target(s) failed:\n\n` +
          failed
            .map((r) => `${r.target}: ${r.error instanceof Error ? r.error.message : (r.publishError ?? "not pushed")}`)
            .join("\n")
      );
    }
    return results;
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
