import * as path from "path";
import { XMLParser } from "fast-xml-parser";
import { FolderNames, Http, SpecialFiles } from "../constants";
import { B6PUri } from "../B6PUri";
import { GlobMatcher } from "../data/GlobMatcher";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { ScriptFactory } from "./ScriptFactory";
import { SnapshotHistoryRecorder } from "./SnapshotHistoryRecorder";
import type { ScriptContext } from "./ScriptContext";
import type { FileSystem, ProgressTask } from "../providers";
import { Err } from "../Err";
import { ScriptFile } from "./ScriptFile";

/**
 * Recursively collect all files under a directory.
 */
async function flattenDirectory(dirPath: string, fs: FileSystem): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readDirectory(B6PUri.fromFsPath(dirPath));
  for (const [name, type] of entries) {
    const full = path.join(dirPath, name);
    if (type === "directory") {
      const nested = await flattenDirectory(full, fs);
      results.push(...nested);
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Read .gitignore patterns from the script root. Used only for the cleanup
 * pass; per-file gitignore filtering during upload is handled inside
 * ScriptFile.upload() / getReasonToNotPush().
 */
async function readGitIgnorePatterns(rootPath: string, fs: FileSystem): Promise<string[]> {
  const gitignorePath = path.join(rootPath, SpecialFiles.GITIGNORE);
  const uri = B6PUri.fromFsPath(gitignorePath);
  try {
    const raw = await fs.readFile(uri);
    const text = Buffer.from(raw).toString("utf-8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return ["**/.DS_Store"];
  }
}

/**
 * Outcome of a push, for callers that need more signal than the human-facing
 * messages — e.g. a CLI that must exit non-zero or emit `--json` when nothing
 * was uploaded or a snapshot shipped without a history entry. Check `pushed`
 * before reading anything else: a push that aborted early uploaded nothing,
 * regardless of what the other fields say.
 * @lastreviewed null
 */
export interface PushResult {
  /**
   * True when the upload actually ran. False when the push aborted before
   * uploading anything (draft folder missing, or empty) — a state a machine
   * consumer must not read as success.
   * @lastreviewed null
   */
  pushed: boolean;
  /**
   * False for a snapshot push whose history entry could not be recorded (no
   * restore point exists), and for any push that did not run (`pushed: false`).
   * @lastreviewed null
   */
  historyRecorded: boolean;
  /**
   * Type-check outcome of the pre-publish transpile:
   *  - `null` — no platform-code type-check ran. A plain (non-snapshot) push
   *    does not compile; a push that aborted before compiling never got there;
   *    and a snapshot whose TS all lives under nested client bundles (nothing
   *    governed by the draft-root tsconfig) has no draft-root code to check.
   *  - `0` — the draft-root code compiled with zero diagnostics: genuinely
   *    type-checked.
   *  - `> 0` — compiled, but N diagnostics were reported. The JavaScript was
   *    emitted and published anyway (the platform runs the emitted JS on
   *    GraalVM regardless of type errors, and local declarations may be
   *    incomplete), so this is a loud warning, not a failure. A machine consumer
   *    should treat `> 0` as "published without a passing type-check".
   * @lastreviewed null
   */
  typeCheckDiagnostics: number | null;
  /**
   * Whether the live (`snapshot/`) copy of every file this push wrote reads back identical to the
   * local bytes (compared by ETag, the platform's SHA-512 of the content):
   *  - `null` — no read-back ran: a plain push, or a push that aborted before uploading.
   *  - `true` — no written file differs. Files skipped as already in sync count as verified, since
   *    the skip rule compared both copies. Files the platform served without a content hash are
   *    warned about but don't make this false.
   *  - `false` — at least one file still differed after one re-upload; see `liveMismatches`. The
   *    push stopped there: no cleanup ran and no history entry was recorded (`historyRecorded` is
   *    false), so a consumer that already reads that field fails the run.
   * @lastreviewed null
   */
  liveVerified: boolean | null;
  /**
   * Draft-relative paths (`/`-separated, e.g. `.build/scripts/app.js`) whose live copy failed the
   * read-back. Empty unless `liveVerified` is false.
   * @lastreviewed null
   */
  liveMismatches: string[];
}

/**
 * Outcome of {@link verifyLiveSnapshot}. Paths are draft-relative and `/`-separated.
 * @lastreviewed null
 */
export interface LiveSnapshotCheck {
  /**
   * Files whose `snapshot/` copy still differs from local after one re-upload.
   * @lastreviewed null
   */
  mismatches: string[];
  /**
   * Files the platform served without a SHA-512 ETag, so neither match nor mismatch can be said.
   * @lastreviewed null
   */
  indeterminate: string[];
}

/**
 * Post-publish read-back for a snapshot push: `HEAD`s the `snapshot/` copy of each file the push
 * wrote and compares its ETag with the local SHA-512. The platform can accept a write (2xx) and
 * still serve different bytes, e.g. an empty or cut-off file, so a clean upload alone doesn't prove
 * the live version is right (ClickUp 86bbqnrtp).
 *
 * A mismatch re-sends that file's `snapshot/` copy once and checks again. A re-send the platform
 * refuses leaves the file a mismatch. Files are checked one at a time, in the order given.
 * @param files The files this push wrote to `snapshot/`
 * @param ctx Where the retries are logged
 * @returns The files still mismatched, and the ones that could not be compared
 * @lastreviewed null
 */
export async function verifyLiveSnapshot(
  files: ScriptFile[],
  ctx: Pick<ScriptContext, "logger">
): Promise<LiveSnapshotCheck> {
  const check: LiveSnapshotCheck = { mismatches: [], indeterminate: [] };
  for (const file of files) {
    const snapshotUrl = ScriptFile.snapshotUrl(await file.upstairsUrl());
    const relative = file.pathWithRespectToDraftRoot().split(path.sep).join("/");
    let status = await file.currentIntegrityStatus({ upstairsOverride: snapshotUrl });
    if (status === "mismatch") {
      ctx.logger.warn(`Live copy of ${relative} doesn't match what was pushed; sending it again: ${snapshotUrl}`);
      try {
        await file.putTo(snapshotUrl);
        status = await file.currentIntegrityStatus({ upstairsOverride: snapshotUrl });
      } catch (e) {
        ctx.logger.warn(`Re-sending ${relative} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (status === "mismatch") {
      check.mismatches.push(relative);
    } else if (status === "indeterminate") {
      check.indeterminate.push(relative);
    }
  }
  return check;
}

/**
 * Core push implementation.
 *
 * Delegates the per-file work to {@link ScriptFile.upload}, which handles:
 *  - exclusion logic (declarations / .git / .gitignore / integrity match)
 *  - collision detection against last-verified hash with user prompt
 *  - snapshot dual-write (draft + snapshot)
 *  - metadata `lastVerifiedHash` updates via touch()
 *  - rich error wrapping
 *
 * A snapshot push then reads the live copies back ({@link verifyLiveSnapshot}). If any is still
 * wrong, the push stops before cleanup and history and returns `liveVerified: false`.
 * @lastreviewed null
 */
export async function executePush(opts: {
  ctx: ScriptContext;
  targetUrl: string;
  rootPath: string;
  snapshot: boolean;
  message?: string;
}): Promise<PushResult> {
  const { ctx, targetUrl, rootPath, snapshot, message } = opts;
  const { fs, prompt, logger, sessionManager, progress } = ctx;
  const draftPath = path.join(rootPath, FolderNames.DRAFT);

  const draftUri = B6PUri.fromFsPath(draftPath);
  if (!(await fs.exists(draftUri))) {
    prompt.error(`Draft folder not found: ${draftPath}`);
    return {
      pushed: false,
      historyRecorded: false,
      typeCheckDiagnostics: null,
      liveVerified: null,
      liveMismatches: [],
    };
  }

  // Build a parser from the target URL so the ScriptRoot can resolve
  // upstairs URLs (mirrors what executePull does on the pull side).
  const parser = new ScriptUrlParser(targetUrl, sessionManager, logger, prompt);
  const factory = new ScriptFactory(ctx);

  // One ScriptRoot for the whole push; all files in this draft tree are
  // siblings under the same root.
  const rootUri = B6PUri.fromFsPath(rootPath).asDirectory();
  const scriptRoot = factory.createScriptRoot(rootUri);
  scriptRoot.withParser(parser);

  // Snapshots transpile TS into the draft build folder so both the source
  // and emitted JS get uploaded and captured in history. Must run before
  // flattenDirectory so the emitted files are included in the upload set.
  // A plain (non-snapshot) push does not compile, so its type-check status is
  // null rather than a count.
  let typeCheckDiagnostics: number | null = null;
  let typeCheckDetail = "";
  if (snapshot) {
    const compileOutcome = await scriptRoot.compileDraftFolder();
    typeCheckDiagnostics = compileOutcome.diagnosticCount;
    typeCheckDetail = compileOutcome.diagnosticText;
  }

  // Push does NOT transpile client bundles (e.g. a MergeReport `static/script.ts`
  // → `static/.build/script.js`); the platform serves that emitted JS verbatim
  // rather than recompiling it. Warn loudly if a bundle's source is newer than
  // its compiled output so a push can't silently ship stale client JS
  // (b6p-cli#9). Runs for both plain and snapshot pushes; reflects on-disk state
  // after any snapshot compile.
  for (const { bundle, buildFolder } of await scriptRoot.findStaleClientBundles()) {
    prompt.warn(
      `Stale client bundle: source(s) under ${bundle} are newer than the compiled output in ${buildFolder}. ` +
        `b6p push does not transpile client TypeScript — recompile the bundle before pushing, ` +
        `or you will ship stale client JS.`
    );
  }

  const allFiles = await flattenDirectory(draftPath, fs);
  logger.info(`Found ${allFiles.length} files in draft folder`);

  if (allFiles.length === 0) {
    prompt.info("No files to push — draft folder is empty.");
    return { pushed: false, historyRecorded: false, typeCheckDiagnostics, liveVerified: null, liveMismatches: [] };
  }

  // Files upload() actually wrote (a resolved Response); skipped files resolve with undefined.
  const written: ScriptFile[] = [];
  const uploadTasks: ProgressTask<void>[] = allFiles.map((filePath) => ({
    execute: async () => {
      const fileUri = B6PUri.fromFsPath(filePath);
      const file = factory.createFile(fileUri, scriptRoot);
      try {
        if (await file.upload({ isSnapshot: snapshot })) {
          written.push(file);
        }
      } catch (e) {
        if (e instanceof Err.UserCancelledError) {
          // Surface cancellation to the progress runner so it can stop the batch.
          throw e;
        }
        logger.error(`Failed to push ${filePath}: ${e instanceof Error ? e.message : e}`);
        throw e;
      }
    },
    description: path.basename(filePath),
  }));

  await progress.withProgress(uploadTasks, {
    title: snapshot ? "Pushing Snapshot..." : "Pushing Script...",
    showItemCount: true,
    cleanupMessage: "Cleaning up...",
  });

  // A snapshot push is only done when the runtime serves what was pushed. If a live copy is still
  // wrong, stop: deleting platform files or recording a restore point would build on a broken publish.
  let liveVerified: boolean | null = null;
  if (snapshot) {
    const live = await verifyLiveSnapshot(written, ctx);
    if (live.indeterminate.length > 0) {
      prompt.warn(
        `Could not verify the live copy of ${live.indeterminate.length} file(s): the platform served them ` +
          `without a content hash (ETag).\n\n${live.indeterminate.join("\n")}`
      );
    }
    if (live.mismatches.length > 0) {
      prompt.error(
        `The live (snapshot/) copy of ${live.mismatches.length} file(s) does not match what was pushed, ` +
          `even after sending it again. The live version may be broken or out of date:\n\n` +
          `${live.mismatches.join("\n")}\n\n` +
          `No cleanup ran and no snapshot history was recorded. Run the snapshot push again.`
      );
      return {
        pushed: true,
        historyRecorded: false,
        typeCheckDiagnostics,
        liveVerified: false,
        liveMismatches: live.mismatches,
      };
    }
    liveVerified = true;
  }

  // Cleanup: delete unused upstairs paths.
  const gitignorePatterns = await readGitIgnorePatterns(rootPath, fs);
  const gitignoreMatcher = new GlobMatcher(rootPath, gitignorePatterns);
  await cleanupUnusedUpstairsPaths({
    ctx,
    targetUrl,
    draftPath,
    gitignoreMatcher,
  });

  let historyRecorded = true;
  if (snapshot) {
    try {
      await SnapshotHistoryRecorder.record(scriptRoot, message ?? "");
    } catch (e) {
      historyRecorded = false;
      logger.warn(`Failed to record snapshot history: ${e instanceof Error ? e.message : e}`);
    }
  }

  // A snapshot that compiled with diagnostics shipped un-type-checked JS. Say so
  // loudly and do NOT let the run read as a clean success — the platform never
  // type-checks, so this push was the only gate (ClickUp 86bbeb659).
  const shippedWithDiagnostics = snapshot && typeCheckDiagnostics !== null && typeCheckDiagnostics > 0;
  if (shippedWithDiagnostics) {
    prompt.warn(
      `Published WITHOUT a passing type-check: the pre-publish transpile reported ` +
        `${typeCheckDiagnostics} diagnostic(s). The JavaScript was emitted and is now live, but these ` +
        `were NOT verified — each is either a real type error or a missing platform declaration, and ` +
        `the platform does not type-check on its side. Review them before relying on this build:\n\n` +
        typeCheckDetail
    );
  }

  if (snapshot && !historyRecorded) {
    prompt.warn(
      "Snapshot files uploaded and compiled, but the snapshot history entry could NOT be recorded — " +
        "the browser IDE's Project History has no restore point for this snapshot. " +
        "Run the snapshot push again to retry recording it."
    );
  } else if (shippedWithDiagnostics) {
    prompt.info("Snapshot uploaded — but see the type-check warning above.");
  } else {
    prompt.info(snapshot ? "Snapshot complete!" : "Push complete!");
  }

  return { pushed: true, historyRecorded, typeCheckDiagnostics, liveVerified, liveMismatches: [] };
}

/**
 * Delete remote files that no longer have a local counterpart.
 */
async function cleanupUnusedUpstairsPaths(opts: {
  ctx: ScriptContext;
  targetUrl: string;
  draftPath: string;
  gitignoreMatcher: GlobMatcher;
}): Promise<void> {
  const { ctx, targetUrl, draftPath, gitignoreMatcher } = opts;
  const { fs, prompt, logger, sessionManager } = ctx;

  try {
    const parser = new XMLParser();

    const response = await sessionManager.fetch(targetUrl, {
      headers: {
        [Http.Headers.ACCEPT]: Http.Headers.ACCEPT_ALL,
        [Http.Headers.CACHE_CONTROL]: Http.Headers.NO_CACHE,
      },
      method: Http.Methods.PROPFIND,
    });

    if (!response.ok) {
      logger.warn(`PROPFIND failed during cleanup: ${response.status}`);
      return;
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);
    const responses = parsed?.["D:multistatus"]?.["D:response"];
    if (!responses?.filter) {
      return;
    }

    const localFiles = await flattenDirectory(draftPath, fs);
    const localRelatives = new Set(localFiles.map((f) => path.relative(draftPath, f).split(path.sep).join("/")));

    const pathsToDelete: string[] = [];

    for (const entry of responses) {
      const href = entry["D:href"];
      if (!href) {
        continue;
      }

      const entryUrl = new URL(href, targetUrl);
      const basePath = new URL(targetUrl).pathname;
      const relative = entryUrl.pathname.slice(basePath.length);

      if (!relative || relative === "/") {
        continue;
      }

      const draftPrefix = FolderNames.DRAFT + "/";
      if (!relative.startsWith(draftPrefix)) {
        continue;
      }

      const draftRelative = relative.slice(draftPrefix.length);
      if (!draftRelative) {
        continue;
      }

      if (draftRelative.endsWith("/")) {
        continue;
      }

      const localEquivalent = path.join(draftPath, ...draftRelative.split("/"));
      if (gitignoreMatcher.matches(localEquivalent)) {
        logger.info(`File is in .gitignore; skipping deletion: ${href}`);
        continue;
      }

      if (!localRelatives.has(draftRelative)) {
        pathsToDelete.push(entryUrl.href);
      }
    }

    if (pathsToDelete.length === 0) {
      logger.info("No unused upstairs paths to delete.");
      return;
    }

    const YES = "Yes";
    const NO = "No";
    const answer = await prompt.confirm(
      `The following ${pathsToDelete.length} upstairs path(s) no longer have local counterparts:\n\n${pathsToDelete.join("\n")}\n\nDelete them?`,
      [YES, NO]
    );

    if (answer !== YES) {
      prompt.info("User chose not to delete unused upstairs paths.");
      return;
    }

    for (const url of pathsToDelete) {
      logger.info("Deleting unused upstairs path: " + url);
      await sessionManager.fetch(url, { method: Http.Methods.DELETE });
    }
  } catch (e) {
    logger.warn(`Cleanup failed: ${e instanceof Error ? e.message : e}`);
  }
}
