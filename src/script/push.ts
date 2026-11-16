import * as path from "path";
import ts from "typescript";
import { buildManifestPath, buildOutputFolder, type GitIdentity } from "@bluestep-systems/b6p-core-bsjs-git";
import { FileExtensions, FolderNames } from "../constants";
import { B6PUri } from "../B6PUri";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { ScriptFactory } from "./ScriptFactory";
import type { ScriptContext } from "./ScriptContext";
import type { TypeCheckError } from "./ScriptTranspiler";
import type { FileSystem } from "../providers";
import { resolveGitIdentity } from "./GitIdentity";
import { pushDraft, type LastSyncedLookup, type PublishRefusal } from "./GitSync";
import type { ScriptRoot } from "./ScriptRoot";
import { TsConfig } from "./TsConfig";

/**
 * Recursively collect all files under a directory, leaving out a git repository's own `.git` folder.
 */
async function flattenDirectory(dirPath: string, fs: FileSystem): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readDirectory(B6PUri.fromFsPath(dirPath));
  for (const [name, type] of entries) {
    if (name === ".git") {
      continue;
    }
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
 * The hashes a pre-git push or pull recorded for the files of a draft folder, as the lookup the git side uses to tell a
 * local edit from a platform change in a folder that has no repository yet.
 * @param scriptRoot The script whose metadata holds the records
 * @param draftPath The draft folder the records' paths are under
 * @lastreviewed null
 */
export async function legacySyncRecords(scriptRoot: ScriptRoot, draftPath: string): Promise<LastSyncedLookup> {
  const metadata = await scriptRoot.getMetaData();
  const records = new Map((metadata?.pushPullRecords ?? []).map((r) => [r.downstairsPath, r.lastVerifiedHash]));
  return async (relative) =>
    records.get(B6PUri.fromFsPath(path.join(draftPath, ...relative.split("/"))).fsPath) ?? null;
}

/**
 * Outcome of a push, for callers that need more signal than the human-facing
 * messages — e.g. a CLI that must exit non-zero or emit `--json` when nothing
 * was pushed or a snapshot did not publish. Check `pushed` before reading
 * anything else: a push that aborted early pushed nothing, regardless of what
 * the other fields say.
 * @lastreviewed null
 */
export interface PushResult {
  /**
   * True when the draft is on the platform: the draft branch was pushed, or already matched. False when the push
   * aborted before that (draft folder missing, or empty; or, on a snapshot push, the compiled `scripts/app.js`
   * missing or blank) — a state a machine consumer must not read as success.
   * @lastreviewed null
   */
  pushed: boolean;
  /**
   * The draft branch's head commit on the platform after the push: the commit this push made, or the one already
   * there when nothing changed. `null` when `pushed` is false.
   * @lastreviewed null
   */
  commitSha: string | null;
  /**
   * The commit the platform published, on a snapshot push. `null` on a plain push, when the push aborted, and when the
   * publish failed (`publishError` says why); a consumer asking for a snapshot must treat `null` as a failure.
   * @lastreviewed null
   */
  publishedSha: string | null;
  /**
   * Why the platform refused or failed the publish of a snapshot push, when it did; the draft was pushed regardless.
   * `null` otherwise.
   * @lastreviewed null
   */
  publishError: string | null;
  /**
   * The platform's structured refusal of the publish: `reason` and `withheld` from the server's `PUBLISH_REFUSED`
   * extensions (every reason, `DRAFT_MOVED` and `BUILD_*` included). `null` when the publish was not refused.
   * @lastreviewed null
   */
  publishRefusal: PublishRefusal | null;
  /**
   * True when this push switched the script from WebDAV to git publishing. The switch is one-way: the script's draft
   * and snapshot no longer accept WebDAV writes.
   * @lastreviewed null
   */
  switchedToGit: boolean;
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
   * The diagnostics `typeCheckDiagnostics` counts, located: `{ file, line, column, code, message }` for each, with `file`
   * relative to the draft folder. Only the script's own sources are counted, never a `.d.ts`. Empty when none, and when
   * no type-check ran.
   * @lastreviewed null
   */
  typeCheckErrors: TypeCheckError[];
  /**
   * Whether the platform's published branch reads back at the commit it reported publishing (`publishedSha`):
   *  - `null` — no read-back ran: a plain push, an aborted one, a failed publish, or the published branch could not be
   *    fetched to compare.
   *  - `true` — the published branch is at `publishedSha`.
   *  - `false` — it is at another commit; see `liveMismatches`.
   * @lastreviewed null
   */
  liveVerified: boolean | null;
  /**
   * Draft-relative paths (`/`-separated) that differ between the commit the platform reported publishing and its
   * published branch. Empty unless `liveVerified` is false (and then empty too when the difference can't be listed).
   * @lastreviewed null
   */
  liveMismatches: string[];
  /**
   * Draft-relative paths (`/`-separated) of files that exist only on the platform and were kept
   * because deleting them was not confirmed: declined, or answered with the safe default (an empty
   * answer, or the CLI's `--yes`). They are part of the pushed commit. Empty when there were none or
   * when they were deleted.
   * @lastreviewed null
   */
  keptPlatformOnly: string[];
}

/**
 * The build manifest as it is now in the draft folder, with where it goes back: a compile wipes the build folder, and a
 * build that is not fully clean must leave an existing manifest as it was (spec §6), so it is put back afterwards.
 * @lastreviewed null
 */
async function existingManifest(
  ctx: ScriptContext,
  draftPath: string
): Promise<{ uri: B6PUri; bytes: Uint8Array } | undefined> {
  const rootFile = async (name: string): Promise<string | undefined> => {
    const uri = B6PUri.fromFsPath(path.join(draftPath, name));
    return (await ctx.fs.exists(uri)) ? Buffer.from(await ctx.fs.readFile(uri)).toString("utf8") : undefined;
  };
  const config = (await rootFile("tsconfig.json")) ?? (await rootFile("jsconfig.json"));
  const relative = buildManifestPath(buildOutputFolder(config));
  const uri = B6PUri.fromFsPath(path.join(draftPath, ...relative.split("/")));
  return (await ctx.fs.exists(uri)) ? { uri, bytes: await ctx.fs.readFile(uri) } : undefined;
}

async function restoreManifest(
  ctx: ScriptContext,
  kept: { uri: B6PUri; bytes: Uint8Array } | undefined
): Promise<void> {
  if (kept) {
    await ctx.fs.createDirectory(kept.uri.dirname);
    await ctx.fs.writeFile(kept.uri, kept.bytes);
  }
}

function notPushed(typeCheckDiagnostics: number | null, typeCheckErrors: TypeCheckError[] = []): PushResult {
  return {
    pushed: false,
    commitSha: null,
    publishedSha: null,
    publishError: null,
    publishRefusal: null,
    switchedToGit: false,
    typeCheckDiagnostics,
    typeCheckErrors,
    liveVerified: null,
    liveMismatches: [],
    keptPlatformOnly: [],
  };
}

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

/**
 * Whether compiled JavaScript has code beyond comments and {@link EMPTY_MODULE_STATEMENTS}. The
 * compiler always appends an inline source map comment, so a blank `app.ts` never compiles to a
 * blank file; the TypeScript scanner drops comments and whitespace as trivia.
 * @param js The compiled file's text
 * @lastreviewed null
 */
function hasCode(js: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, js);
  let tokens = "";
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens += scanner.getTokenText();
  }
  for (const statement of EMPTY_MODULE_STATEMENTS) {
    tokens = tokens.split(statement).join("");
  }
  return tokens.length > 0;
}

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
  return { status: hasCode(text) ? "ok" : "empty", emittedPath };
}

/**
 * Core push implementation, on git: the draft folder is the script's git working tree, a push commits it and pushes the
 * draft branch, and a snapshot then publishes it (see {@link pushDraft}).
 *
 * A snapshot push compiles first and stops before pushing anything if the compiled entrypoint is missing or blank. It
 * is published as pushed: the compiled output is part of the commit. If the platform refuses the publish the draft
 * stays pushed and the result carries `publishError`. A snapshot that compiled with diagnostics is published anyway and
 * warned about loudly.
 *
 * Before anything is pushed, one confirmation covers every platform file the push would overwrite; declining stops the
 * push with nothing sent.
 * @param opts.overwrite Draft-relative paths whose overwrite the caller confirms up front, so the
 *   push doesn't ask about them (e.g. a consumer's flag, after the user approved the files a
 *   declined push listed). Other at-risk files still ask.
 * @param opts.author Who the commit is by. When absent: the folder's `git config`, then the environment.
 * @param opts.adoptUnbound `false` for a deploy to a script the folder isn't the working copy of: the folder is then
 *   never bound to the target's repo. Default `true`.
 * @throws an {@link Err.OverwriteDeclinedError} when an overwrite is not confirmed
 * @throws {GitIdentityError} when no commit author can be found
 * @lastreviewed null
 */
export async function executePush(opts: {
  ctx: ScriptContext;
  targetUrl: string;
  rootPath: string;
  snapshot: boolean;
  message?: string;
  overwrite?: string[];
  author?: GitIdentity;
  adoptUnbound?: boolean;
  /**
   * The script is built by a bundler outside this tool (its `externallyBuilt` config flag): no build manifest is
   * written for it.
   * @lastreviewed null
   */
  externallyBuilt?: boolean;
  enableGit?: boolean;
}): Promise<PushResult> {
  const { ctx, targetUrl, rootPath, snapshot, message, overwrite } = opts;
  const { fs, prompt, logger, sessionManager } = ctx;
  const draftPath = path.join(rootPath, FolderNames.DRAFT);

  const draftUri = B6PUri.fromFsPath(draftPath);
  if (!(await fs.exists(draftUri))) {
    prompt.error(`Draft folder not found: ${draftPath}`);
    return notPushed(null);
  }

  // Fail before the compile and before the platform is touched: a commit made as nobody must not happen, and a script
  // must not be switched to git by a push that then cannot commit.
  const author = await resolveGitIdentity({ explicit: opts.author, dir: draftPath, env: ctx.gitEnv });

  // Build a parser from the target URL so the ScriptRoot can resolve the script's identity.
  const parser = new ScriptUrlParser(targetUrl, sessionManager, logger, prompt);
  const factory = new ScriptFactory(ctx);

  // One ScriptRoot for the whole push; all files in this draft tree are
  // siblings under the same root.
  const rootUri = B6PUri.fromFsPath(rootPath).asDirectory();
  const scriptRoot = factory.createScriptRoot(rootUri);
  scriptRoot.withParser(parser);

  // Snapshots transpile TS into the draft build folder so both the source
  // and emitted JS are part of the commit that gets published. A plain
  // (non-snapshot) push does not compile, so its type-check status is
  // null rather than a count.
  let buildSucceeded = false;
  let typeCheckDiagnostics: number | null = null;
  let typeCheckErrors: TypeCheckError[] = [];
  let typeCheckDetail = "";
  if (snapshot) {
    const keptManifest = await existingManifest(ctx, draftPath);
    let compileOutcome: Awaited<ReturnType<typeof scriptRoot.compileDraftFolder>>;
    try {
      compileOutcome = await scriptRoot.compileDraftFolder();
    } catch (error) {
      await restoreManifest(ctx, keptManifest);
      throw error;
    }
    if (!compileOutcome.fullyClean) {
      await restoreManifest(ctx, keptManifest);
    }
    typeCheckDiagnostics = compileOutcome.diagnosticCount;
    typeCheckErrors = compileOutcome.typeCheckErrors;
    typeCheckDetail = compileOutcome.diagnosticText;

    const buildFolderPath = (await scriptRoot.getDraftBuildFolder()).uri().fsPath;
    const entrypoint = await checkEmittedEntrypoint({ draftPath, buildFolderPath, fs });
    if (entrypoint.status === "missing" || entrypoint.status === "empty") {
      await restoreManifest(ctx, keptManifest);
      prompt.error(
        `Snapshot not published: the compiled entrypoint ${entrypoint.emittedPath} ` +
          `${entrypoint.status === "missing" ? "is missing" : "has no code"} after compiling scripts/app.ts. ` +
          `The platform runs that file, so publishing it would break the live version. Nothing was ` +
          `pushed. Check scripts/app.ts, the compile output and the draft ${TsConfig.NAME}.`
      );
      return notPushed(typeCheckDiagnostics, typeCheckErrors);
    }
    // A manifest vouches that every project's output was written from the sources as they are: a build that reported
    // any error, or did not write every project's output, writes none (any existing one then goes stale).
    buildSucceeded = compileOutcome.fullyClean;
    if (!compileOutcome.fullyClean) {
      prompt.warn(
        `No build manifest was written, because the build was not fully clean:\n\n${compileOutcome.uncleanReasons.join("\n")}\n\n` +
          `A publish of this draft is refused until it is rebuilt cleanly and pushed.`
      );
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
    return notPushed(typeCheckDiagnostics, typeCheckErrors);
  }

  const outcome = await pushDraft(
    {
      ctx,
      script: await parser.getScriptBaseKey(),
      baseUrl: `${parser.url.origin}/`,
      draftPath,
    },
    {
      message: message && message.trim() ? message : snapshot ? "Snapshot from b6p" : "Push from b6p",
      author,
      snapshot,
      adoptUnbound: opts.adoptUnbound ?? true,
      // The build manifest goes in the same commit as the output it describes, and only after a good build.
      ...(buildSucceeded ? { buildManifest: { externallyBuilt: opts.externallyBuilt } } : {}),
      enableGit: opts.enableGit,
      preConfirmed: overwrite,
      lastSynced: await legacySyncRecords(scriptRoot, draftPath),
    }
  );

  if (outcome.switchedToGit) {
    prompt.warn(
      "This script now publishes through git. The switch cannot be undone: its draft and snapshot no longer " +
        "accept WebDAV writes, and its history is the git history from here on."
    );
  }

  const publish = outcome.publish;
  if (publish?.error) {
    prompt.error(
      `The draft was pushed (commit ${outcome.commitSha}) but the platform did not publish it: ${publish.error}`
    );
  }
  if (publish && publish.liveVerified === false) {
    prompt.error(
      `The platform reports publishing commit ${publish.publishedSha}, but its published branch is at another ` +
        `commit${publish.liveMismatches.length > 0 ? `; the files that differ:\n\n${publish.liveMismatches.join("\n")}` : ""}.\n\n` +
        `The live version may be out of date. Run the snapshot push again.`
    );
  }
  if (publish && publish.liveVerified === null && !publish.error) {
    prompt.warn("Could not read the platform's published branch back to verify the publish.");
  }

  // A snapshot that compiled with diagnostics shipped un-type-checked JS. Say so
  // loudly and do NOT let the run read as a clean success — the platform never
  // type-checks, so this push was the only gate (ClickUp 86bbeb659).
  const shippedWithDiagnostics =
    snapshot && !publish?.error && typeCheckDiagnostics !== null && typeCheckDiagnostics > 0;
  if (shippedWithDiagnostics) {
    prompt.warn(
      `Published WITHOUT a passing type-check: the pre-publish transpile reported ` +
        `${typeCheckDiagnostics} diagnostic(s). The JavaScript was emitted and is now live, but these ` +
        `were NOT verified — each is either a real type error or a missing platform declaration, and ` +
        `the platform does not type-check on its side. Review them before relying on this build:\n\n` +
        typeCheckDetail
    );
  }

  if (!publish?.error && publish?.liveVerified !== false) {
    prompt.info(
      shippedWithDiagnostics
        ? "Snapshot published — but see the type-check warning above."
        : snapshot
          ? "Snapshot complete!"
          : "Push complete!"
    );
  }

  return {
    pushed: true,
    commitSha: outcome.commitSha,
    publishedSha: publish?.publishedSha ?? null,
    publishError: publish?.error ?? null,
    publishRefusal: publish?.refusal ?? null,
    typeCheckErrors,
    switchedToGit: outcome.switchedToGit,
    typeCheckDiagnostics,
    liveVerified: publish?.liveVerified ?? null,
    liveMismatches: publish?.liveMismatches ?? [],
    keptPlatformOnly: outcome.keptPlatformOnly,
  };
}
