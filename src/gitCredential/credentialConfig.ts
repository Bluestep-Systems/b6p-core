/**
 * One `credential.helper` or `credential.<url>.helper` entry of the user's global git config
 * (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` and what they include), as git read it, in git's
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
 * A {@link GitCredentialConfigEntry} with its URL pattern: the subsection, or `null` for the
 * generic `credential.helper`.
 * @lastreviewed null
 */
export interface HelperEntry extends GitCredentialConfigEntry {
  readonly url: string | null;
}

const HELPER_KEY = /^credential\.(.+)\.helper$/i;
const GENERIC_HELPER_KEY = "credential.helper";
const FILE_ORIGIN = "file:";

/**
 * The `git config` arguments that list every credential entry of the global config, includes
 * followed, with scope and origin. `--global` is deliberately absent: git 2.53 reads only the file
 * it would write under `--global`, which misses `$XDG_CONFIG_HOME/git/config` beside
 * `~/.gitconfig`; every scope is read and {@link parseHelperEntries} keeps the `global` ones.
 * `--show-scope` needs git 2.26 or later.
 * @lastreviewed null
 */
export const LIST_CREDENTIAL_ENTRIES: readonly string[] = [
  "--includes",
  "--show-scope",
  "--show-origin",
  "--null",
  "--get-regexp",
  "^credential\\.",
];

/**
 * The helper entries of `git config` output for {@link LIST_CREDENTIAL_ENTRIES}: each entry is
 * `<scope>\0<origin>\0<key>\n<value>\0` (no `\n` for a key with no value). Only `global` ones.
 * @lastreviewed null
 */
export function parseHelperEntries(stdout: string): HelperEntry[] {
  const fields = stdout.split("\0");
  const entries: HelperEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [scope, origin, record] = [fields[i], fields[i + 1], fields[i + 2]];
    if (scope !== "global") {
      continue;
    }
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "" : record.slice(newline + 1);
    const url = HELPER_KEY.exec(key)?.[1];
    if (url === undefined && key.toLowerCase() !== GENERIC_HELPER_KEY) {
      continue;
    }
    entries.push({
      key,
      value,
      file: origin.startsWith(FILE_ORIGIN) ? origin.slice(FILE_ORIGIN.length) : null,
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
 * Whether git may use a `credential.<url>.*` entry (`url` the subsection, `null` for the generic
 * entry) for an https request to `host` (`host[:port]`, as on the allowlist), following git's
 * credential contexts (gitcredentials(7), "CREDENTIAL CONTEXTS"; git's urlmatch rules): the
 * scheme must be https, the port must match (443 when absent), each host label must match or be
 * a `*` wildcard, and every matching entry applies (git selects all, in config order, not only
 * the most specific).
 *
 * Where git's answer cannot be known from the host alone, this says yes, so status errs towards
 * "another helper may be asked" and never towards "only b6p": an entry scoped to a path (it applies
 * to the repos under it), one naming a user, a label with a partial wildcard (`gate*`), a percent
 * escape, and a pattern with no scheme (git's partial-URL fallback) all count as applying when
 * their host could be this one.
 * @lastreviewed null
 */
export function patternApplies(url: string | null, host: string): boolean {
  if (url === null) {
    return true;
  }
  let rest = url;
  const scheme = url.indexOf("://");
  if (scheme !== -1) {
    if (url.slice(0, scheme).toLowerCase() !== "https") {
      return false;
    }
    rest = url.slice(scheme + 3);
  }
  const slash = rest.indexOf("/");
  let authority = slash === -1 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  if (at !== -1) {
    authority = authority.slice(at + 1);
  }
  if (authority.includes("%")) {
    return true;
  }
  const pattern = splitPort(authority.toLowerCase());
  const target = splitPort(host.toLowerCase());
  if ((pattern.port || "443") !== (target.port || "443")) {
    return false;
  }
  const want = pattern.host.split(".");
  const have = target.host.split(".");
  if (want.length !== have.length) {
    return false;
  }
  return want.every((label, i) => label === have[i] || label.includes("*"));
}

/**
 * What git asks for `host`: every applying entry in order, each empty value clearing the list so
 * far. `helpers` are b6p's own commands.
 *
 * - `configured`: the list is not empty and holds only b6p.
 * - `alsoAsked`: the other helpers still on it, in order, without repeats.
 * - `others`: the entries that keep b6p from being the only helper asked: each other helper on the
 *   list, and the reset that cleared b6p when a b6p entry came before it.
 * @lastreviewed null
 */
export function askedFor(
  entries: readonly HelperEntry[],
  host: string,
  helpers: ReadonlySet<string>
): { configured: boolean; alsoAsked: string[]; others: GitCredentialConfigEntry[] } {
  let list: HelperEntry[] = [];
  let clearedB6p: HelperEntry | null = null;
  for (const entry of entries) {
    if (!patternApplies(entry.url, host)) {
      continue;
    }
    if (entry.value === "") {
      clearedB6p = list.some((e) => helpers.has(e.value)) ? entry : clearedB6p;
      list = [];
    } else {
      list.push(entry);
    }
  }
  const foreign = list.filter((e) => !helpers.has(e.value));
  const hasB6p = list.some((e) => helpers.has(e.value));
  const others: GitCredentialConfigEntry[] = foreign.map(({ key, value, file }) => ({ key, value, file }));
  if (!hasB6p && clearedB6p) {
    others.push({ key: clearedB6p.key, value: clearedB6p.value, file: clearedB6p.file });
  }
  return {
    configured: hasB6p && foreign.length === 0,
    alsoAsked: [...new Set(foreign.map((e) => e.value))],
    others,
  };
}

/**
 * How many empty values `key` (exact spelling) has in `file`.
 * @lastreviewed null
 */
export function emptiesOf(entries: readonly HelperEntry[], file: string, key: string): number {
  return entries.filter((e) => e.file === file && e.key === key && e.value === "").length;
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
