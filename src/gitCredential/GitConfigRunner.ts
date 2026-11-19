import { execFile } from "node:child_process";
import * as fsSync from "node:fs";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Err } from "../Err";
import { trackOnExit, untrackOnExit } from "../persistence/exitCleanup";
import type { ConfigPathStyle } from "./credentialConfig";

/**
 * What one `git config …` run printed and how it ended.
 * @lastreviewed null
 */
export interface GitConfigOutcome {
  /**
   * git's exit code: 0 on success, 1 for a key or pattern that matched nothing, more for a real failure.
   * `-1` when git could not be started (not installed).
   * @lastreviewed null
   */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Where a git command runs.
 * @lastreviewed null
 */
export interface GitRunOptions {
  /**
   * The directory git runs in (default the process's), which decides the repository whose local
   * and worktree config git reads.
   * @lastreviewed null
   */
  readonly cwd?: string;
}

/**
 * Runs git for the credential helper's setup. The arguments never carry a token: only config keys,
 * value patterns, file names and helper commands pass through here.
 * @lastreviewed null
 */
export interface GitConfigRunner {
  /**
   * Run `git config <args>` and report the outcome; never throws. The caller names the scope
   * (`--file <path>`), or none for a read of every scope.
   * @lastreviewed null
   */
  run(args: readonly string[], options?: GitRunOptions): Promise<GitConfigOutcome>;
  /**
   * Run `git <args>` (`--version`, `var`, `rev-parse`) and report the outcome; never throws.
   * @lastreviewed null
   */
  git(args: readonly string[], options?: GitRunOptions): Promise<GitConfigOutcome>;
  /**
   * The file `git config --global` writes, as git itself reports it: the paths
   * `git var GIT_CONFIG_GLOBAL` prints (git 2.42 or later; `$XDG_CONFIG_HOME/git/config` first when
   * there is one, then `~/.gitconfig` or `$GIT_CONFIG_GLOBAL`), chosen by git's rule (config.c
   * `git_global_config`): the last, unless it cannot be read and the XDG one can. Never worked out
   * from `HOME` or `USERPROFILE`, which Git for Windows does not always use.
   * @throws {Err.GitCredentialSetupError} when git does not report one.
   * @lastreviewed null
   */
  globalFile(): Promise<string>;
  /**
   * Edit the config file `file` the way git does (lockfile.c): create `<file>.lock` exclusively,
   * with the file's mode (waiting briefly while another git holds it), let `edit` turn the file's
   * current bytes (one latin1 character each) into the new ones (`null` to leave it), write them to
   * the lock and rename it over the file. A symlink is followed to its target, even a missing one,
   * as git does, so it stays a link. Every git writer takes the same lock, so nothing another
   * writer does lands between `edit`'s read and the write. Returns whether the file changed.
   * @lastreviewed null
   */
  editFile(file: string, edit: (text: string) => string | null): Promise<boolean>;
  /**
   * How config file paths are compared (see `configPathKey`): `win32` on Windows, where git
   * reports `C:/Users/…` for a file b6p names `C:\\Users\\…`, and `posix` elsewhere. Absent, the
   * platform's.
   * @lastreviewed null
   */
  readonly pathStyle?: ConfigPathStyle;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * Where git writes when asked to write `file`: the target of a symlink, followed as lockfile.c
 * `resolve_symlink` does (up to five links, a relative target taken from the link's directory), even
 * when the target does not exist yet, so the link stays a link.
 * @lastreviewed null
 */
export async function resolveSymlink(file: string): Promise<string> {
  let at = file;
  for (let depth = 0; depth < 5; depth++) {
    let link: string;
    try {
      link = await fsp.readlink(at);
    } catch {
      break;
    }
    if (path.isAbsolute(link)) {
      at = link;
    } else {
      const slash = Math.max(at.lastIndexOf("/"), process.platform === "win32" ? at.lastIndexOf("\\") : -1);
      at = (slash === -1 ? "" : at.slice(0, slash + 1)) + link;
    }
  }
  return at;
}

/**
 * Edit a config file under git's lock protocol ({@link GitConfigRunner.editFile}). The file is read
 * and written as bytes: `edit` gets each byte as one character (latin1) and must return text in the
 * same form, so bytes that are not UTF-8 (a cp1252 name, say) pass through unchanged. The lock is
 * created owner-only and set to the file's mode, read under the lock, before anything is written,
 * so the copy is never more readable than the file. Until it is renamed or removed, the lock is
 * removed if the process stops (`exitCleanup.ts`), and only while it is still the file (inode) this
 * call created.
 * @lastreviewed null
 */
export async function editConfigFile(file: string, edit: (text: string) => string | null): Promise<boolean> {
  const target = await resolveSymlink(file);
  const lock = `${target}.lock`;
  let handle: fsp.FileHandle | undefined;
  for (let waited = 0; ; waited += 25) {
    try {
      // Owner-only until the file's own mode is known: the copy is never more readable than the file.
      handle = await fsp.open(lock, "wx", 0o600);
      break;
    } catch (error) {
      if (codeOf(error) !== "EEXIST" || waited >= 2_000) {
        throw new Err.GitCredentialSetupError(
          `The git config file ${target} could not be locked${codeOf(error) === "EEXIST" ? "; another git is writing it" : ""}.`,
          null
        );
      }
      await sleep(25);
    }
  }
  const made = await handle.stat();
  const cleanup = trackOnExit(lock, () => {
    try {
      const now = fsSync.statSync(lock);
      return now.dev === made.dev && now.ino === made.ino;
    } catch {
      return false;
    }
  });
  try {
    // The mode is read only now, under the lock, so a change another writer made while b6p waited is the one kept.
    let mode: number | undefined;
    try {
      mode = (await fsp.stat(target)).mode & 0o7777;
    } catch (error) {
      if (codeOf(error) !== "ENOENT") {
        throw error;
      }
    }
    if (process.platform !== "win32") {
      await handle.chmod(mode ?? 0o666 & ~process.umask());
    }
    let text = "";
    try {
      text = (await fsp.readFile(target)).toString("latin1");
    } catch (error) {
      if (codeOf(error) !== "ENOENT") {
        throw error;
      }
    }
    const next = edit(text);
    if (next === null || next === text) {
      await handle.close();
      handle = undefined;
      await fsp.unlink(lock);
      untrackOnExit(cleanup);
      return false;
    }
    await handle.writeFile(Buffer.from(next, "latin1"));
    await handle.close();
    handle = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(lock, target);
        untrackOnExit(cleanup);
        return true;
      } catch (error) {
        const code = codeOf(error);
        if (attempt >= 6 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
          throw error;
        }
        await sleep(50 * 2 ** attempt);
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(lock).catch(() => undefined);
    untrackOnExit(cleanup);
    throw error;
  }
}

// `vars` with a relative GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM made absolute against the process's directory, as
// git resolves it, so every git b6p runs (whatever its cwd) and every record name the same file.
function absoluteConfigVars(vars: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let out = vars;
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
    const value = vars[name];
    if (value && !path.isAbsolute(value) && value !== "/dev/null") {
      out = { ...out, [name]: path.resolve(process.cwd(), value) };
    }
  }
  return out;
}

/**
 * The default {@link GitConfigRunner}: the `git` executable on PATH, with `env` (default
 * `process.env`) as its environment, so a test can point `HOME`, `XDG_CONFIG_HOME` or
 * `GIT_CONFIG_GLOBAL` at scratch files.
 * @lastreviewed null
 */
export function gitConfigRunner(env?: NodeJS.ProcessEnv): GitConfigRunner {
  const git = (args: readonly string[], options: GitRunOptions = {}): Promise<GitConfigOutcome> =>
    new Promise((resolve) => {
      execFile(
        "git",
        [...args],
        {
          windowsHide: true,
          env: absoluteConfigVars(env ?? process.env),
          ...(options.cwd ? { cwd: options.cwd } : {}),
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            resolve({ code: -1, stdout: "", stderr: String(stderr) });
            return;
          }
          resolve({ code: error ? Number(error.code) : 0, stdout: String(stdout), stderr: String(stderr) });
        }
      );
    });
  return {
    pathStyle: process.platform === "win32" ? "win32" : "posix",
    run: (args, options) => git(["config", ...args], options),
    git,
    globalFile: async () => {
      const outcome = await git(["var", "GIT_CONFIG_GLOBAL"]);
      const paths = outcome.code === 0 ? outcome.stdout.split(/\r?\n/).filter((line) => line !== "") : [];
      const user = paths[paths.length - 1];
      if (user === undefined) {
        const said = outcome.stderr
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /^(fatal|error):/.test(line));
        throw new Err.GitCredentialSetupError(
          said
            ? `git did not report its global config file: ${said}`
            : "git did not report its global config file (git var GIT_CONFIG_GLOBAL needs git 2.42 or later).",
          outcome.code === -1 ? null : outcome.code
        );
      }
      const xdg = paths.length > 1 ? paths[0] : undefined;
      const readable = (file: string): Promise<boolean> =>
        fsp.access(file, fsConstants.R_OK).then(
          () => true,
          () => false
        );
      return xdg !== undefined && !(await readable(user)) && (await readable(xdg)) ? xdg : user;
    },
    editFile: editConfigFile,
  };
}
