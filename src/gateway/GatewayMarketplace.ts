import * as nodeFs from "node:fs";
import * as path from "node:path";
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
   * The folder `dir` is relative to. The consumer passes its own working directory; core never reads
   * `process.cwd()`.
   * @lastreviewed null
   */
  cwd: string;
  /**
   * Where the clone lives, relative to `cwd` (or absolute). Defaults to the repo's name.
   * @lastreviewed null
   */
  dir?: string;
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
   * `cloned` (a new working clone), `fast-forwarded`, `up-to-date` (nothing new upstream; for a tag, the
   * gateway's tag still points at the checked-out commit), or `ahead` (the clone has commits upstream lacks; nothing to pull).
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
 * Control characters, Unicode format characters and invisible or bidi-ignorable code points
 * (zero-width, directional marks and overrides, BOM, soft hyphen). They can hide inside a name
 * (a zero-width joiner before `.git` is `.git` on HFS+) or garble a terminal, so a listing
 * carrying one is malformed.
 * @lastreviewed null
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

/**
 * A folder name taken from the listing must be one plain path segment on every platform: no
 * separators, drive or reserved characters, control characters, surrounding whitespace, leading
 * dot (so never `.git` in any case, nor another dotfile), trailing dot, Windows 8.3 alias of
 * `.git` (`git~1`), or Windows device name (`CON`, `NUL`, `COM1`, `COM\u00b9`, `LPT1`, ...), so a
 * hostile or odd name cannot place a clone outside the folder the consumer chose or turn the
 * consumer's cwd into a repository.
 * @lastreviewed null
 */
function isPlainSegment(segment: string): boolean {
  return (
    segment !== "" &&
    !segment.startsWith(".") &&
    !/[\\/:*?"<>|]/.test(segment) &&
    !INVISIBLE.test(segment) &&
    segment === segment.trim() &&
    !segment.endsWith(".") &&
    !/^git~[0-9]+$/i.test(segment) &&
    !/^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i.test(
      segment.split(".")[0].trimEnd()
    )
  );
}

/**
 * Check one listing entry's shape. Throws `GatewayUnexpectedResponseError` naming the entry's
 * position and field, never echoing a value. The name is NOT checked as a folder name here.
 * @lastreviewed null
 */
function parseRepo(value: JsonValue | undefined, index: number): GatewayMarketplaceRepo {
  const bad = (what: string): Err.GatewayUnexpectedResponseError =>
    new Err.GatewayUnexpectedResponseError(`The marketplace listing's entry ${index} has ${what}.`, 200, null);
  if (!isRecord(value)) {
    throw bad("the wrong shape");
  }
  const { name, description, defaultBranch, tags, gitUrl } = value;
  if (typeof name !== "string" || INVISIBLE.test(name)) {
    throw bad("no usable name");
  }
  if (typeof description !== "string" || INVISIBLE.test(description)) {
    throw bad("no usable description");
  }
  if (typeof defaultBranch !== "string" || defaultBranch === "" || INVISIBLE.test(defaultBranch)) {
    throw bad("no usable defaultBranch");
  }
  if (!Array.isArray(tags) || !tags.every((t): t is string => typeof t === "string" && !INVISIBLE.test(t))) {
    throw bad("tags that are not a list of plain strings");
  }
  if (typeof gitUrl !== "string" || gitUrl === "") {
    throw bad("no gitUrl");
  }
  return { name, description, defaultBranch, tags, gitUrl };
}

/**
 * `refs/heads/x` and `refs/tags/x` are accepted and mean `x`, so the same options work on a second
 * pull (the clone's own branch is the short name).
 * @lastreviewed null
 */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "");
}

/**
 * Compare two git URLs by what they address, ignoring a trailing slash. The one place a clone's
 * `origin` is matched to a listing's `gitUrl`.
 * @lastreviewed null
 */
function sameUrl(a: string, b: string): boolean {
  const norm = (value: string): string => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return value;
    }
  };
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
   * Every well-formed marketplace repo the caller may read, with its tags. An entry of the wrong
   * shape is left out, so one bad entry never hides the others.
   * @throws {Err.GatewayUnexpectedResponseError} the body is not a listing at all
   * @throws {Err.GatewayError} a subclass for any gateway failure
   * @lastreviewed null
   */
  async list(): Promise<GatewayMarketplaceRepo[]> {
    return (await this.entries()).repos;
  }

  /**
   * One marketplace repo by name.
   * @throws {Err.GatewayNotFoundError} no repo has that name (or it is not visible to this user)
   * @throws {Err.GatewayUnexpectedResponseError} the entry for that name is malformed
   * @lastreviewed null
   */
  async get(name: string): Promise<GatewayMarketplaceRepo> {
    const { repos, malformed } = await this.entries();
    const found = repos.find((repo) => repo.name === name);
    if (found) {
      return found;
    }
    const broken = malformed.get(name);
    if (broken) {
      throw broken;
    }
    throw new Err.GatewayNotFoundError(`No marketplace repo is named ${name}.`, "not-found");
  }

  private async entries(): Promise<{
    repos: GatewayMarketplaceRepo[];
    malformed: Map<string, Err.GatewayUnexpectedResponseError>;
  }> {
    const body = await this.client.getJson(Gateway.Paths.REGISTRY_REPOS);
    if (!isRecord(body) || !Array.isArray(body.repos)) {
      throw new Err.GatewayUnexpectedResponseError("The marketplace listing is not the expected shape.", 200, null);
    }
    const repos: GatewayMarketplaceRepo[] = [];
    const malformed = new Map<string, Err.GatewayUnexpectedResponseError>();
    body.repos.forEach((entry, index) => {
      try {
        repos.push(parseRepo(entry, index));
      } catch (error) {
        if (error instanceof Err.GatewayUnexpectedResponseError) {
          if (isRecord(entry) && typeof entry.name === "string") {
            malformed.set(entry.name, error);
          }
          return;
        }
        throw error;
      }
    });
    return { repos, malformed };
  }

  /**
   * Make `options.dir` (default: `<cwd>/<name>`, relative paths resolved against `options.cwd`) a
   * working clone of the repo at `options.ref` (default: the repo's default branch; `refs/heads/x`
   * and `refs/tags/x` are accepted and mean `x`). A missing or empty folder is cloned. A folder that
   * already holds a clone of the same `gitUrl` is fast-forwarded when it is on that branch and
   * tracks it; a clone on a tag is `up-to-date` only while the gateway's tag still points at the
   * checked-out commit. Nothing is merged, rebased or overwritten, and nothing is pushed.
   *
   * @param name the repo's name from {@link list}
   * @throws {Err.GatewayNotFoundError} no such repo
   * @throws {Err.GatewayConfigError} the folder is relative and `cwd` is missing or not absolute
   * @throws {Err.GatewayUnexpectedResponseError} the name cannot be a folder name (with no `dir`)
   * @throws {Err.GatewayCloneMismatchError} `different-repo`, `different-ref`, `tag-moved` (the tag now
   *   names another commit on the gateway) or `tag-gone` (the gateway no longer has it)
   * @throws {Err.GatewayDirtyWorkingTreeError} the incoming commits change files with local changes
   * @throws {Err.GatewayWorkingCopyError} `not-empty` (files, but no clone), `not-a-clone` (a `.git` that is
   *     not a usable repository), `ref-not-found`, `diverged`, ...
   * @lastreviewed null
   */
  async pull(name: string, options: GatewayMarketplacePullOptions): Promise<GatewayMarketplacePullResult> {
    const repo = await this.get(name);
    if (options.dir === undefined && !isPlainSegment(repo.name)) {
      throw new Err.GatewayUnexpectedResponseError(
        `The marketplace repo name "${repo.name}" cannot be used as a folder name.`,
        200,
        null
      );
    }
    const target = this.targetFolder(repo.name, options);
    const ref = shortRef(options.ref ?? repo.defaultBranch);
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

    const found = await this.gitLayer.inspect(target, ref);
    if (found.origin === null || !sameUrl(found.origin, repo.gitUrl)) {
      throw new Err.GatewayCloneMismatchError(
        `${target} is a clone of a different repository than marketplace repo ${repo.name}, so it was left as it is.`,
        "different-repo",
        target,
        repo.name
      );
    }
    const { branch, head } = found;
    if (branch === null) {
      // A detached head is a tag checkout. Keep it only if it is the tag that was asked for.
      if (options.ref === undefined || found.tagCommit !== head) {
        throw this.differentRef(target, repo.name, ref, "a tag or commit");
      }
      // Tags can move: ask the gateway, rather than trusting the local copy of the tag.
      const upstream = await this.gitLayer.remoteTagCommit(repo.gitUrl, ref);
      if (upstream !== head) {
        throw new Err.GatewayCloneMismatchError(
          upstream === null
            ? `Tag ${ref} no longer exists on the gateway; ${target} still has the commit it was cloned at.`
            : `Tag ${ref} now points at a different commit on the gateway than the one checked out in ${target}.`,
          upstream === null ? "tag-gone" : "tag-moved",
          target,
          repo.name
        );
      }
      return { action: "up-to-date", name: repo.name, dir: target, ref, branch: null, head, from: head };
    }
    if (branch !== ref) {
      throw this.differentRef(target, repo.name, ref, `branch ${branch}`);
    }
    if (found.upstream !== ref) {
      throw this.differentRef(target, repo.name, ref, `branch ${branch} tracking ${found.upstream ?? "nothing"}`);
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

  // Core never reads process.cwd(): a relative folder needs an absolute cwd from the consumer.
  private targetFolder(name: string, options: GatewayMarketplacePullOptions): string {
    const folder = options.dir ?? name;
    if (options.dir !== undefined && path.isAbsolute(folder)) {
      return path.resolve(folder);
    }
    if (typeof options.cwd !== "string" || !path.isAbsolute(options.cwd)) {
      throw new Err.GatewayConfigError(
        "A pull into a relative folder needs the consumer's absolute working directory (cwd)."
      );
    }
    return path.resolve(options.cwd, folder);
  }

  private differentRef(dir: string, repo: string, ref: string, current: string): Err.GatewayCloneMismatchError {
    return new Err.GatewayCloneMismatchError(
      `${dir} is a clone of marketplace repo ${repo} on ${current}, not on ${ref}, so it was left as it is.`,
      "different-ref",
      dir,
      repo
    );
  }
}
