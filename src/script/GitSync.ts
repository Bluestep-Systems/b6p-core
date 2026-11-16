import * as path from "path";
import { createHash } from "node:crypto";
import * as os from "node:os";
import {
  BsjsGitError,
  DRAFT_BRANCH,
  GitNotFastForwardError,
  PublishRefusedError,
  ScriptRepo,
  type GitIdentity,
} from "@bluestep-systems/b6p-core-bsjs-git";
import { FolderNames, SpecialFiles } from "../constants";
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
const EXCLUDE_BEGIN = "# >>> b6p: rules this tool maintains (the script's own .gitignore is not touched)";
const EXCLUDE_END = "# <<< b6p";

/**
 * Files git must never pick up from a script's working tree: macOS folder metadata and this package's own atomic-write
 * temp files.
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
 * Whether a push or pull has switched the script to git yet, so an error thrown afterwards can say so.
 * @lastreviewed null
 */
interface SwitchTracker {
  switched: boolean;
}

/**
 * Tells a consumer that the one-way switch to git had already happened when this error was thrown, by setting
 * `switchedToGit` on it (a field of `OverwriteDeclinedError`, an added property on any other error). The error is
 * returned for rethrowing.
 * @lastreviewed null
 */
function markSwitched(error: unknown, tracker: SwitchTracker): unknown {
  if (tracker.switched && typeof error === "object" && error !== null) {
    Object.defineProperty(error, "switchedToGit", {
      value: true,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return error;
}

/**
 * Thrown when the script still publishes over WebDAV and switching it to git (which cannot be undone) was not confirmed.
 * Nothing was switched and nothing local was changed.
 * @lastreviewed null
 */
export class GitSwitchDeclinedError extends Error {
  constructor() {
    super("The script still publishes over WebDAV and switching it to git was not confirmed");
    this.name = "GitSwitchDeclinedError";
  }
}

/**
 * Thrown by a push when the draft folder's repo has another branch checked out: a commit would advance that branch while
 * the push sends the draft branch, so nothing is committed.
 * @lastreviewed null
 */
export class GitWrongBranchError extends Error {
  constructor(readonly branch: string | undefined) {
    super(
      `The draft folder has ${branch === undefined ? "a detached HEAD" : `the branch "${branch}"`} checked out, ` +
        `not "${DRAFT_BRANCH}": nothing was committed or pushed, because the platform's script is its "${DRAFT_BRANCH}" branch`
    );
    this.name = "GitWrongBranchError";
  }
}

/**
 * Thrown by a pull when files hold changes that exist only in the git index (staged, then edited again): updating the
 * working tree would discard them. Nothing was changed.
 * @lastreviewed null
 */
export class GitStagedChangesError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `${paths.length} file(s) have staged changes that differ from the file on disk, and a pull would discard them ` +
        `(nothing was changed):\n\n${paths.join("\n")}`
    );
    this.name = "GitStagedChangesError";
  }
}

/**
 * Thrown by a pull when an incoming file would be written through a symbolic link out of the draft folder. Nothing was
 * changed.
 * @lastreviewed null
 */
export class GitSymlinkError extends Error {
  constructor(readonly paths: string[]) {
    super(
      ` incoming file(s) would be written through a symbolic link out of the draft folder (nothing was ` +
        `changed):\n\n${paths.join("\n")}`
    );
    this.name = "GitSymlinkError";
  }
}

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
  lstat(p: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * File operations on a script's git working tree, over the context's {@link ScriptContext.gitFs}.
 *
 * A symbolic link is never followed out of a root: reads of one answer "absent", writes through one are refused, and
 * the paths are collected so the caller can warn once ({@link reportSkipped}).
 * @lastreviewed null
 */
class WorkTreeFiles {
  readonly #fs: FsPromises;
  readonly #ctx: ScriptContext;
  readonly #skipped = new Set<string>();

  constructor(ctx: ScriptContext) {
    if (!("promises" in ctx.gitFs)) {
      throw new Err.InvalidStateError("The git file system has no `promises` interface");
    }
    this.#ctx = ctx;
    this.#fs = ctx.gitFs.promises as unknown as FsPromises;
  }

  /**

   * Warns once about the symbolic links and out-of-root paths that were left alone, then forgets them.

   * @lastreviewed null

   */
  reportSkipped(): void {
    if (this.#skipped.size > 0) {
      this.#ctx.prompt.warn(
        `Skipped ${this.#skipped.size} path(s) that are, or sit behind, a symbolic link: a script's files are never ` +
          `read or written through a link out of its draft folder:\n\n${[...this.#skipped].join("\n")}`
      );
      this.#skipped.clear();
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      await this.#fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether `p` is under `root` with no symbolic link between them (nor `p` itself being one). A missing component
   * ends the walk: nothing there can be a link yet.
   * @lastreviewed null
   */
  async #contained(root: string, p: string): Promise<boolean> {
    const relative = path.relative(root, p);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return relative === "";
    }
    let current = root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        if ((await this.#fs.lstat(current)).isSymbolicLink()) {
          this.#skipped.add(p);
          return false;
        }
      } catch (error) {
        if (isMissing(error)) {
          return true;
        }
        throw error;
      }
    }
    return true;
  }

  /**

   * Whether `p` is, or sits behind, a symbolic link (or is outside `root`).

   * @lastreviewed null

   */
  async escapes(root: string, p: string): Promise<boolean> {
    return !(await this.#contained(root, p));
  }

  async readOptional(root: string, p: string): Promise<Uint8Array | undefined> {
    if (!(await this.#contained(root, p))) {
      return undefined;
    }
    try {
      return await this.#fs.readFile(p);
    } catch (error) {
      if (isMissing(error) || (error as { code?: string }).code === "EISDIR") {
        return undefined;
      }
      throw error;
    }
  }

  /**

   * @returns false when the write was refused because the path is, or sits behind, a symbolic link.

   * @lastreviewed null

   */
  async write(root: string, p: string, data: Uint8Array): Promise<boolean> {
    if (!(await this.#contained(root, p))) {
      this.#skipped.add(p);
      return false;
    }
    await this.#fs.mkdir(path.dirname(p), { recursive: true });
    await this.#fs.writeFile(p, data);
    return true;
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
   * Every regular file under `root` as a `/`-separated path relative to it, skipping the repo's own `.git` and every
   * symbolic link.
   * @lastreviewed null
   */
  async listFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (relativeDir: string): Promise<void> => {
      const names = await this.#fs.readdir(relativeDir === "" ? root : path.join(root, ...relativeDir.split("/")));
      for (const name of names) {
        if (name === GIT_DIR) {
          continue;
        }
        const relative = relativeDir === "" ? name : `${relativeDir}/${name}`;
        const place = path.join(root, ...relative.split("/"));
        const stat = await this.#fs.lstat(place);
        if (stat.isSymbolicLink()) {
          this.#skipped.add(place);
        } else if (stat.isDirectory()) {
          await walk(relative);
        } else {
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
  const raw = await files.readOptional(draftPath, path.join(draftPath, GIT_DIR, "config"));
  if (!raw) {
    return undefined;
  }
  const match = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(Buffer.from(raw).toString("utf8"));
  return match?.[1];
}

/**
 * The rules of a script root's old `.gitignore` (which governed what a WebDAV push uploaded) as git rules for the repo
 * rooted at `draft/`. That file's patterns matched paths relative to the script root, so only the ones that reached
 * into `draft/` applied to the draft's files: `draft/<rest>` becomes `/<rest>` (anchored at the draft root) and
 * `**` + `/<rest>` stays as it is. Everything else never matched a draft file and is dropped.
 * @lastreviewed null
 */
export function legacyIgnoreRulesForDraft(rootGitignore: string): string[] {
  const rules: string[] = [];
  for (const raw of rootGitignore.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).replace(/^\//, "");
    const prefix = negated ? "!" : "";
    if (pattern.startsWith(`${FolderNames.DRAFT}/`)) {
      rules.push(`${prefix}/${pattern.slice(FolderNames.DRAFT.length + 1)}`);
    } else if (pattern.startsWith("**/")) {
      rules.push(`${prefix}${pattern}`);
    }
  }
  return rules;
}

/**
 * Writes the repo's `info/exclude` (never committed): the temp and metadata files git must not pick up, and the old
 * script-root `.gitignore` rules ({@link legacyIgnoreRulesForDraft}), so a file the old tool never uploaded is never
 * committed now. The block is rewritten on every call, so an edited root `.gitignore` takes effect; other lines of the
 * file are left alone.
 * @param scriptRoot The script root whose `.gitignore` the rules come from
 * @lastreviewed null
 */
async function ensureLocalExcludes(files: WorkTreeFiles, repoDir: string, scriptRoot: string): Promise<void> {
  const exclude = path.join(repoDir, GIT_DIR, "info", "exclude");
  const existing = await files.readOptional(repoDir, exclude);
  const text = existing ? Buffer.from(existing).toString("utf8") : "";
  const begin = text.indexOf(EXCLUDE_BEGIN);
  const end = text.indexOf(EXCLUDE_END);
  const kept = begin >= 0 && end > begin ? text.slice(0, begin) + text.slice(end + EXCLUDE_END.length) : text;
  const rootRules = await files.readOptional(scriptRoot, path.join(scriptRoot, SpecialFiles.GITIGNORE));
  const rules = [
    ...LOCAL_EXCLUDES,
    ...(rootRules ? legacyIgnoreRulesForDraft(Buffer.from(rootRules).toString("utf8")) : []),
  ];
  const block = [EXCLUDE_BEGIN, ...rules, EXCLUDE_END].join("\n");
  const base = kept.trimEnd();
  await files.write(repoDir, exclude, Buffer.from(`${base}${base ? "\n" : ""}${block}\n`));
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
 * The consent to switch a WebDAV script to git, which cannot be undone, asked before anything is switched or changed
 * locally. The safe answer is first, so an empty answer and auto-confirm decline.
 * @param enableGit The caller already confirmed, so do not ask.
 * @throws {GitSwitchDeclinedError} when it is not given.
 * @lastreviewed null
 */
async function requireSwitchConsent(ctx: ScriptContext, enableGit: boolean | undefined): Promise<void> {
  if (enableGit) {
    return;
  }
  const CANCEL = "Cancel";
  const SWITCH = "Switch to git";
  const answer = await ctx.prompt.confirm(
    "This script has no git repository: it still publishes over WebDAV. Working with it through git switches it to " +
      "git publishing, which cannot be undone, and its draft and snapshot then no longer accept WebDAV writes. " +
      "Switch it to git?",
    [CANCEL, SWITCH],
    { destructive: true, safeOption: CANCEL }
  );
  if (answer !== SWITCH) {
    throw new GitSwitchDeclinedError();
  }
}

/**
 * Clones the script into an empty scratch folder next to the draft (`<root>/.b6p-adopt`). Nothing of the draft folder
 * is touched until {@link installGit} moves the clone's `.git` in.
 * @lastreviewed null
 */
async function cloneToScratch(
  target: DraftTarget,
  files: WorkTreeFiles,
  author?: GitIdentity
): Promise<{ repo: ScriptRepo; scratch: string }> {
  const scratch = path.join(path.dirname(target.draftPath), ".b6p-adopt");
  await files.remove(scratch);
  await files.mkdirp(scratch);
  try {
    const repo = await openRepo(target, scratch, author);
    await repo.clone();
    return { repo, scratch };
  } catch (error) {
    await files.remove(scratch);
    throw error;
  }
}

/**
 * Makes the scratch clone's `.git` the draft folder's, so the folder's files become the working tree of the script's
 * repo as they stand: what differs from the platform then shows as local changes. Replaces a `.git` that is there.
 * @lastreviewed null
 */
async function installGit(files: WorkTreeFiles, scratch: string, draftPath: string): Promise<void> {
  await files.mkdirp(draftPath);
  await files.remove(path.join(draftPath, GIT_DIR));
  await files.rename(path.join(scratch, GIT_DIR), path.join(draftPath, GIT_DIR));
}

/**
 * What a pull did to the local draft.
 * @lastreviewed null
 */
export interface DraftPullOutcome {
  /**
   * Absolute paths of local files kept instead of being replaced by the platform's: edits to files the platform also
   * changed, and local files (ignored or untracked) at paths the platform has started tracking.
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
 *  - no repo: the script's mode is read first. A WebDAV script needs the one-way switch, confirmed before anything is
 *    switched or touched. An empty folder then gets a clone; a folder with files is bound to the repo as it stands (a
 *    file the platform has that differs from the local one is kept when its last sync record says it was edited here,
 *    and replaced otherwise);
 *  - a repo: fetches and fast-forwards. A local edit to a file the platform also changed, and a local ignored or
 *    untracked file at a path the platform now tracks, are kept and reported. Files the platform has that are missing
 *    locally are restored.
 *
 * Nothing is ever written through a symbolic link.
 *
 * @throws {GitSwitchDeclinedError} when a WebDAV script needs the switch and it was declined.
 * @throws {GitNotFastForwardError} when the local draft has commits of its own and the platform moved too.
 * @throws {GitStagedChangesError} when index-only changes would be discarded.
 * @lastreviewed null
 */
export async function pullDraft(target: DraftTarget, options: DraftPullOptions = {}): Promise<DraftPullOutcome> {
  const files = new WorkTreeFiles(target.ctx);
  const tracker: SwitchTracker = { switched: false };
  try {
    return await pullDraftInner(target, options, files, tracker);
  } catch (error) {
    throw markSwitched(error, tracker);
  } finally {
    files.reportSkipped();
  }
}

async function pullDraftInner(
  target: DraftTarget,
  options: DraftPullOptions,
  files: WorkTreeFiles,
  tracker: SwitchTracker
): Promise<DraftPullOutcome> {
  const { ctx, draftPath } = target;
  const scriptRoot = path.dirname(draftPath);
  const overwrite = new Set(options.overwrite ?? []);
  const keptLocalPaths: string[] = [];
  let switchedToGit = false;
  const repo = await openRepo(target, draftPath);

  if (!(await files.exists(path.join(draftPath, GIT_DIR)))) {
    if (!(await repo.gitMode()).gitPublishing) {
      await requireSwitchConsent(ctx, options.enableGit);
      switchedToGit = (await repo.ensureGitModeResult()).switched;
      tracker.switched = switchedToGit;
    }
    if (!(await files.hasEntries(draftPath))) {
      await files.mkdirp(draftPath);
      try {
        await repo.clone();
      } catch (error) {
        await files.remove(path.join(draftPath, GIT_DIR));
        throw error;
      }
      await ensureLocalExcludes(files, draftPath, scriptRoot);
      return { keptLocalPaths, switchedToGit };
    }
    const { scratch } = await cloneToScratch(target, files);
    try {
      await installGit(files, scratch, draftPath);
    } finally {
      await files.remove(scratch);
    }
    await ensureLocalExcludes(files, draftPath, scriptRoot);
    for (const { path: relative } of await repo.listTree(DRAFT_BRANCH)) {
      const remote = await repo.readFile(DRAFT_BRANCH, relative);
      const place = absolute(draftPath, relative);
      const local = await files.readOptional(draftPath, place);
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
      await files.write(draftPath, place, remote);
    }
    return { keptLocalPaths, switchedToGit };
  }

  await ensureLocalExcludes(files, draftPath, scriptRoot);
  await repo.fetch();
  const remote = await remoteDraftOf(repo);
  const local = await repo.sha(DRAFT_BRANCH);
  if (remote && remote !== local) {
    if (await repo.isAncestor(local, remote)) {
      const incoming = await repo.diff(local, remote);
      const changed = new Set(incoming.filter((c) => c.newOid !== undefined).map((c) => c.path));
      const added = incoming.filter((c) => c.status === "added").map((c) => c.path);
      const escaping: string[] = [];
      for (const relative of changed) {
        if (await files.escapes(draftPath, absolute(draftPath, relative))) {
          escaping.push(relative);
        }
      }
      if (escaping.length > 0) {
        throw new GitSymlinkError(escaping);
      }
      const staged = await repo.stagedOnlyChanges();
      if (staged.length > 0) {
        throw new GitStagedChangesError(staged);
      }
      const dirty = new Set((await repo.status()).filter((s) => s.status !== "deleted").map((s) => s.path));
      // Everything the checkout would clobber and that is ours: edited or untracked files, and files at paths the
      // platform has just started tracking (an ignored local file is invisible to the status).
      const saved = new Map<string, Uint8Array>();
      for (const relative of new Set([...dirty, ...added])) {
        const bytes = await files.readOptional(draftPath, absolute(draftPath, relative));
        if (bytes) {
          saved.set(relative, bytes);
        }
      }
      await repo.resetDraft(remote);
      for (const [relative, bytes] of saved) {
        if (overwrite.has(relative)) {
          continue;
        }
        const place = absolute(draftPath, relative);
        const platform = await files.readOptional(draftPath, place);
        if (await files.write(draftPath, place, bytes)) {
          if (changed.has(relative) && !(platform && sameBytes(platform, bytes))) {
            keptLocalPaths.push(place);
          }
        }
      }
    } else if (!(await repo.isAncestor(remote, local))) {
      throw new GitNotFastForwardError(DRAFT_BRANCH);
    }
  }
  // A platform copy the caller confirmed replaces a local one, and it is the fetched platform draft that is read: the
  // local branch may be ahead of it.
  const platformRev = remote ?? DRAFT_BRANCH;
  for (const relative of overwrite) {
    let bytes: Uint8Array;
    try {
      bytes = await repo.readFile(platformRev, relative);
    } catch (error) {
      if (error instanceof BsjsGitError || (error as { code?: string }).code === "NotFoundError") {
        continue;
      }
      throw error;
    }
    await files.write(draftPath, absolute(draftPath, relative), bytes);
  }
  // Files the local draft has that this folder lacks come back.
  for (const { path: relative } of await repo.listTree(DRAFT_BRANCH)) {
    const place = absolute(draftPath, relative);
    if (!(await files.exists(place))) {
      await files.write(draftPath, place, await repo.readFile(DRAFT_BRANCH, relative));
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
  try {
    const repo = await openRepo(target, draftPath);
    await repo.fetch();
    const remote = await remoteDraftOf(repo);
    const audit: { missingLocally: string[]; changed: string[] } = { missingLocally: [], changed: [] };
    if (!remote) {
      return audit;
    }
    for (const { path: relative } of await repo.listTree(remote)) {
      const local = await files.readOptional(draftPath, absolute(draftPath, relative));
      if (!local) {
        audit.missingLocally.push(relative);
      } else if (!sameBytes(local, await repo.readFile(remote, relative))) {
        audit.changed.push(relative);
      }
    }
    return audit;
  } finally {
    files.reportSkipped();
  }
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
   * Write the build manifest into the commit: set it only after a snapshot build that succeeded and emitted
   * everything, so the output and its manifest are committed together; leave it unset after a failed or partial build
   * (an existing manifest then stays and goes stale, which a publish refuses), and for a push that did not build.
   * `externallyBuilt` is the script's own flag: such a script gets no manifest.
   * @lastreviewed null
   */
  readonly buildManifest?: { readonly externallyBuilt?: boolean };
  /**
   * The caller already confirmed switching a WebDAV script to git, so do not ask.
   * @lastreviewed null
   */
  readonly enableGit?: boolean;
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
 * A refusal of the publish by the platform, structured: `reason` is the server's `extensions.reason` (for example
 * `DRAFT_MOVED`, `BUILD_STALE`, `BUILD_MANIFEST_MISSING`, `BUILD_MANIFEST_INVALID`, `ENTRYPOINT_MISSING`) and `withheld`
 * its `extensions.publish.withheld` (the stale paths, or the manifest's path; empty when the server gave none).
 * @lastreviewed null
 */
export interface PublishRefusal {
  readonly reason: string;
  readonly withheld: string[];
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
   * The platform's structured refusal, when it refused the publish (`PUBLISH_REFUSED`): its `reason` and the paths in
   * `publish.withheld`. `null` for any other outcome.
   * @lastreviewed null
   */
  readonly refusal: PublishRefusal | null;
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
  /**
   * Platform files that differ from the local one and that the platform changed.
   * @lastreviewed null
   */
  readonly changed: string[];
  /**
   * Platform files with no local copy that the platform gained.
   * @lastreviewed null
   */
  readonly platformOnly: string[];
  /**
   * Files the platform deleted that this folder still has: pushing would bring them back.
   * @lastreviewed null
   */
  readonly deleted: string[];
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
}): Promise<Pick<OverwriteRisks, "changed" | "platformOnly">> {
  const risks: { changed: string[]; platformOnly: string[] } = { changed: [], platformOnly: [] };
  for (const relative of opts.paths) {
    const platform = await opts.repo.readFile(opts.remote, relative);
    const local = await opts.files.readOptional(opts.workRoot, absolute(opts.workRoot, relative));
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
 * @param opts.paths Files that differ from a platform version nobody here has seen
 * @param opts.deleted Files the platform deleted since the last sync that this push would bring back
 * @throws an {@link Err.OverwriteDeclinedError} naming the files when the answer is not "Overwrite all".
 * @lastreviewed null
 */
export async function confirmOverwrittenFiles(opts: {
  ctx: Pick<ScriptContext, "prompt">;
  paths: readonly string[];
  deleted?: readonly string[];
  isSnapshot: boolean;
  preConfirmed?: readonly string[];
}): Promise<void> {
  const preConfirmed = new Set((opts.preConfirmed ?? []).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));
  const changed = opts.paths.filter((p) => !preConfirmed.has(p));
  const deleted = (opts.deleted ?? []).filter((p) => !preConfirmed.has(p));
  const toAsk = [...changed, ...deleted];
  if (toAsk.length === 0) {
    return;
  }
  const list = [
    ...changed.map((p) => `${p} (changed on the platform since this folder was last synced)`),
    ...deleted.map(
      (p) => `${p} (deleted on the platform since this folder was last synced; pushing would bring it back)`
    ),
  ].join("\n");
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
 * Where the repo lives depends on the folder, and the script's publish mode (read first, never assumed from a repo
 * being there) decides whether a switch is needed:
 *  - a folder bound to this script's repo whose script is in git mode is pushed in place (and must have the draft
 *    branch checked out);
 *  - a folder with no repo (a push), or one bound to a read-only mirror of a script that still publishes over WebDAV, is
 *    bound to the repo, but only after every consent has been given: the scratch clone is read, the overwrite
 *    confirmation asked, and only then is the folder's `.git` installed;
 *  - a deploy, or a folder bound to some other script, copies its files through a scratch clone.
 * A script still publishing over WebDAV is switched to git first, which is one-way and confirmed first (`enableGit`
 * pre-confirms). Its platform draft cannot be compared before it is switched, so the overwrite confirmation for it
 * follows the switch, and nothing is installed locally until it is given.
 *
 * Before anything is pushed, one confirmation covers every platform file the push would overwrite or bring back, and
 * another every platform file with no local copy; the safe answers keep the platform's version. The files committed
 * follow git's ignore rules, including the old script-root `.gitignore` rules ({@link legacyIgnoreRulesForDraft}).
 * Nothing is read through a symbolic link.
 *
 * Once the push has succeeded, nothing that follows throws: a failed publish comes back as `publish.error`.
 *
 * @throws an {@link Err.OverwriteDeclinedError} when an overwrite is not confirmed.
 * @throws {GitSwitchDeclinedError} when the switch is needed and declined.
 * @throws {GitWrongBranchError} when the folder's repo has another branch checked out.
 * @throws {BsjsGitError} (a typed subclass) when git or the platform refuses the push.
 * @lastreviewed null
 */
export async function pushDraft(target: DraftTarget, options: DraftPushOptions): Promise<DraftPushOutcome> {
  const files = new WorkTreeFiles(target.ctx);
  const tracker: SwitchTracker = { switched: false };
  try {
    return await pushDraftInner(target, options, files, tracker);
  } catch (error) {
    throw markSwitched(error, tracker);
  } finally {
    files.reportSkipped();
  }
}

async function pushDraftInner(
  target: DraftTarget,
  options: DraftPushOptions,
  files: WorkTreeFiles,
  tracker: SwitchTracker
): Promise<DraftPushOutcome> {
  const { ctx, draftPath } = target;
  const scriptRoot = path.dirname(draftPath);
  const probe = await openRepo(target, draftPath, options.author);

  const hasGit = await files.exists(path.join(draftPath, GIT_DIR));
  const origin = hasGit ? await readOriginUrl(files, draftPath) : undefined;
  const boundHere = origin !== undefined && normalizeRepoUrl(origin) === normalizeRepoUrl(probe.url);
  const inGitMode = (await probe.gitMode()).gitPublishing;

  let mode: "inPlace" | "adopt" | "transplant";
  if (boundHere && inGitMode) {
    mode = "inPlace";
  } else if (boundHere || (!hasGit && options.adoptUnbound)) {
    mode = "adopt";
  } else {
    mode = "transplant";
  }

  if (mode === "inPlace") {
    const branch = await probe.currentBranch();
    if (branch !== DRAFT_BRANCH) {
      throw new GitWrongBranchError(branch);
    }
  }

  let switchedToGit = false;
  if (!inGitMode) {
    await requireSwitchConsent(ctx, options.enableGit);
    switchedToGit = (await probe.ensureGitModeResult()).switched;
    tracker.switched = switchedToGit;
  }

  let repo = probe;
  let scratch: string | undefined;
  let tempDir: string | undefined;
  try {
    if (mode === "adopt") {
      const cloned = await cloneToScratch(target, files, options.author);
      repo = cloned.repo;
      scratch = cloned.scratch;
    } else if (mode === "transplant") {
      tempDir = await files.mkdtemp(path.join(os.tmpdir(), "b6p-push-"));
      repo = await openRepo(target, tempDir, options.author);
      await repo.clone();
      await ensureLocalExcludes(files, tempDir, scriptRoot);
    } else {
      await ensureLocalExcludes(files, draftPath, scriptRoot);
      await repo.fetch();
    }

    const local = await repo.sha(DRAFT_BRANCH);
    const remote = await remoteDraftOf(repo);
    const platformMoved = mode === "inPlace" && !!remote && remote !== local && !(await repo.isAncestor(remote, local));

    let risks: OverwriteRisks = { changed: [], platformOnly: [], deleted: [] };
    if (remote) {
      if (mode === "inPlace") {
        if (platformMoved) {
          const diff = await repo.diff(local, remote);
          const found = await findOverwriteRisks({
            repo,
            files,
            workRoot: draftPath,
            remote,
            paths: diff.filter((c) => c.newOid !== undefined).map((c) => c.path),
            moved: async () => true,
          });
          const deleted: string[] = [];
          for (const change of diff.filter((c) => c.newOid === undefined)) {
            if (await files.readOptional(draftPath, absolute(draftPath, change.path))) {
              deleted.push(change.path);
            }
          }
          risks = { ...found, deleted };
        }
      } else {
        const lastSynced = mode === "adopt" ? options.lastSynced : undefined;
        // A read-only mirror this folder was bound to knows what the platform had when it was pulled.
        const mirrorHead = hasGit && mode === "adopt" ? probe : undefined;
        const found = await findOverwriteRisks({
          repo,
          files,
          workRoot: draftPath,
          remote,
          paths: (await repo.listTree(remote)).map((f) => f.path),
          moved: async (relative, platform) => {
            if (mirrorHead) {
              const before = await mirrorHead.readFile(DRAFT_BRANCH, relative).catch(() => undefined);
              return before === undefined || !sameBytes(before, platform);
            }
            const recorded = lastSynced ? await lastSynced(relative) : null;
            return recorded === null || recorded !== sha512Hex(platform);
          },
        });
        risks = { ...found, deleted: [] };
      }
    }
    await confirmOverwrittenFiles({
      ctx,
      paths: risks.changed,
      deleted: risks.deleted,
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

    // Every consent is in: only now does the draft folder change.
    if (mode === "adopt" && scratch) {
      await installGit(files, scratch, draftPath);
      repo = await openRepo(target, draftPath, options.author);
      await ensureLocalExcludes(files, draftPath, scriptRoot);
    }
    const repoDir = mode === "transplant" ? (tempDir as string) : draftPath;
    if (mode === "transplant") {
      await files.clearExceptGit(repoDir);
      // Every file is copied and git's ignore rules (the source's `.gitignore` and the rules carried over) decide at
      // commit time what is committed.
      for (const relative of await files.listFiles(draftPath)) {
        const bytes = await files.readOptional(draftPath, absolute(draftPath, relative));
        if (bytes) {
          await files.write(repoDir, absolute(repoDir, relative), bytes);
        }
      }
    }
    for (const relative of keptPlatformOnly) {
      await files.write(repoDir, absolute(repoDir, relative), await repo.readFile(remote as string, relative));
    }

    const commitSha = platformMoved
      ? await repo.commit(options.message, options.author, {
          parents: [local, remote as string],
          ...(options.buildManifest ? { buildManifest: options.buildManifest } : {}),
        })
      : await repo.commit(options.message, options.author, {
          ...(options.buildManifest ? { buildManifest: options.buildManifest } : {}),
        });
    const head = commitSha ?? local;
    if (head !== remote) {
      const pushed = await repo.push();
      if (pushed.sha !== head) {
        throw new GitWrongBranchError(await repo.currentBranch());
      }
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
    if (tempDir) {
      await files.remove(tempDir);
    }
  }
}

/**
 * Publishes the pushed draft and reads back that the platform's published branch is at the commit the platform says it
 * published. Anything that goes wrong comes back as `error`, never a throw: the push itself already succeeded, and the
 * caller must still learn its commit.
 * @lastreviewed null
 */
/**
 * The structured refusal in an error, when it is a `PUBLISH_REFUSED`.
 * @lastreviewed null
 */
function refusalOf(error: unknown): PublishRefusal | null {
  if (!(error instanceof PublishRefusedError)) {
    return null;
  }
  const withheld = (error.details as { withheld?: unknown } | null | undefined)?.withheld;
  return {
    reason: error.reason ?? "",
    withheld: Array.isArray(withheld) ? withheld.filter((p): p is string => typeof p === "string") : [],
  };
}

async function publishAndVerify(repo: ScriptRepo): Promise<DraftPublishOutcome> {
  let publishedSha: string;
  let refreshed: boolean;
  try {
    const result = await repo.publish();
    publishedSha = result.publishedSha;
    refreshed = result.refreshed;
  } catch (error) {
    return {
      publishedSha: null,
      error: error instanceof Error ? error.message : String(error),
      refusal: refusalOf(error),
      liveVerified: null,
      liveMismatches: [],
    };
  }
  try {
    if (!refreshed) {
      await repo.fetch();
    }
    const master = await repo.sha(REMOTE_MASTER);
    if (master === publishedSha) {
      return { publishedSha, error: null, refusal: null, liveVerified: true, liveMismatches: [] };
    }
    let liveMismatches: string[] = [];
    try {
      liveMismatches = (await repo.diff(publishedSha, master)).map((c) => c.path);
    } catch {
      // The published branch's objects may not be local; the sha mismatch is the finding.
    }
    return { publishedSha, error: null, refusal: null, liveVerified: false, liveMismatches };
  } catch {
    return { publishedSha, error: null, refusal: null, liveVerified: null, liveMismatches: [] };
  }
}

/**
 * The draft folder of a script root, `<root>/draft`.
 * @lastreviewed null
 */
export function draftFolderOf(rootPath: string): string {
  return path.join(rootPath, FolderNames.DRAFT);
}
