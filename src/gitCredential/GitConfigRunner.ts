import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import { Err } from "../Err";
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
   * Edit the config file `file` the way git does (lockfile.c): create `<file>.lock` exclusively
   * (waiting briefly while another git holds it), let `edit` turn the file's current text into the
   * new text (`null` to leave it), write that to the lock and rename it over the file, keeping the
   * file's mode. A symlinked file is edited at its target, as git does. Every git writer takes the
   * same lock, so nothing another writer does lands between `edit`'s read and the write. Returns
   * whether the file changed.
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
 * Edit a config file under git's lock protocol ({@link GitConfigRunner.editFile}).
 * @lastreviewed null
 */
export async function editConfigFile(file: string, edit: (text: string) => string | null): Promise<boolean> {
  const target = await fsp.realpath(file).catch(() => file);
  const lock = `${target}.lock`;
  let handle: fsp.FileHandle | undefined;
  for (let waited = 0; ; waited += 25) {
    try {
      handle = await fsp.open(lock, "wx", 0o666);
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
  try {
    let text = "";
    let mode: number | undefined;
    try {
      text = await fsp.readFile(target, "utf8");
      mode = (await fsp.stat(target)).mode & 0o7777;
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
      return false;
    }
    await handle.writeFile(next, "utf8");
    if (mode !== undefined && process.platform !== "win32") {
      await handle.chmod(mode);
    }
    await handle.close();
    handle = undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(lock, target);
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
    throw error;
  }
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
        { windowsHide: true, ...(env ? { env } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) },
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
        throw new Err.GitCredentialSetupError(
          "git did not report its global config file (git var GIT_CONFIG_GLOBAL needs git 2.42 or later).",
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
