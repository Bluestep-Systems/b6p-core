import * as path from "path";
import {
  compileAllowsPublish,
  type BuildFastForward,
  type DraftBuildRefusalReason,
  type DraftCompileOutcome,
  type DraftCompileStatus,
  type GitIdentity,
} from "@bluestep-systems/b6p-core-bsjs-git";
import { FolderNames } from "../constants";
import { B6PUri } from "../B6PUri";
import { ScriptUrlParser } from "../data/ScriptUrlParser";
import { resolvePushRoute, snapshotRefusalFor, type PushRoute, type SnapshotRefusal } from "../data/ServerVersion";
import { ScriptFactory } from "./ScriptFactory";
import type { ScriptContext } from "./ScriptContext";
import type { FileSystem } from "../providers";
import { resolveGitIdentity } from "./GitIdentity";
import { pushDraft, type LastSyncedLookup, type PublishRefusal } from "./GitSync";
import type { ScriptRoot } from "./ScriptRoot";
import { typeCheckErrorsOf, type TypeCheckError } from "./ServerCompile";

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
 * A platform build that ended in a status after which the draft does not publish: anything but `COMPILED`,
 * `NOTHING_TO_COMPILE` and `SKIPPED_EXTERNALLY_BUILT` (for example `BUSY` or `INPUT_INCOMPLETE` once the retries ran
 * out, `COMPILER_UNAVAILABLE`, `NOT_PERMITTED`, `WRITE_FAILED`, `OUTPUT_UPLOAD`, `SKIPPED_GIT_MANAGED`, `GATE_TRIPPED`,
 * `EMIT_WITHHELD`, `UNKNOWN`).
 * @lastreviewed null
 */
export interface BuildIncomplete {
  /** The status, `UNKNOWN` for one this version does not know. @lastreviewed null */
  readonly status: DraftCompileStatus;
  /** The status exactly as the platform sent it. @lastreviewed null */
  readonly rawStatus: string;
  /** What the status means, in words. @lastreviewed null */
  readonly description: string;
}

/**
 * What a build status that does not publish means, for {@link BuildIncomplete.description}.
 * @lastreviewed null
 */
export function describeBuildStatus(status: DraftCompileStatus, rawStatus: string): string {
  switch (status) {
    case "BUSY":
      return "the platform was busy and did not build the draft";
    case "INPUT_INCOMPLETE":
      return "the platform's copy of the draft was incomplete, so it did not build it";
    case "COMPILER_UNAVAILABLE":
      return "the platform's compiler was unavailable";
    case "NOT_PERMITTED":
      return "the platform did not permit building this script";
    case "WRITE_FAILED":
      return "the platform could not write the build output";
    case "OUTPUT_UPLOAD":
      return "the platform took the output as uploaded and did not build it";
    case "SKIPPED_GIT_MANAGED":
      return "this server does not build git drafts";
    case "GATE_TRIPPED":
      return "the platform's save gate held back the new output";
    case "EMIT_WITHHELD":
      return "the platform withheld the new output";
    case "UNKNOWN":
      return `the platform reported a build status this version does not know (${rawStatus || "none"})`;
    default:
      return `the platform reported ${rawStatus}`;
  }
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
   * aborted before that (draft folder missing, or empty) — a state a machine consumer must not read as success.
   * @lastreviewed null
   */
  pushed: boolean;
  /**
   * The draft commit this push made, or the one already on the platform when nothing changed; the platform's build
   * commit, when it makes one, follows it (`buildCommitSha`). `null` when `pushed` is false.
   * @lastreviewed null
   */
  commitSha: string | null;
  /**
   * The commit the platform published, on a snapshot push: the build commit, or the pushed commit when the build made
   * none. `null` on a plain push, when the push aborted, when nothing was published (`snapshotRefused`, a build that
   * failed or does not publish) and when the publish failed (`publishError` says why); a consumer asking for a
   * snapshot must treat `null` as a failure.
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
   * Which route the push took: `server-build` (the platform builds every push, and a snapshot publishes the build) or
   * `push-only` (the server predates the git build: the draft was pushed and nothing else happened), with why and the
   * versions compared. `null` when the push stopped before the server's version was asked.
   * @lastreviewed null
   */
  route: PushRoute | null;
  /**
   * Set when a snapshot push was asked for but the server does not build git drafts: the draft was pushed, nothing was
   * built or published. A result, not an error. `null` for a plain push and on the build route.
   * @lastreviewed null
   */
  snapshotRefused: SnapshotRefusal | null;
  /**
   * What the platform's build of the pushed draft came to (`compileDraft`): status, counts, diagnostics and the save
   * gate's findings. `null` when no build ran (push-only route, aborted push) or the build request failed
   * (`buildError`).
   * @lastreviewed null
   */
  build: DraftCompileOutcome | null;
  /**
   * The build commit the platform made on the draft branch (the output, and the build manifest when it vouched for the
   * build). The local draft folder was moved to it unless `buildFastForward` says otherwise. `null` when it made none: already built, nothing to build,
   * no build ran, or the request failed.
   * @lastreviewed null
   */
  buildCommitSha: string | null;
  /**
   * Whether the draft passes the platform's build check: the build is clean (every project's output written, no
   * blocking error) and its manifest committed, or the draft needs none (externally built, nothing to build). `false`
   * after an unclean build: the output is committed without a manifest
   * and a publish is refused (`BUILD_STALE` or `BUILD_MANIFEST_MISSING`). `null` when no build ran.
   * @lastreviewed null
   */
  buildVouched: boolean | null;
  /**
   * Why no build answer came after a successful push (the draft is pushed; nothing was published). `null` otherwise.
   * @lastreviewed null
   */
  buildError: string | null;
  /**
   * What `buildError` is: `not-requested` (no build was asked for: the platform's draft was no longer the pushed
   * commit), `refused` (the platform refused the build, see `buildErrorReason`; nothing was built) or
   * `request-failed` (any other failure; it may have run). `null` with no `buildError`.
   * @lastreviewed null
   */
  buildErrorKind: "not-requested" | "refused" | "request-failed" | null;
  /**
   * The platform's refusal reason when `buildErrorKind` is `refused`: `DRAFT_MOVED`, `DRAFT_TOO_LARGE` (the draft is
   * over the build's size limit), `REPO_MISSING` or `DRAFT_BRANCH_MISSING`. `null` otherwise.
   * @lastreviewed null
   */
  buildErrorReason: DraftBuildRefusalReason | null;
  /**
   * Set when the build answered with a status after which the draft does not publish (see {@link BuildIncomplete}):
   * a snapshot push then publishes nothing, and neither push reports itself complete. `null` otherwise.
   * @lastreviewed null
   */
  buildIncomplete: BuildIncomplete | null;
  /**
   * How the local draft folder was moved to `buildCommitSha`: `fast-forwarded`, `unchanged` (no build commit),
   * `blocked` (local files the build changes are in the way, `blockedPaths`; the folder was left as it was, and a
   * snapshot published nothing) or `failed` (`error`; the folder's draft branch did not move). `null` when no build
   * answer came.
   * @lastreviewed null
   */
  buildFastForward: BuildFastForward | null;
  /**
   * How many `ERROR` and `WARNING` diagnostics the platform's build reported in all (its `errors` + `warnings`):
   * `null` when no build ran. {@link typeCheckErrors} lists fewer when the platform capped its list (at most 20) or
   * some were outside the script's own sources. The platform builds and type-checks; a type-checker finding is a
   * warning and does not stop the publish, so `> 0` is "built with findings", not a failure.
   * @lastreviewed null
   */
  typeCheckDiagnostics: number | null;
  /**
   * The platform build's diagnostics in the script's own sources (never a `.d.ts`, never outside the tree), located:
   * `{ file, line, column, code, message, severity }`, `file` relative to the draft folder. The platform lists at most
   * 20 diagnostics (`build.diagnosticsOmitted` counts the rest). Empty when none, and when no build ran.
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

function notPushed(route: PushRoute | null): PushResult {
  return {
    pushed: false,
    commitSha: null,
    publishedSha: null,
    publishError: null,
    publishRefusal: null,
    switchedToGit: false,
    route,
    snapshotRefused: null,
    build: null,
    buildCommitSha: null,
    buildVouched: null,
    buildError: null,
    buildErrorKind: null,
    buildErrorReason: null,
    buildIncomplete: null,
    buildFastForward: null,
    typeCheckDiagnostics: null,
    typeCheckErrors: [],
    liveVerified: null,
    liveMismatches: [],
    keptPlatformOnly: [],
  };
}

/**
 * Core push implementation, on git: the draft folder is the script's git working tree, a push commits it and pushes the
 * draft branch (see {@link pushDraft}), the platform then builds the pushed commit, and a snapshot publishes the build.
 *
 * Nothing compiles here. The server's version picks the route once per push ({@link resolvePushRoute}): a `dev` server
 * or one at or above `MIN_SERVER_VERSION` builds every push (GraphQL `compileDraft` pinned to the pushed commit), which
 * commits the output, and the build manifest when it vouches for the build, as one build commit; the draft folder is
 * fast-forwarded to it. A snapshot push then publishes that commit, unless the build failed or ended in a status that
 * does not publish (a tripped gate, a withheld emit). An unclean build is published-or-refused by the platform's
 * manifest check, never by core. On any other server the push is a git push alone, and a snapshot push takes no
 * snapshot (`snapshotRefused`). If the platform refuses the publish the draft stays pushed and the result carries
 * `publishError`.
 *
 * Before anything is pushed, one confirmation covers every platform file the push would overwrite; declining stops the
 * push with nothing sent.
 * @param opts.overwrite Draft-relative paths whose overwrite the caller confirms up front, so the
 *   push doesn't ask about them (e.g. a consumer's flag, after the user approved the files a
 *   declined push listed). Other at-risk files still ask.
 * @param opts.author Who the commit is by. When absent: the folder's `git config`, then the environment.
 * @param opts.adoptUnbound `false` for a deploy to a script the folder isn't the working copy of: the folder is then
 *   never bound to the target's repo. Default `true`.
 * @param opts.floor Overrides `MIN_SERVER_VERSION` (`null` means unset); for tests
 * @param opts.sleep Waits between the build's retries; for tests
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
  enableGit?: boolean;
  floor?: string | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PushResult> {
  const { ctx, targetUrl, rootPath, snapshot, message, overwrite } = opts;
  const { fs, prompt, logger, sessionManager } = ctx;
  const draftPath = path.join(rootPath, FolderNames.DRAFT);

  const draftUri = B6PUri.fromFsPath(draftPath);
  if (!(await fs.exists(draftUri))) {
    prompt.error(`Draft folder not found: ${draftPath}`);
    return notPushed(null);
  }

  // Fail before the platform is touched: a commit made as nobody must not happen, and a script must not be switched
  // to git by a push that then cannot commit.
  const author = await resolveGitIdentity({ explicit: opts.author, dir: draftPath, env: ctx.gitEnv });

  // Build a parser from the target URL so the ScriptRoot can resolve the script's identity.
  const parser = new ScriptUrlParser(targetUrl, sessionManager, logger, prompt);
  const factory = new ScriptFactory(ctx);
  const rootUri = B6PUri.fromFsPath(rootPath).asDirectory();
  const scriptRoot = factory.createScriptRoot(rootUri);
  scriptRoot.withParser(parser);

  const allFiles = await flattenDirectory(draftPath, fs);
  logger.info(`Found ${allFiles.length} files in draft folder`);
  if (allFiles.length === 0) {
    prompt.info("No files to push — draft folder is empty.");
    return notPushed(null);
  }

  const route = await resolvePushRoute({
    origin: parser.url.origin,
    fetchFn: (url, init) => sessionManager.fetch(url, init),
    ...(opts.floor !== undefined ? { floor: opts.floor } : {}),
  });
  const build = route.mode === "server-build";
  const snapshotRefused = snapshot ? snapshotRefusalFor(route) : null;

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
      snapshot: snapshot && build,
      build,
      adoptUnbound: opts.adoptUnbound ?? true,
      enableGit: opts.enableGit,
      preConfirmed: overwrite,
      lastSynced: await legacySyncRecords(scriptRoot, draftPath),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    }
  );

  if (outcome.switchedToGit) {
    prompt.warn(
      "This script now publishes through git. The switch cannot be undone: its draft and snapshot no longer " +
        "accept WebDAV writes, and its history is the git history from here on."
    );
  }

  if (snapshotRefused) {
    prompt.error(
      `The draft was pushed (commit ${outcome.commitSha}), but no snapshot was taken: ` +
        (snapshotRefused.reason === "too-old"
          ? `the server runs ${snapshotRefused.serverVersion}, and building a git draft needs ${snapshotRefused.required} or later.`
          : snapshotRefused.reason === "floor-unset"
            ? "the first server release that builds git drafts is not known yet."
            : "the server's version could not be read, so it is not known to build git drafts.")
    );
  }

  const built = outcome.build;
  const typeCheckErrors = typeCheckErrorsOf(built?.compile ?? null);
  const nothingPublished = snapshot ? " Nothing was published." : "";
  const status = built?.compile?.status;
  const buildIncomplete: BuildIncomplete | null =
    built?.compile && status && !compileAllowsPublish(status)
      ? {
          status,
          rawStatus: built.compile.rawStatus,
          description: built.outcomeUnknown
            ? built.outcomeUnknown.buildFound
              ? "the platform could not tell whether its build landed; the draft it holds is a build of this push, " +
                "taken in here, but how that build went is not known"
              : "the platform could not tell whether its build landed, and no build of this push is on its draft"
            : describeBuildStatus(status, built.compile.rawStatus),
        }
      : null;
  const fastForward = built?.fastForward ?? null;
  if (built?.error) {
    prompt.error(
      built.errorKind === "not-requested"
        ? `The draft was pushed (commit ${outcome.commitSha}), but no build was asked for: ${built.error}${nothingPublished}`
        : built.errorKind === "refused"
          ? `The draft was pushed (commit ${outcome.commitSha}), but the platform refused to build it ` +
            `(${built.errorReason}): ${built.error}${nothingPublished}`
          : `The draft was pushed (commit ${outcome.commitSha}), but the platform's build request failed: ${built.error}${nothingPublished}`
    );
  } else if (built?.compile) {
    if (buildIncomplete) {
      const gate = built.compile.gate;
      prompt.error(
        `The draft was pushed (commit ${outcome.commitSha}), but ${buildIncomplete.description} ` +
          `(${buildIncomplete.rawStatus || buildIncomplete.status}).${nothingPublished}` +
          (gate && gate.problems.length > 0
            ? `\n\n${gate.problems.map((p) => `${p.tsconfig}: ${p.message}`).join("\n")}`
            : "")
      );
    } else if (!built.vouched && status === "COMPILED") {
      prompt.warn(
        "The build was not clean, so the platform committed its output without a build manifest: a publish of this " +
          "draft is refused until it builds cleanly."
      );
    }
    if (fastForward?.state === "blocked") {
      prompt.error(
        `The platform built the draft (build commit ${built.buildCommitSha}), but the draft folder was left at ` +
          `${outcome.commitSha}: ${fastForward.blockedPaths.length} local file(s) the build changes differ from both ` +
          `the pushed commit and the build.${nothingPublished}\n\n${fastForward.blockedPaths.join("\n")}`
      );
    } else if (fastForward?.state === "failed") {
      prompt.error(
        `The platform built the draft (build commit ${built.buildCommitSha}), but the draft folder could not be ` +
          `moved to it: ${fastForward.error}${nothingPublished}`
      );
    }
    if (typeCheckErrors.length > 0) {
      const total = built.compile.errors + built.compile.warnings;
      prompt.warn(
        `The platform's build reported ${total} diagnostic(s)` +
          (total > typeCheckErrors.length
            ? `; ${typeCheckErrors.length} of them in the script's sources are listed`
            : " in the script's sources") +
          `:\n\n` +
          typeCheckErrors
            .map((e) => `${e.file}:${e.line}:${e.column} ${e.severity} TS${e.code}: ${e.message}`)
            .join("\n")
      );
    }
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

  const builtCleanly =
    !built ||
    (!built.error &&
      !buildIncomplete &&
      (fastForward === null || fastForward.state === "fast-forwarded" || fastForward.state === "unchanged"));
  const succeeded = snapshot ? !!publish && !publish.error && publish.liveVerified !== false : builtCleanly;
  if (succeeded) {
    prompt.info(snapshot ? "Snapshot complete!" : "Push complete!");
  }

  return {
    pushed: true,
    commitSha: outcome.commitSha,
    publishedSha: publish?.publishedSha ?? null,
    publishError: publish?.error ?? null,
    publishRefusal: publish?.refusal ?? null,
    switchedToGit: outcome.switchedToGit,
    route,
    snapshotRefused,
    build: built?.compile ?? null,
    buildCommitSha: built?.buildCommitSha ?? null,
    buildVouched: built && !built.error ? built.vouched : null,
    buildError: built?.error ?? null,
    buildErrorKind: built?.errorKind ?? null,
    buildErrorReason: built?.errorReason ?? null,
    buildIncomplete,
    buildFastForward: fastForward,
    typeCheckDiagnostics: built?.compile ? built.compile.errors + built.compile.warnings : null,
    typeCheckErrors,
    liveVerified: publish?.liveVerified ?? null,
    liveMismatches: publish?.liveMismatches ?? [],
    keptPlatformOnly: outcome.keptPlatformOnly,
  };
}
