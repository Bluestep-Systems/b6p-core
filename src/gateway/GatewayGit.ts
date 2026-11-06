import * as nodeFs from "node:fs";
import * as path from "node:path";
import git from "isomorphic-git";
import type { GitHttpRequest, GitHttpResponse, HttpClient, WalkerEntry } from "isomorphic-git";
import { Http } from "../constants/Http";
import { Err } from "../Err";
import type { GatewayClient } from "./GatewayClient";
import { gatewayErrorFor } from "./GatewayClient";
import type { GatewayContext } from "./GatewayContext";
import { redactToken } from "./GatewayToken";

/**
 * The remote name every clone made here uses.
 * @lastreviewed null
 */
const REMOTE = "origin";

/**
 * Options for {@link GatewayGit.clone}.
 * @lastreviewed null
 */
export interface GatewayCloneOptions {
  /**
   * The branch or tag to check out. Defaults to the remote's default branch.
   * @lastreviewed null
   */
  ref?: string;
}

/**
 * What {@link GatewayGit.clone} did.
 * @lastreviewed null
 */
export interface GatewayCloneResult {
  /**
   * The checked-out branch, or `null` when `ref` named a tag (a detached head).
   * @lastreviewed null
   */
  branch: string | null;
  /**
   * The commit now checked out.
   * @lastreviewed null
   */
  head: string;
}

/**
 * The state of a clone made by {@link GatewayGit}.
 * @lastreviewed null
 */
export interface GatewayGitStatus {
  /**
   * The current branch, or `null` on a detached head.
   * @lastreviewed null
   */
  branch: string | null;
  /**
   * The branch's upstream as `origin/<branch>`, or `null` when it tracks nothing.
   * @lastreviewed null
   */
  upstream: string | null;
  /**
   * The commit checked out.
   * @lastreviewed null
   */
  head: string;
  /**
   * Whether any file is modified, staged, deleted or untracked.
   * @lastreviewed null
   */
  dirty: boolean;
  /**
   * Repo-relative, `/`-separated paths with local changes (empty when clean).
   * @lastreviewed null
   */
  dirtyPaths: string[];
  /**
   * Commits on the branch that its upstream lacks, as of the last fetch (`0` without an upstream).
   * @lastreviewed null
   */
  ahead: number;
  /**
   * Commits on the upstream that the branch lacks, as of the last fetch (`0` without an upstream).
   * @lastreviewed null
   */
  behind: number;
}

/**
 * Options for {@link GatewayGit.status}.
 * @lastreviewed null
 */
export interface GatewayGitStatusOptions {
  /**
   * Fetch from the gateway first, so `ahead` / `behind` are current. Off by default: status then
   * uses only what is on disk.
   * @lastreviewed null
   */
  fetch?: boolean;
}

/**
 * What {@link GatewayGit.pull} did: `up-to-date` (nothing new upstream), `ahead` (the branch has
 * commits upstream lacks and upstream has none new; nothing to pull) or `fast-forwarded`.
 * @lastreviewed null
 */
export interface GatewayPullResult {
  outcome: "up-to-date" | "ahead" | "fast-forwarded";
  branch: string;
  /**
   * The commit before the pull.
   * @lastreviewed null
   */
  from: string;
  /**
   * The commit after the pull.
   * @lastreviewed null
   */
  to: string;
}

/**
 * What {@link GatewayGit.push} did.
 * @lastreviewed null
 */
export interface GatewayPushResult {
  /**
   * `false` when the branch had no commits upstream lacks, so nothing was sent.
   * @lastreviewed null
   */
  pushed: boolean;
  branch: string;
  /**
   * The upstream branch that was updated, e.g. `master`.
   * @lastreviewed null
   */
  remoteBranch: string;
  /**
   * The commit the branch is now at.
   * @lastreviewed null
   */
  head: string;
}

// The current branch, its upstream and commit, read from the clone's own config.
interface Tracking {
  branch: string;
  head: string;
  // `null` when the branch tracks nothing.
  remoteBranch: string | null;
}

// Normalise a path from isomorphic-git (already `/`-separated) and drop a leading `./`.
function posix(file: string): string {
  return file.split(path.sep).join("/").replace(/^\.\//, "");
}

// The error's `code`, as isomorphic-git sets it on every error it throws.
function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// The `filepaths` of an isomorphic-git `CheckoutConflictError`, or `[]` for any other error.
function conflictPathsOf(error: unknown): string[] {
  if (codeOf(error) === "CheckoutConflictError" && typeof error === "object" && error !== null && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (typeof data === "object" && data !== null && "filepaths" in data) {
      const filepaths = (data as { filepaths: unknown }).filepaths;
      if (Array.isArray(filepaths)) {
        return filepaths.filter((p): p is string => typeof p === "string").map(posix);
      }
    }
  }
  return [];
}

/**
 * Git over the gateway's smart HTTP endpoints, in pure JS (isomorphic-git; no git install needed).
 * It works only with the gateway-supplied `gitUrl` from the listings, never one it builds.
 *
 * Safety rules, all enforced here rather than left to a caller:
 * - every request carries the `b6pt_` token via {@link GatewayClient.authHeadersFor}, which refuses
 *   a URL off the gateway's origin before any request is made; redirects are never followed;
 * - {@link push} sends the current branch to its upstream only as a fast-forward: never forced,
 *   never a ref deletion, never a tag;
 * - {@link pull} only fast-forwards, and refuses (naming the paths) when it would overwrite local
 *   changes;
 * - file contents are never rewritten: no `autocrlf`, no filters, so a Windows checkout keeps the
 *   bytes the repository holds.
 *
 * Each operation runs inside the {@link GatewayClient} queue, so git traffic never overlaps a REST
 * call or another git operation. The working copy is on the local disk through Node's `fs`
 * directly: isomorphic-git needs the Node-fs surface (`lstat`, symlinks, file modes, sub-second
 * mtimes) that the core `FileSystem` provider (URI-based, no `lstat`/`symlink`/`chmod`) does not
 * offer, and a clone is always a real folder on the local machine.
 * @lastreviewed null
 */
export class GatewayGit {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly client: GatewayClient
  ) {}

  /**
   * Clone `gitUrl` into `dir` (created if missing; it must be empty if it exists) and check out
   * `ref`, or the default branch.
   *
   * @param gitUrl the `gitUrl` of a knowledge base or marketplace repo from the gateway's listing
   * @param dir the local folder (an OS path)
   * @throws {Err.GatewayWorkingCopyError} `not-empty` when `dir` has files; `ref-not-found`
   * @throws {Err.GatewayError} a subclass for any gateway failure (see {@link gatewayErrorFor})
   * @lastreviewed null
   */
  clone(gitUrl: string, dir: string, options: GatewayCloneOptions = {}): Promise<GatewayCloneResult> {
    return this.client.sequence(async () => {
      await this.client.authHeadersFor(gitUrl);
      const existed = nodeFs.existsSync(dir);
      if (existed && (!nodeFs.statSync(dir).isDirectory() || nodeFs.readdirSync(dir).length > 0)) {
        throw new Err.GatewayWorkingCopyError(`${dir} already has files, so nothing was cloned into it.`, "not-empty");
      }
      try {
        await git.clone({
          fs: nodeFs,
          http: this.http(),
          dir,
          url: gitUrl,
          remote: REMOTE,
          ref: options.ref,
          singleBranch: true,
        });
      } catch (error) {
        // Whatever is in `dir` now was put there by this attempt (it was absent or empty).
        if (existed) {
          for (const entry of nodeFs.readdirSync(dir)) {
            nodeFs.rmSync(path.join(dir, entry), { recursive: true, force: true });
          }
        } else {
          nodeFs.rmSync(dir, { recursive: true, force: true });
        }
        throw this.notFoundRef(error, options.ref) ?? error;
      }
      const head = await git.resolveRef({ fs: nodeFs, dir, ref: "HEAD" });
      const branch = (await git.currentBranch({ fs: nodeFs, dir })) ?? null;
      return { branch, head };
    });
  }

  /**
   * The URL the clone in `dir` fetches from and pushes to (its `origin`), or `null` when it has none.
   * @throws {Err.GatewayWorkingCopyError} `not-a-clone` when `dir` is not a clone
   * @lastreviewed null
   */
  async originUrl(dir: string): Promise<string | null> {
    this.requireClone(dir);
    const url: unknown = await git.getConfig({ fs: nodeFs, dir, path: `remote.${REMOTE}.url` });
    return typeof url === "string" && url.length > 0 ? url : null;
  }

  /**
   * The state of the clone in `dir`.
   * @throws {Err.GatewayWorkingCopyError} `not-a-clone` when `dir` is not a clone (a detached head is not an
   *   error: `branch` is then `null`)
   * @lastreviewed null
   */
  status(dir: string, options: GatewayGitStatusOptions = {}): Promise<GatewayGitStatus> {
    return this.client.sequence(async () => {
      this.requireClone(dir);
      const branch = (await git.currentBranch({ fs: nodeFs, dir })) ?? null;
      const head = await git.resolveRef({ fs: nodeFs, dir, ref: "HEAD" });
      const remoteBranch = branch ? await this.upstreamOf(dir, branch) : null;
      if (options.fetch && remoteBranch) {
        await this.fetchBranch(dir, remoteBranch);
      }
      let ahead = 0;
      let behind = 0;
      if (branch && remoteBranch) {
        const counts = await this.aheadBehind(dir, head, remoteBranch);
        ahead = counts.ahead;
        behind = counts.behind;
      }
      const dirtyPaths = await this.dirtyPaths(dir);
      return {
        branch,
        upstream: branch && remoteBranch ? `${REMOTE}/${remoteBranch}` : null,
        head,
        dirty: dirtyPaths.length > 0,
        dirtyPaths,
        ahead,
        behind,
      };
    });
  }

  /**
   * Fetch the current branch's upstream and fast-forward to it. A clean tree just proceeds. Local
   * changes the incoming commits do not touch are kept. The call never merges, rebases or
   * overwrites.
   *
   * @throws {Err.GatewayDirtyWorkingTreeError} the incoming commits change files that have local
   *   changes (`paths`); nothing was changed
   * @throws {Err.GatewayWorkingCopyError} `not-a-clone`, `detached`, `no-upstream`, or `diverged`
   * @throws {Err.GatewayError} a subclass for any gateway failure
   * @lastreviewed null
   */
  pull(dir: string): Promise<GatewayPullResult> {
    return this.client.sequence(async () => {
      const tracking = await this.tracking(dir);
      const { branch, head: from, remoteBranch } = tracking;
      if (remoteBranch === null) {
        throw this.noUpstream(branch);
      }
      await this.fetchBranch(dir, remoteBranch);
      const remoteRef = `refs/remotes/${REMOTE}/${remoteBranch}`;
      const to = await git.resolveRef({ fs: nodeFs, dir, ref: remoteRef });
      if (to === from) {
        return { outcome: "up-to-date", branch, from, to };
      }
      if (await git.isDescendent({ fs: nodeFs, dir, oid: from, ancestor: to })) {
        return { outcome: "ahead", branch, from, to: from };
      }
      if (!(await git.isDescendent({ fs: nodeFs, dir, oid: to, ancestor: from }))) {
        throw new Err.GatewayWorkingCopyError(
          `${branch} and ${REMOTE}/${remoteBranch} have each moved on without the other, so it cannot be fast-forwarded.`,
          "diverged"
        );
      }

      const incoming = await this.changedBetween(dir, from, to);
      const dirty = new Set(await this.dirtyPaths(dir));
      const clash = incoming.filter((file) => dirty.has(file) || [...dirty].some((d) => file.startsWith(`${d}/`)));
      if (clash.length > 0) {
        throw this.dirtyError(branch, clash);
      }

      // Move the branch, then check out. A checkout refusal (a case the diff above did not
      // foresee) puts the branch back, so the tree is never left at odds with HEAD.
      const branchRef = `refs/heads/${branch}`;
      await git.writeRef({ fs: nodeFs, dir, ref: branchRef, value: to, force: true });
      try {
        await git.checkout({ fs: nodeFs, dir, ref: branch, force: false, noUpdateHead: true });
      } catch (error) {
        await git.writeRef({ fs: nodeFs, dir, ref: branchRef, value: from, force: true });
        const paths = conflictPathsOf(error);
        if (paths.length > 0) {
          throw this.dirtyError(branch, paths);
        }
        throw error;
      }
      return { outcome: "fast-forwarded", branch, from, to };
    });
  }

  /**
   * Push the current branch to its upstream, only as a fast-forward. Never forced, never a
   * deletion, never tags. Nothing is sent when the branch has no commits upstream lacks.
   *
   * @throws {Err.GatewayConflictError} the upstream has moved on (not a fast-forward), whether the
   *   client or the gateway noticed
   * @throws {Err.GatewayWorkingCopyError} `not-a-clone`, `detached` or `no-upstream`
   * @throws {Err.GatewayError} a subclass for any other gateway failure (auth, scope, not permitted, ...)
   * @lastreviewed null
   */
  push(dir: string): Promise<GatewayPushResult> {
    return this.client.sequence(async () => {
      const tracking = await this.tracking(dir);
      const { branch, head, remoteBranch } = tracking;
      if (remoteBranch === null) {
        throw this.noUpstream(branch);
      }
      // Refresh the view of the upstream first, so a branch behind it is refused here with the
      // right reason and never reaches the wire.
      await this.fetchBranch(dir, remoteBranch);
      const counts = await this.aheadBehind(dir, head, remoteBranch);
      if (counts.behind > 0) {
        throw new Err.GatewayConflictError(
          `${branch} does not build on ${REMOTE}/${remoteBranch}: the upstream has ${counts.behind} commit(s) it lacks, so the push was not sent.`,
          "non-fast-forward"
        );
      }
      if (counts.ahead === 0) {
        return { pushed: false, branch, remoteBranch, head };
      }
      let result: Awaited<ReturnType<typeof git.push>>;
      try {
        result = await git.push({
          fs: nodeFs,
          http: this.http(),
          dir,
          remote: REMOTE,
          ref: branch,
          remoteRef: `refs/heads/${remoteBranch}`,
          force: false,
        });
      } catch (error) {
        if (codeOf(error) === "PushRejectedError") {
          throw new Err.GatewayConflictError(
            `${branch} does not build on ${REMOTE}/${remoteBranch}: the push was rejected as not a fast-forward.`,
            "non-fast-forward"
          );
        }
        throw error;
      }
      if (!result.ok) {
        const said = Object.values(result.refs)
          .map((r) => r.error)
          .filter((e): e is string => typeof e === "string");
        const text = [result.error, ...said].filter(Boolean).join("; ");
        if (/non-fast-forward|fetch first|stale info/i.test(text)) {
          throw new Err.GatewayConflictError(
            `${branch} does not build on ${REMOTE}/${remoteBranch}: the gateway rejected the push as not a fast-forward.`,
            "non-fast-forward"
          );
        }
        throw new Err.GatewayUnexpectedResponseError(
          `The gateway did not accept the push of ${branch}${text ? `: ${text}` : ""}.`,
          null,
          null
        );
      }
      return { pushed: true, branch, remoteBranch, head };
    });
  }

  // ── internals ──────────────────────────────────────────────────────

  private requireClone(dir: string): void {
    if (!nodeFs.existsSync(path.join(dir, ".git"))) {
      throw new Err.GatewayWorkingCopyError(`${dir} is not a git clone.`, "not-a-clone");
    }
  }

  private async tracking(dir: string): Promise<Tracking> {
    this.requireClone(dir);
    const branch = await git.currentBranch({ fs: nodeFs, dir });
    if (!branch) {
      throw new Err.GatewayWorkingCopyError(`${dir} is on a detached head, not on a branch.`, "detached");
    }
    const head = await git.resolveRef({ fs: nodeFs, dir, ref: "HEAD" });
    return { branch, head, remoteBranch: await this.upstreamOf(dir, branch) };
  }

  // The branch name `branch` tracks on the gateway remote, from the clone's own config.
  private async upstreamOf(dir: string, branch: string): Promise<string | null> {
    const remote: unknown = await git.getConfig({ fs: nodeFs, dir, path: `branch.${branch}.remote` });
    const merge: unknown = await git.getConfig({ fs: nodeFs, dir, path: `branch.${branch}.merge` });
    if (remote !== REMOTE || typeof merge !== "string" || !merge.startsWith("refs/heads/")) {
      return null;
    }
    return merge.slice("refs/heads/".length);
  }

  private noUpstream(branch: string): Err.GatewayWorkingCopyError {
    return new Err.GatewayWorkingCopyError(`${branch} tracks no branch on the gateway.`, "no-upstream");
  }

  private dirtyError(branch: string, paths: string[]): Err.GatewayDirtyWorkingTreeError {
    const sorted = [...new Set(paths)].sort();
    return new Err.GatewayDirtyWorkingTreeError(
      `Updating ${branch} would overwrite local changes to ${sorted.length} file(s); nothing was changed.`,
      sorted
    );
  }

  // Map isomorphic-git's "no such remote ref" failure to a GatewayWorkingCopyError (ref-not-found).
  private notFoundRef(error: unknown, ref: string | undefined): Err.GatewayWorkingCopyError | undefined {
    if (ref !== undefined && ["NotFoundError", "ResolveRefError"].includes(codeOf(error) ?? "")) {
      return new Err.GatewayWorkingCopyError(
        `The gateway's repository has no branch or tag named ${ref}.`,
        "ref-not-found"
      );
    }
    return undefined;
  }

  private async fetchBranch(dir: string, remoteBranch: string): Promise<void> {
    await git.fetch({
      fs: nodeFs,
      http: this.http(),
      dir,
      remote: REMOTE,
      remoteRef: `refs/heads/${remoteBranch}`,
      singleBranch: true,
      tags: false,
    });
  }

  private async aheadBehind(
    dir: string,
    head: string,
    remoteBranch: string
  ): Promise<{ ahead: number; behind: number }> {
    const remoteRef = `refs/remotes/${REMOTE}/${remoteBranch}`;
    let remoteHead: string;
    try {
      remoteHead = await git.resolveRef({ fs: nodeFs, dir, ref: remoteRef });
    } catch {
      return { ahead: 0, behind: 0 };
    }
    const mine = new Set((await git.log({ fs: nodeFs, dir, ref: head })).map((c) => c.oid));
    const theirs = new Set((await git.log({ fs: nodeFs, dir, ref: remoteHead })).map((c) => c.oid));
    return {
      ahead: [...mine].filter((oid) => !theirs.has(oid)).length,
      behind: [...theirs].filter((oid) => !mine.has(oid)).length,
    };
  }

  // Paths whose working copy or index differs from HEAD, plus untracked files (ignored ones excluded).
  private async dirtyPaths(dir: string): Promise<string[]> {
    const rows = await git.statusMatrix({ fs: nodeFs, dir });
    return rows
      .filter(([, head, work, stage]) => !(head === 1 && work === 1 && stage === 1))
      .map(([file]) => posix(file))
      .sort();
  }

  // Files (not folders) whose content differs between two commits, including added and removed ones.
  private async changedBetween(dir: string, from: string, to: string): Promise<string[]> {
    const changed: string[] = [];
    await git.walk({
      fs: nodeFs,
      dir,
      trees: [git.TREE({ ref: from }), git.TREE({ ref: to })],
      map: async (file: string, entries: (WalkerEntry | null)[]): Promise<null | undefined> => {
        if (file === ".") {
          return undefined;
        }
        const [before, after] = entries;
        const kinds = await Promise.all([before?.type(), after?.type()]);
        if (kinds.includes("tree") && kinds.every((k) => k === undefined || k === "tree")) {
          return undefined;
        }
        const [a, b] = await Promise.all([before?.oid(), after?.oid()]);
        if (a !== b) {
          changed.push(posix(file));
        }
        return undefined;
      },
    });
    return changed;
  }

  /**
   * The HTTP client isomorphic-git talks through: the injected `fetchFn` (so a consumer's proxy
   * and TLS settings apply), the bearer header from {@link GatewayClient.authHeadersFor} on every
   * request (so a URL off the gateway's origin throws before any bytes are sent), and redirects
   * refused. A non-2xx answer becomes the typed gateway error right here.
   * @lastreviewed null
   */
  private http(): HttpClient {
    return {
      request: async (req: GitHttpRequest): Promise<GitHttpResponse> => {
        const auth = await this.client.authHeadersFor(req.url);
        const secret = (auth[Http.Headers.AUTHORIZATION] ?? "").replace(/^Bearer /, "");
        const method = req.method ?? "GET";
        const headers: Record<string, string> = { ...(req.headers ?? {}), ...auth };
        const init: RequestInit = { method, headers, redirect: "error", signal: req.signal };
        if (req.body) {
          const chunks: Buffer[] = [];
          for await (const chunk of req.body) {
            chunks.push(Buffer.from(chunk));
          }
          init.body = Buffer.concat(chunks);
        }
        const url = new URL(req.url);
        const what = `${method} ${url.pathname}${url.search}`;
        let response: Response;
        try {
          response = await this.ctx.fetchFn(url, init);
        } catch (error) {
          const why = redactToken(error instanceof Error ? error.message : String(error), secret);
          throw new Err.GatewayUnavailableError(`${what}: the gateway could not be reached: ${why}.`, null, null);
        }
        this.ctx.logger.debug(`gateway git ${what} -> ${response.status}`);
        if (!response.ok) {
          let text = "";
          try {
            text = await response.text();
          } catch {
            // best-effort body only
          }
          throw gatewayErrorFor(response.status, text, what, secret);
        }
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return {
          url: req.url,
          method,
          headers: responseHeaders,
          body: response.body ? streamOf(response.body) : singleChunk(new Uint8Array()),
          statusCode: response.status,
          statusMessage: response.statusText,
        };
      },
    };
  }
}

// Adapt a web `ReadableStream` to the async iterator isomorphic-git reads.
async function* streamOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* singleChunk(chunk: Uint8Array): AsyncGenerator<Uint8Array, void, undefined> {
  yield chunk;
}
