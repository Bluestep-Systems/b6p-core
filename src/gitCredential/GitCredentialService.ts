import * as path from "node:path";
import type { GitCredentialResetRecord } from "../cache/GitCredentialResets";
import { GitCredential } from "../constants/GitCredential";
import { Err } from "../Err";
import { parseGatewayOrigin } from "../gateway/GatewayClient";
import { gatewayTokenProblem } from "../gateway/GatewayToken";
import { appendPair, keepsEntries, pairsIn, parseConfigFile, removePair } from "./configFile";
import {
  askedFor,
  configPathKey,
  exactValuePattern,
  helperKeyFor,
  LIST_CREDENTIAL_ENTRIES,
  pairsOf,
  parseHelperEntries,
  patternIsHost,
  urlOfKey,
  type ConfigPathStyle,
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
   * The generic helpers (`credential.helper`) in the config read, which apply to every https host
   * that has no reset of its own after them.
   * @lastreviewed null
   */
  readonly otherHelpers: string[];
  /**
   * Which config was read, as {@link GitCredentialStatusScope} says.
   * @lastreviewed null
   */
  readonly scope: GitCredentialStatusScope;
}

/**
 * Which git config a status covers.
 *
 * - `global`: the system, global and command-line config (`git -c`, `GIT_CONFIG_COUNT`), read
 *   outside any repository.
 * - `global+here`: those and the local and worktree config of the one repository the status was
 *   read in.
 *
 * Neither covers another repository's own config: a helper set in some other clone's
 * `.git/config`, or in a file an `includeIf` reads only there, is seen only by a status read in
 * that clone ({@link GitCredentialService.cloneStatus}). An `includeIf` after b6p's entries is
 * counted as a helper that may be asked.
 * @lastreviewed null
 */
export type GitCredentialStatusScope = "global" | "global+here";

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
  /**
   * Resets of b6p's for a host set up again that were left in place (see
   * {@link GitCredentialKeptReset}).
   * @lastreviewed null
   */
  readonly keptResets: GitCredentialKeptReset[];
  /**
   * Which config `hosts` was read from ({@link GitCredentialStatusScope}).
   * @lastreviewed null
   */
  readonly scope: GitCredentialStatusScope;
}

/**
 * Why a reset b6p wrote was left in the user's git config.
 *
 * - `shared-key`: the same key in the same file has other empty values too, and `git config`
 *   (which removes by value) cannot take out b6p's alone.
 * - `unconfirmed`: a setup or removal was interrupted, and the file no longer shows which of the
 *   key's empty values is b6p's, so none is removed. b6p forgets it once reported.
 * @lastreviewed null
 */
export type GitCredentialKeptResetReason = "shared-key" | "unconfirmed";

/**
 * A reset b6p wrote and left in place.
 * @lastreviewed null
 */
export interface GitCredentialKeptReset {
  /**
   * The URL pattern of its key (`https://host`, as written).
   * @lastreviewed null
   */
  readonly url: string;
  /**
   * The file it is in.
   * @lastreviewed null
   */
  readonly file: string;
  readonly reason: GitCredentialKeptResetReason;
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
   * The resets b6p wrote that were left in place, each with why.
   * @lastreviewed null
   */
  readonly keptResets: GitCredentialKeptReset[];
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
  /**
   * The directory to read git's config from (default the process's): inside a repository, its
   * local and worktree config count too.
   * @lastreviewed null
   */
  readonly cwd?: string;
}

/**
 * Options for {@link GitCredentialService.cloneStatus}.
 * @lastreviewed null
 */
export interface GitCredentialCloneOptions {
  /**
   * The command b6p's entries carry (default {@link GitCredential.DEFAULT_HELPER}).
   * @lastreviewed null
   */
  readonly helper?: string;
  /**
   * The remote whose URL names the host (default `origin`).
   * @lastreviewed null
   */
  readonly remote?: string;
}

/**
 * The oldest git whose credential contexts {@link credentialContextMatch} follows: the partial-URL
 * fallback (credential.c `match_partial_url`) arrived in git 2.27.0 and is unchanged through 2.53.
 * Status, setup and removal refuse an older git.
 * @lastreviewed null
 */
export const GIT_MATCHING_FLOOR = "2.27.0";

/**
 * The oldest git that reports the file `git config --global` writes (`git var GIT_CONFIG_GLOBAL`),
 * which setup needs.
 * @lastreviewed null
 */
export const GIT_SETUP_FLOOR = "2.42.0";

/**
 * The `major.minor.patch` of `git --version` output (`git version 2.45.1.windows.1`,
 * `git version 2.39.3 (Apple Git-146)`), or `null`.
 * @lastreviewed null
 */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function atLeast(version: [number, number, number], floor: string): boolean {
  const want = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (version[i] !== want[i]) {
      return version[i] > want[i];
    }
  }
  return true;
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
   * and the entries responsible when it is not, plus the generic helpers. Read from the config in
   * effect in `cwd` (default the process's directory): system, global (`~/.gitconfig`,
   * `$XDG_CONFIG_HOME/git/config`), the command line and `GIT_CONFIG_COUNT`, and inside a
   * repository its local and worktree config, with what they include. `scope` says which; no
   * status covers another repository's own config ({@link GitCredentialStatusScope}).
   *
   * Entries match as git's credential contexts do ({@link credentialContextMatch}). Where an entry
   * applies to only some requests (one scoped to a path, say), another helper counts as asked and a
   * reset or b6p's own entry as not applying, and an `includeIf` after the last reset counts as a
   * helper that may be asked, so a host is `configured` only when git certainly asks b6p alone.
   * Changes nothing.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or older than {@link GIT_MATCHING_FLOOR}.
   * @lastreviewed null
   */
  async setupStatus(options: GitCredentialHelperOptions = {}): Promise<GitCredentialSetupStatus> {
    const helper = checkedHelper(options.helper);
    await this.requireGit(GIT_MATCHING_FLOOR);
    return this.statusOf(await this.helperEntries(options.cwd), new Set([helper]), await this.scopeAt(options.cwd));
  }

  /**
   * Whether git asks b6p alone for the host of one clone's remote (`origin` by default), reading
   * the config in effect in that clone (its local and worktree config included), so a consumer can
   * warn after a `kb pull` or `script pull` that git there would also ask another helper. `null`
   * when the clone has no such remote, or its URL's host is not an allowed one. Changes nothing.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or older than {@link GIT_MATCHING_FLOOR}.
   * @lastreviewed null
   */
  async cloneStatus(dir: string, options: GitCredentialCloneOptions = {}): Promise<GitCredentialHostStatus | null> {
    const helper = checkedHelper(options.helper);
    const remote = options.remote ?? "origin";
    if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
      throw new Err.GitCredentialSetupError("The remote name is not a plain name.", null);
    }
    await this.requireGit(GIT_MATCHING_FLOOR);
    const outcome = await this.ctx.gitConfig.run(["--get", `remote.${remote}.url`], { cwd: dir });
    if (outcome.code !== 0) {
      return null;
    }
    let host: string | null;
    try {
      const url = new URL(outcome.stdout.trim());
      url.username = "";
      url.password = "";
      host = credentialHostOf(url);
    } catch {
      return null;
    }
    const allowed = (await this.allowedHosts()).find((a) => a.host === host);
    if (allowed === undefined) {
      return null;
    }
    return { ...allowed, ...askedFor(await this.helperEntries(dir), allowed.host, new Set([helper])) };
  }

  /**
   * Make b6p the helper git asks for every allowed host, in the user's global git config, the way
   * `gh auth setup-git` does: a new `[credential "https://<host>"]` section holding an empty
   * `helper =` (a reset, so no earlier helper such as `store` or `cache` answers that host or keeps
   * the token) and then `helper =` b6p's command, appended in one edit to the file git itself says
   * `git config --global` writes ({@link GitConfigRunner.globalFile}), under git's own lock on that
   * file, so the pair is written whole or not at all.
   *
   * A host is repaired when the system and global config (the files setup can change) do not
   * certainly make git ask b6p alone; one that does is left alone, so a second run changes
   * nothing. b6p's own entries for a repaired host, and its reset pairs
   * ({@link GitCredentialResetState}), are taken out first, so neither line is ever doubled. Every
   * pair written is recorded ({@link GitCredentialResets}) before and after the edit. The user's
   * entries are never moved or deleted: one that still applies after b6p's (a `*.bluestep.net`
   * helper later in the config, a repository's own helper, say) leaves the host
   * `configured: false` in `hosts` (read as {@link setupStatus} reads, in `cwd`), with the entry in
   * `others`.
   *
   * The whole run holds the git config lock ({@link GitCredentialResets.exclusive}), so two setups,
   * or a setup and a removal, never interleave, in one process or several.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or older than {@link GIT_SETUP_FLOOR}, a
   *   config file cannot be read, locked or written, or `git config` fails.
   * @lastreviewed null
   */
  async setupGit(options: GitCredentialHelperOptions = {}): Promise<GitCredentialSetupResult> {
    const helper = checkedHelper(options.helper);
    const helpers = new Set([helper]);
    await this.requireGit(GIT_SETUP_FLOOR);
    return this.ctx.resets.exclusive(async () => {
      const file = await this.ctx.gitConfig.globalFile();
      let entries = await this.helperEntries(options.cwd);
      let claims = await this.settleResets(entries);
      const before = await this.statusOf(entries.filter(isWritableScope), helpers, "global");
      const added: string[] = [];
      const alreadyConfigured: string[] = [];
      const keptResets: GitCredentialKeptReset[] = [];
      for (const host of before.hosts) {
        if (host.configured) {
          alreadyConfigured.push(host.host);
          continue;
        }
        const out = await this.removeFor(entries, claims, helpers, (url) => patternIsHost(url, host.host), "any");
        keptResets.push(...out.keptResets);
        entries = await this.helperEntries(options.cwd);
        await this.install(entries, file, host.host, helper);
        entries = await this.helperEntries(options.cwd);
        claims = await this.settleResets(entries);
        added.push(host.host);
      }
      const after = await this.statusOf(entries, helpers, await this.scopeAt(options.cwd));
      return {
        added,
        alreadyConfigured,
        hosts: after.hosts,
        otherHelpers: after.otherHelpers,
        keptResets,
        scope: after.scope,
      };
    });
  }

  /**
   * Take b6p out of the user's global git config: each reset pair that is b6p's
   * ({@link GitCredentialResetState}) with one of `helpers` after it, both lines in one edit under
   * git's lock on the file, then every other `credential.<url>.helper` entry whose value is one of
   * `helpers`, for any URL and in any spelling (a host no longer allowed included), each from the
   * file it came from. Only system-independent global files are edited; a repository's config is
   * never touched. A reset b6p did not write, or whose ownership is not certain, is never removed,
   * whatever sits next to it; one b6p wrote but cannot tell apart is reported in `keptResets`.
   * Holds the git config lock throughout, as {@link setupGit} does.
   *
   * @throws {Err.GitCredentialSetupError} when git is missing or older than {@link GIT_MATCHING_FLOOR},
   *   a config file cannot be locked or written, or `git config` fails.
   * @lastreviewed null
   */
  async removeGit(options: GitCredentialRemoveOptions = {}): Promise<GitCredentialRemoveResult> {
    const helpers = new Set((options.helpers ?? [GitCredential.DEFAULT_HELPER]).map((h) => checkedHelper(h)));
    await this.requireGit(GIT_MATCHING_FLOOR);
    return this.ctx.resets.exclusive(async () => {
      const entries = await this.helperEntries();
      const claims = await this.settleResets(entries);
      return this.removeFor(entries, claims, helpers, () => true, "named");
    });
  }

  private async statusOf(
    entries: readonly HelperEntry[],
    helpers: ReadonlySet<string>,
    scope: GitCredentialStatusScope
  ): Promise<GitCredentialSetupStatus> {
    const hosts = (await this.allowedHosts()).map((allowed) => ({
      ...allowed,
      ...askedFor(entries, allowed.host, helpers),
    }));
    return {
      hosts,
      configured: hosts.length > 0 && hosts.every((host) => host.configured),
      otherHelpers: [
        ...new Set(entries.filter((e) => e.kind === "helper" && e.url === null && e.value !== "").map((e) => e.value)),
      ],
      scope,
    };
  }

  private get pathStyle(): ConfigPathStyle {
    return this.ctx.gitConfig.pathStyle ?? (process.platform === "win32" ? "win32" : "posix");
  }

  private async scopeAt(cwd: string | undefined): Promise<GitCredentialStatusScope> {
    return (await this.ctx.gitConfig.git(["rev-parse", "--git-dir"], { cwd })).code === 0 ? "global+here" : "global";
  }

  private async requireGit(floor: string): Promise<void> {
    this.gitVersion ??= this.ctx.gitConfig.git(["--version"]).then((outcome) => {
      if (outcome.code === -1) {
        throw new Err.GitCredentialSetupError("git could not be run; it may not be installed.", null);
      }
      const version = parseGitVersion(outcome.stdout);
      if (version === null) {
        throw new Err.GitCredentialSetupError("git did not report a version b6p recognises.", outcome.code);
      }
      return version;
    });
    let version: [number, number, number];
    try {
      version = await this.gitVersion;
    } catch (error) {
      this.gitVersion = undefined;
      throw error;
    }
    if (!atLeast(version, floor)) {
      throw new Err.GitCredentialSetupError(`git ${version.join(".")} is older than ${floor}, which this needs.`, null);
    }
  }

  private gitVersion: Promise<[number, number, number]> | undefined;

  /**
   * Append b6p's reset-then-`helper` pair for `host` to `file` in one edit under git's lock,
   * recorded `adding` (with the pairs the key had) before and `installed` after; when the edit
   * throws, the record is settled from the file as it then is. The edit is refused when the file no
   * longer holds what the record counted, or does not parse.
   * @lastreviewed null
   */
  private async install(entries: readonly HelperEntry[], file: string, host: string, helper: string): Promise<void> {
    const key = helperKeyFor(host);
    const pairsBefore = pairsOf(entries, file, key, helper, this.pathStyle);
    await this.ctx.resets.put(file, key, { state: "adding", helper, pairsBefore });
    const bytes = asBytes(helper);
    try {
      await this.ctx.gitConfig.editFile(file, (text) => {
        const parsed = parseConfigFile(text);
        if (parsed === null) {
          throw new Err.GitCredentialSetupError(`git config file ${file} could not be read as git reads it.`, null);
        }
        if (pairsIn(parsed, key, bytes).length !== pairsBefore) {
          throw new Err.GitCredentialSetupError(`git config file ${file} changed while setup was writing it.`, null);
        }
        const next = appendPair(text, `https://${host}`, bytes);
        const written = parseConfigFile(next);
        if (
          written === null ||
          !keepsEntries(parsed, written, 2) ||
          pairsIn(written, key, bytes).length !== pairsBefore + 1
        ) {
          throw new Err.GitCredentialSetupError(
            `b6p's entries could not be appended to git config file ${file} without changing an entry already there.`,
            null
          );
        }
        return next;
      });
    } catch (error) {
      // Settled from the file, not cleared: an error after the edit landed must not orphan b6p's pair.
      await this.helperEntries()
        .then((now) => this.settleResets(now))
        .catch(() => undefined);
      throw error;
    }
    await this.ctx.resets.put(file, key, { state: "installed", helper });
  }

  /**
   * Take out b6p's entries for the URLs `urls` passes, in global files only. First each reset pair of
   * b6p's (`owned`) whose helper is one of `helpers` (or, for `pairs: "any"`, whatever its helper,
   * as setup replacing its own pair does): re-read under git's lock on its file, and removed, both
   * lines in that one edit, only when the file holds exactly one such pair. A file with several,
   * and every `unconfirmed` claim, is reported and forgotten, and only its helper lines go, so what
   * is left is an inert reset. Then b6p's other helper entries, each spelling from its own file.
   * @lastreviewed null
   */
  private async removeFor(
    entries: readonly HelperEntry[],
    claims: ResetClaims,
    helpers: ReadonlySet<string>,
    urls: (url: string) => boolean,
    pairs: "named" | "any"
  ): Promise<GitCredentialRemoveResult> {
    const style = this.pathStyle;
    const removed: string[] = [];
    const keptResets: GitCredentialKeptReset[] = [];
    const pairHelpers = new Set<string>();
    const once = (file: string, key: string, value: string): string =>
      `${configPathKey(file, style)}\0${key}\0${value}`;
    for (const claim of claims.owned) {
      if (!urls(claim.url) || (pairs === "named" && !helpers.has(claim.record.helper))) {
        continue;
      }
      const result: { outcome: "removed" | "gone" | GitCredentialKeptResetReason } = { outcome: "gone" };
      await this.ctx.gitConfig.editFile(claim.file, (text) => {
        const parsed = parseConfigFile(text);
        const found = parsed === null ? [] : pairsIn(parsed, asBytes(claim.key), asBytes(claim.record.helper));
        if (parsed === null || (found.length === 1 && !(found[0][0].ownLine && found[0][1].ownLine))) {
          result.outcome = "unconfirmed";
        } else if (found.length > 1) {
          result.outcome = "shared-key";
        } else if (found.length === 1) {
          result.outcome = "removed";
          return removePair(text, parsed, found[0]);
        }
        return null;
      });
      if (result.outcome === "removed") {
        if (!removed.includes(claim.url)) {
          removed.push(claim.url);
        }
      } else if (result.outcome !== "gone") {
        keptResets.push({ url: claim.url, file: claim.file, reason: result.outcome });
        pairHelpers.add(once(claim.file, claim.key, claim.record.helper));
      }
      await this.ctx.resets.put(claim.file, claim.key, undefined);
    }
    for (const claim of claims.unconfirmed) {
      if (urls(claim.url)) {
        keptResets.push({ url: claim.url, file: claim.file, reason: "unconfirmed" });
        await this.ctx.resets.put(claim.file, claim.key, undefined);
      }
    }
    const now = claims.owned.length > 0 ? await this.helperEntries() : entries;
    const done = new Set<string>();
    for (const entry of now) {
      if (
        entry.kind !== "helper" ||
        entry.scope !== "global" ||
        entry.url === null ||
        entry.file === null ||
        entry.value === "" ||
        !urls(entry.url)
      ) {
        continue;
      }
      const id = once(entry.file, entry.key, entry.value);
      if (done.has(id) || !(helpers.has(entry.value) || pairHelpers.has(id))) {
        continue;
      }
      done.add(id);
      requireSuccess(
        await this.ctx.gitConfig.run(["--file", entry.file, "--unset-all", entry.key, exactValuePattern(entry.value)]),
        "remove"
      );
      if (!removed.includes(entry.url)) {
        removed.push(entry.url);
      }
    }
    return { removed, keptResets };
  }

  /**
   * Settle every reset record against the config as it is now ({@link GitCredentialResetState})
   * and return the claims that stand: `owned` (installed, its pair in place) and `unconfirmed`.
   * Ownership is never inferred from a count of empty values: an installed record whose helper no
   * longer directly follows an empty value of its key in its file is dropped, and an addition that
   * left the file with any number of pairs but the two it predicts becomes `unconfirmed`.
   * @lastreviewed null
   */
  private async settleResets(entries: readonly HelperEntry[]): Promise<ResetClaims> {
    const style = this.pathStyle;
    const claims: ResetClaims = { owned: [], unconfirmed: [] };
    for (const [file, keys] of Object.entries(await this.ctx.resets.all())) {
      for (const [key, record] of Object.entries(keys)) {
        const url = urlOfKey(key);
        const pairs = pairsOf(entries, file, key, record.helper, style);
        const before = record.pairsBefore ?? 0;
        let next: GitCredentialResetRecord | undefined;
        if (url === null) {
          next = undefined;
        } else if (record.state === "installed") {
          next = pairs > 0 ? record : undefined;
        } else if (record.state === "adding") {
          next =
            pairs === before
              ? undefined
              : pairs === before + 1
                ? { state: "installed", helper: record.helper }
                : { state: "unconfirmed", helper: record.helper };
        } else {
          next = record;
        }
        if (next !== record) {
          await this.ctx.resets.put(file, key, next);
        }
        if (next !== undefined && url !== null) {
          (next.state === "installed" ? claims.owned : claims.unconfirmed).push({ file, key, url, record: next });
        }
      }
    }
    return claims;
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

  private async helperEntries(cwd?: string): Promise<HelperEntry[]> {
    const outcome = await this.ctx.gitConfig.run(LIST_CREDENTIAL_ENTRIES, { cwd });
    if (outcome.code === 1) {
      return [];
    }
    requireSuccess(outcome, "read");
    // git names a repository's own file relative to where it ran (`.git/config`).
    const base = cwd ?? process.cwd();
    return parseHelperEntries(outcome.stdout).map((entry) =>
      entry.file === null || path.isAbsolute(entry.file) || path.win32.isAbsolute(entry.file)
        ? entry
        : { ...entry, file: path.resolve(base, entry.file) }
    );
  }
}

// A string as the bytes of its UTF-8 encoding, one latin1 character each: the form config file edits work in.
const asBytes = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

// The scopes setup can change: global files, and system ones that come before them.
const isWritableScope = (entry: HelperEntry): boolean => entry.scope === "system" || entry.scope === "global";

/**
 * A reset record that stands after settling, with the URL pattern of its key.
 * @lastreviewed null
 */
interface ResetClaim {
  readonly file: string;
  readonly key: string;
  readonly url: string;
  readonly record: GitCredentialResetRecord;
}

/**
 * What {@link GitCredentialService} settled: the resets that are b6p's, and the ones it cannot
 * confirm.
 * @lastreviewed null
 */
interface ResetClaims {
  readonly owned: ResetClaim[];
  readonly unconfirmed: ResetClaim[];
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
