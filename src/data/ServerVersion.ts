import { ApiEndpoints } from "../constants";
import { Err } from "../Err";

/**
 * Earliest server release whose push flow core 0.9.0 speaks: WebDAV never compiles, GraphQL
 * `compileDraft` compiles the draft, and `takeSnapshot` recompiles and publishes (web #1961 and
 * #1957). Core has no compiler of its own, so every push, plain or snapshot, needs it. `null`
 * until that release is cut; while unset, a push to any server but a `dev` build is refused with
 * reason `floor-unset`.
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
 * Asks the org's server for its version and refuses the operation when it predates server-side
 * compiling. Called once per push, before anything is uploaded.
 * @param opts.origin The org's origin (same as the push's)
 * @param opts.fetchFn The session's `fetch`, so the request shares the push's origin and session
 * @param opts.operation Which push is asking; reported on the error, and the same floor applies
 * @param opts.floor Overrides {@link MIN_SERVER_VERSION} (`null` means unset); used by tests
 * @throws an {@link Err.ServerVersionUnsupportedError} when the server is too old, its version
 *   cannot be read, or the floor is not yet known
 * @lastreviewed null
 */
export async function assertServerVersion(opts: {
  origin: string | URL;
  fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>;
  operation: "push" | "snapshot";
  floor?: string | null;
}): Promise<void> {
  const { origin, fetchFn, operation } = opts;
  const required = opts.floor !== undefined ? opts.floor : MIN_SERVER_VERSION;
  const label = operation === "snapshot" ? "a snapshot push" : "a push";

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

  if (serverVersion !== null && serverVersion !== DEV_VERSION && parseReleaseTag(serverVersion) === null) {
    // Reported something that is not a release tag: unreadable, not trusted.
    throw new Err.ServerVersionUnsupportedError(
      `The server at ${url.origin} reported the version "${serverVersion}", which is not a release version, ` +
        `so it cannot be confirmed to compile scripts itself, which ${label} needs.`,
      { serverVersion, required, operation, reason: "unknown" }
    );
  }
  if (serverVersion === null) {
    throw new Err.ServerVersionUnsupportedError(
      `The version of the server at ${url.origin} could not be read, so it cannot be confirmed to compile ` +
        `scripts itself, which ${label} needs.`,
      { serverVersion: null, required, operation, reason: "unknown" }
    );
  }
  if (serverVersion === DEV_VERSION) {
    return;
  }
  if (required === null) {
    throw new Err.ServerVersionUnsupportedError(
      `The server at ${url.origin} is version ${serverVersion}, and the release that first supports ${label} ` +
        `is not yet known.`,
      { serverVersion, required: null, operation, reason: "floor-unset" }
    );
  }
  if (!meetsMinimumVersion(serverVersion, required)) {
    throw new Err.ServerVersionUnsupportedError(
      `The server at ${url.origin} is version ${serverVersion}; ${label} needs ${required} or later, ` +
        `which compiles scripts on the server.`,
      { serverVersion, required, operation, reason: "too-old" }
    );
  }
}
