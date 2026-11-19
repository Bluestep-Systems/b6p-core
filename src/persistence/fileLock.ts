import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";

/**
 * How {@link withFileLock} waits and keeps its lock.
 * @lastreviewed null
 */
export interface FileLockOptions {
  /**
   * How long to wait for the lock before giving up (default 10 s). Every failed attempt counts
   * against it, whatever the error: a lock held by another process, a file system that refuses the
   * lockfile (`EPERM`, `EACCES`, as a Windows sharing restriction does), or a takeover that failed.
   * Keep it longer than `staleMs` plus two `updateMs`, so a lock a crashed process left behind is
   * taken over before a waiter gives up.
   * @lastreviewed null
   */
  readonly timeoutMs?: number;
  /**
   * A lock whose heartbeat is older than this is taken to be left by a process that died holding it
   * (default 5 s, five heartbeats). A lock whose stamp names a process on this host that no longer
   * exists is taken over at once.
   * @lastreviewed null
   */
  readonly staleMs?: number;
  /**
   * How often the holder refreshes the lockfile's modification time, its heartbeat (default 1 s), for
   * as long as the work runs, however long that is.
   * @lastreviewed null
   */
  readonly updateMs?: number;
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
export const FILE_LOCK_DEFAULTS = { timeoutMs: 10_000, staleMs: 5_000, updateMs: 1_000, retryMs: 20 } as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const RELEASE_DELAYS_MS = [20, 50, 100, 200, 400, 800] as const;

// Remove `file`, retrying a transient refusal (a Windows sharing restriction). Gone already counts as removed.
async function unlinkRetrying(file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.unlink(file);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        return;
      }
      const delay = RELEASE_DELAYS_MS[attempt];
      if (code === undefined || !TRANSIENT.has(code) || delay === undefined) {
        throw error;
      }
      await sleep(delay);
    }
  }
}

/**
 * One look at a lockfile, through a single open handle, so its identity (device and inode), its
 * heartbeat (modification time) and its stamp all come from the same file and never mix an old
 * file's time with a new holder's stamp.
 * @lastreviewed null
 */
interface LockLook {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly stamp: string;
}

async function look(file: string): Promise<LockLook | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    const stamp = await handle.readFile("utf8");
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, stamp };
  } finally {
    await handle.close();
  }
}

const sameLock = (a: LockLook, b: LockLook): boolean => a.dev === b.dev && a.ino === b.ino && a.stamp === b.stamp;

// Whether the stamp names a process on this host that no longer exists (`b6p-lock <pid> <host> <token>`).
function holderGone(stamp: string): boolean {
  const match = /^b6p-lock (\d+) (\S+) /.exec(stamp);
  if (!match || match[2] !== os.hostname() || Number(match[1]) === process.pid) {
    return false;
  }
  try {
    process.kill(Number(match[1]), 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

const isStale = (seen: LockLook, staleMs: number): boolean =>
  Date.now() - seen.mtimeMs > staleMs || holderGone(seen.stamp);

/**
 * Take over the stale lock `judged`, one waiter at a time: only the holder of `<lock>.takeover`
 * (created exclusively, held for a few file operations) may remove the lockfile, and it looks again
 * under that guard, removing the lockfile only if it is still the same file with the same stamp
 * and still stale. A waiter that acted on an old judgement therefore never removes a lock another
 * has just taken. A guard left by a process that died during a takeover is removed once it is
 * `staleMs` old. Returns whether to try for the lock again at once.
 * @lastreviewed null
 */
async function takeOver(lockPath: string, judged: LockLook, staleMs: number): Promise<boolean> {
  const guard = `${lockPath}.takeover`;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(guard, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      const held = await look(guard).catch(() => null);
      if (held && Date.now() - held.mtimeMs > staleMs) {
        await fs.unlink(guard).catch(() => undefined);
      }
      return false;
    }
    throw error;
  }
  try {
    await handle.close();
    const now = await look(lockPath);
    if (now === null) {
      return true;
    }
    if (sameLock(now, judged) && isStale(now, staleMs)) {
      await fs.unlink(lockPath);
      return true;
    }
    return false;
  } finally {
    await unlinkRetrying(guard).catch(() => undefined);
  }
}

/**
 * Run `work` while holding the lockfile `lockPath`, created exclusively (`wx`) with a stamp unique
 * to this call (`b6p-lock <pid> <host> <token>`).
 *
 * - **Heartbeat.** The holder keeps the file open and refreshes its modification time every
 *   `updateMs` for as long as `work` runs, so a long transaction (a setup over many hosts, a slow
 *   Windows process launch) keeps its lock however long it takes.
 * - **Stale.** A lock counts as stale only when its heartbeat is older than `staleMs`, or its stamp
 *   names a process on this host that no longer exists. Takeovers are serialized ({@link takeOver}).
 * - **Release.** Removes the lockfile only if it is still the file this call created (same device
 *   and inode as its open handle), retrying a transient `EPERM`/`EBUSY`/`EACCES`. A release whose
 *   heartbeat had fallen behind (the process was suspended) takes the takeover guard first.
 * - **Waiting.** Every failed attempt, whatever its error, sleeps `retryMs` and counts against
 *   `timeoutMs`.
 *
 * @throws {Error} when the lock is not acquired within `timeoutMs`.
 * @lastreviewed null
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_DEFAULTS.timeoutMs;
  const staleMs = options.staleMs ?? FILE_LOCK_DEFAULTS.staleMs;
  const updateMs = options.updateMs ?? FILE_LOCK_DEFAULTS.updateMs;
  const retryMs = options.retryMs ?? FILE_LOCK_DEFAULTS.retryMs;
  const deadline = Date.now() + timeoutMs;
  const stamp = `b6p-lock ${process.pid} ${os.hostname()} ${crypto.randomBytes(12).toString("hex")}`;
  let handle: fs.FileHandle | undefined;
  let lastCode: string | undefined;
  for (;;) {
    let again = false;
    try {
      handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(stamp);
      } catch (error) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await fs.unlink(lockPath).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      lastCode = errorCode(error);
    }
    if (lastCode === "EEXIST") {
      try {
        const seen = await look(lockPath);
        again = seen === null || (isStale(seen, staleMs) && (await takeOver(lockPath, seen, staleMs)));
      } catch (error) {
        lastCode = errorCode(error) ?? lastCode;
      }
    }
    if (Date.now() >= deadline) {
      const why = lastCode === undefined || lastCode === "EEXIST" ? "" : ` (${lastCode})`;
      throw new Error(`Timed out waiting for a lock on b6p's shared state${why}.`);
    }
    if (!again) {
      await sleep(retryMs);
    }
  }
  const held = handle;
  let lastBeat = Date.now();
  const beat = setInterval(() => {
    const now = new Date();
    held.utimes(now, now).then(
      () => (lastBeat = Date.now()),
      () => undefined
    );
  }, updateMs);
  beat.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(beat);
    const release = async (): Promise<void> => {
      const mine = await held.stat().catch(() => null);
      const there = await fs.stat(lockPath).catch(() => null);
      await held.close().catch(() => undefined);
      if (mine && there && mine.dev === there.dev && mine.ino === there.ino) {
        await unlinkRetrying(lockPath);
      }
    };
    try {
      if (Date.now() - lastBeat > staleMs / 2) {
        await releaseGuarded(lockPath, release, timeoutMs, retryMs);
      } else {
        await release();
      }
    } catch {
      // Left behind after every retry: its heartbeat has stopped, so a waiter takes it over once it is stale.
    }
  }
}

// Run `release` holding the takeover guard (waiting up to `timeoutMs` for it), so it cannot race a takeover.
async function releaseGuarded(
  lockPath: string,
  release: () => Promise<void>,
  timeoutMs: number,
  retryMs: number
): Promise<void> {
  const guard = `${lockPath}.takeover`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await (await fs.open(guard, "wx")).close();
      break;
    } catch {
      if (Date.now() >= deadline) {
        return release();
      }
      await sleep(retryMs);
    }
  }
  try {
    await release();
  } finally {
    await unlinkRetrying(guard).catch(() => undefined);
  }
}
