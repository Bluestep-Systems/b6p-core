import * as path from "node:path";
import { GitCredential } from "../constants/GitCredential";

/**
 * One `credential.helper` or `credential.<url>.helper` entry, or an `includeIf.<condition>.path`
 * entry, of the git config in effect where it was read (system, global, the repository's local
 * and worktree files, the command line and `GIT_CONFIG_COUNT`, and what they include), in git's
 * order.
 * @lastreviewed null
 */
export interface GitCredentialConfigEntry {
  /**
   * The key exactly as git prints it: section and name lowercase, the URL subsection as written
   * (git treats it as case-sensitive when writing).
   * @lastreviewed null
   */
  readonly key: string;
  readonly value: string;
  /**
   * The file it came from, or `null` when it did not come from a file.
   * @lastreviewed null
   */
  readonly file: string | null;
}

/**
 * A {@link GitCredentialConfigEntry} with its scope (`system`, `global`, `local`, `worktree`,
 * `command`), what it is (a credential helper, or a conditional include whose file may add one in
 * another repository), and for a helper its URL pattern: the subsection (`""` for
 * `[credential ""]`), or `null` for the generic `credential.helper`.
 * @lastreviewed null
 */
export interface HelperEntry extends GitCredentialConfigEntry {
  readonly scope: string;
  readonly kind: "helper" | "includeif";
  readonly url: string | null;
}

const HELPER_KEY = /^credential\.(.*)\.helper$/i;
const INCLUDEIF_KEY = /^includeif\..*\.path$/i;
const GENERIC_HELPER_KEY = "credential.helper";
const FILE_ORIGIN = "file:";

/**
 * The `git config` arguments that list every credential and conditional-include entry of the
 * config in effect, includes followed, with scope and origin. No scope option: git 2.53's
 * `--global` reads only the file it would write, which misses `$XDG_CONFIG_HOME/git/config` beside
 * `~/.gitconfig`, and status needs every scope.
 * @lastreviewed null
 */
export const LIST_CREDENTIAL_ENTRIES: readonly string[] = [
  "--includes",
  "--show-scope",
  "--show-origin",
  "--null",
  "--get-regexp",
  "^(credential|includeif)\\.",
];

/**
 * The helper and conditional-include entries of `git config` output for
 * {@link LIST_CREDENTIAL_ENTRIES}: each entry is `<scope>\0<origin>\0<key>\n<value>\0` (no `\n` for
 * a key with no value), every scope kept.
 * @lastreviewed null
 */
export function parseHelperEntries(stdout: string): HelperEntry[] {
  const fields = stdout.split("\0");
  const entries: HelperEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [scope, origin, record] = [fields[i], fields[i + 1], fields[i + 2]];
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "" : record.slice(newline + 1);
    const url = HELPER_KEY.exec(key)?.[1];
    const includeIf = INCLUDEIF_KEY.test(key);
    if (url === undefined && !includeIf && key.toLowerCase() !== GENERIC_HELPER_KEY) {
      continue;
    }
    entries.push({
      key,
      value,
      file: origin.startsWith(FILE_ORIGIN) ? origin.slice(FILE_ORIGIN.length) : null,
      scope,
      kind: includeIf ? "includeif" : "helper",
      url: url ?? null,
    });
  }
  return entries;
}

function splitPort(authority: string): { host: string; port: string } {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    const rest = end === -1 ? "" : authority.slice(end + 1);
    return { host: authority.slice(0, end + 1), port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const colon = authority.lastIndexOf(":");
  return colon === -1
    ? { host: authority, port: "" }
    : { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

/**
 * Whether a `credential.<url>.*` entry applies to the requests b6p answers for one allowed host:
 *
 * - `yes`: to every one of them, whatever the repository path, the spelling of the host or the
 *   username in the remote URL;
 * - `no`: to none;
 * - `maybe`: to some (an entry scoped to a path, one naming the `b6p` user, a partial-URL entry
 *   whose host git compares as written).
 * @lastreviewed null
 */
export type CredentialContextMatch = "yes" | "no" | "maybe";

// git 2.53 urlmatch.c: the character classes of url_normalize_1 and append_normalized_escapes.
const URL_SCHEME_CHARS = /^[A-Za-z0-9+.-]*/;
const URL_HOST_CHARS = /^[A-Za-z0-9.\-_[:\]*]*/;
const URL_UNSAFE_CHARS = ' <>"%{}|\\^`';
const URL_RESERVED = ":/?#[]@!$&'()*+,;=";

// git's hex2chr: the byte two hex digits spell, or -1.
function hexByte(text: string, at: number): number {
  const pair = text.slice(at, at + 2);
  return /^[0-9A-Fa-f]{2}$/.test(pair) ? parseInt(pair, 16) : -1;
}

/**
 * git's append_normalized_escapes with no extra escapes and the reserved delimiters left as found:
 * `%XX` of an unreserved byte is decoded, an unsafe byte is escaped, every escape is uppercase.
 * `null` for a `%` not followed by two hex digits (git then rejects the URL).
 * @lastreviewed null
 */
function normalizeEscapes(text: string): string | null {
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    let ch = bytes[i];
    let wasEscaped = false;
    if (ch === 0x25) {
      const hex = bytes.subarray(i + 1, i + 3).toString("latin1");
      const value = hex.length === 2 ? hexByte(hex, 0) : -1;
      if (value < 0) {
        return null;
      }
      ch = value;
      i += 2;
      wasEscaped = true;
    }
    const c = String.fromCharCode(ch);
    if (ch <= 0x1f || ch >= 0x7f || URL_UNSAFE_CHARS.includes(c) || (wasEscaped && URL_RESERVED.includes(c))) {
      out += `%${ch.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += c;
    }
  }
  return out;
}

// git's url_decode_mem: each `%XX` (but `%00`) becomes its byte; anything else stays as it is.
function urlDecode(text: string): string {
  const out: number[] = [];
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x25 && i + 2 < bytes.length) {
      const value = hexByte(bytes.subarray(i + 1, i + 3).toString("latin1"), 0);
      if (value > 0) {
        out.push(value);
        i += 2;
        continue;
      }
    }
    out.push(bytes[i]);
  }
  return Buffer.from(out).toString("utf8");
}

/**
 * A URL pattern as git 2.53's url_normalize_1 (urlmatch.c, globs allowed) leaves it, or `null`
 * where git rejects it and falls back to partial-URL matching.
 * @lastreviewed null
 */
interface NormalizedPattern {
  readonly scheme: string;
  // The user name (escapes normalized), `null` when the pattern names none.
  readonly user: string | null;
  // Lowercase; `*` labels kept.
  readonly host: string;
  // Digits without leading zeros, `""` for the scheme's default.
  readonly port: string;
  // The path with dot segments resolved, then any query or fragment: `/` for none.
  readonly path: string;
}

function normalizePattern(url: string): NormalizedPattern | null {
  const spanned = URL_SCHEME_CHARS.exec(url)?.[0].length ?? 0;
  if (
    spanned === 0 ||
    !/^[A-Za-z]/.test(url) ||
    spanned + 3 > url.length ||
    url.slice(spanned, spanned + 3) !== "://"
  ) {
    return null;
  }
  const scheme = url.slice(0, spanned).toLowerCase();
  let rest = url.slice(spanned + 3);
  const delimiter = rest.search(/[/?#]/);
  let slash = delimiter === -1 ? rest.length : delimiter;
  let user: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1 && at < slash) {
    user = "";
    if (at > 0) {
      const userinfo = normalizeEscapes(rest.slice(0, at));
      if (userinfo === null) {
        return null;
      }
      const colon = userinfo.indexOf(":");
      user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    }
    rest = rest.slice(at + 1);
    slash -= at + 1;
  }
  if (rest === "" || ":/?#".includes(rest[0])) {
    return null; // A missing host: only file: URLs may have one.
  }
  let colon = slash - 1;
  while (colon > 0 && rest[colon] !== ":" && rest[colon] !== "]") {
    colon--;
  }
  if (rest[colon] !== ":") {
    colon = slash;
  }
  if ((URL_HOST_CHARS.exec(rest)?.[0].length ?? 0) < colon) {
    return null; // Invalid characters in the host, a `%` escape included.
  }
  const host = rest.slice(0, colon).toLowerCase();
  let port = "";
  if (colon < slash) {
    const written = rest.slice(colon + 1, slash);
    const digits = written === "" ? "" : written.replace(/^0+/, "") || "0";
    if (digits !== "" && !(scheme === "https" && digits === "443") && !(scheme === "http" && digits === "80")) {
      if (!/^\d+$/.test(digits) || digits.length > 5 || Number(digits) === 0 || Number(digits) > 65535) {
        return null;
      }
      port = digits;
    }
  }
  const path = normalizePath(rest.slice(slash));
  return path === null ? null : { scheme, user, host, port, path };
}

// The path loop of url_normalize_1: escapes normalized, `.` and `..` resolved, the rest appended.
function normalizePath(written: string): string | null {
  let rest = written.startsWith("/") ? written.slice(1) : written;
  let norm = "/";
  for (;;) {
    const segmentStart = norm.length;
    const found = rest.search(/[/?#]/);
    const next = found === -1 ? rest.length : found;
    const segment = normalizeEscapes(rest.slice(0, next));
    if (segment === null) {
      return null;
    }
    norm += segment;
    let skipSlash = false;
    if (segment === ".") {
      if (segmentStart === 1) {
        norm = norm.slice(0, -1);
        skipSlash = true;
      } else {
        norm = norm.slice(0, -2);
      }
    } else if (segment === "..") {
      let previous = norm.length - 3;
      if (previous <= 0) {
        return null;
      }
      while (norm[--previous] !== "/") {
        // Back to the slash before the previous segment.
      }
      if (previous === 0) {
        norm = norm.slice(0, 1);
        skipSlash = true;
      } else {
        norm = norm.slice(0, previous);
      }
    }
    rest = rest.slice(next);
    if (!rest.startsWith("/")) {
      break;
    }
    rest = rest.slice(1);
    if (!skipSlash) {
      norm += "/";
    }
  }
  if (rest !== "") {
    const tail = normalizeEscapes(rest);
    if (tail === null) {
      return null;
    }
    norm += tail;
  }
  return norm;
}

// urlmatch.c match_host: label by label, a label that is exactly `*` matching any one.
function matchHost(have: string, pattern: string): boolean {
  let url = have;
  let pat = pattern;
  while (url !== "" && pat !== "") {
    const urlDot = url.indexOf(".");
    const patDot = pat.indexOf(".");
    const urlLabel = urlDot === -1 ? url : url.slice(0, urlDot);
    const patLabel = patDot === -1 ? pat : pat.slice(0, patDot);
    if (patLabel !== "*" && patLabel !== urlLabel) {
      return false;
    }
    url = urlDot === -1 ? "" : url.slice(urlDot + 1);
    pat = patDot === -1 ? "" : pat.slice(patDot + 1);
  }
  return url === "" && pat === "";
}

/**
 * credential.c match_partial_url, for a pattern git could not normalize: the pattern is split as
 * credential_from_url_1 does with partial URLs allowed (parts percent-decoded), and each part it
 * sets must equal the request's as written (case-sensitive), which is all git compares.
 * @lastreviewed null
 */
function partialMatch(url: string, host: string): CredentialContextMatch {
  const protoEnd = url.indexOf("://");
  const cp = protoEnd === -1 ? 0 : protoEnd + 3;
  const at = url.indexOf("@", cp);
  const colon = url.indexOf(":", cp);
  const found = url.slice(cp).search(/[/?#]/);
  const slash = found === -1 ? url.length : cp + found;
  let username: string | undefined;
  let hostStart = cp;
  if (at !== -1 && slash > at) {
    username = urlDecode(url.slice(cp, colon === -1 || at <= colon ? at : colon));
    hostStart = at + 1;
  }
  const protocol = protoEnd > 0 ? url.slice(0, protoEnd) : undefined;
  const wantHost = slash - hostStart > 0 ? urlDecode(url.slice(hostStart, slash)) : undefined;
  let pathStart = slash;
  while (url[pathStart] === "/") {
    pathStart++;
  }
  const wantPath = pathStart < url.length ? urlDecode(url.slice(pathStart)) : undefined;
  if ([username, protocol, wantHost, wantPath].some((part) => part?.includes("\n"))) {
    return "no"; // git warns and skips the entry.
  }
  let match: CredentialContextMatch = "yes";
  if (protocol !== undefined && protocol !== "https") {
    return "no";
  }
  if (wantHost !== undefined) {
    // The request's host is as the remote URL wrote it: b6p answers any case of the allowed host, and `:443` beside
    // a default port, so a pattern naming one spelling matches only some of those requests.
    const spellings = splitPort(host).port === "" ? [host, `${host}:443`] : [host];
    if (!spellings.includes(wantHost.toLowerCase())) {
      return "no";
    }
    match = "maybe";
  }
  if (username !== undefined) {
    if (username !== GitCredential.USERNAME) {
      return "no"; // b6p answers only requests with no username or `b6p`.
    }
    match = "maybe";
  }
  if (wantPath !== undefined) {
    match = "maybe"; // The request's path is the repository's.
  }
  return match;
}

/**
 * How a `credential.<url>.*` entry (`url` the subsection, `null` for the generic entry) applies to
 * the https requests b6p answers for `host` (`host[:port]`, as on the allowlist), following git
 * 2.53's credential contexts exactly: every matching entry applies, in config order (select_all).
 *
 * - A pattern git can normalize (urlmatch.c url_normalize_1) matches by scheme (case-insensitive),
 *   host (case-insensitive, a whole `*` label matching any one label, no `%` escapes), port
 *   (leading zeros dropped, the scheme's default the same as none), the user when it names one,
 *   and the path as a prefix on a `/` boundary (escapes normalized, dot segments resolved).
 * - Any other pattern (no scheme, a missing host as in `https://`, a `%` in the host, port 0) is
 *   matched as credential.c match_partial_url does: each part it names, percent-decoded, must
 *   equal the request's exactly. `https://` names only the protocol, so it matches every https
 *   request.
 *
 * A request's path, the case of its host and a username in the remote URL are not known here, so
 * an entry that depends on them is `maybe`.
 * @lastreviewed null
 */
export function credentialContextMatch(url: string | null, host: string): CredentialContextMatch {
  if (url === null) {
    return "yes";
  }
  const pattern = normalizePattern(url);
  if (pattern === null) {
    return partialMatch(url, host);
  }
  const target = splitPort(host.toLowerCase());
  if (pattern.scheme !== "https") {
    return "no";
  }
  if (pattern.user !== null && pattern.user !== GitCredential.USERNAME) {
    return "no";
  }
  if (!matchHost(target.host, pattern.host)) {
    return "no";
  }
  if (pattern.port !== (target.port === "443" ? "" : target.port)) {
    return "no";
  }
  return pattern.user !== null || pattern.path !== "/" ? "maybe" : "yes";
}

/**
 * Whether git may use a `credential.<url>.*` entry for a request b6p answers for `host`: its
 * {@link credentialContextMatch} is `yes` or `maybe`.
 * @lastreviewed null
 */
export function patternApplies(url: string | null, host: string): boolean {
  return credentialContextMatch(url, host) !== "no";
}

/**
 * Whether a URL pattern names exactly `https://<host>` in a form git normalizes (setup's own
 * spelling, or another case or port spelling of it): no wildcard, user, path, query or other port.
 * @lastreviewed null
 */
export function patternIsHost(url: string, host: string): boolean {
  const pattern = normalizePattern(url);
  const target = splitPort(host.toLowerCase());
  return (
    pattern !== null &&
    pattern.scheme === "https" &&
    pattern.user === null &&
    pattern.path === "/" &&
    pattern.host === target.host &&
    pattern.port === (target.port === "443" ? "" : target.port)
  );
}

/**
 * What git asks for `host`: every applying entry in order, each empty value clearing the list so
 * far. `helpers` are b6p's own commands. Where an entry applies to only some of the requests
 * ({@link credentialContextMatch} `maybe`), the answer takes the worst case for each question: a
 * foreign helper counts as asked, and a reset or b6p's own entry counts as not applying when it
 * would hide a foreign helper, and as applying when it would clear b6p.
 *
 * - `configured`: git certainly asks b6p and no other helper.
 * - `alsoAsked`: the other helpers git may ask, in order, without repeats.
 * - `others`: the entries that keep b6p from being the only helper asked: each other helper git
 *   may ask, each `includeIf` after the last reset (its file may add a helper in another
 *   repository), and the reset that may clear b6p when a b6p entry came before it.
 * @lastreviewed null
 */
export function askedFor(
  entries: readonly HelperEntry[],
  host: string,
  helpers: ReadonlySet<string>
): { configured: boolean; alsoAsked: string[]; others: GitCredentialConfigEntry[] } {
  let foreign: HelperEntry[] = [];
  let surelyB6p = false;
  let clearedB6p: HelperEntry | null = null;
  for (const entry of entries) {
    if (entry.kind === "includeif") {
      // Its file is read only where its condition holds; in another repository it may add a helper here.
      foreign.push(entry);
      continue;
    }
    const match = credentialContextMatch(entry.url, host);
    if (match === "no") {
      continue;
    }
    if (entry.value === "") {
      if (match === "yes") {
        foreign = [];
      }
      if (surelyB6p) {
        clearedB6p = entry;
      }
      surelyB6p = false;
    } else if (helpers.has(entry.value)) {
      surelyB6p ||= match === "yes";
    } else {
      foreign.push(entry);
    }
  }
  const others: GitCredentialConfigEntry[] = foreign.map(({ key, value, file }) => ({ key, value, file }));
  if (!surelyB6p && clearedB6p) {
    others.push({ key: clearedB6p.key, value: clearedB6p.value, file: clearedB6p.file });
  }
  return {
    configured: surelyB6p && foreign.length === 0,
    alsoAsked: [...new Set(foreign.filter((e) => e.kind === "helper").map((e) => e.value))],
    others,
  };
}

/**
 * How config file paths are spelled and compared: `win32` (git for Windows reports forward
 * slashes, a path b6p builds has backslashes, and the file system ignores case) or `posix`.
 * @lastreviewed null
 */
export type ConfigPathStyle = "posix" | "win32";

/**
 * The form of a config file path that two spellings of the same file share: on `win32`
 * normalized with either slash and compared without case, on `posix` normalized.
 * @lastreviewed null
 */
export function configPathKey(file: string, style: ConfigPathStyle): string {
  return style === "win32" ? path.win32.normalize(file).toLowerCase() : path.posix.normalize(file);
}

function valuesOf(entries: readonly HelperEntry[], file: string, key: string, style: ConfigPathStyle): string[] {
  const want = configPathKey(file, style);
  return entries
    .filter((e) => e.file !== null && e.key === key && configPathKey(e.file, style) === want)
    .map((e) => e.value);
}

/**
 * How many times `helper` directly follows an empty value among the values of `key` (exact
 * spelling) in `file` (the pair setup writes), as git lists them.
 * @lastreviewed null
 */
export function pairsOf(
  entries: readonly HelperEntry[],
  file: string,
  key: string,
  helper: string,
  style: ConfigPathStyle
): number {
  const values = valuesOf(entries, file, key, style);
  let pairs = 0;
  for (let i = 0; i + 1 < values.length; i++) {
    if (values[i] === "" && values[i + 1] === helper) {
      pairs++;
      i++;
    }
  }
  return pairs;
}

/**
 * The value as a POSIX extended regex matching exactly it (git's value-pattern).
 * @lastreviewed null
 */
export function exactValuePattern(value: string): string {
  return `^${value.replace(/[.[\]{}()\\*+?^$|]/g, "\\$&")}$`;
}

/**
 * The key setup writes for `host`.
 * @lastreviewed null
 */
export function helperKeyFor(host: string): string {
  return `credential.https://${host}.helper`;
}

/**
 * The URL pattern of a `credential.<url>.helper` key, or `null` for any other key.
 * @lastreviewed null
 */
export function urlOfKey(key: string): string | null {
  return HELPER_KEY.exec(key)?.[1] ?? null;
}
