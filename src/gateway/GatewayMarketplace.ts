import * as nodeFs from "node:fs";
import * as path from "node:path";
import git from "isomorphic-git";
import { Gateway } from "../constants/Gateway";
import { Err } from "../Err";
import type { GatewayMarketplaceRepo, JsonValue } from "../types";
import type { GatewayClient } from "./GatewayClient";
import type { GatewayGit } from "./GatewayGit";

/**
 * Options for {@link GatewayMarketplace.pull}.
 * @lastreviewed null
 */
export interface GatewayMarketplacePullOptions {
  /**
   * The branch or tag to check out. Defaults to the repo's default branch.
   * @lastreviewed null
   */
  ref?: string;
}

/**
 * What {@link GatewayMarketplace.pull} did.
 * @lastreviewed null
 */
export interface GatewayMarketplacePullResult {
  /**
   * `cloned` (a new working clone), `fast-forwarded`, `up-to-date` (nothing new upstream, which is
   * always so for a tag), or `ahead` (the clone has commits upstream lacks; nothing to pull).
   * @lastreviewed null
   */
  action: "cloned" | "fast-forwarded" | "up-to-date" | "ahead";
  /**
   * The marketplace repo's name.
   * @lastreviewed null
   */
  name: string;
  /**
   * The absolute local folder.
   * @lastreviewed null
   */
  dir: string;
  /**
   * The ref that was cloned or kept: the branch or tag asked for, else the default branch.
   * @lastreviewed null
   */
  ref: string;
  /**
   * The checked-out branch, or `null` on a tag (a detached head).
   * @lastreviewed null
   */
  branch: string | null;
  /**
   * The commit now checked out.
   * @lastreviewed null
   */
  head: string;
  /**
   * The commit before a fast-forward; the same as `head` when nothing changed or the repo was just cloned.
   * @lastreviewed null
   */
  from: string;
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A repo name becomes a folder name, so it must be one plain path segment.
 * @lastreviewed null
 */
function safeSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function parseRepo(value: JsonValue, index: number): GatewayMarketplaceRepo {
  const bad = (what: string): Err.GatewayUnexpectedResponseError =>
    new Err.GatewayUnexpectedResponseError(`The marketplace listing's entry ${index} has ${what}.`, 200, null);
  if (!isRecord(value)) {
    throw bad("the wrong shape");
  }
  const { name, description, defaultBranch, tags, gitUrl } = value;
  if (typeof name !== "string" || !safeSegment(name)) {
    throw bad("no usable name");
  }
  if (typeof description !== "string") {
    throw bad("no description");
  }
  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    throw bad("no defaultBranch");
  }
  if (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === "string")) {
    throw bad("tags that are not a list of strings");
  }
  if (typeof gitUrl !== "string" || gitUrl === "") {
    throw bad("no gitUrl");
  }
  return { name, description, defaultBranch, tags, gitUrl };
}

/**
 * The same remote spelled two ways must compare equal: ignore a trailing slash and a `.git`.
 * @lastreviewed null
 */
function sameRemote(a: string, b: string): boolean {
  const norm = (u: string): string => u.replace(/\/+$/, "").replace(/\.git$/, "");
  return norm(a) === norm(b);
}

/**
 * Marketplace repositories on web-global's gateway: browse them and pull a plain working clone.
 * There is no push (the gateway refuses it for the marketplace), and a pull never reads or
 * changes any script's sources or pins.
 * @lastreviewed null
 */
export class GatewayMarketplace {
  constructor(
    private readonly client: GatewayClient,
    private readonly gitLayer: GatewayGit
  ) {}

  /**
   * Every marketplace repo the caller may read, with its tags.
   * @throws {Err.GatewayUnexpectedResponseError} the body is not the contract's shape
   * @throws {Err.GatewayError} a subclass for any gateway failure
   * @lastreviewed null
   */
  async list(): Promise<GatewayMarketplaceRepo[]> {
    const body = await this.client.getJson(Gateway.Paths.REGISTRY_REPOS);
    if (!isRecord(body) || !Array.isArray(body.repos)) {
      throw new Err.GatewayUnexpectedResponseError("The marketplace listing is not the expected shape.", 200, null);
    }
    return body.repos.map(parseRepo);
  }

  /**
   * One marketplace repo by name.
   * @throws {Err.GatewayNotFoundError} no repo has that name (or it is not visible to this user)
   * @lastreviewed null
   */
  async get(name: string): Promise<GatewayMarketplaceRepo> {
    const found = (await this.list()).find((repo) => repo.name === name);
    if (!found) {
      throw new Err.GatewayNotFoundError(`No marketplace repo is named ${name}.`, "not-found");
    }
    return found;
  }

  /**
   * Make `dir` (default: `./<name>`) a working clone of the repo at `ref` (default: the repo's
   * default branch). A missing or empty folder is cloned. A folder that already holds a clone of
   * the same `gitUrl` is fast-forwarded when it is on a branch; a clone on a tag is already up to
   * date. Nothing is merged, rebased or overwritten, and nothing is pushed.
   *
   * @param name the repo's name from {@link list}
   * @param dir the local folder, an OS path (relative paths resolve against the process's cwd)
   * @throws {Err.GatewayNotFoundError} no such repo
   * @throws {Err.GatewayCloneMismatchError} `dir` is a clone of another repo, or is on another ref
   * @throws {Err.GatewayDirtyWorkingTreeError} the incoming commits change files with local changes
   * @throws {Err.GatewayWorkingCopyError} `not-empty` (files, but no clone), `ref-not-found`, `diverged`, ...
   * @lastreviewed null
   */
  async pull(
    name: string,
    dir?: string,
    options: GatewayMarketplacePullOptions = {}
  ): Promise<GatewayMarketplacePullResult> {
    const repo = await this.get(name);
    const target = path.resolve(dir ?? repo.name);
    const ref = options.ref ?? repo.defaultBranch;
    if (!nodeFs.existsSync(path.join(target, ".git"))) {
      const cloned = await this.gitLayer.clone(repo.gitUrl, target, { ref });
      return {
        action: "cloned",
        name: repo.name,
        dir: target,
        ref,
        branch: cloned.branch,
        head: cloned.head,
        from: cloned.head,
      };
    }

    const origin = await git.getConfig({ fs: nodeFs, dir: target, path: "remote.origin.url" });
    if (typeof origin !== "string" || !sameRemote(origin, repo.gitUrl)) {
      throw new Err.GatewayCloneMismatchError(
        `${target} is a clone of a different repository than marketplace repo ${repo.name}, so it was left as it is.`,
        "different-repo",
        target,
        repo.name
      );
    }
    const branch = (await git.currentBranch({ fs: nodeFs, dir: target })) ?? null;
    const head = await git.resolveRef({ fs: nodeFs, dir: target, ref: "HEAD" });
    if (branch === null) {
      // A detached head is a tag checkout. Keep it only if it is the tag that was asked for.
      const tagHead = await git
        .resolveRef({ fs: nodeFs, dir: target, ref: `refs/tags/${ref}` })
        .catch((): null => null);
      if (options.ref === undefined || tagHead === null || (await this.peeled(target, tagHead)) !== head) {
        throw this.differentRef(target, repo.name, ref, "a tag or commit");
      }
      return { action: "up-to-date", name: repo.name, dir: target, ref, branch: null, head, from: head };
    }
    if (branch !== ref) {
      throw this.differentRef(target, repo.name, ref, `branch ${branch}`);
    }
    const pulled = await this.gitLayer.pull(target);
    return {
      action: pulled.outcome,
      name: repo.name,
      dir: target,
      ref,
      branch,
      head: pulled.to,
      from: pulled.from,
    };
  }

  private differentRef(dir: string, repo: string, ref: string, current: string): Err.GatewayCloneMismatchError {
    return new Err.GatewayCloneMismatchError(
      `${dir} is a clone of marketplace repo ${repo} on ${current}, not on ${ref}, so it was left as it is.`,
      "different-ref",
      dir,
      repo
    );
  }

  // An annotated tag points at a tag object; the checkout is the commit it names.
  private async peeled(dir: string, oid: string): Promise<string> {
    try {
      const tag = await git.readTag({ fs: nodeFs, dir, oid });
      return tag.tag.object;
    } catch {
      return oid;
    }
  }
}
