import type { GitCredentialResetRecord, GitCredentialResetsByFile } from "../cache/GitCredentialResets";
import { GitCredential } from "../constants/GitCredential";
import { Err } from "../Err";
import { parseGatewayOrigin } from "../gateway/GatewayClient";
import { gatewayTokenProblem } from "../gateway/GatewayToken";
import {
  askedFor,
  emptiesOf,
  exactValuePattern,
  helperKeyFor,
  LIST_CREDENTIAL_ENTRIES,
  parseHelperEntries,
  patternApplies,
  urlOfKey,
  type GitCredentialConfigEntry,
  type HelperEntry,
} from "./credentialConfig";
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
 * An allowed host and what git does with its credential requests, given the user's global git
 * config (see {@link GitCredentialService.setupStatus}).
 * @lastreviewed null
 */
export interface GitCredentialHostStatus extends GitCredentialHost {
  /**
   * Whether b6p is the only helper git asks for this host, so no other helper sees the token or is
   * told to store it.
   * @lastreviewed null
   */
  readonly configured: boolean;
  /**
   * The other helpers git asks for this host, in order. A storing helper (such as `store`) here
   * would keep a copy of the token.
   * @lastreviewed null
   */
  readonly alsoAsked: string[];
  /**
   * The config entries that keep b6p from being the only helper: each other helper git asks, and
   * the reset that clears b6p's entry when one comes after it. Setup never moves or deletes the
   * user's entries, so these stay until the user moves them before b6p's reset or removes them.
   * @lastreviewed null
   */
  readonly others: GitCredentialConfigEntry[];
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
   * https host that has no reset of its own after them.
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
   * The hosts b6p's reset and helper were written for.
   * @lastreviewed null
   */
  readonly added: string[];
  /**
   * The hosts that were set up already and were left as they were.
   * @lastreviewed null
   */
  readonly alreadyConfigured: string[];
  /**
   * Every allowed host as it stands after the setup. A host written for can still be
   * `configured: false` when a later entry of the user's applies to it (see
   * {@link GitCredentialHostStatus.others}).
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
   * The URL patterns b6p's entries were removed for (`https://host`, as written), whether or not
   * that host is still allowed.
   * @lastreviewed null
   */
  readonly removed: string[];
  /**
   * The URL patterns where a reset b6p wrote was left in place, because the same key in the same
   * file now has more empty values than b6p recorded and `git config` (which removes by value only)
   * cannot take out b6p's alone. The record of it is kept.
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
   * Every allowed host and whether b6p is the only helper git asks for it, with the other helpers
   * and the entries responsible when it is not, plus the generic helpers. Read from every file git
   * reads as global config (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, what they include),
   * matching entries as git's credential contexts do ({@link patternApplies}); where that cannot be
   * decided from the host alone (an entry scoped to a path, say) the entry counts as applying, so a
   * host is never reported set up when another helper may still be asked. Changes nothing.
   *
   * Needs git 2.26 or later (`--show-scope`); an older git fails as {@link Err.GitCredentialSetupError}.
   * @lastreviewed null
   */
  async setupStatus(options: GitCredentialHelperOptions = {}): Promise<GitCredentialSetupStatus> {
    const helper = checkedHelper(options.helper);
    return this.statusOf(await this.helperEntries(), new Set([helper]));
  }

  /**
   * Make b6p the helper git asks for every allowed host, in the user's global git config, the way
   * `gh auth setup-git` does: `credential.https://<host>.helper` gets an empty value (a reset, so
   * no earlier helper such as `store` or `cache` answers that host or keeps the token) followed by
   * `helper`, both appended to the file `git config --global` writes.
   *
   * A host already set up is left alone, so a second run changes nothing. For any other host,
   * b6p's own entries for it, and the resets b6p recorded for it, are taken out first, so neither
   * line is ever doubled, and a run that stopped halfway is finished cleanly. Every reset written
   * is recorded ({@link GitCredentialResets}) before and after the write; when the helper cannot
   * be added after its reset, the reset is taken out again in the same call. The user's entries
   * are never moved or deleted: one that still applies after b6p's (a `*.bluestep.net` helper
   * later in the config, say) leaves the host `configured: false`, with the entry in `others`.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or older than 2.26, or `git config` fails.
   * @lastreviewed null
   */
  async setupGit(options: GitCredentialHelperOptions = {}): Promise<GitCredentialSetupResult> {
    const helper = checkedHelper(options.helper);
    const helpers = new Set([helper]);
    let entries = await this.helperEntries();
    await this.settleResets(entries);
    const before = await this.statusOf(entries, helpers);
    const added: string[] = [];
    const alreadyConfigured: string[] = [];
    for (const host of before.hosts) {
      if (host.configured) {
        alreadyConfigured.push(host.host);
        continue;
      }
      await this.removeFor(entries, await this.ctx.resets.all(), helpers, (url) => patternIsHost(url, host.host));
      entries = await this.helperEntries();
      await this.install(entries, host.host, helper);
      entries = await this.helperEntries();
      added.push(host.host);
    }
    const after = added.length === 0 ? before : await this.statusOf(entries, helpers);
    return { added, alreadyConfigured, hosts: after.hosts, otherHelpers: after.otherHelpers };
  }

  /**
   * Take b6p out of the user's global git config: every `credential.<url>.helper` entry whose value
   * is one of `helpers`, for any URL and in any spelling (a host no longer allowed included), each
   * from the file it came from, and every reset b6p recorded writing. A reset b6p did not record is
   * never removed, whatever sits next to it.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or older than 2.26, or `git config` fails.
   * @lastreviewed null
   */
  async removeGit(options: GitCredentialRemoveOptions = {}): Promise<GitCredentialRemoveResult> {
    const helpers = new Set((options.helpers ?? [GitCredential.DEFAULT_HELPER]).map((h) => checkedHelper(h)));
    const entries = await this.helperEntries();
    const records = await this.settleResets(entries);
    return this.removeFor(entries, records, helpers, () => true);
  }

  private async statusOf(
    entries: readonly HelperEntry[],
    helpers: ReadonlySet<string>
  ): Promise<GitCredentialSetupStatus> {
    const hosts = (await this.allowedHosts()).map((allowed) => ({
      ...allowed,
      ...askedFor(entries, allowed.host, helpers),
    }));
    return {
      hosts,
      configured: hosts.length > 0 && hosts.every((host) => host.configured),
      otherHelpers: [...new Set(entries.filter((e) => e.url === null && e.value !== "").map((e) => e.value))],
    };
  }

  /**
   * Append b6p's reset and `helper` for `host` to the global write file. The reset is skipped when
   * b6p already has one recorded there (a reset it could not take out); a failure to add the helper
   * takes this call's reset out again before throwing.
   * @lastreviewed null
   */
  private async install(entries: readonly HelperEntry[], host: string, helper: string): Promise<void> {
    const file = this.ctx.gitConfig.globalFile();
    const key = helperKeyFor(host);
    const recorded = (await this.ctx.resets.all())[file]?.[key]?.installed ?? 0;
    let addedReset = false;
    if (recorded === 0) {
      await this.addReset(entries, file, key, 0);
      addedReset = true;
    }
    const outcome = await this.ctx.gitConfig.run(["--file", file, "--add", key, helper]);
    if (outcome.code !== 0) {
      if (addedReset) {
        const now = await this.helperEntries();
        await this.removeResets(now, file, key, emptiesOf(now, file, key) > 0 ? 1 : 0);
      }
      requireSuccess(outcome, "add");
    }
  }

  /**
   * Add one reset to `key` in `file`, recorded before (`pending`) and after (`installed + 1`).
   * @lastreviewed null
   */
  private async addReset(entries: readonly HelperEntry[], file: string, key: string, installed: number): Promise<void> {
    const emptiesBefore = emptiesOf(entries, file, key);
    await this.ctx.resets.put(file, key, { installed, pending: { op: "add", emptiesBefore } });
    const outcome = await this.ctx.gitConfig.run(["--file", file, "--add", key, ""]);
    if (outcome.code !== 0) {
      await this.ctx.resets.put(file, key, { installed });
      requireSuccess(outcome, "add");
    }
    await this.ctx.resets.put(file, key, { installed: installed + 1 });
  }

  /**
   * Remove b6p's `installed` resets of `key` in `file`, recorded before (`pending`) and after. Only
   * when they are all the empty values the key has there: `git config` removes by value, so with
   * one of the user's beside them nothing is removed and `false` is returned.
   * @lastreviewed null
   */
  private async removeResets(
    entries: readonly HelperEntry[],
    file: string,
    key: string,
    installed: number
  ): Promise<boolean> {
    if (installed === 0) {
      await this.ctx.resets.put(file, key, undefined);
      return true;
    }
    const emptiesBefore = emptiesOf(entries, file, key);
    if (emptiesBefore !== installed) {
      return false;
    }
    await this.ctx.resets.put(file, key, { installed, pending: { op: "remove", emptiesBefore } });
    const outcome = await this.ctx.gitConfig.run(["--file", file, "--unset-all", key, "^$"]);
    if (outcome.code !== 0) {
      await this.ctx.resets.put(file, key, { installed });
      requireSuccess(outcome, "remove");
    }
    await this.ctx.resets.put(file, key, undefined);
    return true;
  }

  /**
   * Remove b6p's helper entries whose URL passes `urls` (each spelling, from its own file) and the
   * resets b6p recorded under such URLs.
   * @lastreviewed null
   */
  private async removeFor(
    entries: readonly HelperEntry[],
    records: GitCredentialResetsByFile,
    helpers: ReadonlySet<string>,
    urls: (url: string) => boolean
  ): Promise<GitCredentialRemoveResult> {
    const removed: string[] = [];
    const keptResets: string[] = [];
    const done = new Set<string>();
    for (const entry of entries) {
      if (entry.url === null || entry.file === null || !helpers.has(entry.value) || !urls(entry.url)) {
        continue;
      }
      const once = `${entry.file}\0${entry.key}\0${entry.value}`;
      if (done.has(once)) {
        continue;
      }
      done.add(once);
      requireSuccess(
        await this.ctx.gitConfig.run(["--file", entry.file, "--unset-all", entry.key, exactValuePattern(entry.value)]),
        "remove"
      );
      if (!removed.includes(entry.url)) {
        removed.push(entry.url);
      }
    }
    const now = done.size > 0 ? await this.helperEntries() : entries;
    for (const [file, keys] of Object.entries(records)) {
      for (const [key, record] of Object.entries(keys)) {
        const url = urlOfKey(key);
        if (url === null || !urls(url)) {
          continue;
        }
        if (!(await this.removeResets(now, file, key, record.installed)) && !keptResets.includes(url)) {
          keptResets.push(url);
        }
      }
    }
    return { removed, keptResets };
  }

  /**
   * Settle every reset record against the config as it is now: a pending change counts as done
   * when the key's empty values moved the way it would have moved them, and no record claims more
   * resets than the key has. Records that hold nothing are dropped.
   * @lastreviewed null
   */
  private async settleResets(entries: readonly HelperEntry[]): Promise<GitCredentialResetsByFile> {
    const records = await this.ctx.resets.all();
    const settled: GitCredentialResetsByFile = {};
    for (const [file, keys] of Object.entries(records)) {
      for (const [key, record] of Object.entries(keys)) {
        const empties = emptiesOf(entries, file, key);
        let installed = record.installed;
        if (record.pending?.op === "add" && empties > record.pending.emptiesBefore) {
          installed += 1;
        } else if (record.pending?.op === "remove" && empties < record.pending.emptiesBefore) {
          installed = 0;
        }
        installed = Math.min(installed, empties);
        const next: GitCredentialResetRecord = { installed };
        if (installed !== record.installed || record.pending !== undefined) {
          await this.ctx.resets.put(file, key, next);
        }
        if (installed > 0) {
          (settled[file] ??= {})[key] = next;
        }
      }
    }
    return settled;
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

  private async helperEntries(): Promise<HelperEntry[]> {
    const outcome = await this.ctx.gitConfig.run(LIST_CREDENTIAL_ENTRIES);
    if (outcome.code === 1) {
      return [];
    }
    if (outcome.code === 129) {
      throw new Err.GitCredentialSetupError(
        "git is too old to read its config with scope and origin (git 2.26 or later is needed).",
        outcome.code
      );
    }
    requireSuccess(outcome, "read");
    return parseHelperEntries(outcome.stdout);
  }
}

/**
 * Whether a URL pattern names exactly `https://<host>` (the forms setup writes, any spelling): no
 * wildcard, path, user or other port.
 * @lastreviewed null
 */
function patternIsHost(url: string, host: string): boolean {
  const lowered = url.toLowerCase().replace(/\/$/, "");
  return !lowered.includes("*") && patternApplies(url, host) && /^https:\/\/[^/@]+$/.test(lowered);
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
