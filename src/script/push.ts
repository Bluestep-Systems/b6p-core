import * as path from "path";
import { XMLParser } from "fast-xml-parser";
import { FileExtensions, FolderNames, Http, SpecialFiles } from "../constants";
import { B6PUri } from "../B6PUri";
import { GlobMatcher } from "../data/GlobMatcher";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { resolveCompileRoute, type CompileRoute } from "../data/ServerVersion";
import { ScriptFactory } from "./ScriptFactory";
import { SnapshotHistoryRecorder } from "./SnapshotHistoryRecorder";
import type { ScriptContext } from "./ScriptContext";
import type { ScriptRoot } from "./ScriptRoot";
import type { FileSystem, ProgressTask } from "../providers";
import { Err } from "../Err";
import { ScriptFile } from "./ScriptFile";
import { TsConfig } from "./TsConfig";
import { resolveNativeCompilerPath, type TranspileOutcome } from "./ScriptTranspiler";
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
   * Which compile the push used (ruling 44b): `server` (the platform compiles; `compile` and
   * `publish` apply) or `local` (core compiled with its bundled TypeScript 7.1 and uploaded the
   * sources and `.build` as before 0.9.0; `typeCheckDiagnostics`, `liveVerified` and
   * `liveMismatches` apply). `null` only when the push stopped before asking the server (the draft
   * folder is missing).
   * @lastreviewed null
   */
  compileMode: "server" | "local" | null;
  /**
   * Why `compileMode` was chosen: the server's reported version, the floor and the reason. `null`
   * exactly when `compileMode` is.
   * @lastreviewed null
   */
  route: CompileRoute | null;
  /**
   * What the platform's `compileDraft` came to, after the sources went up. `null` when the push
   * did not run (`pushed: false`), and always on the local path.
   * @lastreviewed null
   */
  compile: DraftCompileOutcome | null;
  /**
   * What the platform's `takeSnapshot` came to. `null` for a plain push, for a push that did not
   * run, on the local path, and for a snapshot push whose compile ended in a status that does not publish (anything
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
  // TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
  /**
   * Local path only (absent on the server path). Type-check outcome of the pre-publish transpile:
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
  typeCheckDiagnostics?: number | null;
  /**
   * Local path only (absent on the server path). Whether the live (`snapshot/`) copy of every file this push wrote reads back identical to the
   * local bytes (compared by ETag, the platform's SHA-512 of the content):
   *  - `null` — no read-back ran: a plain push, or a push that aborted before uploading.
   *    Also `null` when no copy was wrong but at least one was served without a content hash
   *    (ETag), so it could not be compared: those files are named in a warning, and cleanup and
   *    history still run.
   *  - `true` — every written file reads back identical. Files skipped as already in sync count as
   *    verified, since the skip rule compared both copies.
   *  - `false` — at least one file was still different, missing (`404`) or unreadable (another
   *    non-2xx) after one re-upload; see `liveMismatches`. The push stopped there: no cleanup ran
   *    and no history entry was recorded (`historyRecorded` is false), so a consumer that already
   *    reads that field fails the run.
   * @lastreviewed null
   */
  liveVerified?: boolean | null;
  /**
   * Local path only (absent on the server path). Draft-relative paths (`/`-separated, e.g.
   * `.build/scripts/app.js`) whose live copy failed the
   * read-back. Empty unless `liveVerified` is false.
   * @lastreviewed null
   */
  liveMismatches?: string[];
}

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * Outcome of {@link verifyLiveSnapshot}. Paths are draft-relative and `/`-separated.
 * @lastreviewed null
 */
export interface LiveSnapshotCheck {
  /**
   * Files whose `snapshot/` copy still differs from local, is missing (`404`) or can't be read
   * (another non-2xx) after one re-upload.
   * @lastreviewed null
   */
  mismatches: string[];
  /**
   * Files the platform served (2xx) without a SHA-512 ETag, so neither match nor mismatch can be
   * said.
   * @lastreviewed null
   */
  indeterminate: string[];
}

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * Outcome of {@link checkEmittedEntrypoint}.
 * @lastreviewed null
 */
export interface EmittedEntrypointCheck {
  /**
   * - `"no-source"` — the draft has no `scripts/app.ts` (a JS-only draft): nothing to check.
   * - `"ok"` — the compiled entrypoint exists and has content.
   * - `"missing"` — `scripts/app.ts` exists but the compile wrote no `scripts/app.js`.
   * - `"empty"` — the compiled entrypoint has no code: only comments (the inline source map
   *   included) and the compiler's empty-module lines, e.g. from a blank `app.ts` or one holding
   *   only types. The platform serves such a file as an empty `200`.
   * @lastreviewed null
   */
  status: "no-source" | "ok" | "missing" | "empty";
  /**
   * Absolute path of the compiled entrypoint the check looked for.
   * @lastreviewed null
   */
  emittedPath: string;
}

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * Statements the compiler writes into a module with no code of its own: the ES module marker a
 * types-only file compiles to, and the CommonJS preamble. Compared token by token, so spacing and
 * comments don't matter.
 * @lastreviewed null
 */
const EMPTY_MODULE_STATEMENTS = [
  "export{};",
  '"use strict";',
  "'use strict';",
  'Object.defineProperty(exports,"__esModule",{value:true});',
];

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * Whether compiled JavaScript has code beyond comments and {@link EMPTY_MODULE_STATEMENTS}. The
 * compiler always appends an inline source map comment, so a blank `app.ts` never compiles to a
 * blank file; the TypeScript scanner drops comments and whitespace as trivia.
 * @param js The compiled file's text
 * @lastreviewed null
 */
async function hasCode(js: string): Promise<boolean> {
  // ES modules: loaded on first use, and only by the local fallback. The scanner is plain
  // JavaScript (no native compiler process).
  const { createScanner } = await import("typescript/ast/scanner");
  const { LanguageVariant, SyntaxKind } = await import("typescript/ast");
  const scanner = createScanner(true, LanguageVariant.Standard, js);
  let tokens = "";
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens += scanner.getTokenText();
  }
  for (const statement of EMPTY_MODULE_STATEMENTS) {
    tokens = tokens.split(statement).join("");
  }
  return tokens.length > 0;
}

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * Pre-publish check for a snapshot push: after the compile, the entrypoint the platform runtime
 * loads must be there. The runtime resolves `scripts/app` to `<build folder>/scripts/app.js`; if
 * that file is missing or has no code, publishing it breaks the live version (a missing one fails
 * with `NoSuchFileException .../scripts/app`, one with no code answers an empty `200`), so the push
 * must stop before any upload (ClickUp 86bbqnrtp).
 *
 * Only the entrypoint is checked. A helper module may legitimately compile to almost nothing, so
 * checking every emitted file would stop good pushes. The transpiler sets `rootDir` to the
 * tsconfig's folder, which is why `scripts/app.ts` always maps to `<build folder>/scripts/app.js`.
 * @param opts.draftPath The draft folder
 * @param opts.buildFolderPath The draft-root tsconfig's build folder ({@link ScriptRoot.getDraftBuildFolder})
 * @param opts.fs The file system to read
 * @returns What was found, and the path it looked at
 * @lastreviewed null
 */
export async function checkEmittedEntrypoint(opts: {
  draftPath: string;
  buildFolderPath: string;
  fs: FileSystem;
}): Promise<EmittedEntrypointCheck> {
  const { draftPath, buildFolderPath, fs } = opts;
  const emittedPath = path.join(buildFolderPath, FolderNames.SCRIPTS, "app" + FileExtensions.JAVASCRIPT);
  const sourceUri = B6PUri.fromFsPath(path.join(draftPath, FolderNames.SCRIPTS, "app" + FileExtensions.TYPESCRIPT));
  if (!(await fs.exists(sourceUri))) {
    return { status: "no-source", emittedPath };
  }
  const emittedUri = B6PUri.fromFsPath(emittedPath);
  if (!(await fs.exists(emittedUri))) {
    return { status: "missing", emittedPath };
  }
  const text = Buffer.from(await fs.readFile(emittedUri)).toString("utf-8");
  return { status: (await hasCode(text)) ? "ok" : "empty", emittedPath };
}

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * How the read-back retry warning describes each failed status.
 * @lastreviewed null
 */
const READ_BACK_PROBLEMS = {
  mismatch: "doesn't match what was pushed",
  missing: "is missing (404)",
  unreadable: "could not be read back",
} as const;

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * Post-publish read-back for a snapshot push: `HEAD`s the `snapshot/` copy of each file the push
 * wrote and compares its ETag with the local SHA-512. The platform can accept a write (2xx) and
 * still serve different bytes, e.g. an empty or cut-off file, so a clean upload alone doesn't prove
 * the live version is right (ClickUp 86bbqnrtp).
 *
 * A copy that differs, is missing (`404`) or can't be read (another non-2xx) is re-sent once and
 * checked again; a re-send the platform refuses leaves it a mismatch. Only a 2xx without a content
 * hash is indeterminate. Files are checked one at a time, in the order given.
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
    let status = await file.readBackStatus(snapshotUrl);
    if (status === "mismatch" || status === "missing" || status === "unreadable") {
      ctx.logger.warn(`Live copy of ${relative} ${READ_BACK_PROBLEMS[status]}; sending it again: ${snapshotUrl}`);
      try {
        await file.putTo(snapshotUrl);
        status = await file.readBackStatus(snapshotUrl);
      } catch (e) {
        ctx.logger.warn(`Re-sending ${relative} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (status === "indeterminate") {
      check.indeterminate.push(relative);
    } else if (status !== "match") {
      check.mismatches.push(relative);
    }
  }
  return check;
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
 * @param opts.isSnapshot Whether the push also writes `snapshot/` itself (the local fallback's
 *   snapshot push), so a file is skipped only when that copy matches too
 * @returns The files at risk, in the order given
 * @lastreviewed null
 */
export async function collectOverwriteCandidates(
  files: ScriptFile[],
  // TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
  opts?: { isSnapshot?: boolean }
): Promise<OverwriteCandidate[]> {
  const candidates: OverwriteCandidate[] = [];
  for (const file of files) {
    if (await file.getReasonToNotPush({ isSnapshot: opts?.isSnapshot })) {
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
 * @param opts.isSnapshot Whether the push is a snapshot push (the wording of messages)
 * @param opts.writesSnapshotCopies Whether the push writes `snapshot/` itself (the local fallback's
 *   snapshot push); the skip check then also compares that copy
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
  // TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
  writesSnapshotCopies?: boolean;
  preConfirmed?: string[];
}): Promise<Set<ScriptFile>> {
  const { prompt } = opts.ctx;
  const preConfirmed = new Set((opts.preConfirmed ?? []).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));
  const candidates = await collectOverwriteCandidates(opts.files, { isSnapshot: opts.writesSnapshotCopies });
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
 * First it asks the org's server for its version ({@link resolveCompileRoute}) and picks the
 * compile (ruling 44b):
 *  - **server** (a `dev` build, or at or above `MIN_SERVER_VERSION`): the sources go to `draft/`
 *    only; then the platform compiles the draft (`compileDraft`) and, for a snapshot push whose
 *    compile left something to publish, publishes it (`takeSnapshot`); see {@link uploadAndCompile}.
 *    A compile the platform's gate or `noEmitOnError` held back is returned in `compile`, with the
 *    sources saved and nothing published.
 *  - **local** (below the floor, an unreadable version, or the floor unset): the push as it was
 *    before 0.9.0, compiled with the bundled TypeScript 7.1; see {@link executeLocalPush}.
 *
 * Before any upload, one confirmation covers every file that would overwrite a platform version
 * nobody here has seen ({@link confirmOverwrites}); declining stops the push with nothing written.
 * @param opts.overwrite Draft-relative paths whose overwrite the caller confirms up front, so the
 *   push doesn't ask about them (e.g. a consumer's flag, after the user approved the files a
 *   declined push listed). Other at-risk files still ask.
 * @param opts.sleep Waits between the platform-call retries; tests inject a recorder
 * @param opts.serverVersionFloor Overrides `MIN_SERVER_VERSION` (`null` means unset); used by tests
 * @throws an {@link Err.OverwriteDeclinedError} when an overwrite is not confirmed
 * @throws an {@link Err.PublishRefusedError} when the platform refuses a snapshot publish (server path)
 * @throws an {@link Err.ServerCompileRequestError} when a compile or publish request fails (server path)
 * @throws an {@link Err.LocalCompilerUnavailableError} when the local path's snapshot push needs the
 *   bundled TypeScript compiler and it is missing or cannot run; nothing was uploaded
 * @throws an {@link Err.CompilationError} when the local compile cannot emit (local path)
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
  serverVersionFloor?: string | null;
}): Promise<PushResult> {
  const { ctx, targetUrl, rootPath, snapshot, message, overwrite } = opts;
  const { fs, prompt, logger, sessionManager } = ctx;
  const draftPath = path.join(rootPath, FolderNames.DRAFT);

  const draftUri = B6PUri.fromFsPath(draftPath);
  if (!(await fs.exists(draftUri))) {
    prompt.error(`Draft folder not found: ${draftPath}`);
    return {
      pushed: false,
      compileMode: null,
      route: null,
      compile: null,
      publish: null,
      historyRecorded: false,
      keptPlatformOnly: [],
    };
  }

  // Ask once, before anything is uploaded or any prompt is shown, who compiles.
  const route = await resolveCompileRoute({
    origin: new URL(targetUrl).origin,
    fetchFn: (url, init) => sessionManager.fetch(url, init),
    floor: opts.serverVersionFloor,
  });
  logger.info(
    `Server version ${route.serverVersion ?? "unknown"} (floor ${route.required ?? "unset"}): ` +
      `${route.mode === "server" ? "the server compiles" : "compiling locally"} (${route.reason}).`
  );

  // Build a parser from the target URL so the ScriptRoot can resolve
  // upstairs URLs (mirrors what executePull does on the pull side).
  const parser = new ScriptUrlParser(targetUrl, sessionManager, logger, prompt);
  const factory = new ScriptFactory(ctx);

  // One ScriptRoot for the whole push; all files in this draft tree are
  // siblings under the same root.
  const rootUri = B6PUri.fromFsPath(rootPath).asDirectory();
  const scriptRoot = factory.createScriptRoot(rootUri);
  scriptRoot.withParser(parser);

  // TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
  if (route.mode === "local") {
    return executeLocalPush({ ctx, targetUrl, rootPath, snapshot, message, overwrite, route, scriptRoot, factory });
  }

  const notPushed: PushResult = {
    pushed: false,
    compileMode: "server",
    route,
    compile: null,
    publish: null,
    historyRecorded: false,
    keptPlatformOnly: [],
  };

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

  return { pushed: true, compileMode: "server", route, compile, publish, historyRecorded, keptPlatformOnly };
}

// TODO(2026-12-09): remove the local TS 7.1 fallback once every namespace runs web >= MIN_SERVER_VERSION (ruling 44)
/**
 * The local fallback push (ruling 44b): the push as it ran before 0.9.0, for a server that does not
 * compile scripts itself (below `MIN_SERVER_VERSION`), one whose version could not be read, or any
 * server but `dev` while the floor is unset. Called by {@link executePush} once it has chosen the
 * route; not exported.
 *
 * A snapshot push compiles the draft locally with the bundled TypeScript 7.1 (one native compiler
 * process, closed afterwards), stops when the compiled entrypoint `scripts/app.js` is missing or has
 * no code ({@link checkEmittedEntrypoint}), then uploads the sources and the build folder to
 * `draft/` and `snapshot/`, reads the live copies back ({@link verifyLiveSnapshot}) and records the
 * history entry. A plain push uploads to `draft/` without compiling. Both warn about stale client
 * bundles. If a live copy is still wrong after the read-back, the push stops before cleanup and
 * history and returns `liveVerified: false`.
 * @lastreviewed null
 */
async function executeLocalPush(opts: {
  ctx: ScriptContext;
  targetUrl: string;
  rootPath: string;
  snapshot: boolean;
  message?: string;
  overwrite?: string[];
  route: CompileRoute;
  scriptRoot: ScriptRoot;
  factory: ScriptFactory;
}): Promise<PushResult> {
  const { ctx, targetUrl, rootPath, snapshot, message, overwrite, route, scriptRoot, factory } = opts;
  const { fs, prompt, logger, progress } = ctx;
  const draftPath = path.join(rootPath, FolderNames.DRAFT);
  const base = {
    compileMode: "local" as const,
    route,
    compile: null,
    publish: null,
    historyRecorded: false,
    typeCheckDiagnostics: null,
    liveVerified: null,
    liveMismatches: [],
    keptPlatformOnly: [],
  };

  // Snapshots transpile TS into the draft build folder so both the source
  // and emitted JS get uploaded and captured in history. Must run before
  // flattenDirectory so the emitted files are included in the upload set.
  // A plain (non-snapshot) push does not compile, so its type-check status is
  // null rather than a count.
  let typeCheckDiagnostics: number | null = null;
  let typeCheckDetail = "";
  if (snapshot) {
    let compileOutcome: TranspileOutcome;
    try {
      // Checked before compileDraftFolder clears the local build folder, so a missing compiler
      // changes nothing locally or on the platform.
      resolveNativeCompilerPath();
      compileOutcome = await scriptRoot.compileDraftFolder();
    } catch (e) {
      if (e instanceof Err.LocalCompilerUnavailableError) {
        throw new Err.LocalCompilerUnavailableError(
          `Snapshot not pushed: the server at ${new URL(targetUrl).origin} does not compile scripts itself ` +
            `(version ${route.serverVersion ?? "unknown"}, ${route.reason}), so this push compiles locally, ` +
            `and ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)} Nothing was uploaded.`,
          { serverVersion: route.serverVersion, reason: route.reason, cause: e.cause }
        );
      }
      throw e;
    }
    typeCheckDiagnostics = compileOutcome.diagnosticCount;
    typeCheckDetail = compileOutcome.diagnosticText;

    const buildFolderPath = (await scriptRoot.getDraftBuildFolder()).uri().fsPath;
    const entrypoint = await checkEmittedEntrypoint({ draftPath, buildFolderPath, fs });
    if (entrypoint.status === "missing" || entrypoint.status === "empty") {
      prompt.error(
        `Snapshot not published: the compiled entrypoint ${entrypoint.emittedPath} ` +
          `${entrypoint.status === "missing" ? "is missing" : "has no code"} after compiling scripts/app.ts. ` +
          `The platform runs that file, so publishing it would break the live version. Nothing was ` +
          `uploaded. Check scripts/app.ts, the compile output and the draft ${TsConfig.NAME}.`
      );
      return { ...base, pushed: false, typeCheckDiagnostics };
    }
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
    return { ...base, pushed: false, typeCheckDiagnostics };
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
    writesSnapshotCopies: snapshot,
    preConfirmed: overwrite,
  });

  // Files upload() actually wrote (a resolved Response); skipped files resolve with undefined.
  const written: ScriptFile[] = [];
  const uploadTasks: ProgressTask<void>[] = entries.map(({ filePath, file }) => ({
    execute: async () => {
      try {
        if (await file.upload({ isSnapshot: snapshot, overwriteConfirmed: confirmed.has(file) })) {
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
        `The live (snapshot/) copy of ${live.mismatches.length} file(s) is missing, unreadable or does not ` +
          `match what was pushed, ` +
          `even after sending it again. The live version may be broken or out of date:\n\n` +
          `${live.mismatches.join("\n")}\n\n` +
          `No cleanup ran and no snapshot history was recorded. Run the snapshot push again.`
      );
      return { ...base, pushed: true, typeCheckDiagnostics, liveVerified: false, liveMismatches: live.mismatches };
    }
    // Nothing was wrong, but a copy served without a content hash was never compared.
    liveVerified = live.indeterminate.length > 0 ? null : true;
  }

  // Cleanup: delete unused upstairs paths.
  const gitignorePatterns = await readGitIgnorePatterns(rootPath, fs);
  const gitignoreMatcher = new GlobMatcher(rootPath, gitignorePatterns);
  const keptPlatformOnly = await cleanupUnusedUpstairsPaths({
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

  return { ...base, pushed: true, historyRecorded, typeCheckDiagnostics, liveVerified, keptPlatformOnly };
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
