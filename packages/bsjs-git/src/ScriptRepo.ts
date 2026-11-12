import "./bufferShim";
import git, { type HttpClient, type PromiseFsClient, type PushResult } from "isomorphic-git";
import {
  BsjsGitError,
  GitIdentityError,
  GitModeError,
  GitNotFastForwardError,
  GitPushRejectedError,
  GitUnpushedChangesError,
  DRAFT_MOVED_REASON,
  PublishDraftMovedError,
  PublishFailedError,
  PublishRefusedError,
} from "./errors";
import { CsrfFetch, type ScriptAuth } from "./csrf";
import { basicTokenFetch, createProxyHttp, type FetchLike } from "./http";
import { compoundId, publishMutationFor, type ScriptRef } from "./scriptKey";

/**
 * The script's editable branch.
 * @lastreviewed null
 */
export const DRAFT_BRANCH = "draft";
/**
 * The script's published branch; only a publish moves it.
 * @lastreviewed null
 */
export const PUBLISHED_BRANCH = "master";

const REMOTE = "origin";
const SHA = /^[0-9a-f]{40}$/;

/**
 * Who a commit is by. Always supplied by the caller: this package never invents an identity.
 * @lastreviewed null
 */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Everything a {@link ScriptRepo} needs, with the platform and the file system injected.
 * @lastreviewed null
 */
export interface ScriptRepoOptions {
  /**
   * The file system the working tree and `.git` live on: Node's `fs`, or a browser one such as LightningFS. Injected so
   * this package imports nothing node-only.
   * @lastreviewed null
   */
  readonly fs: PromiseFsClient;
  /**
   * The working tree's directory on `fs` (the repo's `.git` is inside it).
   * @lastreviewed null
   */
  readonly dir: string;
  /**
   * The script.
   * @lastreviewed null
   */
  readonly script: ScriptRef;
  /**
   * The organization's base URL, such as `https://org.bluestep.net/`.
   * @lastreviewed null
   */
  readonly baseUrl: string | URL;
  /**
   * Who is calling: a `b6pt_` token, or the signed-in browser session (see {@link ScriptAuth}).
   * @lastreviewed null
   */
  readonly auth: ScriptAuth;
  /**
   * The default commit author. Optional here; a commit without one passed to {@link ScriptRepo.commit} throws.
   * @lastreviewed null
   */
  readonly author?: GitIdentity;
  /**
   * Overrides the global `fetch` (tests, or a runtime that needs a custom one).
   * @lastreviewed null
   */
  readonly fetch?: FetchLike;
}

/**
 * One commit, newest first in listings.
 * @lastreviewed null
 */
export interface CommitInfo {
  readonly sha: string;
  readonly author: GitIdentity;
  /**
   * ISO 8601, UTC.
   * @lastreviewed null
   */
  readonly timestamp: string;
  readonly message: string;
}

/**
 * One file in a tree at a revision.
 * @lastreviewed null
 */
export interface TreeFile {
  /**
   * Path from the repo root, without a leading slash.
   * @lastreviewed null
   */
  readonly path: string;
  /**
   * The blob's object id.
   * @lastreviewed null
   */
  readonly oid: string;
}

/**
 * One file that differs between two revisions.
 * @lastreviewed null
 */
export interface FileChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  /**
   * Blob id at the first revision; absent when added.
   * @lastreviewed null
   */
  readonly oldOid?: string;
  /**
   * Blob id at the second revision; absent when deleted.
   * @lastreviewed null
   */
  readonly newOid?: string;
}

/**
 * A working-tree file that differs from the last commit.
 * @lastreviewed null
 */
export interface WorkingChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
}

/**
 * What a push did.
 * @lastreviewed null
 */
export interface PushOutcome {
  readonly ref: string;
  /**
   * The commit the remote branch now points at.
   * @lastreviewed null
   */
  readonly sha: string;
}

/**
 * Paging for {@link ScriptRepo.log}.
 * @lastreviewed null
 */
export interface LogOptions {
  /**
   * A branch name or commit sha. Default: the draft branch.
   * @lastreviewed null
   */
  readonly rev?: string;
  /**
   * At most this many commits. Default 50.
   * @lastreviewed null
   */
  readonly limit?: number;
  /**
   * A commit sha to continue after (exclusive): pass the last sha of the previous page.
   * @lastreviewed null
   */
  readonly before?: string;
}

/**
 * Options of {@link ScriptRepo.clone}.
 * @lastreviewed null
 */
export interface CloneOptions {
  /** First run {@link ScriptRepo.ensureGitMode}. Off by default: a read-only clone must not flip a script. */
  readonly ensureGit?: boolean;
  /** Only this many commits of history (a shallow clone); more with {@link ScriptRepo.deepen}. Default: all. */
  readonly depth?: number;
  /** Fetch only `ref` (and the published branch, at the same depth) instead of every branch. Default false. */
  readonly singleBranch?: boolean;
  /** The branch to check out; default the draft branch. */
  readonly ref?: string;
}

/**
 * One page of {@link ScriptRepo.logPage}.
 * @lastreviewed null
 */
export interface LogPage {
  readonly commits: CommitInfo[];
  /** The history loaded here ends before the page did: deepen the clone and ask again. */
  readonly shallowBoundary: boolean;
}

/**
 * What {@link ScriptRepo.publish} did.
 * @lastreviewed null
 */
export interface PublishResult {
  /** The commit the platform promoted to the published branch. */
  readonly publishedSha: string;
  /** Whether the follow-up fetch that updates the local `origin/master` succeeded. The publish happened either way. */
  readonly refreshed: boolean;
  /** Why the follow-up fetch failed, when `refreshed` is false. */
  readonly refreshError?: unknown;
}

/**
 * The decoded `Uint8Array` of a blob as text.
 * @lastreviewed null
 */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function posixClean(path: string): string {
  if (path.includes("\\")) {
    throw new Error(`Not a path inside the working tree (use "/" separators): ${path}`);
  }
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..") || parts[0] === ".git") {
    throw new Error(`Not a path inside the working tree: ${path}`);
  }
  return parts.join("/");
}

function requireIdentity(identity: GitIdentity | undefined): GitIdentity {
  if (!identity || !identity.name.trim() || !identity.email.trim()) {
    throw new GitIdentityError("A commit needs an author with a name and an email supplied by the caller");
  }
  return identity;
}

/**
 * A script's git repo on the platform: clone, edit, commit and push the **draft** branch through the platform's
 * git proxy, publish it, and read history. Browser and Node alike; the file system is injected.
 *
 * Only the draft branch is pushed by default. The platform's forge refuses any proxied push to the published branch,
 * and a script is pushable only in GIT publish mode; both arrive as typed {@link BsjsGitError}s.
 * @lastreviewed null
 */
export class ScriptRepo {
  readonly dir: string;
  readonly script: ScriptRef;
  /**
   * The proxy URL of the script's repo.
   * @lastreviewed null
   */
  readonly url: string;
  readonly #fs: PromiseFsClient;
  readonly #http: HttpClient;
  readonly #origin: string;
  readonly #csrf: CsrfFetch;
  readonly #author: GitIdentity | undefined;
  readonly #fetch: FetchLike;

  constructor(options: ScriptRepoOptions) {
    this.#fs = options.fs;
    this.dir = options.dir;
    this.script = options.script;
    const base = new URL(String(options.baseUrl));
    this.#origin = `${base.origin}/`;
    this.url = `${this.#origin}git/${compoundId(options.script)}`;
    this.#author = options.author;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#csrf = new CsrfFetch(this.#fetch, this.#origin, options.auth);
    this.#http = createProxyHttp(
      options.auth.kind === "token"
        ? basicTokenFetch(options.auth.token, this.#fetch)
        : (url, init) => this.#csrf.request(url, init ?? {})
    );
  }

  /**
   * Clones every branch of the script's repo into {@link dir} and checks out the draft branch.
   *
   * @param options `ensureGit: true` first runs {@link ensureGitMode}, so a script still publishing over WebDAV is
   *        switched to git (one-way, irreversible on the platform) and gets its repo. Off by default: a read-only
   *        clone must not flip a script.
   * @throws {GitRepoNotFoundError} when the script has no repo or is not visible.
   * @lastreviewed null
   */
  async clone(options: CloneOptions = {}): Promise<void> {
    if (options.ensureGit) {
      await this.ensureGitMode();
    }
    const ref = options.ref ?? DRAFT_BRANCH;
    const singleBranch = options.singleBranch ?? false;
    const depth = options.depth;
    await git.clone({
      fs: this.#fs,
      http: this.#http,
      dir: this.dir,
      url: this.url,
      remote: REMOTE,
      ref,
      singleBranch,
      noTags: true,
      ...(depth !== undefined ? { depth } : {}),
    });
    if (singleBranch && ref !== PUBLISHED_BRANCH) {
      // The published head comes along at the same depth: the publish markers (what is live) need it.
      await this.#fetchBranch(PUBLISHED_BRANCH, depth === undefined ? {} : { depth });
    }
  }

  /**
   * Fetches more history into a shallow clone: `depth` further commits past what is loaded, on the draft and published
   * branches. A no-op on a clone with full history.
   * @lastreviewed null
   */
  async deepen(depth: number): Promise<void> {
    if (!(await this.isShallow())) {
      return;
    }
    await this.#fetchBranch(DRAFT_BRANCH, { depth, relative: true });
    await this.#fetchBranch(PUBLISHED_BRANCH, { depth, relative: true });
  }

  /**
   * Whether this clone has a history boundary (it was cloned with a depth and not fully deepened).
   * @lastreviewed null
   */
  async isShallow(): Promise<boolean> {
    return (await this.#shallowCommits()).size > 0;
  }

  async #shallowCommits(): Promise<Set<string>> {
    try {
      const text = await this.#fs.promises.readFile(`${this.dir}/.git/shallow`, "utf8");
      return new Set(
        String(text)
          .split(/\r?\n/)
          .filter((line) => SHA.test(line.trim()))
          .map((line) => line.trim())
      );
    } catch {
      return new Set();
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await this.#fs.promises.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** One branch at a depth; a branch the platform does not have (a never-published script has no master) is skipped. */
  async #fetchBranch(branch: string, extra: { depth?: number; relative?: boolean }): Promise<void> {
    try {
      await git.fetch({
        fs: this.#fs,
        http: this.#http,
        dir: this.dir,
        url: this.url,
        remote: REMOTE,
        ref: branch,
        singleBranch: true,
        tags: false,
        ...extra,
      });
    } catch (error) {
      if (!isGitError(error, "NotFoundError")) {
        throw error;
      }
    }
  }

  /**
   * Fetches every branch from the platform, updating the remote-tracking branches (`origin/draft`, `origin/master`).
   * @lastreviewed null
   */
  async fetch(): Promise<void> {
    await git.fetch({
      fs: this.#fs,
      http: this.#http,
      dir: this.dir,
      url: this.url,
      remote: REMOTE,
      singleBranch: false,
      tags: false,
    });
  }

  /**
   * Fetches, then fast-forwards the local draft to the platform's. A local draft with commits of its own is not
   * merged; that is the caller's decision.
   * @throws {GitNotFastForwardError} when the branches have diverged.
   * @lastreviewed null
   */
  async pull(): Promise<void> {
    try {
      await git.fastForward({
        fs: this.#fs,
        http: this.#http,
        dir: this.dir,
        url: this.url,
        remote: REMOTE,
        ref: DRAFT_BRANCH,
        singleBranch: true,
      });
    } catch (error) {
      if (isGitError(error, "FastForwardError", "MergeNotSupportedError")) {
        throw new GitNotFastForwardError(DRAFT_BRANCH);
      }
      throw error;
    }
  }

  /**
   * Checks out a branch (or sha), overwriting working-tree files when `force` is set.
   * @lastreviewed null
   */
  async checkout(ref: string = DRAFT_BRANCH, force = false): Promise<void> {
    await git.checkout({ fs: this.#fs, dir: this.dir, ref, remote: REMOTE, force });
  }

  /**
   * Writes a file into the working tree (creating folders); stage and commit with {@link commit}.
   * @lastreviewed null
   */
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const clean = posixClean(path);
    const parts = clean.split("/");
    let folder = this.dir;
    for (const part of parts.slice(0, -1)) {
      folder = `${folder}/${part}`;
      await this.#fs.promises.mkdir(folder).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "EEXIST") {
          throw error;
        }
      });
    }
    await this.#fs.promises.writeFile(`${this.dir}/${clean}`, data);
  }

  /**
   * Removes a file from the working tree; stage and commit with {@link commit}.
   * @lastreviewed null
   */
  async removeFile(path: string): Promise<void> {
    await this.#fs.promises.unlink(`${this.dir}/${posixClean(path)}`);
  }

  /**
   * The working-tree files that differ from the last commit.
   * @lastreviewed null
   */
  async status(): Promise<WorkingChange[]> {
    const matrix = await git.statusMatrix({ fs: this.#fs, dir: this.dir });
    const changes: WorkingChange[] = [];
    for (const [path, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) {
        continue;
      }
      if (workdir === 0) {
        if (head === 1) {
          changes.push({ path, status: "deleted" });
        }
      } else {
        changes.push({ path, status: head === 0 ? "added" : "modified" });
      }
    }
    return changes;
  }

  /**
   * Stages every working-tree change and commits it to the current branch.
   * @param message the commit message.
   * @param author overrides the constructor's author.
   * @param options `parents` makes the commit over exactly those parents (a merge when there are two) and commits even
   *        with nothing staged: the tree is whatever is staged now.
   * @returns the new commit's sha, or `undefined` when nothing changed.
   * @throws {GitIdentityError} when there is no author.
   * @lastreviewed null
   */
  async commit(
    message: string,
    author?: GitIdentity,
    options: { readonly parents?: readonly string[]; readonly force?: readonly string[] } = {}
  ): Promise<string | undefined> {
    const who = requireIdentity(author ?? this.#author);
    const parent = options.parents ? [...options.parents] : undefined;
    for (const forced of options.force ?? []) {
      const filepath = posixClean(forced);
      if (await this.#exists(`${this.dir}/${filepath}`)) {
        // Staged even when .gitignore matches it; once in the index it is tracked like any other file.
        await git.add({ fs: this.#fs, dir: this.dir, filepath, force: true });
      }
    }
    const matrix = await git.statusMatrix({ fs: this.#fs, dir: this.dir });
    let changed = 0;
    for (const [path, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) {
        continue;
      }
      changed += 1;
      if (workdir === 0) {
        if (stage !== 0) {
          await git.remove({ fs: this.#fs, dir: this.dir, filepath: path });
        }
      } else if (stage !== (workdir === 1 ? 1 : 2)) {
        await git.add({ fs: this.#fs, dir: this.dir, filepath: path });
      }
    }
    if (changed === 0 && !parent) {
      return undefined;
    }
    return git.commit({
      fs: this.#fs,
      dir: this.dir,
      message,
      author: who,
      committer: who,
      ...(parent ? { parent } : {}),
    });
  }

  /**
   * A branch name or sha as a commit sha; a branch prefers the local ref, then the platform's
   * (`origin/<branch>`).
   * @throws {BsjsGitError} (`REPO_NOT_FOUND`) when the local repo has no such branch or commit.
   * @lastreviewed null
   */
  async sha(rev: string): Promise<string> {
    return this.#resolve(rev);
  }

  /**
   * Whether `ancestor` is `descendant` or one of its ancestors (both branch names or shas).
   * @lastreviewed null
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const [oid, target] = await Promise.all([this.#resolve(ancestor), this.#resolve(descendant)]);
    if (oid === target) {
      return true;
    }
    return git.isDescendent({ fs: this.#fs, dir: this.dir, oid: target, ancestor: oid, depth: -1 });
  }

  /**
   * Points the local draft branch at `rev` and checks it out, overwriting working-tree files (the caller keeps
   * whatever local edits it wants to survive and writes them back afterwards).
   * @lastreviewed null
   */
  async resetDraft(rev: string): Promise<void> {
    const oid = await this.#resolve(rev);
    await git.writeRef({ fs: this.#fs, dir: this.dir, ref: `refs/heads/${DRAFT_BRANCH}`, value: oid, force: true });
    await git.checkout({ fs: this.#fs, dir: this.dir, ref: DRAFT_BRANCH, force: true });
  }

  /**
   * Pushes a branch (the draft by default) to the platform.
   * @throws {GitPushNotEnabledError} when the script is not in GIT publish mode.
   * @throws {GitPushRejectedError} when the forge refuses the ref update (the published branch is protected).
   * @throws {GitNotFastForwardError} when the remote branch has commits the local one lacks.
   * @lastreviewed null
   */
  async push(ref: string = DRAFT_BRANCH, force = false): Promise<PushOutcome> {
    let result: PushResult;
    try {
      result = await git.push({
        fs: this.#fs,
        http: this.#http,
        dir: this.dir,
        url: this.url,
        remote: REMOTE,
        ref,
        remoteRef: ref,
        force,
      });
    } catch (error) {
      if (isGitError(error, "PushRejectedError")) {
        throw new GitNotFastForwardError(ref);
      }
      if (isGitError(error, "GitPushError")) {
        // isomorphic-git throws when the server answered but refused the ref update; the result carries its words.
        result = (error as { data: { result: PushResult } }).data.result;
      } else {
        throw error;
      }
    }
    const status = result.refs[`refs/heads/${ref}`];
    if (!result.ok || (status && !status.ok)) {
      const reason = status?.error || result.error || "rejected";
      throw new GitPushRejectedError(ref, reason, ref === PUBLISHED_BRANCH || /protected|pre-receive/i.test(reason));
    }
    return { ref, sha: await this.#resolve(ref) };
  }

  /**
   * Makes sure the script publishes over git. Reads the script's `gitPublishing` and `gitCloneUrl` with a real query
   * (`remoteObject(id)`, no write) and, only when it is not already in GIT mode, runs the platform's own switch (`enableGitPublishing: true` on the script's update
   * mutation: synchronous, creates the repo and seeds `master` and `draft` from the WebDAV copy, and **one-way**).
   * Uses the same CSRF-carrying path as {@link publish}.
   *
   * @returns the script's clone URL as the platform reports it.
   * @throws {GitModeError} when the platform refuses or does not answer with a clone URL.
   * @lastreviewed null
   */
  async ensureGitMode(): Promise<string> {
    return (await this.ensureGitModeResult()).cloneUrl;
  }

  /**
   * Whether the script publishes over git, read with a query (no write, nothing is switched).
   * @returns `gitPublishing` and, when it is, the clone URL as the platform reports it.
   * @throws {GitModeError} when the platform does not answer.
   * @lastreviewed null
   */
  async gitMode(): Promise<{ readonly gitPublishing: boolean; readonly cloneUrl: string | null }> {
    const { typeName } = publishMutationFor(this.script);
    const read = await this.#gql(
      `query GitMode($id: String!) { remoteObject(id: $id) { ... on ${typeName} { gitPublishing gitCloneUrl } } }`,
      { id: compoundId(this.script) },
      (message, cause) => new GitModeError(message, cause)
    );
    const current = read.data?.remoteObject as GraphQlScript | undefined;
    return { gitPublishing: current?.gitPublishing === true, cloneUrl: current?.gitCloneUrl ?? null };
  }

  /**
   * The branch the working tree has checked out, or `undefined` when HEAD is detached.
   * @lastreviewed null
   */
  async currentBranch(): Promise<string | undefined> {
    return (await git.currentBranch({ fs: this.#fs, dir: this.dir, fullname: false })) ?? undefined;
  }

  /**
   * Paths whose staged content differs from both the last commit and the working-tree file: changes that exist only in
   * the index, which a checkout would discard.
   * @lastreviewed null
   */
  async stagedOnlyChanges(): Promise<string[]> {
    const matrix = await git.statusMatrix({ fs: this.#fs, dir: this.dir });
    return matrix.filter(([, , , stage]) => stage === 3).map(([filepath]) => filepath);
  }

  /**
   * {@link ensureGitMode}, also saying whether this call is the one that switched the script.
   * @returns `cloneUrl` as the platform reports it; `switched` is true when the script was in WEBDAV mode and this
   *          call turned git on (one-way).
   * @throws {GitModeError} as {@link ensureGitMode}.
   * @lastreviewed null
   */
  async ensureGitModeResult(): Promise<{ readonly cloneUrl: string; readonly switched: boolean }> {
    const { mutationName, inputType } = publishMutationFor(this.script);
    const fail = (message: string, cause?: unknown): BsjsGitError => new GitModeError(message, cause);
    const id = compoundId(this.script);
    const current = await this.gitMode();
    if (current.gitPublishing && current.cloneUrl) {
      return { cloneUrl: current.cloneUrl, switched: false };
    }
    const enabled = await this.#gql(
      `mutation EnableGit($inputs: [${inputType}!]!) { ${mutationName}(inputs: $inputs) { id gitPublishing gitCloneUrl } }`,
      { inputs: [{ topId: id, enableGitPublishing: true }] },
      fail
    );
    const node = enabled.data?.[mutationName];
    const item = Array.isArray(node) ? node[0] : node;
    if (!item?.gitPublishing || !item.gitCloneUrl) {
      throw new GitModeError("the script is not in git mode after enabling it, or the platform gave no clone URL");
    }
    return { cloneUrl: item.gitCloneUrl, switched: true };
  }

  async #gql(
    query: string,
    variables: unknown,
    fail: (message: string, cause?: unknown) => BsjsGitError
  ): Promise<GraphQlBody> {
    let response: Response;
    try {
      response = await this.#csrf.postJson("gql", JSON.stringify({ query, variables }));
    } catch (cause) {
      throw fail(cause instanceof Error ? cause.message : String(cause), cause);
    }
    if (!response.ok) {
      throw fail(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as GraphQlBody;
    if (body.errors?.length) {
      const first = body.errors[0];
      if (first.extensions?.code === "PUBLISH_REFUSED") {
        if (first.extensions.reason === DRAFT_MOVED_REASON) {
          throw new PublishDraftMovedError(first.extensions.publish, first.message);
        }
        throw new PublishRefusedError(first.extensions.reason, first.extensions.publish, first.message);
      }
      throw fail(body.errors.map((e) => e.message).join("; "));
    }
    return body;
  }

  /**
   * Publishes the draft: asks the platform to promote the pushed draft to the published branch (the same publish
   * the platform runs for any script, a `takeSnapshot` update) and returns the commit it published.
   *
   * @returns the published sha (`config.publishedSha`). The publish has happened once this resolves; `refreshed` says
   *          whether the follow-up fetch that brings `origin/master` up to date also succeeded (`refreshError` if not).
   * @throws {GitUnpushedChangesError} when the local draft is not what the platform holds.
   * @throws {PublishRefusedError} when the platform refuses (nothing is written); `reason` says why.
   * @lastreviewed null
   */
  async publish(): Promise<PublishResult> {
    await this.fetch();
    const local = await this.#resolve(DRAFT_BRANCH);
    const remote = await this.#resolve(`refs/remotes/${REMOTE}/${DRAFT_BRANCH}`).catch(() => undefined);
    if (local !== remote) {
      throw new GitUnpushedChangesError(local, remote);
    }
    const { mutationName, inputType } = publishMutationFor(this.script);
    const query = `mutation Publish($inputs: [${inputType}!]!) { ${mutationName}(inputs: $inputs) { id config { publishedSha } } }`;
    const body = await this.#gql(
      query,
      { inputs: [{ topId: compoundId(this.script), takeSnapshot: true, expectedDraftSha: local }] },
      (m, c) => new PublishFailedError(m, { cause: c })
    );
    const node = body.data?.[mutationName];
    const item = Array.isArray(node) ? node[0] : node;
    const sha = item?.config?.publishedSha;
    if (!sha || !SHA.test(sha)) {
      throw new PublishFailedError("the platform's answer carried no publishedSha");
    }
    try {
      await this.fetch();
    } catch (refreshError) {
      return { publishedSha: sha, refreshed: false, refreshError };
    }
    return { publishedSha: sha, refreshed: true };
  }

  /**
   * Commits on a branch or from a sha, newest first.
   * @param options paging: `limit` and `before` (the last sha of the previous page; the walk still starts at `rev`).
   * @lastreviewed null
   */
  async log(options: LogOptions = {}): Promise<CommitInfo[]> {
    return (await this.logPage(options)).commits;
  }

  /**
   * {@link log}, also saying whether the walk stopped at the shallow boundary of a bounded clone: `shallowBoundary` is
   * true when fewer commits than asked for came back because the history loaded here ends, not because the repo's does.
   * The caller then calls {@link deepen} and asks again from the same cursor.
   * @lastreviewed null
   */
  async logPage(options: LogOptions = {}): Promise<LogPage> {
    const limit = options.limit ?? 50;
    const start = await this.#resolve(options.rev ?? DRAFT_BRANCH);
    const { before } = options;
    // The walk always starts at `rev` and skips through the cursor, so a merge's other parent is not lost; a deeper
    // walk extends a shallower one, so the depth just grows until the cursor and one page are in view.
    let depth = before ? limit + 64 : limit;
    for (;;) {
      const entries = await git.log({ fs: this.#fs, dir: this.dir, ref: start, depth });
      const exhausted = entries.length < depth;
      const from = before ? entries.findIndex((entry) => entry.oid === before) + 1 : 0;
      const boundary =
        exhausted && entries.length > 0 && (await this.#shallowCommits()).has(entries[entries.length - 1].oid);
      if (before && from === 0 && exhausted) {
        return { commits: [], shallowBoundary: boundary };
      }
      if ((before && from === 0) || (entries.length < from + limit && !exhausted)) {
        depth *= 2;
        continue;
      }
      const page = entries.slice(from, from + limit);
      return {
        commits: page.map((entry) => ({
          sha: entry.oid,
          author: { name: entry.commit.author.name, email: entry.commit.author.email },
          timestamp: new Date(entry.commit.author.timestamp * 1000).toISOString(),
          message: entry.commit.message.replace(/\n+$/, ""),
        })),
        shallowBoundary: boundary && page.length < limit,
      };
    }
  }

  /**
   * The files of the tree at a branch or sha.
   * @lastreviewed null
   */
  async listTree(rev: string = DRAFT_BRANCH): Promise<TreeFile[]> {
    const ref = await this.#resolve(rev);
    const files: TreeFile[] = [];
    await git.walk({
      fs: this.#fs,
      dir: this.dir,
      trees: [git.TREE({ ref })],
      map: async (path, [entry]) => {
        if (entry && (await entry.type()) === "blob") {
          files.push({ path, oid: await entry.oid() });
        }
        return undefined;
      },
    });
    return files;
  }

  /**
   * A file's bytes at a branch or sha.
   * @lastreviewed null
   */
  async readFile(rev: string, path: string): Promise<Uint8Array> {
    const oid = await this.#resolve(rev);
    const { blob } = await git.readBlob({ fs: this.#fs, dir: this.dir, oid, filepath: posixClean(path) });
    return blob;
  }

  /**
   * A file's text at a branch or sha.
   * @lastreviewed null
   */
  async readText(rev: string, path: string): Promise<string> {
    return decodeText(await this.readFile(rev, path));
  }

  /**
   * The files that differ between two branches or shas, sorted by path.
   * @lastreviewed null
   */
  async diff(from: string, to: string): Promise<FileChange[]> {
    const [a, b] = await Promise.all([this.#resolve(from), this.#resolve(to)]);
    const changes: FileChange[] = [];
    await git.walk({
      fs: this.#fs,
      dir: this.dir,
      trees: [git.TREE({ ref: a }), git.TREE({ ref: b })],
      map: async (path, [before, after]) => {
        const beforeBlob = before && (await before.type()) === "blob";
        const afterBlob = after && (await after.type()) === "blob";
        if (!beforeBlob && !afterBlob) {
          return undefined;
        }
        const oldOid = beforeBlob ? await before.oid() : undefined;
        const newOid = afterBlob ? await after.oid() : undefined;
        if (oldOid === newOid) {
          return undefined;
        }
        const status = !oldOid ? "added" : !newOid ? "deleted" : "modified";
        changes.push({ path, status, ...(oldOid ? { oldOid } : {}), ...(newOid ? { newOid } : {}) });
        return undefined;
      },
    });
    return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }

  /**
   * A branch name or sha to a commit sha; a branch prefers the local ref, then the platform's.
   * @lastreviewed null
   */
  async #resolve(rev: string): Promise<string> {
    if (SHA.test(rev)) {
      return rev;
    }
    for (const candidate of [rev, `refs/remotes/${REMOTE}/${rev}`]) {
      try {
        return await git.resolveRef({ fs: this.#fs, dir: this.dir, ref: candidate });
      } catch (error) {
        if (!isGitError(error, "NotFoundError")) {
          throw error;
        }
      }
    }
    throw new BsjsGitError("REPO_NOT_FOUND", `No branch or commit named ${rev} in the local repo`);
  }
}

interface GraphQlBody {
  data?: Record<string, GraphQlScript | GraphQlScript[] | undefined>;
  errors?: { message: string; extensions?: { code?: string; reason?: string; publish?: unknown } }[];
}

interface GraphQlScript {
  config?: { publishedSha?: string };
  gitPublishing?: boolean;
  gitCloneUrl?: string | null;
}

function isGitError(error: unknown, ...codes: string[]): boolean {
  return typeof error === "object" && error !== null && codes.includes((error as { code?: string }).code ?? "");
}
