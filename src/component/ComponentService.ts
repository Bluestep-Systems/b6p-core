import { Http } from "../constants";
import { MimeTypes } from "../constants/MimeTypes";
import { Err } from "../Err";
import type { PlatformContext } from "../PlatformContext";

/**
 * A custom component addressed by its git repo URL: the origin that serves it
 * and the repo name that is its identity (the module-federation container name).
 * @lastreviewed null
 */
export interface ComponentRef {
  /** The platform origin, e.g. `https://config.bluestep.net` @lastreviewed null */
  origin: string;
  /** The component's repo name, e.g. `revenue-tile` @lastreviewed null */
  repoName: string;
}

/** Lifecycle of one custom-component build, as the platform reports it. @lastreviewed null */
export type BuildState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";

/** One structured build diagnostic from the platform's builder. @lastreviewed null */
export interface BuildDiagnostic {
  severity: "ERROR" | "WARNING" | "INFO";
  /** Repo-relative source path, when the diagnostic has one @lastreviewed null */
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
}

/**
 * The state of one build of a custom component, mirroring the platform's
 * `ComponentBuildStatus` GraphQL type field for field.
 * @lastreviewed null
 */
export interface ComponentBuildStatus {
  buildId: string;
  ref: string;
  sha: string;
  state: BuildState;
  diagnostics: BuildDiagnostic[];
  /** Builder pod console output; present only for a watchdog-condemned build @lastreviewed null */
  log: string | null;
  /** Same-origin remoteEntry.js URL for this build's artifact; null unless servable @lastreviewed null */
  entryUrl: string | null;
  queuedAt: string | null;
  finishedAt: string | null;
  /** The component's rowVersion after a publish; null from build submits and status reads @lastreviewed null */
  componentRowVersion: number | null;
}

/** A catalog row from the tenant's custom-component catalog. @lastreviewed null */
interface CatalogEntry {
  topId: string;
  repoName: string | null;
}

/** The GraphQL response envelope: data and/or errors. @lastreviewed null */
interface GqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
}

/** The selection set requested for every `ComponentBuildStatus` answer. @lastreviewed null */
const BUILD_STATUS_FIELDS = `buildId ref sha state
  diagnostics { severity file line column message }
  log entryUrl queuedAt finishedAt componentRowVersion`;

/**
 * Custom-component build and publish operations against the platform's GraphQL
 * surface: submit a build (`buildCustomComponent`), read a build's state
 * (`customComponentBuild`), and publish the current draft
 * (`publishCustomComponent`). The platform owns every gate — this service sends
 * the operation and reports what came back; it never builds or validates
 * locally.
 *
 * A component is addressed by its git repo URL
 * (`https://<host>/git/component/<name>.git`): the origin names the tenant, the
 * repo name is resolved to the component's catalog id through the
 * `customComponents` query on first use and cached for the lifetime of this
 * service instance.
 *
 * Everything it needs arrives through the constructor as a
 * {@link PlatformContext} — unlike the script tree it reads no files and keeps
 * no store, so the shared bundle is the whole bundle.
 * @lastreviewed null
 */
export class ComponentService {
  constructor(private readonly ctx: PlatformContext) {}

  /** repoName resolution cache, keyed `origin|repoName`, per service instance. @lastreviewed null */
  private readonly idCache = new Map<string, string>();

  /**
   * Parse a component git repo URL into its {@link ComponentRef}.
   *
   * Accepts `https://<host>/git/component/<name>.git` (the `.git` suffix and a
   * trailing slash are optional) and nothing else — a non-https scheme, a
   * script repo URL (`/git/script/...`) or a bare origin is refused, naming
   * what was expected.
   * @throws Err.ComponentUrlError when the URL is not a component repo URL
   * @lastreviewed null
   */
  static parseRepoUrl(repoUrl: string): ComponentRef {
    let url: URL;
    try {
      url = new URL(repoUrl);
    } catch {
      throw new Err.ComponentUrlError(
        `Not a component repo URL: "${repoUrl}" is not a URL (expected https://<host>/git/component/<name>.git)`
      );
    }
    // Only https gives a usable origin: ssh/git/file URLs have origin "null",
    // and http would carry the session token in the clear.
    if (url.protocol !== "https:") {
      throw new Err.ComponentUrlError(
        `Not a component repo URL: ${repoUrl} uses ${url.protocol.replace(/:$/, "")} ` +
          `(expected https://<host>/git/component/<name>.git)`
      );
    }
    const match = /^\/git\/component\/([^/]+?)(\.git)?\/?$/.exec(url.pathname);
    if (!match || match[1] === ".git") {
      throw new Err.ComponentUrlError(
        `Not a component repo URL: ${repoUrl} (expected https://<host>/git/component/<name>.git)`
      );
    }
    return { origin: url.origin, repoName: match[1] };
  }

  /**
   * Submit a build of the component's source at `ref` (the platform defaults it
   * to the `draft` working branch) and return the platform's answer: the QUEUED
   * build, or — submits are idempotent per commit — the already active or
   * succeeded build of that commit.
   *
   * With `wait`, polls the build until it reaches a terminal state and returns
   * that instead; a timeout throws with the last observed state named.
   * @lastreviewed null
   */
  async build(opts: {
    repoUrl: string;
    ref?: string;
    wait?: boolean;
    /** Poll spacing while waiting; tests inject 0 @lastreviewed null */
    pollIntervalMs?: number;
    /** Overall wait budget; elapsed throws rather than polling forever @lastreviewed null */
    timeoutMs?: number;
  }): Promise<ComponentBuildStatus> {
    const component = ComponentService.parseRepoUrl(opts.repoUrl);
    const id = await this.resolveComponentId(component);
    return this.evictingOnRefusal(component, async () => {
      const submitted = ComponentService.requireResult(
        "buildCustomComponent",
        (
          await this.gql<{ buildCustomComponent: ComponentBuildStatus }>(
            component.origin,
            `mutation Build($id: String!, $ref: String) { buildCustomComponent(id: $id, ref: $ref) { ${BUILD_STATUS_FIELDS} } }`,
            { id, ref: opts.ref ?? null }
          )
        ).buildCustomComponent
      );
      if (!opts.wait || submitted.state === "SUCCEEDED" || submitted.state === "FAILED") {
        return submitted;
      }
      return this.waitForBuild(component, id, submitted, opts.pollIntervalMs, opts.timeoutMs);
    });
  }

  /**
   * The build to report on: the newest build of the exact `sha` when given,
   * else the component's newest build overall. Null when nothing was ever
   * built.
   * @lastreviewed null
   */
  async status(opts: { repoUrl: string; sha?: string }): Promise<ComponentBuildStatus | null> {
    const component = ComponentService.parseRepoUrl(opts.repoUrl);
    const id = await this.resolveComponentId(component);
    return this.evictingOnRefusal(component, () => this.fetchStatus(component.origin, id, opts.sha ?? null));
  }

  /**
   * Publish the component's current draft. The platform requires a SUCCEEDED
   * build of exactly the draft's current commit — publish never builds — and
   * answers the published build. A refusal (no build, stale build, artifact
   * aged out) arrives as a GraphQL error and is thrown with the platform's own
   * explanation.
   * @lastreviewed null
   */
  async publish(opts: { repoUrl: string }): Promise<ComponentBuildStatus> {
    const component = ComponentService.parseRepoUrl(opts.repoUrl);
    const id = await this.resolveComponentId(component);
    return this.evictingOnRefusal(component, async () =>
      ComponentService.requireResult(
        "publishCustomComponent",
        (
          await this.gql<{ publishCustomComponent: ComponentBuildStatus }>(
            component.origin,
            `mutation Publish($id: String!) { publishCustomComponent(id: $id) { ${BUILD_STATUS_FIELDS} } }`,
            { id }
          )
        ).publishCustomComponent
      )
    );
  }

  /**
   * Resolve a {@link ComponentRef} to the component's catalog id through the
   * tenant's `customComponents` catalog, cached per origin+name for this
   * service instance. An unknown name throws naming the names that do exist,
   * since the caller most likely holds a clone whose component was renamed or
   * deleted.
   * @lastreviewed null
   */
  async resolveComponentId(ref: ComponentRef): Promise<string> {
    const cacheKey = `${ref.origin}|${ref.repoName}`;
    const cached = this.idCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const data = await this.gql<{ customComponents: CatalogEntry[] }>(
      ref.origin,
      `query Catalog { customComponents { topId repoName } }`,
      {}
    );
    const hit = data.customComponents.find((c) => c.repoName === ref.repoName);
    if (!hit) {
      const known = data.customComponents.map((c) => c.repoName).filter((n): n is string => n !== null);
      throw new Err.ComponentNotFoundError(ref.repoName, known);
    }
    this.idCache.set(cacheKey, hit.topId);
    return hit.topId;
  }

  /**
   * Poll `customComponentBuild` for the submitted build's sha until it reports
   * a terminal state. Progress goes to the logger per observed transition, not
   * per poll, so a quiet build logs twice rather than two hundred times.
   * @lastreviewed null
   */
  private async waitForBuild(
    component: ComponentRef,
    id: string,
    submitted: ComponentBuildStatus,
    pollIntervalMs = ComponentService.DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = ComponentService.DEFAULT_BUILD_TIMEOUT_MS
  ): Promise<ComponentBuildStatus> {
    // A NaN or infinite budget would otherwise never reach the deadline.
    const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : ComponentService.DEFAULT_BUILD_TIMEOUT_MS;
    const interval =
      Number.isFinite(pollIntervalMs) && pollIntervalMs >= 0
        ? pollIntervalMs
        : ComponentService.DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + budget;
    let lastState: BuildState = submitted.state;
    this.ctx.logger.info(`Build ${submitted.buildId} of ${component.repoName}@${submitted.sha}: ${lastState}`);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Err.ComponentBuildTimeoutError(
          component.repoName,
          submitted.sha,
          submitted.buildId,
          lastState,
          budget
        );
      }
      // Clamped so the last sleep ends at the deadline and is followed by one
      // final poll rather than overshooting by a whole interval.
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, remaining)));
      const current = await this.fetchStatus(component.origin, id, submitted.sha);
      if (!current || current.buildId !== submitted.buildId) {
        // null: the read raced the new record. A different buildId: an older
        // build of the same sha (a resubmit after FAILED creates a new one).
        // Either way, keep polling for the build that was submitted.
        continue;
      }
      if (current.state !== lastState) {
        lastState = current.state;
        this.ctx.logger.info(`Build ${current.buildId} of ${component.repoName}@${current.sha}: ${lastState}`);
      }
      if (current.state === "SUCCEEDED" || current.state === "FAILED") {
        return current;
      }
    }
  }

  private async fetchStatus(origin: string, id: string, sha: string | null): Promise<ComponentBuildStatus | null> {
    const data = await this.gql<{ customComponentBuild: ComponentBuildStatus | null }>(
      origin,
      `query Status($id: String!, $sha: String) { customComponentBuild(id: $id, sha: $sha) { ${BUILD_STATUS_FIELDS} } }`,
      { id, sha }
    );
    return data.customComponentBuild;
  }

  /**
   * POST one GraphQL operation to the origin's `/gql` through the managed
   * session (`csrfFetch`), throwing on an HTTP failure or any GraphQL error —
   * the platform's refusal text is the message a consumer shows.
   * @lastreviewed null
   */
  private async gql<T>(origin: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.ctx.sessionManager.csrfFetch(new URL("gql", origin + "/"), {
      method: Http.Methods.POST,
      headers: {
        [Http.Headers.CONTENT_TYPE]: MimeTypes.APPLICATION_JSON,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Err.HttpResponseError(`Component operation failed: ${response.status} ${text.slice(0, 1_000)}`);
    }
    let json: GqlEnvelope<T>;
    try {
      json = (await response.json()) as GqlEnvelope<T>;
    } catch {
      // A 200 that isn't JSON is a proxy or login page, not a GraphQL answer.
      throw new Err.ComponentOperationError(["The platform answered 200 with a body that is not JSON"]);
    }
    if (json.errors?.length) {
      throw new Err.ComponentOperationError(json.errors.map((e) => e.message));
    }
    if (json.data == null) {
      throw new Err.ComponentOperationError(["The platform answered neither data nor errors"]);
    }
    return json.data;
  }

  /**
   * The non-null answer a GraphQL root field declared `!` must carry; a missing
   * or null one is a malformed envelope, not a result.
   * @lastreviewed null
   */
  private static requireResult<T>(field: string, value: T | null | undefined): T {
    if (value == null) {
      throw new Err.ComponentOperationError([`The platform answered without a ${field} result`]);
    }
    return value;
  }

  /**
   * Run `op`, and when the platform refuses it, evict the component's cached
   * catalog id first — a component deleted and recreated under the same repo
   * name gets a new id, and a stale entry would otherwise refuse forever in a
   * long-lived service (the VS Code extension holds one for the whole session).
   * @lastreviewed null
   */
  private async evictingOnRefusal<T>(component: ComponentRef, op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof Err.ComponentOperationError) {
        this.idCache.delete(`${component.origin}|${component.repoName}`);
      }
      throw e;
    }
  }

  /** Poll spacing while waiting on a build. @lastreviewed null */
  private static readonly DEFAULT_POLL_INTERVAL_MS = 3_000;

  /**
   * Overall wait budget for `build --wait`. Generous on purpose: a build is one
   * Kubernetes Job including image pull and queue time, and the platform's own
   * watchdog condemns a dead Job well inside this window.
   * @lastreviewed null
   */
  private static readonly DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;
}
