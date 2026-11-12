import * as path from "path";
import { createHash } from "node:crypto";
import * as os from "node:os";
import {
  BsjsGitError,
  DRAFT_BRANCH,
  GitNotFastForwardError,
  GitRepoNotFoundError,
  ScriptRepo,
  type GitIdentity,
} from "@bluestep-systems/b6p-core-bsjs-git";
import { FolderNames, SpecialFiles } from "../constants";
import { GlobMatcher } from "../data/GlobMatcher";
import type { ScriptKey } from "../data/ScriptKey";
import { Err } from "../Err";
import type { ScriptContext } from "./ScriptContext";

/**
 * The `origin` branch of the platform's draft, as `ScriptRepo` resolves it.
 * @lastreviewed null
 */
const REMOTE_DRAFT = `refs/remotes/origin/${DRAFT_BRANCH}`;
const REMOTE_MASTER = "refs/remotes/origin/master";
const GIT_DIR = ".git";

/**
 * Files git must never pick up from a script's working tree: macOS folder metadata and this package's own atomic-write
 * temp files. Written once to the repo's `info/exclude`, so the script's committed `.gitignore` stays the script's own.
 * @lastreviewed null
 */
const LOCAL_EXCLUDES = [".DS_Store", "*.b6p-tmp"];

/**
 * Where the files of a script's draft live and which script they belong to: everything the git side needs to open the
 * script's repo.
 * @lastreviewed null
 */
export interface DraftTarget {
  readonly ctx: ScriptContext;
  readonly script: ScriptKey;
  /**
   * The organization's origin, such as `https://org.bluestep.net/`.
   * @lastreviewed null
   */
  readonly baseUrl: string;
  /**
   * The local `draft/` folder: the git working tree.
   * @lastreviewed null
   */
  readonly draftPath: string;
}

/**
 * What a legacy (pre-git) pull or push last synced for a file: the SHA-512 of the content, hex, or `null` when this
 * machine has no record. Lets a draft folder created before git be told apart from edits made since.
 * @lastreviewed null
 */
export type LastSyncedLookup = (draftRelative: string) => Promise<string | null>;

/**
 * The slice of Node's `fs.promises` this module uses on the git working tree.
 * @lastreviewed null
 */
interface FsPromises {
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  mkdir(p: string, options?: { recursive?: boolean }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  readdir(p: string): Promise<string[]>;
  stat(p: string): Promise<{ isDirectory(): boolean }>;
  unlink(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/**
 * File operations on a script's git working tree, over the context's {@link ScriptContext.gitFs}.
 * @lastreviewed null
 */
class WorkTreeFiles {
  readonly #fs: FsPromises;

  constructor(ctx: ScriptContext) {
    if (!("promises" in ctx.gitFs)) {
      throw new Err.InvalidStateError("The git file system has no `promises` interface");
    }
    this.#fs = ctx.gitFs.promises as unknown as FsPromises;
  }

  async exists(p: string): Promise<boolean> {
    try {
      await this.#fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async readOptional(p: string): Promise<Uint8Array | undefined> {
    try {
      return await this.#fs.readFile(p);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "EISDIR") {
        return undefined;
      }
      throw error;
    }
  }

  async write(p: string, data: Uint8Array): Promise<void> {
    await this.#fs.mkdir(path.dirname(p), { recursive: true });
    await this.#fs.writeFile(p, data);
  }

  async mkdirp(p: string): Promise<void> {
    await this.#fs.mkdir(p, { recursive: true });
  }

  async mkdtemp(prefix: string): Promise<string> {
    return this.#fs.mkdtemp(prefix);
  }

  async remove(p: string): Promise<void> {
    await this.#fs.rm(p, { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.#fs.rename(from, to);
  }

  /**
   * Whether the folder exists and holds anything at all.
   * @lastreviewed null
   */
  async hasEntries(dir: string): Promise<boolean> {
    try {
      return (await this.#fs.readdir(dir)).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Every file under `root` as a `/`-separated path relative to it, skipping the repo's own `.git` and anything the
   * predicate calls ignored.
   * @lastreviewed null
   */
  async listFiles(root: string, ignored: (relative: string) => boolean = () => false): Promise<string[]> {
    const found: string[] = [];
    const walk = async (relativeDir: string): Promise<void> => {
      const names = await this.#fs.readdir(relativeDir === "" ? root : path.join(root, ...relativeDir.split("/")));
      for (const name of names) {
        if (name === GIT_DIR) {
          continue;
        }
        const relative = relativeDir === "" ? name : `${relativeDir}/${name}`;
        const stat = await this.#fs.stat(path.join(root, ...relative.split("/")));
        if (stat.isDirectory()) {
          await walk(relative);
        } else if (!ignored(relative)) {
          found.push(relative);
        }
      }
    };
    await walk("");
    return found.sort();
  }

  /**
   * Deletes everything directly under `root` except the repo's `.git`.
   * @lastreviewed null
   */
  async clearExceptGit(root: string): Promise<void> {
    for (const name of await this.#fs.readdir(root)) {
      if (name !== GIT_DIR) {
        await this.remove(path.join(root, name));
      }
    }
  }
}

function absolute(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0;
}

function sha512Hex(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("hex");
}

function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

/**
 * Opens the script's repo on `dir` (the draft folder, or a scratch folder).
 * @lastreviewed null
 */
export async function openRepo(target: DraftTarget, dir: string, author?: GitIdentity): Promise<ScriptRepo> {
  return new ScriptRepo({
    fs: target.ctx.gitFs,
    dir,
    script: target.script,
    baseUrl: target.baseUrl,
    auth: { kind: "token", token: await target.ctx.gitToken() },
    ...(author ? { author } : {}),
    ...(target.ctx.gitFetch ? { fetch: target.ctx.gitFetch } : {}),
  });
}

/**
 * Whether the draft folder is already a git working tree.
 * @lastreviewed null
 */
export async function isGitWorkingTree(ctx: ScriptContext, draftPath: string): Promise<boolean> {
  return new WorkTreeFiles(ctx).exists(path.join(draftPath, GIT_DIR));
}

async function readOriginUrl(files: WorkTreeFiles, draftPath: string): Promise<string | undefined> {
  const raw = await files.readOptional(path.join(draftPath, GIT_DIR, "config"));
  if (!raw) {
    return undefined;
  }
  const match = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(Buffer.from(raw).toString("utf8"));
  return match?.[1];
}

async function ensureLocalExcludes(files: WorkTreeFiles, repoDir: string): Promise<void> {
  const exclude = path.join(repoDir, GIT_DIR, "info", "exclude");
  const existing = await files.readOptional(exclude);
  const text = existing ? Buffer.from(existing).toString("utf8") : "";
  const missing = LOCAL_EXCLUDES.filter((line) => !text.split(/\r?\n/).includes(line));
  if (missing.length > 0) {
    await files.write(
      exclude,
      Buffer.from(`${text}${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`)
    );
  }
}

async function remoteDraftOf(repo: ScriptRepo): Promise<string | undefined> {
  try {
    return await repo.sha(REMOTE_DRAFT);
  } catch (error) {
    if (error instanceof BsjsGitError && error.code === "REPO_NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Thrown by {@link pullDraft} when the script still publishes over WebDAV and the switch to git was not confirmed.
 * @lastreviewed null
 */
export class GitSwitchDeclinedError extends Error {
  constructor() {
    super("The script still publishes over WebDAV and switching it to git was not confirmed");
    this.name = "GitSwitchDeclinedError";
  }
}

/**
 * Clones the script into `repo`'s folder. A script that publishes over WebDAV has no repo to clone: that needs the
 * one-way switch to git, so the caller must have asked for it (`enableGit`) or confirm it at the prompt (the safe
 * answer is the default).
 *
 * @returns whether this call switched the script to git.
 * @throws {GitSwitchDeclinedError} when the switch is needed and declined.
 * @lastreviewed null
 */
async function cloneWithSwitch(
  target: DraftTarget,
  repo: ScriptRepo,
  enableGit: boolean | undefined
): Promise<boolean> {
  try {
    await repo.clone();
    return false;
  } catch (error) {
    if (!(error instanceof GitRepoNotFoundError)) {
      throw error;
    }
  }
  // A failed clone leaves a half-made `.git`; the retry needs the folder as it was.
  await new WorkTreeFiles(target.ctx).remove(path.join(repo.dir, GIT_DIR));
  if (!enableGit) {
    const CANCEL = "Cancel";
    const SWITCH = "Switch to git";
    const answer = await target.ctx.prompt.confirm(
      "This script has no git repository: it still publishes over WebDAV. Getting it as a git working copy switches " +
        "it to git publishing, which cannot be undone, and its draft and snapshot then no longer accept WebDAV writes. " +
        "Switch it to git?",
      [CANCEL, SWITCH],
      { destructive: true, safeOption: CANCEL }
    );
    if (answer !== SWITCH) {
      throw new GitSwitchDeclinedError();
    }
  }
  const { switched } = await repo.ensureGitModeResult();
  await repo.clone();
  return switched;
}

/**
 * Clones the script into a scratch folder and moves its `.git` into the existing draft folder, so a draft folder from
 * before git (files, no repository) becomes the working tree of the script's repo with its files as they are: what
 * differs from the platform then shows as local changes.
 * @lastreviewed null
 */
async function bindDraftToRepo(
  target: DraftTarget,
  files: WorkTreeFiles,
  clone: (scratch: ScriptRepo) => Promise<boolean>
): Promise<boolean> {
  const scratch = path.join(path.dirname(target.draftPath), ".b6p-adopt");
  await files.remove(scratch);
  await files.mkdirp(scratch);
  try {
    const switched = await clone(await openRepo(target, scratch));
    await files.rename(path.join(scratch, GIT_DIR), path.join(target.draftPath, GIT_DIR));
    return switched;
  } finally {
    await files.remove(scratch);
  }
}

/**
 * What a pull did to the local draft.
 * @lastreviewed null
 */
export interface DraftPullOutcome {
  /**
   * Absolute paths of local edits kept because the platform changed the same files.
   * @lastreviewed null
   */
  readonly keptLocalPaths: string[];
  /**
   * Whether this pull switched the script from WebDAV to git (one-way).
   * @lastreviewed null
   */
  readonly switchedToGit: boolean;
}

/**
 * Options of {@link pullDraft}.
 * @lastreviewed null
 */
export interface DraftPullOptions {
  /**
   * The caller already confirmed switching a WebDAV script to git, so do not ask.
   * @lastreviewed null
   */
  readonly enableGit?: boolean;
  /**
   * Draft-relative, `/`-separated paths whose platform copy wins even over a local edit.
   * @lastreviewed null
   */
  readonly overwrite?: readonly string[];
  /**
   * What a pre-git sync recorded per file; only used when a draft folder with files but no repo is adopted.
   * @lastreviewed null
   */
  readonly lastSynced?: LastSyncedLookup;
}

/**
 * Brings the platform's draft into the local draft folder:
 *  - no repo and an empty folder: clones the script's repo into it (a WebDAV script needs the one-way switch first);
 *  - no repo but files (a folder pulled before git): binds it to the repo as it stands. A file the platform has that
 *    differs from the local one is kept as a local edit when its last sync record says it was edited here, and
 *    replaced otherwise;
 *  - a repo: fetches and fast-forwards. A local edit to a file the platform also changed is kept and reported. Files
 *    the platform has that are missing locally are restored.
 *
 * @throws {GitSwitchDeclinedError} when a WebDAV script needs the switch and it was declined.
 * @throws {GitNotFastForwardError} when the local draft has commits of its own and the platform moved too.
 * @lastreviewed null
 */
export async function pullDraft(target: DraftTarget, options: DraftPullOptions = {}): Promise<DraftPullOutcome> {
  const { ctx, draftPath } = target;
  const files = new WorkTreeFiles(ctx);
  const overwrite = new Set(options.overwrite ?? []);
  const keptLocalPaths: string[] = [];
  let switchedToGit = false;
  const repo = await openRepo(target, draftPath);

  if (!(await files.exists(path.join(draftPath, GIT_DIR)))) {
    if (!(await files.hasEntries(draftPath))) {
      await files.mkdirp(draftPath);
      try {
        switchedToGit = await cloneWithSwitch(target, repo, options.enableGit);
      } catch (error) {
        await files.remove(path.join(draftPath, GIT_DIR));
        throw error;
      }
      await ensureLocalExcludes(files, draftPath);
      return { keptLocalPaths, switchedToGit };
    }
    switchedToGit = await bindDraftToRepo(target, files, (scratch) =>
      cloneWithSwitch(target, scratch, options.enableGit)
    );
    await ensureLocalExcludes(files, draftPath);
    for (const { path: relative } of await repo.listTree(DRAFT_BRANCH)) {
      const remote = await repo.readFile(DRAFT_BRANCH, relative);
      const place = absolute(draftPath, relative);
      const local = await files.readOptional(place);
      if (local && sameBytes(local, remote)) {
        continue;
      }
      if (local && !overwrite.has(relative)) {
        const recorded = options.lastSynced ? await options.lastSynced(relative) : null;
        if (recorded !== null && recorded !== sha512Hex(local)) {
          keptLocalPaths.push(place);
          continue;
        }
      }
      await files.write(place, remote);
    }
    return { keptLocalPaths, switchedToGit };
  }

  await ensureLocalExcludes(files, draftPath);
  await repo.fetch();
  const remote = await remoteDraftOf(repo);
  const local = await repo.sha(DRAFT_BRANCH);
  if (remote && remote !== local) {
    if (await repo.isAncestor(local, remote)) {
      const changed = new Set((await repo.diff(local, remote)).map((c) => c.path));
      const dirty = (await repo.status()).filter((s) => s.status !== "deleted").map((s) => s.path);
      const saved = new Map<string, Uint8Array>();
      for (const relative of dirty) {
        const bytes = await files.readOptional(absolute(draftPath, relative));
        if (bytes) {
          saved.set(relative, bytes);
        }
      }
      await repo.resetDraft(remote);
      for (const [relative, bytes] of saved) {
        if (overwrite.has(relative)) {
          continue;
        }
        await files.write(absolute(draftPath, relative), bytes);
        if (changed.has(relative)) {
          keptLocalPaths.push(absolute(draftPath, relative));
        }
      }
    } else if (!(await repo.isAncestor(remote, local))) {
      throw new GitNotFastForwardError(DRAFT_BRANCH);
    }
  }
  // Files the platform has that this folder lacks come back; a platform copy the caller confirmed replaces a local one.
  for (const { path: relative } of await repo.listTree(DRAFT_BRANCH)) {
    const place = absolute(draftPath, relative);
    if (overwrite.has(relative) || !(await files.exists(place))) {
      await files.write(place, await repo.readFile(DRAFT_BRANCH, relative));
    }
  }
  return { keptLocalPaths, switchedToGit };
}

/**
 * Which files of a draft folder differ from the platform's draft.
 * @lastreviewed null
 */
export interface DraftAudit {
  /**
   * Draft-relative, `/`-separated paths the platform has that this folder lacks.
   * @lastreviewed null
   */
  readonly missingLocally: string[];
  /**
   * Draft-relative paths present on both sides with different content.
   * @lastreviewed null
   */
  readonly changed: string[];
}

/**
 * Compares the local draft folder with the platform's draft. Fetches first; reads nothing else from the platform.
 * @returns the differences, or `undefined` when the folder is not a git working tree yet (there is nothing to compare
 *          against without pulling it).
 * @lastreviewed null
 */
export async function auditDraft(target: DraftTarget): Promise<DraftAudit | undefined> {
  const { ctx, draftPath } = target;
  const files = new WorkTreeFiles(ctx);
  if (!(await files.exists(path.join(draftPath, GIT_DIR)))) {
    return undefined;
  }
  const repo = await openRepo(target, draftPath);
  await repo.fetch();
  const remote = await remoteDraftOf(repo);
  const audit: { missingLocally: string[]; changed: string[] } = { missingLocally: [], changed: [] };
  if (!remote) {
    return audit;
  }
  for (const { path: relative } of await repo.listTree(remote)) {
    const local = await files.readOptional(absolute(draftPath, relative));
    if (!local) {
      audit.missingLocally.push(relative);
    } else if (!sameBytes(local, await repo.readFile(remote, relative))) {
      audit.changed.push(relative);
    }
  }
  return audit;
}

/**
 * Options of {@link pushDraft}.
 * @lastreviewed null
 */
export interface DraftPushOptions {
  readonly message: string;
  /**
   * Who the commit is by; the caller resolved it (see {@link resolveGitIdentity}).
   * @lastreviewed null
   */
  readonly author: GitIdentity;
  /**
   * Whether to publish the pushed draft.
   * @lastreviewed null
   */
  readonly snapshot: boolean;
  /**
   * A draft folder with no repo becomes the script's working tree (a push). Otherwise (a deploy) the folder is the
   * source of someone else's script and is left alone: its files go through a scratch clone.
   * @lastreviewed null
   */
  readonly adoptUnbound: boolean;
  /**
   * Draft-relative paths whose overwrite the caller confirmed up front.
   * @lastreviewed null
   */
  readonly preConfirmed?: readonly string[];
  /**
   * What a pre-git sync recorded per file; tells a local edit from a platform change in a folder without a repo.
   * @lastreviewed null
   */
  readonly lastSynced?: LastSyncedLookup;
}

/**
 * The publish half of a {@link DraftPushOutcome}.
 * @lastreviewed null
 */
export interface DraftPublishOutcome {
  /**
   * The commit the platform published, or `null` when the publish failed (see `error`).
   * @lastreviewed null
   */
  readonly publishedSha: string | null;
  /**
   * Why the publish failed, when it did.
   * @lastreviewed null
   */
  readonly error: string | null;
  /**
   * Whether the platform's published branch is at `publishedSha` after the publish: `null` when it could not be read.
   * @lastreviewed null
   */
  readonly liveVerified: boolean | null;
  /**
   * Draft-relative paths that differ between the published commit and the published branch, when they differ.
   * @lastreviewed null
   */
  readonly liveMismatches: string[];
}

/**
 * What {@link pushDraft} did.
 * @lastreviewed null
 */
export interface DraftPushOutcome {
  /**
   * The draft branch's head on the platform after the push.
   * @lastreviewed null
   */
  readonly commitSha: string;
  readonly switchedToGit: boolean;
  /**
   * Draft-relative paths that exist only on the platform and were kept because deleting them was not confirmed.
   * @lastreviewed null
   */
  readonly keptPlatformOnly: string[];
  /**
   * Set when the push was asked to publish.
   * @lastreviewed null
   */
  readonly publish?: DraftPublishOutcome;
}

interface OverwriteRisks {
  readonly changed: string[];
  readonly platformOnly: string[];
}

/**
 * The draft files whose push would overwrite or drop a platform version nobody here has seen: files the platform has
 * that differ from the local one, narrowed to the ones the platform changed (`moved`), and the platform's files with
 * no local copy at all.
 * @lastreviewed null
 */
async function findOverwriteRisks(opts: {
  repo: ScriptRepo;
  files: WorkTreeFiles;
  workRoot: string;
  remote: string;
  paths: readonly string[];
  moved: (relative: string, platformBytes: Uint8Array) => Promise<boolean>;
}): Promise<OverwriteRisks> {
  const risks: OverwriteRisks = { changed: [], platformOnly: [] };
  for (const relative of opts.paths) {
    const platform = await opts.repo.readFile(opts.remote, relative);
    const local = await opts.files.readOptional(absolute(opts.workRoot, relative));
    if (local && sameBytes(local, platform)) {
      continue;
    }
    if (!(await opts.moved(relative, platform))) {
      continue;
    }
    (local ? risks.changed : risks.platformOnly).push(relative);
  }
  return risks;
}

/**
 * The push's one overwrite confirmation, asked before anything leaves this machine. The safe answer is first so an
 * empty answer and auto-confirm both decline.
 * @throws an {@link Err.OverwriteDeclinedError} naming the files when the answer is not "Overwrite all".
 * @lastreviewed null
 */
export async function confirmOverwrittenFiles(opts: {
  ctx: Pick<ScriptContext, "prompt">;
  paths: readonly string[];
  isSnapshot: boolean;
  preConfirmed?: readonly string[];
}): Promise<void> {
  const preConfirmed = new Set((opts.preConfirmed ?? []).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));
  const toAsk = opts.paths.filter((p) => !preConfirmed.has(p));
  if (toAsk.length === 0) {
    return;
  }
  const list = toAsk.map((p) => `${p} (changed on the platform since this folder was last synced)`).join("\n");
  const CANCEL = "Cancel";
  const OVERWRITE_ALL = "Overwrite all";
  const answer = await opts.ctx.prompt.confirm(
    `${toAsk.length} file(s) would overwrite a platform version nobody here has seen:\n\n${list}\n\n` +
      `Nothing has been pushed yet. Overwrite all of them with your local files?`,
    [CANCEL, OVERWRITE_ALL],
    { destructive: true, safeOption: CANCEL }
  );
  if (answer !== OVERWRITE_ALL) {
    const kind = opts.isSnapshot ? "Snapshot push" : "Push";
    await opts.ctx.prompt.popup(`${kind} cancelled: nothing was pushed.`);
    throw new Err.OverwriteDeclinedError(
      `${kind} stopped before pushing anything: ${toAsk.length} file(s) were not overwritten, because ` +
        `each would overwrite a platform version nobody here has seen:\n\n${list}\n\n` +
        `Pull or audit them to see the platform versions before overwriting them.`,
      [...toAsk]
    );
  }
}

/**
 * Commits the draft folder's changes to the script's draft branch, pushes it and, for a snapshot, publishes it.
 *
 * Where the repo lives depends on the folder: a folder already bound to this script's repo is pushed in place; a
 * folder with no repo is bound to it (a push) or copied through a scratch clone (a deploy, or a folder bound to some
 * other script). A script still publishing over WebDAV is switched to git first, which is one-way.
 *
 * Before anything is pushed, one confirmation covers every platform file the push would overwrite, and another every
 * platform file with no local copy; the safe answers keep the platform's version.
 *
 * @throws an {@link Err.OverwriteDeclinedError} when an overwrite is not confirmed.
 * @throws {BsjsGitError} (a typed subclass) when git or the platform refuses.
 * @lastreviewed null
 */
export async function pushDraft(target: DraftTarget, options: DraftPushOptions): Promise<DraftPushOutcome> {
  const { ctx, draftPath } = target;
  const files = new WorkTreeFiles(ctx);
  const probe = await openRepo(target, draftPath, options.author);

  let mode: "inPlace" | "adopt" | "transplant";
  if (await files.exists(path.join(draftPath, GIT_DIR))) {
    const origin = await readOriginUrl(files, draftPath);
    mode = origin !== undefined && normalizeRepoUrl(origin) === normalizeRepoUrl(probe.url) ? "inPlace" : "transplant";
  } else {
    mode = options.adoptUnbound ? "adopt" : "transplant";
  }

  let repoDir = draftPath;
  let repo = probe;
  let switchedToGit = false;
  let scratch: string | undefined;
  try {
    if (mode === "adopt") {
      switchedToGit = (await probe.ensureGitModeResult()).switched;
      await bindDraftToRepo(target, files, async (cloned) => {
        await cloned.clone();
        return false;
      });
    } else if (mode === "transplant") {
      scratch = await files.mkdtemp(path.join(os.tmpdir(), "b6p-push-"));
      repoDir = scratch;
      repo = await openRepo(target, scratch, options.author);
      switchedToGit = (await repo.ensureGitModeResult()).switched;
      await repo.clone();
    }
    await ensureLocalExcludes(files, repoDir);
    await repo.fetch();

    const local = await repo.sha(DRAFT_BRANCH);
    const remote = await remoteDraftOf(repo);
    const platformMoved = mode === "inPlace" && !!remote && remote !== local && !(await repo.isAncestor(remote, local));

    let risks: OverwriteRisks = { changed: [], platformOnly: [] };
    if (remote) {
      if (mode === "inPlace") {
        if (platformMoved) {
          const moved = (await repo.diff(local, remote)).filter((c) => c.newOid !== undefined).map((c) => c.path);
          risks = await findOverwriteRisks({
            repo,
            files,
            workRoot: draftPath,
            remote,
            paths: moved,
            moved: async () => true,
          });
        }
      } else {
        const lastSynced = mode === "adopt" ? options.lastSynced : undefined;
        risks = await findOverwriteRisks({
          repo,
          files,
          workRoot: draftPath,
          remote,
          paths: (await repo.listTree(remote)).map((f) => f.path),
          moved: async (relative, platform) => {
            const recorded = lastSynced ? await lastSynced(relative) : null;
            return recorded === null || recorded !== sha512Hex(platform);
          },
        });
      }
    }
    await confirmOverwrittenFiles({
      ctx,
      paths: risks.changed,
      isSnapshot: options.snapshot,
      preConfirmed: options.preConfirmed,
    });

    const keptPlatformOnly: string[] = [];
    if (risks.platformOnly.length > 0) {
      // "No" is FIRST: an empty answer and auto-confirm both take options[0], and a yes drops platform files that may
      // exist nowhere else.
      const NO = "No";
      const YES = "Yes";
      let answer: string | undefined;
      try {
        answer = await ctx.prompt.confirm(
          `The following ${risks.platformOnly.length} platform file(s) have no local counterpart:\n\n` +
            `${risks.platformOnly.join("\n")}\n\nDelete them from the platform?`,
          [NO, YES],
          { destructive: true, safeOption: NO }
        );
      } catch (error) {
        // No answer at all (end of input, a dismissed dialog) is not a yes.
        ctx.logger.warn(`Delete prompt got no answer: ${error instanceof Error ? error.message : error}`);
      }
      if (answer !== YES) {
        keptPlatformOnly.push(...risks.platformOnly);
        ctx.prompt.warn(
          `Kept ${keptPlatformOnly.length} platform-only file(s): they are on the platform but not in your local ` +
            `draft folder, and deleting them was not confirmed.\n\n${keptPlatformOnly.join("\n")}\n\n` +
            `Their platform copies are included in this push.`
        );
      }
    }

    if (mode === "transplant") {
      await files.clearExceptGit(repoDir);
      const matcher = await sourceIgnoreMatcher(files, draftPath);
      for (const relative of await files.listFiles(draftPath, (r) => matcher.matches(absolute(draftPath, r)))) {
        await files.write(
          absolute(repoDir, relative),
          (await files.readOptional(absolute(draftPath, relative))) ?? new Uint8Array()
        );
      }
    }
    for (const relative of keptPlatformOnly) {
      await files.write(absolute(repoDir, relative), await repo.readFile(remote as string, relative));
    }

    const commitSha = platformMoved
      ? await repo.commit(options.message, options.author, { parents: [local, remote as string] })
      : await repo.commit(options.message, options.author);
    const head = commitSha ?? local;
    if (head !== remote) {
      await repo.push();
    }

    const outcome: DraftPushOutcome = { commitSha: head, switchedToGit, keptPlatformOnly };
    if (!options.snapshot) {
      return outcome;
    }
    return { ...outcome, publish: await publishAndVerify(repo) };
  } finally {
    if (scratch) {
      await files.remove(scratch);
    }
  }
}

async function sourceIgnoreMatcher(files: WorkTreeFiles, draftPath: string): Promise<GlobMatcher> {
  const raw = await files.readOptional(path.join(draftPath, SpecialFiles.GITIGNORE));
  const patterns = raw
    ? Buffer.from(raw)
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"))
    : [];
  return new GlobMatcher(draftPath, [SpecialFiles.DS_STORE_PATTERN, "**/*.b6p-tmp", ...patterns]);
}

/**
 * Publishes the pushed draft and reads back that the platform's published branch is at the commit the platform says it
 * published. A refusal or failure comes back as `error`, not a throw: the push itself already succeeded.
 * @lastreviewed null
 */
async function publishAndVerify(repo: ScriptRepo): Promise<DraftPublishOutcome> {
  let publishedSha: string;
  let refreshed: boolean;
  try {
    const result = await repo.publish();
    publishedSha = result.publishedSha;
    refreshed = result.refreshed;
  } catch (error) {
    if (error instanceof BsjsGitError) {
      return { publishedSha: null, error: error.message, liveVerified: null, liveMismatches: [] };
    }
    throw error;
  }
  try {
    if (!refreshed) {
      await repo.fetch();
    }
    const master = await repo.sha(REMOTE_MASTER);
    if (master === publishedSha) {
      return { publishedSha, error: null, liveVerified: true, liveMismatches: [] };
    }
    let liveMismatches: string[] = [];
    try {
      liveMismatches = (await repo.diff(publishedSha, master)).map((c) => c.path);
    } catch {
      // The published branch's objects may not be local; the sha mismatch is the finding.
    }
    return { publishedSha, error: null, liveVerified: false, liveMismatches };
  } catch {
    return { publishedSha, error: null, liveVerified: null, liveMismatches: [] };
  }
}

/**
 * The draft folder of a script root, `<root>/draft`.
 * @lastreviewed null
 */
export function draftFolderOf(rootPath: string): string {
  return path.join(rootPath, FolderNames.DRAFT);
}
