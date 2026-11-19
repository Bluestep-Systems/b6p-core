import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";

/**
 * How {@link withFileLock} waits.
 * @lastreviewed null
 */
export interface FileLockOptions {
  /**
   * How long to wait for the lock before giving up (default 10 s). Every failed attempt counts
   * against it, whatever the error: a lock held by another process, or a file system that refuses
   * the lockfile (`EPERM`, `EACCES`, as a Windows sharing restriction does).
   * @lastreviewed null
   */
  readonly timeoutMs?: number;
  /**
   * How long to sleep between attempts (default 20 ms).
   * @lastreviewed null
   */
  readonly retryMs?: number;
}

/**
 * The defaults of {@link FileLockOptions}.
 * @lastreviewed null
 */
export const FILE_LOCK_DEFAULTS = { timeoutMs: 10_000, retryMs: 20 } as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [20, 50, 100, 200, 400] as const;

// Run `step`, retrying a transient refusal (a Windows sharing restriction) a few times.
async function retrying<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      const code = errorCode(error);
      const delay = RETRY_DELAYS_MS[attempt];
      if (code === undefined || !TRANSIENT.has(code) || delay === undefined) {
        throw error;
      }
      await sleep(delay);
    }
  }
}

/**
 * When the process `pid` started, as this platform reports it, or `null` where b6p cannot tell
 * (Windows, where the only queries start PowerShell; a process that is gone). Linux: field 22 of
 * `/proc/<pid>/stat` (clock ticks since boot). macOS and the BSDs: `ps -o lstart=`.
 * @lastreviewed null
 */
export function processStart(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
    }
    if (process.platform === "win32") {
      return null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return out === "" ? null : out.replace(/\s+/g, "_");
  } catch {
    return null;
  }
}

// The PID namespace this process sees (Linux), so a pid is only judged where it names the same process.
function pidNamespace(): string {
  try {
    return process.platform === "linux" ? fsSync.readlinkSync("/proc/self/ns/pid") : "-";
  } catch {
    return "?";
  }
}

let mine: { start: string; ns: string } | undefined;
function self(): { start: string; ns: string } {
  return (mine ??= { start: processStart(process.pid) ?? "-", ns: pidNamespace() });
}

/**
 * A lockfile's stamp: `b6p-lock pid=<pid> host=<hostname> start=<start|-> ns=<pid namespace|-> token=<hex>`.
 * @lastreviewed null
 */
interface Stamp {
  readonly pid: number;
  readonly host: string;
  readonly start: string;
  readonly ns: string;
}

function parseStamp(text: string): Stamp | null {
  const m = /^b6p-lock pid=(\d+) host=(\S+) start=(\S+) ns=(\S+) token=[0-9a-f]{24}$/.exec(text);
  return m ? { pid: Number(m[1]), host: m[2], start: m[3], ns: m[4] } : null;
}

/**
 * Whether the holder named by `text` has certainly exited: a complete stamp from this host and this
 * PID namespace, whose pid no longer exists, or exists with another start time (the pid was
 * reused). Anything else (another host, a partial or unreadable stamp, `EPERM` from the check, a pid
 * whose start time b6p cannot read) counts as alive.
 * @lastreviewed null
 */
function holderDead(text: string): boolean {
  const stamp = parseStamp(text);
  if (stamp === null || stamp.host !== os.hostname() || stamp.ns !== self().ns || stamp.ns === "?") {
    return false;
  }
  if (stamp.pid === process.pid) {
    return stamp.start !== "-" && self().start !== "-" && stamp.start !== self().start;
  }
  try {
    process.kill(stamp.pid, 0);
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
  if (stamp.start === "-") {
    return false;
  }
  const now = processStart(stamp.pid);
  return now !== null && now !== stamp.start;
}

/**
 * Take the lockfile out of the way only if it still holds `expected`: rename it to a name unique
 * to this caller, read what was moved, and delete it when it is `expected`; otherwise link it back
 * (never over a file that has appeared there since) and report `false`.
 * @lastreviewed null
 */
async function removeIfStill(lockPath: string, expected: string): Promise<boolean> {
  const aside = `${lockPath}.${crypto.randomBytes(8).toString("hex")}.aside`;
  try {
    await retrying(() => fs.rename(lockPath, aside));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  const moved = await fs.readFile(aside, "utf8").catch(() => undefined);
  if (moved === expected) {
    await retrying(() => fs.unlink(aside)).catch(() => undefined);
    return true;
  }
  try {
    await fs.link(aside, lockPath);
  } finally {
    await retrying(() => fs.unlink(aside)).catch(() => undefined);
  }
  return false;
}

/**
 * Run `work` while holding the lockfile `lockPath`, the way git holds `<file>.lock`: created
 * exclusively (`wx`) and removed after, with a stamp naming its holder (process id, host name, the
 * process's start time where the platform reports it, its PID namespace on Linux, and a token unique
 * to this call).
 *
 * - **No time-based takeover.** Neither the lockfile's age nor any clock is ever consulted. A waiter
 *   removes a lock only when it is certain its holder has exited ({@link holderDead}); a lock from
 *   another host, or one whose holder cannot be proven gone, waits for its holder or for a person.
 * - **Removing a dead holder's lock** renames it aside and deletes it only if it still holds the
 *   dead stamp (otherwise it is linked back), so two waiters that both proved the same holder dead
 *   never remove the lock one of them has just taken.
 * - **Release** removes the lockfile the same way, only while it holds this call's stamp, retrying a
 *   transient `EPERM`/`EBUSY`/`EACCES`.
 * - **Waiting.** Every failed attempt, whatever its error, sleeps `retryMs` and counts against
 *   `timeoutMs`.
 *
 * @throws {Error} when the lock is not acquired within `timeoutMs`, naming the lockfile and its
 *   holder, and saying to delete it when no b6p or VS Code process is running.
 * @lastreviewed null
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_DEFAULTS.timeoutMs;
  const retryMs = options.retryMs ?? FILE_LOCK_DEFAULTS.retryMs;
  const deadline = Date.now() + timeoutMs;
  const { start, ns } = self();
  const token = crypto.randomBytes(12).toString("hex");
  const stamp = `b6p-lock pid=${process.pid} host=${os.hostname()} start=${start} ns=${ns} token=${token}`;
  let lastCode: string | undefined;
  let holder: string | undefined;
  for (;;) {
    let again = false;
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(stamp);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      break;
    } catch (error) {
      lastCode = errorCode(error);
    }
    if (lastCode === "EEXIST") {
      try {
        holder = await fs.readFile(lockPath, "utf8");
        again = holderDead(holder) && (await removeIfStill(lockPath, holder));
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          again = true;
        } else {
          lastCode = errorCode(error) ?? lastCode;
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage(lockPath, lastCode, holder));
    }
    if (!again) {
      await sleep(retryMs);
    }
  }
  try {
    return await work();
  } finally {
    // Left behind only if every retry was refused; a waiter then removes it once this process has exited.
    await removeIfStill(lockPath, stamp).catch(() => undefined);
  }
}

function timeoutMessage(lockPath: string, code: string | undefined, holder: string | undefined): string {
  if (code !== undefined && code !== "EEXIST") {
    return `Timed out waiting for the lock ${lockPath}: the file system refused it (${code}).`;
  }
  const stamp = holder === undefined ? null : parseStamp(holder);
  const who = stamp ? `process ${stamp.pid} on ${stamp.host}` : "a process b6p cannot identify";
  return (
    `Timed out waiting for the lock ${lockPath}, held by ${who}. ` +
    `If no b6p or VS Code process is running, delete ${lockPath}.`
  );
}
