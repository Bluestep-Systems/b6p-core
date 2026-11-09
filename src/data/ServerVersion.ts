import { ApiEndpoints } from "../constants";

/**
 * Earliest server release whose push flow core 0.9.0 speaks: WebDAV never compiles, GraphQL
 * `compileDraft` compiles the draft, and `takeSnapshot` recompiles and publishes (web #1961 and
 * #1957). A server at or above it (or a `dev` build) gets the server flow; any other server gets a
 * draft-only push, and a snapshot push to it takes no snapshot (ruling 46). `null` until that
 * release is cut; while unset, every server but a `dev` build gets the draft-only route.
 * //HUMAN-REVIEW-NEEDED set this to the first web release tag containing web #1961 and #1957
 * (2731b31060, 3c44dc71fc) before #23 releases.
 * @lastreviewed null
 */
export const MIN_SERVER_VERSION: string | null = null;

/** What the server reports on a local build: always current. @lastreviewed null */
const DEV_VERSION = "dev";

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
 * such as `26.11.02.05` sorts below `26.11.09.00`). Exactly `dev` is current and meets any floor.
 * An unreadable version, or an unreadable floor, does not.
 * @lastreviewed null
 */
export function meetsMinimumVersion(serverVersion: string, floor: string): boolean {
  if (serverVersion.trim() === DEV_VERSION) {
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
 * Which route a push takes, and why (ruling 46).
 *  - `server`: sources go to `draft/`, then the platform compiles (`compileDraft`) and, for a
 *    snapshot push, publishes (`takeSnapshot`); reason `dev` or `at-or-above-floor`.
 *  - `draft-only`: sources go to `draft/` and nothing else happens, because the server does not
 *    support server-side compile; reason `below-floor`, `unknown` (the version could not be read,
 *    or is not a release tag) or `floor-unset`.
 * @lastreviewed null
 */
export interface PushRoute {
  /** What the push does after the sources are saved. @lastreviewed null */
  readonly mode: "server" | "draft-only";
  /** Why this mode was chosen. @lastreviewed null */
  readonly reason: "dev" | "at-or-above-floor" | "below-floor" | "unknown" | "floor-unset";
  /** The version the server reported (trimmed), or `null` when it could not be read. @lastreviewed null */
  readonly serverVersion: string | null;
  /** The floor compared against, or `null` while it is unset. @lastreviewed null */
  readonly required: string | null;
}

/**
 * Why a snapshot push took no snapshot: the server does not support server-side compile.
 * `too-old` (a readable version below the floor), `unknown` (no readable version) or `floor-unset`
 * (the floor is not yet known). The sources were still saved to the draft.
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
 * The snapshot refusal a route implies: `null` on the server route, otherwise why the draft-only
 * route cannot take a snapshot.
 * @lastreviewed null
 */
export function snapshotRefusalFor(route: PushRoute): SnapshotRefusal | null {
  if (route.mode === "server") {
    return null;
  }
  const reason =
    route.reason === "below-floor" ? "too-old" : route.reason === "floor-unset" ? "floor-unset" : "unknown";
  return { reason, serverVersion: route.serverVersion, required: route.required };
}

/**
 * Asks the org's server for its version and picks the push's route: the server flow when it is a
 * `dev` build or at or above the floor, otherwise draft-only. Never throws and never refuses a
 * push: a version that cannot be read picks draft-only, which every server supports. Called once
 * per push, before anything is uploaded.
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

  if (serverVersion === DEV_VERSION) {
    return { mode: "server", reason: "dev", serverVersion, required };
  }
  if (serverVersion === null || parseReleaseTag(serverVersion) === null) {
    // Nothing readable, or something that is not a release tag: not trusted to compile.
    return { mode: "draft-only", reason: "unknown", serverVersion, required };
  }
  if (required === null) {
    return { mode: "draft-only", reason: "floor-unset", serverVersion, required };
  }
  return meetsMinimumVersion(serverVersion, required)
    ? { mode: "server", reason: "at-or-above-floor", serverVersion, required }
    : { mode: "draft-only", reason: "below-floor", serverVersion, required };
}
