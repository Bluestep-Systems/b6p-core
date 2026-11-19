import { execFile } from "node:child_process";

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
 * Runs `git config <args>` and reports the outcome; never throws. The caller names the scope
 * (`--global`, or `--file <path>` to change the file an entry came from). The arguments never
 * carry a token: only config keys, value patterns and helper commands pass through here.
 * @lastreviewed null
 */
export type GitConfigRunner = (args: readonly string[]) => Promise<GitConfigOutcome>;

/**
 * The default {@link GitConfigRunner}: the `git` executable on PATH, with `env` (default
 * `process.env`) as its environment, so a test can point `HOME`, `XDG_CONFIG_HOME` or
 * `GIT_CONFIG_GLOBAL` at scratch files.
 * @lastreviewed null
 */
export function gitConfigRunner(env?: NodeJS.ProcessEnv): GitConfigRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile("git", ["config", ...args], { windowsHide: true, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          resolve({ code: -1, stdout: "", stderr: String(stderr) });
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}
