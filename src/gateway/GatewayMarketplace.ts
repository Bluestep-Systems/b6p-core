import * as nodeFs from "node:fs";
import * as path from "node:path";
import { Gateway } from "../constants/Gateway";
import { Err } from "../Err";
import { Http } from "../constants/Http";
import type {
  GatewayMarketplaceCreateRequest,
  GatewayMarketplaceCreateResult,
  GatewayMarketplaceRepo,
  GatewayMarketplaceRepoMetadata,
  JsonValue,
} from "../types";
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
  return parseRepoEntry(value, `The marketplace listing's entry ${index}`, 200);
}

/**
 * {@link parseRepo} for any answer carrying one entry: `subject` opens each message ("The create answer"),
 * `status` is the HTTP status it came with.
 * @lastreviewed null
 */
function parseRepoEntry(value: JsonValue | undefined, subject: string, status: number): GatewayMarketplaceRepo {
  const bad = (what: string): Err.GatewayUnexpectedResponseError =>
    new Err.GatewayUnexpectedResponseError(`${subject} has ${what}.`, status, null);
  if (!isRecord(value)) {
    throw bad("the wrong shape");
  }
  const { name, description, defaultBranch, tags, gitUrl } = value;
  if (typeof name !== "string" || INVISIBLE.test(name)) {
    throw bad("no usable name");
  }
  // A description may hold tab, CR and LF (the create contract allows them): a create that has made the
  // repo must not then fail on the answer.
  if (typeof description !== "string" || INVISIBLE.test(description.replace(/[\t\r\n]/g, ""))) {
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
 * A marketplace repo name as the gateway accepts it (contract 6.x, `POST /api/v1/registry/repos`).
 * @lastreviewed null
 */
const REPO_NAME = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/;
/**
 * Names Forgejo 15.0.5 refuses for a repo (`reservedRepoNames`, `reservedRepoPatterns`), compared ignoring case:
 * `.`, `..`, `-`, and anything ending `.git`, `.wiki`, `.rss` or `.atom`. A name that only contains one of those
 * words (`wiki`, `kb.wiki.docs`, `kb.rss2`) is fine.
 * @lastreviewed null
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([".", "..", "-"]);
const RESERVED_SUFFIXES: readonly string[] = [".git", ".wiki", ".rss", ".atom"];

function forgeReserves(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_NAMES.has(lower) || RESERVED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

const TOPIC = /^[a-z0-9][-.a-z0-9]*$/;
const MAX_DESCRIPTION = 2048;
const MAX_WEBSITE = 1024;
const MAX_TOPICS = 25;
const MAX_TOPIC_LENGTH = 35;

function invalid(field: string, why: string): Err.GatewayInvalidArgumentError {
  return new Err.GatewayInvalidArgumentError(`The marketplace repo ${field} ${why}; nothing was sent.`);
}

/**
 * Check `metadata` as the gateway will and return the members given as a request body fragment. An absent
 * (`undefined`) member is left out, never sent as `null`.
 * @throws {Err.GatewayInvalidArgumentError} a member the gateway would refuse as `400 invalid-request`
 * @lastreviewed null
 */
function metadataBody(metadata: GatewayMarketplaceRepoMetadata): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {};
  const { description, website, topics } = metadata as { [key: string]: unknown };
  if (description !== undefined) {
    if (typeof description !== "string") {
      throw invalid("description", "must be a string (omit it to leave it out)");
    }
    if (description.length > MAX_DESCRIPTION) {
      throw invalid("description", `is longer than ${MAX_DESCRIPTION} characters`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(description)) {
      throw invalid("description", "has a control character (only tab, CR and LF are allowed)");
    }
    body.description = description;
  }
  if (website !== undefined) {
    if (typeof website !== "string") {
      throw invalid("website", "must be a string (omit it to leave it out)");
    }
    if (website !== "") {
      let url: URL | undefined;
      try {
        url = new URL(website);
      } catch {
        url = undefined;
      }
      if (
        website.length > MAX_WEBSITE ||
        !/^[\x21-\x7e]+$/.test(website) ||
        url === undefined ||
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.hostname === ""
      ) {
        throw invalid(
          "website",
          `is not "" or an absolute http(s) URL of printable ASCII, at most ${MAX_WEBSITE} characters`
        );
      }
    }
    body.website = website;
  }
  if (topics !== undefined) {
    if (!Array.isArray(topics) || !topics.every((t): t is string => typeof t === "string")) {
      throw invalid("topics", "must be a list of strings");
    }
    if (topics.length > MAX_TOPICS) {
      throw invalid("topics", `has more than ${MAX_TOPICS} entries`);
    }
    if (new Set(topics).size !== topics.length) {
      throw invalid("topics", "has a duplicate");
    }
    if (topics.some((t) => t.length > MAX_TOPIC_LENGTH || !TOPIC.test(t))) {
      throw invalid(
        "topics",
        `has an entry that is not lowercase letters, digits, "-" or "." (starting with a letter or digit), at most ${MAX_TOPIC_LENGTH} characters`
      );
    }
    body.topics = [...topics];
  }
  return body;
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
 * Marketplace repositories on web-global's gateway: browse them, pull a plain working clone, and
 * create a new (empty) repo. Core has no push of its own (a repo is pushed with plain `git`), and a
 * pull never reads or changes any script's sources or pins.
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

  /**
   * Create a marketplace repo (`POST /api/v1/registry/repos`, scope `registry:push`, a fleet super): the gateway
   * makes it private and empty with default branch `main`, sets the metadata given and protects `main`.
   * An existing empty repo of the same name (left by an earlier attempt) is adopted rather than refused.
   * Only the members given are sent. The request is checked as the gateway checks it, so a bad one fails here
   * with nothing sent.
   *
   * The repo is empty, so it is NOT in {@link list} until its first push: the result carries the repo from
   * the answer (do not list to find it). The first push is `git push --atomic <gitUrl> main` alone, then its tags in a second push.
   *
   * @returns `created` is `true` for a new repo (`201`), `false` when an existing empty one was adopted (`200`)
   * @throws {Err.GatewayInvalidArgumentError} the name or a metadata member is one the gateway would refuse; nothing sent
   * @throws {Err.GatewayInvalidRequestError} `400`, the gateway refused the request
   * @throws {Err.GatewayTooLargeError} `413`
   * @throws {Err.GatewayScopeError} the token lacks `registry:push` (`scope`)
   * @throws {Err.GatewayNotPermittedError} `403 not-permitted`: the owner is not a fleet super
   * @throws {Err.GatewayRepoExistsError} `409 repo-exists`: a repo of that name has history, is archived, or differs in case
   * @throws {Err.GatewayRewriteInProgressError} `409 rewrite-in-progress`: another change holds the repo; retry shortly
   * @throws {Err.GatewayForgeUnavailableError} `502 forge-unavailable`: an empty repo may be left; calling again adopts it
   * @throws {Err.GatewayUnexpectedResponseError} the answer is not a repo named as asked
   * @throws {Err.GatewayError} a subclass for any other gateway failure
   * @lastreviewed null
   */
  async create(request: GatewayMarketplaceCreateRequest): Promise<GatewayMarketplaceCreateResult> {
    const { name } = request;
    if (typeof name !== "string" || !REPO_NAME.test(name) || name.includes("..") || forgeReserves(name)) {
      throw invalid(
        "name",
        'must be lowercase letters, digits, ".", "_" or "-", start and end with a letter or digit, be at most 100 characters, not contain "..", and not be one the forge reserves (`.`, `..`, `-`, or ending `.git`, `.wiki`, `.rss`, `.atom`)'
      );
    }
    const body: Record<string, JsonValue> = { name, ...metadataBody(request) };
    const answer = await this.client.requestDetailed(Http.Methods.POST, Gateway.Paths.REGISTRY_REPOS, { body });
    if (answer.status !== 200 && answer.status !== 201) {
      throw new Err.GatewayUnexpectedResponseError(
        `POST ${Gateway.Paths.REGISTRY_REPOS}: the gateway answered ${answer.status}, not 201 or 200.`,
        answer.status,
        null
      );
    }
    const repo = parseRepoEntry(answer.body, "The create answer", answer.status);
    if (repo.name !== name) {
      throw new Err.GatewayUnexpectedResponseError(
        "The create answer is for a repo with another name than the one asked for.",
        answer.status,
        null
      );
    }
    return { repo, created: answer.status === 201 };
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
