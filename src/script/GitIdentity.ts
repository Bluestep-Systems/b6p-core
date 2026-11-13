import { execFile } from "node:child_process";
import { GitIdentityError, type GitIdentity } from "@bluestep-systems/b6p-core-bsjs-git";

/**
 * Reads one `git config` value as git itself resolves it (repository, global and system config) for the repository
 * at, or the folder `dir`. Resolves to `undefined` when the key is unset or git is not installed.
 * @lastreviewed null
 */
export type GitConfigReader = (dir: string, key: string) => Promise<string | undefined>;

/**
 * Where a commit author may come from, in the order they are tried.
 * @lastreviewed null
 */
export interface GitIdentitySources {
  /**
   * An author the caller chose outright. Wins over everything else; it must be complete.
   * @lastreviewed null
   */
  readonly explicit?: GitIdentity;
  /**
   * The script folder whose `git config` (and the user's global one) is consulted.
   * @lastreviewed null
   */
  readonly dir: string;
  /**
   * The environment searched last for `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`, then `GIT_COMMITTER_NAME`/`_EMAIL`.
   * Defaults to `process.env`.
   * @lastreviewed null
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Replaces the `git config` lookup (tests); default runs the `git` executable.
   * @lastreviewed null
   */
  readonly readGitConfig?: GitConfigReader;
}

/**
 * The default {@link GitConfigReader}: `git config --get <key>` in `dir`.
 * @lastreviewed null
 */
export const runGitConfig: GitConfigReader = (dir, key) =>
  new Promise((resolve) => {
    execFile("git", ["config", "--get", key], { cwd: dir, windowsHide: true }, (error, stdout) => {
      const value = error ? "" : stdout.trim();
      resolve(value === "" ? undefined : value);
    });
  });

function complete(name: string | undefined, email: string | undefined): GitIdentity | undefined {
  const n = name?.trim();
  const e = email?.trim();
  return n && e ? { name: n, email: e } : undefined;
}

/**
 * The author a script commit is made by, the first complete (name and email) one of: the explicit identity, `git
 * config user.name`/`user.email` for the script folder, then `GIT_AUTHOR_*`, then `GIT_COMMITTER_*` in the
 * environment. There is no default: a commit made as nobody would reach the script's history as nobody.
 *
 * @throws {GitIdentityError} when the explicit identity is incomplete, or when no source has one.
 * @lastreviewed null
 */
export async function resolveGitIdentity(sources: GitIdentitySources): Promise<GitIdentity> {
  if (sources.explicit) {
    const explicit = complete(sources.explicit.name, sources.explicit.email);
    if (!explicit) {
      throw new GitIdentityError("The commit author given has no name or no email");
    }
    return explicit;
  }
  const read = sources.readGitConfig ?? runGitConfig;
  const fromConfig = complete(await read(sources.dir, "user.name"), await read(sources.dir, "user.email"));
  if (fromConfig) {
    return fromConfig;
  }
  const env = sources.env ?? process.env;
  const fromEnv =
    complete(env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL) ?? complete(env.GIT_COMMITTER_NAME, env.GIT_COMMITTER_EMAIL);
  if (fromEnv) {
    return fromEnv;
  }
  throw new GitIdentityError(
    "No commit author found: none was given, the git config for the script folder has no user.name and user.email, " +
      "and the environment has no GIT_AUTHOR_NAME and GIT_AUTHOR_EMAIL"
  );
}
