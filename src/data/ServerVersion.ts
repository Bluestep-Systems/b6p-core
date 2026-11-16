import { ApiEndpoints } from "../constants";

/**
 * Earliest server release that builds a git-pushed draft: GraphQL `compileDraft` with `expectedDraftSha` compiles the
 * script's draft branch and commits the output (and, when it vouches for the build, the build manifest) as a build
 * commit (web CU-1k5g91bq6u2). A server at or above it (or a `dev` build) gets the build after every push; any other
 * gets the git push alone, and a snapshot push to it publishes nothing. `null` means unset: every server but a `dev`
 * build then gets the push alone.
 * @lastreviewed null
 */
// HUMAN-REVIEW-NEEDED: placeholder. Set this to the first web release tag containing the compileDraft git build
// (CU-1k5g91bq6u2) once it is cut; 1.0.0 must not release while it is null.
export const MIN_SERVER_VERSION: string | null = null;

/**
 * What a development build reports instead of a release tag, taken as current: `dev`, and `latest`
 * (web's fast local image build sets it, ruling 49). A stale local image predating the floor would
 * get the build anyway, and its build request would fail after the push.
 * @lastreviewed null
 */
const DEV_VERSIONS: ReadonlySet<string> = new Set(["dev", "latest"]);

const RELEASE_TAG = /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/;

/**
 * Parses a release tag (`YY.MM.DD.NN`) into its numeric parts, or `null` when the text is not one.
 * Surrounding whitespace is ignored.
 * @lastreviewed null
 */
export function parseReleaseTag(text: string): number[] | null {
  const trimmed = text.trim();
  return RELEASE_TAG.test(trimmed) ? trimmed.split(".").map(Number) : null;
}

/**
 * Whether a server version meets a floor, compared numerically part by part (so a backport patch
 * such as `26.11.02.05` sorts below `26.11.09.00`). Exactly `dev` or `latest` is current and meets any floor.
 * An unreadable version, or an unreadable floor, does not.
 * @lastreviewed null
 */
export function meetsMinimumVersion(serverVersion: string, floor: string): boolean {
  if (DEV_VERSIONS.has(serverVersion.trim())) {
    return true;
  }
  const have = parseReleaseTag(serverVersion);
  const need = parseReleaseTag(floor);
  if (have === null || need === null) {
    return false;
  }
  for (let i = 0; i < need.length; i++) {
    if (have[i] !== need[i]) {
      return have[i] > need[i];
    }
  }
  return true;
}

/**
 * Which route a push takes, and why.
 *  - `server-build`: the draft is git-pushed, then the platform builds it (`compileDraft`) and, for a snapshot push,
 *    the build commit is published; reason `dev` or `at-or-above-floor`.
 *  - `push-only`: the draft is git-pushed and nothing else happens, because the server does not build git drafts;
 *    reason `below-floor`, `unknown` (the version could not be read, or is not a release tag) or `floor-unset`.
 * @lastreviewed null
 */
export interface PushRoute {
  /** What the push does after the draft is pushed. @lastreviewed null */
  readonly mode: "server-build" | "push-only";
  /** Why this mode was chosen. @lastreviewed null */
  readonly reason: "dev" | "at-or-above-floor" | "below-floor" | "unknown" | "floor-unset";
  /** The version the server reported (trimmed), or `null` when it could not be read. @lastreviewed null */
  readonly serverVersion: string | null;
  /** The floor compared against, or `null` while it is unset. @lastreviewed null */
  readonly required: string | null;
}

/**
 * Why a snapshot push took no snapshot: the server does not build git drafts.
 * `too-old` (a readable version below the floor), `unknown` (no readable version) or `floor-unset`
 * (the floor is not yet known). The draft was still pushed.
 * @lastreviewed null
 */
export interface SnapshotRefusal {
  /** Why the server is not trusted to compile and publish. @lastreviewed null */
  readonly reason: "too-old" | "unknown" | "floor-unset";
  /** The version the server reported, or `null` when it could not be read. @lastreviewed null */
  readonly serverVersion: string | null;
  /** The earliest release that supports a snapshot, or `null` when that is not yet known. @lastreviewed null */
  readonly required: string | null;
}

/**
 * The snapshot refusal a route implies: `null` on the build route, otherwise why the push-only
 * route cannot take a snapshot.
 * @lastreviewed null
 */
export function snapshotRefusalFor(route: PushRoute): SnapshotRefusal | null {
  if (route.mode === "server-build") {
    return null;
  }
  const reason =
    route.reason === "below-floor" ? "too-old" : route.reason === "floor-unset" ? "floor-unset" : "unknown";
  return { reason, serverVersion: route.serverVersion, required: route.required };
}

/**
 * Asks the org's server for its version and picks the push's route: the build when it is a
 * `dev` build or at or above the floor, otherwise push-only. Never throws and never refuses a
 * push: a version that cannot be read picks push-only, which every git server supports. Called once
 * per push, before anything is pushed.
 * @param opts.origin The org's origin (same as the push's)
 * @param opts.fetchFn The session's `fetch`, so the request shares the push's origin and session
 * @param opts.floor Overrides {@link MIN_SERVER_VERSION} (`null` means unset); used by tests
 * @lastreviewed null
 */
export async function resolvePushRoute(opts: {
  origin: string | URL;
  fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>;
  floor?: string | null;
}): Promise<PushRoute> {
  const { origin, fetchFn } = opts;
  const required = opts.floor !== undefined ? opts.floor : MIN_SERVER_VERSION;

  const url = new URL(origin);
  url.pathname = ApiEndpoints.APPINFO_VERSION;
  url.search = "";
  let serverVersion: string | null = null;
  try {
    const response = await fetchFn(url);
    if (response.status === 200) {
      const text = (await response.text()).trim();
      serverVersion = text.length > 0 ? text : null;
    }
  } catch {
    serverVersion = null;
  }

  if (serverVersion !== null && DEV_VERSIONS.has(serverVersion)) {
    return { mode: "server-build", reason: "dev", serverVersion, required };
  }
  if (serverVersion === null || parseReleaseTag(serverVersion) === null) {
    // Nothing readable, or something that is not a release tag: not trusted to compile.
    return { mode: "push-only", reason: "unknown", serverVersion, required };
  }
  if (required === null) {
    return { mode: "push-only", reason: "floor-unset", serverVersion, required };
  }
  return meetsMinimumVersion(serverVersion, required)
    ? { mode: "server-build", reason: "at-or-above-floor", serverVersion, required }
    : { mode: "push-only", reason: "below-floor", serverVersion, required };
}
