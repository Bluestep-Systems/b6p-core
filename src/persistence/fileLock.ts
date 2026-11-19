import * as crypto from "crypto";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { sameFile, trackOnExit, untrackOnExit, type ExitCleanupEntry } from "./exitCleanup";

/**
 * How {@link withFileLock} waits.
 * @lastreviewed null
 */
export interface FileLockOptions {
  /**
   * How long to wait for the lock before giving up (default 10 s): while another process holds it,
   * or, on Windows, while the file system refuses the lockfile (`EPERM`, `EBUSY`, `EACCES`, as a
   * sharing restriction or antivirus does).
   * @lastreviewed null
   */
  readonly timeoutMs?: number;
  /**
   * How long to sleep between attempts (default 20 ms).
   * @lastreviewed null
   */
  readonly retryMs?: number;
  /**
   * Called when the lockfile's directory is missing (someone deleted it), before trying again;
   * default `mkdir -p` of that directory.
   * @lastreviewed null
   */
  readonly ensureDir?: () => Promise<void>;
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
// What creating the lockfile may refuse and still succeed later: another holder, and on Windows a sharing or
// antivirus refusal. Anything else (a read-only or full disk, a directory b6p may not write) fails at once.
const RETRIED_OPEN = new Set(process.platform === "win32" ? ["EEXIST", ...TRANSIENT] : ["EEXIST"]);
const RETRY_DELAYS_MS = [20, 50, 100, 200, 400] as const;

/**
 * The releases this process could not finish (every retry refused): lockfile path → the stamps it
 * wrote there. Only this process may remove a lock holding one of them; it tries again on its next
 * acquisition of the same lock, and on exit.
 * @lastreviewed null
 */
const pendingRelease = new Map<string, Map<string, ExitCleanupEntry>>();

/**
 * Take the lock in one synchronous run, as git does: create it exclusively, read its device and
 * inode, write the stamp, close it and register it for exit cleanup, so no exit, signal or uncaught
 * exception can land between the file appearing and its being tracked. Anything failing before the
 * stamp is tracked closes and removes the file and throws; a failing close after that keeps the
 * acquisition, since the lock is written, ours and tracked.
 * @lastreviewed null
 */
function acquireSync(lockPath: string, stamp: string): ExitCleanupEntry {
  const fd = fsSync.openSync(lockPath, "wx");
  let entry: ExitCleanupEntry;
  try {
    const made = fsSync.fstatSync(fd, { bigint: true });
    const bytes = Buffer.from(stamp, "utf8");
    for (let at = 0; at < bytes.length; ) {
      at += fsSync.writeSync(fd, bytes, at, bytes.length - at);
    }
    entry = trackOnExit(lockPath, sameFile(lockPath, made, stamp));
  } catch (error) {
    try {
      fsSync.closeSync(fd);
    } catch {
      // Closed or not, the file goes.
    }
    try {
      fsSync.unlinkSync(lockPath);
    } catch {
      // Gone already.
    }
    throw error;
  }
  try {
    fsSync.closeSync(fd);
  } catch {
    // The stamp is written and tracked: the lock is ours, and release removes it as usual.
  }
  return entry;
}

// Remove `lockPath` if it holds `stamp`, retrying a transient refusal. Resolves whether it is gone (or not ours).
async function release(lockPath: string, stamp: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fs.readFile(lockPath, "utf8")) !== stamp) {
        return true; // Not ours (deleted by a person and taken since): nothing to release.
      }
      await fs.unlink(lockPath);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        return true;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (code === undefined || !TRANSIENT.has(code) || delay === undefined) {
        return false;
      }
      await sleep(delay);
    }
  }
}

async function retryPending(lockPath: string): Promise<void> {
  const pending = pendingRelease.get(lockPath);
  for (const [stamp, entry] of pending ?? []) {
    if (await release(lockPath, stamp)) {
      pending?.delete(stamp);
      untrackOnExit(entry);
    }
  }
  if (pending && pending.size === 0) {
    pendingRelease.delete(lockPath);
  }
}

/**
 * Run `work` while holding the lockfile `lockPath`, the way git holds `<file>.lock`: created
 * exclusively (`wx`), its stamp (`b6p-lock pid=<pid> host=<hostname> token=<hex>`) written and the
 * file registered for exit cleanup in one synchronous run, and removed after.
 *
 * - **Never removed by another process.** No age, clock or process check ever lets a waiter take a
 *   lock over. A lock whose holder died stays until a person deletes it, and the timeout says so.
 * - **Release** removes the lockfile only while it holds this acquisition's stamp, retrying a
 *   transient `EPERM`/`EBUSY`/`EACCES`. A release still refused is kept pending: this process
 *   removes that lock (and only this one may) on its next acquisition of it, and on exit.
 * - **Stopping.** From the moment it exists, the lock is removed if the process exits, gets SIGINT,
 *   SIGTERM or SIGHUP with no handler of the host's, or dies of an uncaught exception
 *   (`exitCleanup.ts`, as git's tempfile.c does), while it is still the same file (device and
 *   inode) holding this stamp. Only a hard kill (SIGKILL, power loss) can leave one.
 * - **A missing directory** (a deleted `~/.b6p`) is created again (`ensureDir`) and the attempt
 *   retried.
 * - **Waiting.** A lock held by another (and on Windows `EPERM`/`EBUSY`/`EACCES`) is retried
 *   every `retryMs` until `timeoutMs`; any other refusal to create it fails at once.
 *
 * @throws {Error} when the lock is not acquired within `timeoutMs`, naming the lockfile and its
 *   holder (or saying it is empty), and saying to delete it when no b6p or VS Code process is running;
 *   at once when the file system refuses the lockfile for good (`EROFS`, `ENOSPC`, `EACCES` on POSIX).
 * @lastreviewed null
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_DEFAULTS.timeoutMs;
  const retryMs = options.retryMs ?? FILE_LOCK_DEFAULTS.retryMs;
  const ensureDir =
    options.ensureDir ?? (() => fs.mkdir(path.dirname(lockPath), { recursive: true }).then(() => undefined));
  const deadline = Date.now() + timeoutMs;
  const stamp = `b6p-lock pid=${process.pid} host=${os.hostname()} token=${crypto.randomBytes(12).toString("hex")}`;
  let lastCode: string | undefined;
  let lastError: unknown;
  let holder: string | undefined;
  let entry: ExitCleanupEntry | undefined;
  await retryPending(lockPath);
  for (;;) {
    let again = false;
    try {
      entry = acquireSync(lockPath, stamp);
      break;
    } catch (error) {
      lastError = error;
      lastCode = errorCode(error);
    }
    if (lastCode === "ENOENT") {
      try {
        await ensureDir();
        again = true;
      } catch (error) {
        lastCode = errorCode(error) ?? lastCode;
      }
    } else if (lastCode === "EEXIST") {
      holder = undefined;
      try {
        holder = await fs.readFile(lockPath, "utf8");
      } catch (error) {
        again = errorCode(error) === "ENOENT"; // Released between the two calls; any other refusal waits.
      }
      if (holder === undefined) {
        // Nothing more to learn: try again (at once if it was released).
      } else if (pendingRelease.get(lockPath)?.has(holder)) {
        await retryPending(lockPath);
        again = true;
      }
    }
    if (lastCode === undefined) {
      throw lastError;
    }
    if (lastCode !== "ENOENT" && !RETRIED_OPEN.has(lastCode)) {
      throw new Error(`The lock ${lockPath} could not be created: the file system refused it (${lastCode}).`);
    }
    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage(lockPath, lastCode, holder));
    }
    if (!again) {
      await sleep(retryMs);
    }
  }
  const mine = entry as ExitCleanupEntry;
  try {
    return await work();
  } finally {
    if (await release(lockPath, stamp)) {
      untrackOnExit(mine);
    } else {
      const pending = pendingRelease.get(lockPath) ?? new Map<string, ExitCleanupEntry>();
      pending.set(stamp, mine);
      pendingRelease.set(lockPath, pending);
    }
  }
}

function timeoutMessage(lockPath: string, code: string | undefined, holder: string | undefined): string {
  if (code !== undefined && code !== "EEXIST") {
    return `Timed out waiting for the lock ${lockPath}: the file system refused it (${code}).`;
  }
  const stamp = holder === undefined ? null : /^b6p-lock pid=(\d+) host=(\S+) /.exec(holder);
  const who =
    holder === ""
      ? "The lock is empty (a process stopped before writing it)"
      : stamp
        ? `It is held by process ${stamp[1]} on ${stamp[2]}`
        : "It is held by a process b6p cannot identify";
  return `Timed out waiting for the lock ${lockPath}. ${who}. If no b6p or VS Code process is running, delete ${lockPath}.`;
}
