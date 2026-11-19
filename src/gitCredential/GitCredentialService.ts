import { GitCredential } from "../constants/GitCredential";
import { Err } from "../Err";
import { parseGatewayOrigin } from "../gateway/GatewayClient";
import { gatewayTokenProblem } from "../gateway/GatewayToken";
import type { GitCredentialContext } from "./GitCredentialContext";
import type { GitConfigOutcome } from "./GitConfigRunner";
import { credentialHostOf, requestedCredentialHost } from "./hosts";

/**
 * Where an allowed host comes from.
 *
 * - `gateway`: the configured gateway (`settings.gatewayUrl`), when it is https.
 * - `script-pull`: a tenant host a script pull reached with the stored token.
 * @lastreviewed null
 */
export type GitCredentialHostSource = "gateway" | "script-pull";

/**
 * A host b6p answers git's credential requests for.
 * @lastreviewed null
 */
export interface GitCredentialHost {
  /**
   * `host` or `host:port` (the port only when it is not 443), lowercase.
   * @lastreviewed null
   */
  readonly host: string;
  readonly source: GitCredentialHostSource;
}

/**
 * An allowed host and what git does with its credential requests, given the user's global git config.
 * @lastreviewed null
 */
export interface GitCredentialHostStatus extends GitCredentialHost {
  /**
   * Whether git asks b6p's helper first for this host (after every `helper =` reset that applies to it).
   * @lastreviewed null
   */
  readonly configured: boolean;
  /**
   * The other helpers git asks for this host, in order, and tells to store a credential that worked. Empty after
   * {@link GitCredentialService.setupGit} unless a generic `credential.helper` comes later in the config than
   * b6p's reset: a storing helper (such as `store`) listed here would keep a copy of the token.
   * @lastreviewed null
   */
  readonly alsoAsked: string[];
}

/**
 * What {@link GitCredentialService.setupStatus} found.
 * @lastreviewed null
 */
export interface GitCredentialSetupStatus {
  /**
   * Every allowed host, with whether it is set up.
   * @lastreviewed null
   */
  readonly hosts: GitCredentialHostStatus[];
  /**
   * Whether every allowed host is set up. `false` when there is no allowed host.
   * @lastreviewed null
   */
  readonly configured: boolean;
  /**
   * The generic helpers (`credential.helper`) in the global git config, which apply to every
   * https host that has no reset of its own.
   * @lastreviewed null
   */
  readonly otherHelpers: string[];
}

/**
 * What {@link GitCredentialService.setupGit} changed.
 * @lastreviewed null
 */
export interface GitCredentialSetupResult {
  /**
   * The hosts whose credential requests now go to b6p.
   * @lastreviewed null
   */
  readonly added: string[];
  /**
   * The hosts that were set up already and were left as they were.
   * @lastreviewed null
   */
  readonly alreadyConfigured: string[];
  /**
   * Every allowed host as it stands after the setup.
   * @lastreviewed null
   */
  readonly hosts: GitCredentialHostStatus[];
  /**
   * As {@link GitCredentialSetupStatus.otherHelpers}; left in place.
   * @lastreviewed null
   */
  readonly otherHelpers: string[];
}

/**
 * What {@link GitCredentialService.removeGit} took out.
 * @lastreviewed null
 */
export interface GitCredentialRemoveResult {
  /**
   * The URL each removed entry was for (`https://host`), whether or not that host is still allowed.
   * @lastreviewed null
   */
  readonly removed: string[];
  /**
   * The URLs whose reset before b6p's entry was left in place, because the same file has another
   * `helper =` for that URL that `git config` cannot tell apart from it. The entry itself was removed.
   * @lastreviewed null
   */
  readonly keptResets: string[];
}

/**
 * Options naming the helper command written into git config.
 * @lastreviewed null
 */
export interface GitCredentialHelperOptions {
  /**
   * The command git runs (default {@link GitCredential.DEFAULT_HELPER}). A consumer installed
   * somewhere `b6p` is not on PATH, or one that is not the CLI, passes its own.
   * @lastreviewed null
   */
  readonly helper?: string;
}

/**
 * Options naming the helper commands {@link GitCredentialService.removeGit} takes out.
 * @lastreviewed null
 */
export interface GitCredentialRemoveOptions {
  /**
   * The commands to remove (default just {@link GitCredential.DEFAULT_HELPER}). An entry with any
   * other value is left alone.
   * @lastreviewed null
   */
  readonly helpers?: readonly string[];
}

const HELPER_KEY = /^credential\.(.+)\.helper$/i;
const GENERIC_HELPER_KEY = "credential.helper";
const FILE_ORIGIN = "file:";

/**
 * One `credential.*.helper` (or `credential.helper`) entry of the global config (`~/.gitconfig`,
 * `$XDG_CONFIG_HOME/git/config` and what they include), as git read it, in git's order.
 * @lastreviewed null
 */
interface HelperEntry {
  /**
   * The key, as git prints it (section and name lowercase, the URL as written).
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

function sameKey(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The helpers git asks for `host`, in order: the generic and the host's own entries in config
 * order, each empty value clearing the list so far (gitcredentials(7)).
 * @lastreviewed null
 */
function effectiveHelpers(entries: readonly HelperEntry[], host: string): string[] {
  const own = helperKeyFor(host);
  const list: string[] = [];
  for (const entry of entries) {
    if (!sameKey(entry.key, GENERIC_HELPER_KEY) && !sameKey(entry.key, own)) {
      continue;
    }
    if (entry.value === "") {
      list.length = 0;
    } else {
      list.push(entry.value);
    }
  }
  return list;
}

function helperKeyFor(host: string): string {
  return `credential.https://${host}.helper`;
}

/**
 * The value as a POSIX extended regex matching exactly it (git's value-pattern).
 * @lastreviewed null
 */
function exactValuePattern(value: string): string {
  return `^${value.replace(/[.[\]{}()\\*+?^$|]/g, "\\$&")}$`;
}

function checkedHelper(helper: string | undefined): string {
  const command = helper ?? GitCredential.DEFAULT_HELPER;
  if (command.trim() === "" || /[\r\n\0]/.test(command)) {
    throw new Err.GitCredentialSetupError("The helper command is empty or spans more than one line.", null);
  }
  return command;
}

/**
 * The `key=value` attributes of one credential request as git writes them (git-credential(1),
 * "INPUT/OUTPUT FORMAT"): one per line, up to a blank line or the end. A repeated key keeps its
 * last value; the `key[]=` multi-valued ones are not needed here and are skipped.
 * @lastreviewed null
 */
export function parseCredentialRequest(input: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const raw of input.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      break;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq);
    if (key.endsWith("[]")) {
      continue;
    }
    fields.set(key, line.slice(eq + 1));
  }
  return fields;
}

/**
 * b6p as git's credential helper: plain `git fetch`, `pull` and `push` in a knowledge-base clone
 * (the gateway) or a script's draft (a tenant) use the stored `b6pt_` token without asking, the
 * way `gh auth setup-git` does for github.com.
 *
 * It answers only for an allowlist ({@link allowedHosts}): the configured gateway's host when it is
 * https, and the tenant hosts script pulls reached with the token. The match is exact on
 * `host[:port]`, https only, and a request naming another user, or carrying a `url=` git never
 * sends a helper, gets nothing. For anything else it
 * answers nothing, so git asks its other helpers.
 *
 * The token goes only to stdout, as the answer to `get`: never into argv, a log line or a message.
 * @lastreviewed null
 */
export class GitCredentialService {
  constructor(private readonly ctx: GitCredentialContext) {}

  /**
   * The hosts answered for, the gateway first. An unusable gateway URL, or one that is not https
   * (loopback http, used in development), contributes none.
   * @lastreviewed null
   */
  async allowedHosts(): Promise<GitCredentialHost[]> {
    const allowed: GitCredentialHost[] = [];
    const gateway = await this.gatewayHost();
    if (gateway !== null) {
      allowed.push({ host: gateway, source: "gateway" });
    }
    for (const host of await this.ctx.hosts.hosts()) {
      if (host !== gateway) {
        allowed.push({ host, source: "script-pull" });
      }
    }
    return allowed;
  }

  /**
   * Answer one credential-helper call: `action` is git's argument (`get`, `store` or `erase`) and
   * `input` what git wrote on stdin. Returns what to write on stdout; the caller then exits 0.
   * Never throws.
   *
   * - `get` answers `username` and `password` (the stored token) only for an https request to an
   *   allowed host, and nothing otherwise.
   * - `store` does nothing: the token enters only through the consumer's own sign-in, so git has
   *   nothing to teach b6p.
   * - `erase` does nothing either. git sends it after any refusal of the credential (a 401), and the
   *   stored token is the one credential every b6p operation shares: one tenant refusing it, or a
   *   moment's outage answered with a 401, would otherwise sign b6p out everywhere. A token that is
   *   really revoked is replaced through the consumer's sign-in, as before.
   * - Any other action does nothing, as git expects of a helper.
   * @lastreviewed null
   */
  async answer(action: string, input: string): Promise<string> {
    if (action !== "get") {
      return "";
    }
    try {
      return await this.get(parseCredentialRequest(input));
    } catch {
      this.ctx.logger.warn("A git credential request could not be answered; git will ask elsewhere.");
      return "";
    }
  }

  /**
   * Every allowed host, whether git asks `helper` first for it, the other helpers it also asks, and
   * the generic helpers in the global config. Read with includes followed, from every file git
   * reads as global config (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`).
   * @lastreviewed null
   */
  async setupStatus(options: GitCredentialHelperOptions = {}): Promise<GitCredentialSetupStatus> {
    const helper = checkedHelper(options.helper);
    const entries = await this.helperEntries();
    const hosts = (await this.allowedHosts()).map((allowed) => this.hostStatus(allowed, entries, helper));
    return {
      hosts,
      configured: hosts.length > 0 && hosts.every((host) => host.configured),
      otherHelpers: otherHelpersOf(entries),
    };
  }

  /**
   * Make b6p the helper git asks for every allowed host, in the user's global git config, the way
   * `gh auth setup-git` does: `credential.https://<host>.helper` gets an empty value (a reset, so
   * no generic helper such as `store` or `cache` answers that host or keeps the token) followed by
   * `helper`. A host git already asks b6p first is left as it is, so a second run changes nothing;
   * for any other host b6p's own entries are taken out first (see {@link removeGit}), so neither
   * line is ever doubled. Other helpers' entries stay. A tenant host recorded later needs another
   * run.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or `git config` fails.
   * @lastreviewed null
   */
  async setupGit(options: GitCredentialHelperOptions = {}): Promise<GitCredentialSetupResult> {
    const helper = checkedHelper(options.helper);
    const before = await this.setupStatus({ helper });
    const added: string[] = [];
    const alreadyConfigured: string[] = [];
    for (const host of before.hosts) {
      if (host.configured) {
        alreadyConfigured.push(host.host);
        continue;
      }
      const key = helperKeyFor(host.host);
      await this.removeEntries(new Set([helper]), (entryKey) => sameKey(entryKey, key));
      requireSuccess(await this.ctx.gitConfig(["--global", "--add", key, ""]), "add");
      requireSuccess(await this.ctx.gitConfig(["--global", "--add", key, helper]), "add");
      added.push(host.host);
    }
    const after = added.length === 0 ? before : await this.setupStatus({ helper });
    return { added, alreadyConfigured, hosts: after.hosts, otherHelpers: after.otherHelpers };
  }

  /**
   * Take b6p out of the user's global git config: every `credential.<url>.helper` entry whose value
   * is one of `helpers`, for any URL (a host no longer allowed included), each from the file it
   * came from (an included file or `$XDG_CONFIG_HOME/git/config` too), and with it the reset setup
   * wrote: the empty `helper =` immediately before it, for the same URL in the same file. Any other
   * reset, and every other helper, stays.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or `git config` fails.
   * @lastreviewed null
   */
  async removeGit(options: GitCredentialRemoveOptions = {}): Promise<GitCredentialRemoveResult> {
    const helpers = new Set((options.helpers ?? [GitCredential.DEFAULT_HELPER]).map((h) => checkedHelper(h)));
    return this.removeEntries(helpers, () => true);
  }

  private hostStatus(
    allowed: GitCredentialHost,
    entries: readonly HelperEntry[],
    helper: string
  ): GitCredentialHostStatus {
    const asked = effectiveHelpers(entries, allowed.host);
    const configured = asked[0] === helper;
    return { ...allowed, configured, alsoAsked: configured ? asked.slice(1) : asked };
  }

  /**
   * Removes the URL-scoped entries whose value is in `helpers` and whose key passes `keyFilter`,
   * with the reset immediately before each (same file, same key). `git config` can only remove by
   * value, so a reset is removed only when every empty value of that key in that file is such a
   * reset; otherwise it is kept and reported.
   * @lastreviewed null
   */
  private async removeEntries(
    helpers: ReadonlySet<string>,
    keyFilter: (key: string) => boolean
  ): Promise<GitCredentialRemoveResult> {
    const entries = await this.helperEntries();
    const groups = new Map<string, { file: string; key: string; url: string; values: Set<string>; resets: number }>();
    entries.forEach((entry, i) => {
      const url = HELPER_KEY.exec(entry.key)?.[1];
      if (url === undefined || entry.file === null || !helpers.has(entry.value) || !keyFilter(entry.key)) {
        return;
      }
      const id = `${entry.file}\0${entry.key.toLowerCase()}`;
      const group = groups.get(id) ?? { file: entry.file, key: entry.key, url, values: new Set(), resets: 0 };
      group.values.add(entry.value);
      const previous = entries[i - 1];
      if (previous && previous.file === entry.file && sameKey(previous.key, entry.key) && previous.value === "") {
        group.resets += 1;
      }
      groups.set(id, group);
    });
    const removed: string[] = [];
    const keptResets: string[] = [];
    for (const group of groups.values()) {
      for (const value of group.values) {
        requireSuccess(
          await this.ctx.gitConfig(["--file", group.file, "--unset-all", group.key, exactValuePattern(value)]),
          "remove"
        );
      }
      if (group.resets > 0) {
        const empties = entries.filter(
          (e) => e.file === group.file && sameKey(e.key, group.key) && e.value === ""
        ).length;
        if (empties === group.resets) {
          requireSuccess(await this.ctx.gitConfig(["--file", group.file, "--unset-all", group.key, "^$"]), "remove");
        } else if (!keptResets.includes(group.url)) {
          keptResets.push(group.url);
        }
      }
      if (!removed.includes(group.url)) {
        removed.push(group.url);
      }
    }
    return { removed, keptResets };
  }

  private async get(fields: Map<string, string>): Promise<string> {
    // git hands a helper the URL's parts (protocol, host, path), never `url=`. A `url=` here was not written by git
    // and could be parsed differently from how git would (a backslash, say), so it is refused, not reconciled.
    if (fields.has("url")) {
      return "";
    }
    const protocol = fields.get("protocol");
    const host = fields.get("host");
    if (protocol !== "https" || host === undefined) {
      return "";
    }
    const username = fields.get("username");
    if (username !== undefined && username !== GitCredential.USERNAME) {
      return "";
    }
    const requested = requestedCredentialHost(host);
    if (requested === null || !(await this.allowedHosts()).some((allowed) => allowed.host === requested)) {
      return "";
    }
    const token = await this.ctx.token.token();
    if (token === undefined || gatewayTokenProblem(token) !== null) {
      return "";
    }
    return `username=${GitCredential.USERNAME}\npassword=${token}\n`;
  }

  private async gatewayHost(): Promise<string | null> {
    try {
      return credentialHostOf(new URL(parseGatewayOrigin(await this.ctx.gatewayUrl())));
    } catch {
      return null;
    }
  }

  /**
   * The global config's credential helper entries, in git's order. Read without `--global`, which
   * (git 2.53) reads only the file it would write and so misses `$XDG_CONFIG_HOME/git/config`
   * beside `~/.gitconfig`; every scope is read and only `global` entries kept. Includes are followed.
   * @lastreviewed null
   */
  private async helperEntries(): Promise<HelperEntry[]> {
    const outcome = await this.ctx.gitConfig([
      "--includes",
      "--show-scope",
      "--show-origin",
      "--null",
      "--get-regexp",
      "^credential\\.",
    ]);
    if (outcome.code === 1) {
      return [];
    }
    requireSuccess(outcome, "read");
    // Each entry is `<scope>\0<origin>\0<key>\n<value>\0` (no `\n` for a key with no value).
    const fields = outcome.stdout.split("\0");
    const entries: HelperEntry[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [scope, origin, record] = [fields[i], fields[i + 1], fields[i + 2]];
      const newline = record.indexOf("\n");
      const key = newline === -1 ? record : record.slice(0, newline);
      const value = newline === -1 ? "" : record.slice(newline + 1);
      if (scope === "global" && (HELPER_KEY.test(key) || sameKey(key, GENERIC_HELPER_KEY))) {
        entries.push({ key, value, file: origin.startsWith(FILE_ORIGIN) ? origin.slice(FILE_ORIGIN.length) : null });
      }
    }
    return entries;
  }
}

function otherHelpersOf(entries: readonly HelperEntry[]): string[] {
  const others: string[] = [];
  for (const entry of entries) {
    if (sameKey(entry.key, GENERIC_HELPER_KEY) && entry.value !== "" && !others.includes(entry.value)) {
      others.push(entry.value);
    }
  }
  return others;
}

function requireSuccess(outcome: GitConfigOutcome, what: "read" | "add" | "remove"): void {
  if (outcome.code === 0) {
    return;
  }
  if (outcome.code === -1) {
    throw new Err.GitCredentialSetupError("git could not be run; it may not be installed.", null);
  }
  const verb = { read: "reading", add: "adding to", remove: "removing from" }[what];
  const detail = outcome.stderr.trim().split(/\r?\n/)[0] ?? "";
  throw new Err.GitCredentialSetupError(
    `git config failed ${verb} the user's git config (exit ${outcome.code})${detail ? `: ${detail}` : ""}.`,
    outcome.code
  );
}
