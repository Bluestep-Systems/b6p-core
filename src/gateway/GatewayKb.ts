import * as nodeFs from "node:fs";
import * as path from "node:path";
import { Gateway } from "../constants/Gateway";
import { Err } from "../Err";
import type { GatewayKnowledgeBase } from "../types";
import type { GatewayClient } from "./GatewayClient";
import type { GatewayGit } from "./GatewayGit";

/**
 * Filters for {@link GatewayKb.list}.
 * @lastreviewed null
 */
export interface GatewayKbListOptions {
  /**
   * Only global or only tenant knowledge bases.
   * @lastreviewed null
   */
  scope?: "global" | "tenant";
  /**
   * Only this tenant's knowledge bases (`U<seqnum>`).
   * @lastreviewed null
   */
  tenant?: string;
}

/**
 * Options for {@link GatewayKb.pull}.
 * @lastreviewed null
 */
export interface GatewayKbPullOptions {
  /**
   * The folder `dir` is relative to. The consumer passes its own working directory; core never reads
   * `process.cwd()`.
   * @lastreviewed null
   */
  cwd: string;
  /**
   * Where the clone lives, relative to `cwd` (or absolute). Defaults to the knowledge base's name
   * (global) or `<tenant>-<name>` (tenant).
   * @lastreviewed null
   */
  dir?: string;
}

/**
 * What {@link GatewayKb.pull} did.
 * @lastreviewed null
 */
export interface GatewayKbPullResult {
  /**
   * The knowledge base that was pulled.
   * @lastreviewed null
   */
  kb: GatewayKnowledgeBase;
  /**
   * The absolute folder of the clone.
   * @lastreviewed null
   */
  dir: string;
  /**
   * `cloned` (a new clone of the live branch), `fast-forwarded`, `up-to-date`, or `ahead` (the clone
   * has commits the gateway lacks and nothing new to pull).
   * @lastreviewed null
   */
  outcome: "cloned" | "fast-forwarded" | "up-to-date" | "ahead";
  /**
   * The branch checked out, or `null` on a detached head.
   * @lastreviewed null
   */
  branch: string | null;
  /**
   * The commit before the pull, `null` for a fresh clone.
   * @lastreviewed null
   */
  from: string | null;
  /**
   * The commit now checked out.
   * @lastreviewed null
   */
  to: string;
}

/**
 * What {@link GatewayKb.push} did.
 * @lastreviewed null
 */
export interface GatewayKbPushResult {
  /**
   * `false` when the clone had no commits the gateway lacks, so nothing was sent.
   * @lastreviewed null
   */
  pushed: boolean;
  /**
   * The commit the branch is at.
   * @lastreviewed null
   */
  commit: string;
  /**
   * The knowledge base's `ref`, e.g. `global/onboarding`.
   * @lastreviewed null
   */
  ref: string;
}

/**
 * A knowledge-base address as typed: a global `<name>` or a tenant `<U…>/<name>`.
 * @lastreviewed null
 */
interface ParsedRef {
  tenant: string | null;
  name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check one entry of the listing and return it typed. Throws `GatewayUnexpectedResponseError`,
 * naming the entry's position and field but never echoing a value.
 * @lastreviewed null
 */
function knowledgeBaseFrom(entry: unknown, index: number): GatewayKnowledgeBase {
  const bad = (field: string): Err.GatewayUnexpectedResponseError =>
    new Err.GatewayUnexpectedResponseError(
      `GET ${Gateway.Paths.KNOWLEDGE_BASES}: entry ${index} of the listing has a missing or malformed "${field}".`,
      200,
      null
    );
  if (!isRecord(entry)) {
    throw bad("entry");
  }
  const text = (field: string): string => {
    const value = entry[field];
    if (typeof value !== "string" || value.length === 0) {
      throw bad(field);
    }
    return value;
  };
  const scope = entry.scope;
  if (scope !== "global" && scope !== "tenant") {
    throw bad("scope");
  }
  const tenantField = entry.tenant;
  let tenant: string | null;
  if (scope === "global" && tenantField === null) {
    tenant = null;
  } else if (scope === "tenant" && typeof tenantField === "string" && tenantField.length > 0) {
    tenant = tenantField;
  } else {
    throw bad("tenant");
  }
  if (typeof entry.canPush !== "boolean") {
    throw bad("canPush");
  }
  return {
    ref: text("ref"),
    scope,
    tenant,
    name: text("name"),
    title: text("title"),
    liveBranch: text("liveBranch"),
    canPush: entry.canPush,
    gitUrl: text("gitUrl"),
  };
}

/**
 * Parse `<name>` (global) or `<tenant>/<name>` (tenant). A listing's own `ref` form
 * (`global/<name>`, `tenant/<tenant>/<name>`) is accepted too.
 * @lastreviewed null
 */
function parseRef(raw: string): ParsedRef {
  const bad = (): Err.GatewayKnowledgeBaseError =>
    new Err.GatewayKnowledgeBaseError(
      `"${raw}" is not a knowledge-base address: expected <name> or <tenant>/<name>.`,
      "bad-ref",
      raw
    );
  let parts = raw.split("/");
  if (parts[0] === "global" && parts.length === 2) {
    parts = [parts[1]];
  } else if (parts[0] === "tenant" && parts.length === 3) {
    parts = [parts[1], parts[2]];
  }
  if (parts.length > 2 || parts.some((part) => part.length === 0 || part !== part.trim())) {
    throw bad();
  }
  return parts.length === 1 ? { tenant: null, name: parts[0] } : { tenant: parts[0], name: parts[1] };
}

/**
 * A folder name taken from a listing must be one plain path segment, so a hostile or odd name
 * cannot place a clone outside the folder the consumer chose.
 * @lastreviewed null
 */
function isPlainSegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && !/[\\/:*?"<>|\0]/.test(segment) && segment === segment.trim();
}

/**
 * Compare two git URLs by what they address, ignoring a trailing slash.
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
 * Knowledge bases on web-global's gateway: list what the caller may read, pull one into a local
 * folder, push local commits back. Built over the gateway's one {@link GatewayClient} and
 * {@link GatewayGit}, so its requests share their one-at-a-time queue.
 *
 * Nothing here prompts. A pull that would overwrite local changes throws
 * `GatewayDirtyWorkingTreeError` with the paths, and a push the caller may not make throws
 * `GatewayKnowledgeBasePushNotPermittedError`; the consumer decides what to tell the user.
 * @lastreviewed null
 */
export class GatewayKb {
  constructor(
    private readonly client: GatewayClient,
    private readonly git: GatewayGit
  ) {}

  /**
   * The knowledge bases the caller may read, global and tenant, optionally filtered.
   *
   * @throws {Err.GatewayUnexpectedResponseError} the body is not the promised list
   * @throws {Err.GatewayError} a subclass for any gateway failure
   * @lastreviewed null
   */
  async list(options: GatewayKbListOptions = {}): Promise<GatewayKnowledgeBase[]> {
    const body = await this.client.getJson(Gateway.Paths.KNOWLEDGE_BASES, {
      scope: options.scope,
      tenant: options.tenant,
    });
    if (!isRecord(body) || !Array.isArray(body.knowledgeBases)) {
      throw new Err.GatewayUnexpectedResponseError(
        `GET ${Gateway.Paths.KNOWLEDGE_BASES}: the body is not a listing of knowledge bases.`,
        200,
        null
      );
    }
    return body.knowledgeBases.map((entry: unknown, index: number) => knowledgeBaseFrom(entry, index));
  }

  /**
   * Find one knowledge base by address: `<name>` for a global one, `<U…>/<name>` for a tenant one.
   *
   * @throws {Err.GatewayKnowledgeBaseError} `bad-ref`, `not-found` or `ambiguous`
   * @throws {Err.GatewayError} a subclass for any gateway failure
   * @lastreviewed null
   */
  async resolve(ref: string): Promise<GatewayKnowledgeBase> {
    const parsed = parseRef(ref);
    const listed =
      parsed.tenant === null
        ? await this.list({ scope: "global" })
        : await this.list({ scope: "tenant", tenant: parsed.tenant });
    const matches = listed.filter(
      (kb) => kb.name === parsed.name && (parsed.tenant === null ? kb.scope === "global" : kb.tenant === parsed.tenant)
    );
    if (matches.length === 0) {
      throw new Err.GatewayKnowledgeBaseError(`No knowledge base "${ref}" is visible to this user.`, "not-found", ref);
    }
    if (matches.length > 1) {
      throw new Err.GatewayKnowledgeBaseError(
        `"${ref}" matches ${matches.length} knowledge bases.`,
        "ambiguous",
        ref,
        matches.map((kb) => kb.ref)
      );
    }
    return matches[0];
  }

  /**
   * Bring a knowledge base into a local folder. A missing or empty folder gets a clone of the live
   * branch; an existing clone of the same repository is fast-forwarded. Never prompts, never
   * discards local changes.
   *
   * @throws {Err.GatewayKnowledgeBaseError} the address is bad, unknown or ambiguous, or the listed
   *   name cannot be a folder name (`unsafe-name`)
   * @throws {Err.GatewayWorkingCopyError} `wrong-repository` (the folder is a clone of another repo),
   *   `not-empty` (it has files but is not a clone), `diverged`, `detached` or `no-upstream`
   * @throws {Err.GatewayDirtyWorkingTreeError} the incoming commits change files with local changes
   * @throws {Err.GatewayError} a subclass for any gateway failure
   * @lastreviewed null
   */
  async pull(ref: string, options: GatewayKbPullOptions): Promise<GatewayKbPullResult> {
    const kb = await this.resolve(ref);
    const folder = options.dir ?? (kb.tenant === null ? kb.name : `${kb.tenant}-${kb.name}`);
    if (options.dir === undefined && !isPlainSegment(folder)) {
      throw new Err.GatewayKnowledgeBaseError(
        `The knowledge base name "${kb.name}" cannot be used as a folder name.`,
        "unsafe-name",
        kb.ref
      );
    }
    const dir = path.resolve(options.cwd, folder);

    const exists = nodeFs.existsSync(dir);
    const empty = !exists || (nodeFs.statSync(dir).isDirectory() && nodeFs.readdirSync(dir).length === 0);
    if (empty) {
      const cloned = await this.git.clone(kb.gitUrl, dir, { ref: kb.liveBranch });
      return { kb, dir, outcome: "cloned", branch: cloned.branch, from: null, to: cloned.head };
    }

    if (nodeFs.existsSync(path.join(dir, ".git"))) {
      const origin = await this.git.originUrl(dir);
      if (origin === null || !sameUrl(origin, kb.gitUrl)) {
        throw new Err.GatewayWorkingCopyError(
          `${dir} is a clone of a different repository than knowledge base ${kb.ref}.`,
          "wrong-repository"
        );
      }
      const pulled = await this.git.pull(dir);
      return { kb, dir, outcome: pulled.outcome, branch: pulled.branch, from: pulled.from, to: pulled.to };
    }
    throw new Err.GatewayWorkingCopyError(`${dir} already has files, so nothing was cloned into it.`, "not-empty");
  }

  /**
   * Push the local commits of the clone in `dir` to its knowledge base. The knowledge base is found
   * from the clone's remote in a fresh listing, and a clone whose `canPush` is `false` is refused
   * before anything is sent.
   *
   * @throws {Err.GatewayKnowledgeBasePushNotPermittedError} the listing says this user cannot push there
   * @throws {Err.GatewayKnowledgeBaseError} `not-a-kb`: the clone's remote is not a knowledge base this user can see;
   *   `wrong-branch`: the clone is not on the live branch (or is detached), refused before any git request
   * @throws {Err.GatewayConflictError} the gateway's branch has moved on (not a fast-forward)
   * @throws {Err.GatewayWorkingCopyError} `not-a-clone`, `detached` or `no-upstream`
   * @throws {Err.GatewayError} a subclass for any other gateway failure
   * @lastreviewed null
   */
  async push(dir: string): Promise<GatewayKbPushResult> {
    const origin = await this.git.originUrl(dir);
    const listed = await this.list();
    const kb = origin === null ? undefined : listed.find((candidate) => sameUrl(candidate.gitUrl, origin));
    if (kb === undefined) {
      throw new Err.GatewayKnowledgeBaseError(
        `${dir} is not a clone of a knowledge base visible to this user.`,
        "not-a-kb",
        null
      );
    }
    if (!kb.canPush) {
      throw new Err.GatewayKnowledgeBasePushNotPermittedError(
        `This user may read knowledge base ${kb.ref} but not push to it.`,
        kb.ref
      );
    }
    const { branch } = await this.git.status(dir);
    if (branch !== kb.liveBranch) {
      throw new Err.GatewayKnowledgeBaseError(
        branch === null
          ? `${dir} is on a detached head, but knowledge base ${kb.ref} takes pushes only on its live branch ${kb.liveBranch}.`
          : `${dir} is on branch ${branch}, but knowledge base ${kb.ref} takes pushes only on its live branch ${kb.liveBranch}.`,
        "wrong-branch",
        kb.ref,
        [],
        { branch, liveBranch: kb.liveBranch }
      );
    }
    const pushed = await this.git.push(dir);
    return { pushed: pushed.pushed, commit: pushed.head, ref: kb.ref };
  }
}
