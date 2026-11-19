import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
 * Runs `git config` for the credential helper's setup. The arguments never carry a token: only
 * config keys, value patterns and helper commands pass through here.
 * @lastreviewed null
 */
export interface GitConfigRunner {
  /**
   * Run `git config <args>` and report the outcome; never throws. The caller names the scope
   * (`--file <path>`), or none for a read of every scope.
   * @lastreviewed null
   */
  run(args: readonly string[]): Promise<GitConfigOutcome>;
  /**
   * The file `git config --global` writes, by git's rule: `$GIT_CONFIG_GLOBAL` when set, else
   * `~/.gitconfig`, unless that is missing and `$XDG_CONFIG_HOME/git/config` (default
   * `~/.config/git/config`) exists. Setup writes there with `--file`, so b6p knows which file each
   * of its entries is in.
   * @lastreviewed null
   */
  globalFile(): string;
}

/**
 * The default {@link GitConfigRunner}: the `git` executable on PATH, with `env` (default
 * `process.env`) as its environment, so a test can point `HOME`, `XDG_CONFIG_HOME` or
 * `GIT_CONFIG_GLOBAL` at scratch files.
 * @lastreviewed null
 */
export function gitConfigRunner(env?: NodeJS.ProcessEnv): GitConfigRunner {
  const vars = env ?? process.env;
  return {
    run: (args) =>
      new Promise((resolve) => {
        execFile(
          "git",
          ["config", ...args],
          { windowsHide: true, ...(env ? { env } : {}) },
          (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") {
              resolve({ code: -1, stdout: "", stderr: String(stderr) });
              return;
            }
            resolve({ code: error ? Number(error.code) : 0, stdout: String(stdout), stderr: String(stderr) });
          }
        );
      }),
    globalFile: () => {
      if (vars.GIT_CONFIG_GLOBAL) {
        return vars.GIT_CONFIG_GLOBAL;
      }
      const home = vars.HOME || vars.USERPROFILE || os.homedir();
      const dotfile = path.join(home, ".gitconfig");
      const xdg = path.join(vars.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config");
      return !existsSync(dotfile) && existsSync(xdg) ? xdg : dotfile;
    },
  };
}
