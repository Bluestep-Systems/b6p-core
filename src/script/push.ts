import * as path from "path";
import { XMLParser } from "fast-xml-parser";
import { FolderNames, Http, SpecialFiles } from "../constants";
import { B6PUri } from "../B6PUri";
import { GlobMatcher } from "../data/GlobMatcher";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { assertServerVersion } from "../data/ServerVersion";
import { ScriptFactory } from "./ScriptFactory";
import { SnapshotHistoryRecorder } from "./SnapshotHistoryRecorder";
import type { ScriptContext } from "./ScriptContext";
import type { ScriptRoot } from "./ScriptRoot";
import type { FileSystem, ProgressTask } from "../providers";
import { Err } from "../Err";
import type { ScriptFile } from "./ScriptFile";
import {
  compileAllowsPublish,
  compileDraft,
  takeSnapshot,
  type DraftCompileOutcome,
  type PublishOutcome,
  type ServerCompileTarget,
} from "./ServerCompile";

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
 * Absolute paths of the build folders (each tsconfig's `outDir`, `.build` by default) under the
 * draft. The platform compiles BSJS and owns what it writes there, so a push neither uploads these
 * files nor offers to delete the platform's copies. A tsconfig that cannot be read is skipped: this
 * is best-effort and must never stop a push.
 * @param scriptRoot The script being pushed
 * @param logger Where skipped tsconfigs are logged
 * @lastreviewed null
 */
async function findBuildFolders(scriptRoot: ScriptRoot, logger: ScriptContext["logger"]): Promise<string[]> {
  const folders: string[] = [];
  for (const tsConfig of await scriptRoot.findTsConfigFiles()) {
    try {
      folders.push(B6PUri.stripDirectoryMarker(path.normalize((await tsConfig.getBuildFolder()).uri().fsPath)));
    } catch (e) {
      logger.info(`Skipping build folder of ${tsConfig.path()}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return folders;
}

/**
 * Whether a path is inside one of the given folders.
 * @lastreviewed null
 */
function isInAnyFolder(filePath: string, folders: string[]): boolean {
  const normalized = B6PUri.stripDirectoryMarker(path.normalize(filePath));
  return folders.some((folder) => normalized === folder || normalized.startsWith(folder + path.sep));
}

/**
 * Outcome of a push, for callers that need more signal than the human-facing
 * messages — e.g. a CLI that must exit non-zero or emit `--json` when nothing
 * was uploaded, the platform's compile did not produce output, or a snapshot
 * shipped without a history entry. Check `pushed` before reading anything
 * else: a push that aborted early uploaded nothing, regardless of what the
 * other fields say.
 *
 * A compile that the platform's save gate held back (`GATE_TRIPPED`) or that a
 * `noEmitOnError` project withheld (`EMIT_WITHHELD`) is a result, not an error:
 * the sources are saved. Read `compile.status`.
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
   * What the platform's `compileDraft` came to, after the sources went up. `null` when the push
   * did not run (`pushed: false`).
   * @lastreviewed null
   */
  compile: DraftCompileOutcome | null;
  /**
   * What the platform's `takeSnapshot` came to. `null` for a plain push, for a push that did not
   * run, and for a snapshot push whose compile ended in a status that does not publish (anything
   * but `COMPILED`, `NOTHING_TO_COMPILE` or `SKIPPED_EXTERNALLY_BUILT`): nothing was published
   * then, and `compile.status` says why. A platform refusal is thrown as an
   * {@link Err.PublishRefusedError} instead.
   * @lastreviewed null
   */
  publish: PublishOutcome | null;
  /**
   * False for a snapshot push whose history entry could not be recorded (no
   * restore point exists), whose snapshot was not published, and for any push
   * that did not run (`pushed: false`).
   * @lastreviewed null
   */
  historyRecorded: boolean;
  /**
   * Draft-relative paths (`/`-separated) of files that exist only on the platform and were kept
   * because deleting them was not confirmed: declined, or answered with the safe default (an empty
   * answer, or the CLI's `--yes`). Empty when there were none, when they were deleted, or when
   * cleanup did not run.
   * @lastreviewed null
   */
  keptPlatformOnly: string[];
}

/**
 * A file whose upload would overwrite a platform version nobody here has seen.
 * @lastreviewed null
 */
export interface OverwriteCandidate {
  /**
   * The file to upload.
   * @lastreviewed null
   */
  file: ScriptFile;
  /**
   * Draft-relative, `/`-separated path, e.g. `scripts/app.ts`.
   * @lastreviewed null
   */
  path: string;
  /**
   * Why it is at risk; see {@link ScriptFile.platformChangeAtRisk}.
   * @lastreviewed null
   */
  risk: "changed" | "unsynced";
}

/**
 * Finds the files of a push whose upload would overwrite a platform version nobody here has seen,
 * by the rule in {@link ScriptFile.platformChangeAtRisk}. Files the push won't upload anyway
 * (ignored, declarations, already in sync) are left out, so they are never asked about.
 *
 * Reads the platform one file at a time. The skip check it runs is cached on each file, so the
 * upload that follows doesn't repeat it.
 * @param files The push's files, the same instances the upload will use
 * @returns The files at risk, in the order given
 * @lastreviewed null
 */
export async function collectOverwriteCandidates(files: ScriptFile[]): Promise<OverwriteCandidate[]> {
  const candidates: OverwriteCandidate[] = [];
  for (const file of files) {
    if (await file.getReasonToNotPush()) {
      continue;
    }
    const risk = await file.platformChangeAtRisk();
    if (risk) {
      candidates.push({ file, path: file.pathWithRespectToDraftRoot().split(path.sep).join("/"), risk });
    }
  }
  return candidates;
}

/**
 * The push's one overwrite confirmation (ClickUp 86bbjennm). Before anything is uploaded, it finds
 * every file at risk ({@link collectOverwriteCandidates}) and asks once for all of them, so an
 * answer, or the lack of one, can no longer leave a push half done. Files the caller already
 * confirmed in `preConfirmed` are not asked about: that is how a consumer confirms without a
 * prompt, e.g. from a flag.
 * @param opts.files The push's files, the same instances the upload will use
 * @param opts.ctx Where the prompt goes
 * @param opts.isSnapshot Whether the push is a snapshot push (only changes the wording of messages)
 * @param opts.preConfirmed Draft-relative paths (`/`- or `\`-separated) the caller confirms up front
 * @returns The files whose overwrite is confirmed; `upload()` skips its own prompt for them
 * @throws an {@link Err.OverwriteDeclinedError} listing the files, when the answer is anything but
 *   "Overwrite all". Nothing has been uploaded at that point.
 * @lastreviewed null
 */
export async function confirmOverwrites(opts: {
  files: ScriptFile[];
  ctx: Pick<ScriptContext, "prompt">;
  isSnapshot: boolean;
  preConfirmed?: string[];
}): Promise<Set<ScriptFile>> {
  const { prompt } = opts.ctx;
  const preConfirmed = new Set((opts.preConfirmed ?? []).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));
  const candidates = await collectOverwriteCandidates(opts.files);
  const confirmed = new Set(candidates.filter((c) => preConfirmed.has(c.path)).map((c) => c.file));
  const toAsk = candidates.filter((c) => !preConfirmed.has(c.path));
  if (toAsk.length === 0) {
    return confirmed;
  }
  const why = (c: OverwriteCandidate) =>
    c.risk === "changed"
      ? "changed on the platform since the last push or pull from here"
      : "the platform has a different copy, never pulled or pushed from this machine";
  const list = toAsk.map((c) => `${c.path} (${why(c)})`).join("\n");
  // "Cancel" is FIRST: an empty answer and the CLI's --yes both take options[0] (ClickUp 86bc2h3ef).
  const CANCEL = "Cancel";
  const OVERWRITE_ALL = "Overwrite all";
  const answer = await prompt.confirm(
    `${toAsk.length} file(s) would overwrite a platform version nobody here has seen:\n\n${list}\n\n` +
      `Nothing has been uploaded yet. Overwrite all of them with your local files?`,
    [CANCEL, OVERWRITE_ALL],
    { destructive: true, safeOption: CANCEL }
  );
  if (answer !== OVERWRITE_ALL) {
    const kind = opts.isSnapshot ? "Snapshot push" : "Push";
    await prompt.popup(`${kind} cancelled: nothing was uploaded.`);
    // What was kept and why; how to confirm is the consumer's to say (it gets `paths`).
    throw new Err.OverwriteDeclinedError(
      `${kind} stopped before uploading anything: ${toAsk.length} file(s) were not overwritten, because ` +
        `each would overwrite a platform version nobody here has seen:\n\n${list}\n\n` +
        `Pull or audit them to see the platform versions before overwriting them.`,
      toAsk.map((c) => c.path)
    );
  }
  toAsk.forEach((c) => confirmed.add(c.file));
  return confirmed;
}

/**
 * The platform half of a push: uploads each file to `draft/`, then asks the platform to compile the
 * draft, then (snapshot push only, and only when the compile left something to publish) asks it to
 * publish. Nothing is PUT into `snapshot/` or a build folder: the platform compiles and publishes.
 *
 * Uploads run in order and stop at the first failure. When any file went up, the draft is still
 * compiled before the failure is rethrown, so it is not left half-compiled (best effort: a compile
 * failure then is logged, not thrown, so the upload failure is what the caller sees).
 * @param opts.ctx Where progress, prompts and logs go
 * @param opts.scriptRoot The script; supplies its key, origin and session for the GraphQL calls
 * @param opts.entries The files to upload, in order
 * @param opts.confirmed Files whose overwrite is already confirmed; `upload()` skips its prompt for them
 * @param opts.snapshot Whether to publish after a compile that left something to publish
 * @param opts.afterUpload Runs after every upload succeeded and before the compile (the deletion of
 *   platform-only files belongs here: it changes the draft's sources); its result is returned
 * @param opts.sleep Waits between retries; tests inject a recorder
 * @returns How many files were written, the compile outcome, the publish outcome (`null` when none
 *   was attempted) and what `afterUpload` returned
 * @throws the first upload failure (an {@link Err.FileSendError}, {@link Err.UserCancelledError}, ...)
 * @throws an {@link Err.ServerCompileRequestError} when the compile or publish request fails
 * @throws an {@link Err.PublishRefusedError} when the platform refuses the publish
 * @lastreviewed null
 */
export async function uploadAndCompile<R = void>(opts: {
  ctx: Pick<ScriptContext, "logger" | "progress">;
  scriptRoot: ServerCompileTarget;
  entries: { filePath: string; file: ScriptFile }[];
  confirmed: Set<ScriptFile>;
  snapshot: boolean;
  afterUpload?: () => Promise<R>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  written: number;
  compile: DraftCompileOutcome;
  publish: PublishOutcome | null;
  afterUpload: R | undefined;
}> {
  const { ctx, scriptRoot, entries, confirmed, snapshot } = opts;
  const { logger, progress } = ctx;
  const sleepOpts = { sleep: opts.sleep };

  // Files upload() actually wrote (a resolved Response); skipped files resolve with undefined.
  let written = 0;
  let failure: { error: unknown } | null = null;
  const uploadTasks: ProgressTask<void>[] = entries.map(({ filePath, file }) => ({
    execute: async () => {
      if (failure) {
        return; // stop uploading after the first failure, whatever the progress runner does next
      }
      try {
        if (await file.upload({ overwriteConfirmed: confirmed.has(file) })) {
          written++;
        }
      } catch (e) {
        failure = { error: e };
        if (!(e instanceof Err.UserCancelledError)) {
          logger.error(`Failed to push ${filePath}: ${e instanceof Error ? e.message : e}`);
        }
        throw e;
      }
    },
    description: path.basename(filePath),
  }));

  try {
    await progress.withProgress(uploadTasks, {
      title: snapshot ? "Pushing Snapshot..." : "Pushing Script...",
      showItemCount: true,
      cleanupMessage: "Cleaning up...",
    });
  } catch (e) {
    const error = (failure as { error: unknown } | null)?.error ?? e;
    if (written > 0) {
      try {
        const compile = await compileDraft(scriptRoot, sleepOpts);
        logger.warn(`Compiled the draft after a failed push: ${compile.status}`);
      } catch (compileError) {
        logger.warn(
          `Could not compile the draft after a failed push: ${compileError instanceof Error ? compileError.message : compileError}`
        );
      }
    }
    throw error;
  }

  const afterUpload = opts.afterUpload ? await opts.afterUpload() : undefined;

  const compile = await compileDraft(scriptRoot, sleepOpts);
  let publish: PublishOutcome | null = null;
  if (snapshot && compileAllowsPublish(compile.status)) {
    publish = await takeSnapshot(scriptRoot, sleepOpts);
  }
  return { written, compile, publish, afterUpload };
}

/**
 * Core push implementation.
 *
 * Delegates the per-file work to {@link ScriptFile.upload}, which handles:
 *  - exclusion logic (declarations / .git / .gitignore / integrity match)
 *  - collision detection against last-verified hash with user prompt
 *  - metadata `lastVerifiedHash` updates via touch()
 *  - rich error wrapping
 *
 * Before any upload, one confirmation covers every file that would overwrite a platform version
 * nobody here has seen ({@link confirmOverwrites}); declining stops the push with nothing written.
 * The sources go to `draft/` only; then the platform compiles the draft (`compileDraft`) and, for a
 * snapshot push whose compile left something to publish, publishes it (`takeSnapshot`); see
 * {@link uploadAndCompile}. A compile the platform's gate or `noEmitOnError` held back is returned in
 * `compile`, with the sources saved and nothing published.
 * @param opts.overwrite Draft-relative paths whose overwrite the caller confirms up front, so the
 *   push doesn't ask about them (e.g. a consumer's flag, after the user approved the files a
 *   declined push listed). Other at-risk files still ask.
 * @param opts.sleep Waits between the platform-call retries; tests inject a recorder
 * @throws an {@link Err.OverwriteDeclinedError} when an overwrite is not confirmed
 * @throws an {@link Err.ServerVersionUnsupportedError} when the org's server is below the floor
 * @throws an {@link Err.PublishRefusedError} when the platform refuses a snapshot publish
 * @throws an {@link Err.ServerCompileRequestError} when a compile or publish request fails
 * @lastreviewed null
 */
export async function executePush(opts: {
  ctx: ScriptContext;
  targetUrl: string;
  rootPath: string;
  snapshot: boolean;
  message?: string;
  overwrite?: string[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<PushResult> {
  const { ctx, targetUrl, rootPath, snapshot, message, overwrite } = opts;
  const { fs, prompt, logger, sessionManager } = ctx;
  const draftPath = path.join(rootPath, FolderNames.DRAFT);

  const notPushed: PushResult = {
    pushed: false,
    compile: null,
    publish: null,
    historyRecorded: false,
    keptPlatformOnly: [],
  };

  const draftUri = B6PUri.fromFsPath(draftPath);
  if (!(await fs.exists(draftUri))) {
    prompt.error(`Draft folder not found: ${draftPath}`);
    return notPushed;
  }

  // Core uploads sources only, so the org's server must compile them itself. Ask once, before anything
  // is uploaded or any prompt is shown; a refusal changes nothing.
  await assertServerVersion({
    origin: new URL(targetUrl).origin,
    fetchFn: (url, init) => sessionManager.fetch(url, init),
    operation: snapshot ? "snapshot" : "push",
  });

  // Build a parser from the target URL so the ScriptRoot can resolve
  // upstairs URLs (mirrors what executePull does on the pull side).
  const parser = new ScriptUrlParser(targetUrl, sessionManager, logger, prompt);
  const factory = new ScriptFactory(ctx);

  // One ScriptRoot for the whole push; all files in this draft tree are
  // siblings under the same root.
  const rootUri = B6PUri.fromFsPath(rootPath).asDirectory();
  const scriptRoot = factory.createScriptRoot(rootUri);
  scriptRoot.withParser(parser);

  // Push uploads sources only. BSJS is compiled on the platform, which owns the build folder; core
  // neither compiles nor type-checks, and never writes `snapshot/`.

  const buildFolders = await findBuildFolders(scriptRoot, logger);
  const allFiles = (await flattenDirectory(draftPath, fs)).filter((f) => !isInAnyFolder(f, buildFolders));
  logger.info(`Found ${allFiles.length} files in draft folder`);

  if (allFiles.length === 0) {
    prompt.info("No files to push — draft folder is empty.");
    return notPushed;
  }

  // One ScriptFile per file for the whole push: the confirmation pass and the upload share them,
  // and with them each file's cached skip check.
  const entries = allFiles.map((filePath) => ({
    filePath,
    file: factory.createFile(B6PUri.fromFsPath(filePath), scriptRoot),
  }));
  const confirmed = await confirmOverwrites({
    files: entries.map((e) => e.file),
    ctx,
    isSnapshot: snapshot,
    preConfirmed: overwrite,
  });

  const gitignorePatterns = await readGitIgnorePatterns(rootPath, fs);
  const gitignoreMatcher = new GlobMatcher(rootPath, gitignorePatterns);
  const done = await uploadAndCompile({
    ctx,
    scriptRoot,
    entries,
    confirmed,
    snapshot,
    sleep: opts.sleep,
    // Deleting platform-only files changes the draft's sources, so it runs before the compile.
    afterUpload: () => cleanupUnusedUpstairsPaths({ ctx, targetUrl, draftPath, gitignoreMatcher, buildFolders }),
  });
  const keptPlatformOnly = done.afterUpload ?? [];
  const { compile, publish } = done;

  let historyRecorded = false;
  if (publish) {
    historyRecorded = true;
    try {
      await SnapshotHistoryRecorder.record(scriptRoot, message ?? "");
    } catch (e) {
      historyRecorded = false;
      logger.warn(`Failed to record snapshot history: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (!compileAllowsPublish(compile.status) && compile.status !== "SKIPPED_GIT_MANAGED") {
    // The sources are saved but the platform did not build (or publish) them: say what and why.
    prompt.warn(
      `${snapshot ? "Snapshot push" : "Push"}: the sources were saved on the platform, but its compile of the ` +
        `draft ended as ${compile.rawStatus || "unknown"} (${compile.errors} error(s), ${compile.warnings} ` +
        `warning(s)).` +
        (snapshot ? " No snapshot was taken." : "")
    );
  } else if (snapshot && !publish) {
    prompt.warn(`Sources were saved, but no snapshot was taken: the platform's compile ended as ${compile.rawStatus}.`);
  } else if (snapshot && !historyRecorded) {
    prompt.warn(
      "Snapshot published, but the snapshot history entry could NOT be recorded — " +
        "the browser IDE's Project History has no restore point for this snapshot. " +
        "Run the snapshot push again to retry recording it."
    );
  } else {
    prompt.info(snapshot ? "Snapshot complete!" : "Push complete!");
  }

  return { pushed: true, compile, publish, historyRecorded, keptPlatformOnly };
}

/**
 * Delete remote files that no longer have a local counterpart, after one confirmation listing
 * them. Anything but an explicit "Yes" keeps them all, including a prompt that throws because it
 * got no answer. Files matched by `.gitignore` are never deleted. Failures are logged, never
 * thrown: a push that uploaded fine is not failed by cleanup.
 * @param opts.ctx Where requests, prompts and logs go
 * @param opts.targetUrl The script's WebDAV base URL, listed with `PROPFIND`
 * @param opts.draftPath The local draft folder to compare against
 * @param opts.gitignoreMatcher The script's `.gitignore` patterns
 * @param opts.buildFolders Absolute build folder paths the platform owns; files under them are never
 *   deleted
 * @returns Draft-relative paths of the platform-only files it kept because deleting them was not
 *   confirmed; empty when there were none, when they were deleted, or when cleanup failed
 * @lastreviewed null
 */
export async function cleanupUnusedUpstairsPaths(opts: {
  ctx: ScriptContext;
  targetUrl: string;
  draftPath: string;
  gitignoreMatcher: GlobMatcher;
  buildFolders?: string[];
}): Promise<string[]> {
  const { ctx, targetUrl, draftPath, gitignoreMatcher, buildFolders = [] } = opts;
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
      return [];
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);
    const responses = parsed?.["D:multistatus"]?.["D:response"];
    if (!responses?.filter) {
      return [];
    }

    const localFiles = await flattenDirectory(draftPath, fs);
    const localRelatives = new Set(localFiles.map((f) => path.relative(draftPath, f).split(path.sep).join("/")));

    const pathsToDelete: string[] = [];
    const relativesToDelete: string[] = [];

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

      if (isInAnyFolder(localEquivalent, buildFolders)) {
        continue;
      }

      if (!localRelatives.has(draftRelative)) {
        pathsToDelete.push(entryUrl.href);
        relativesToDelete.push(draftRelative);
      }
    }

    if (pathsToDelete.length === 0) {
      logger.info("No unused upstairs paths to delete.");
      return [];
    }

    // "No" is FIRST: an empty answer and the CLI's --yes both take options[0], and a yes deletes
    // platform files that may exist nowhere else (ClickUp 86bc2h3ef).
    const NO = "No";
    const YES = "Yes";
    let answer: string | undefined;
    try {
      answer = await prompt.confirm(
        `The following ${pathsToDelete.length} upstairs path(s) no longer have local counterparts:\n\n${pathsToDelete.join("\n")}\n\nDelete them?`,
        [NO, YES],
        { destructive: true, safeOption: NO }
      );
    } catch (e) {
      // No answer at all (end of input, a dismissed dialog) is not a yes. The files stay, so they
      // must be reported as kept, not lost in the catch below as a failed cleanup.
      logger.warn(`Cleanup prompt got no answer: ${e instanceof Error ? e.message : e}`);
    }

    if (answer !== YES) {
      // A warning, not info: consumers that quiet info (e.g. for machine-readable output) still
      // show warnings, and an auto-answered prompt was never shown to anyone. It says what was
      // kept; how to confirm a delete is the consumer's to explain.
      prompt.warn(
        `Kept ${pathsToDelete.length} platform-only file(s): they are on the platform but not in your local ` +
          `draft folder, and deleting them was not confirmed.\n\n${pathsToDelete.join("\n")}\n\n` +
          `Pull them to get them locally.`
      );
      return relativesToDelete;
    }

    for (const url of pathsToDelete) {
      logger.info("Deleting unused upstairs path: " + url);
      await sessionManager.fetch(url, { method: Http.Methods.DELETE });
    }
    return [];
  } catch (e) {
    logger.warn(`Cleanup failed: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
